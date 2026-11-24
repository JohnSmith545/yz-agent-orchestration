// Tests for projects-routes.mjs: the Project menu's routes (/api/projects) and the Orchestration bank's routes
// (/api/orchestrations), through a real local http server. Every file is a temp one (config.json, projects.json,
// the bank, the data folders); git and the restart are stubs, so no process is started or stopped.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-routes-test-'))
process.env.FACTORY_DATA_DIR = path.join(ROOT, 'data')
const { makeProjectRoutes } = await import('../projects-routes.mjs')
const R = await import('../agent-rules.mjs')
const B = await import('../orchestration-bank.mjs')

const DATA = process.env.FACTORY_DATA_DIR
const CONFIG_FILE = path.join(ROOT, 'config.json')
const PROJECTS_FILE = path.join(DATA, 'projects.json')
const BANK_FILE = path.join(DATA, 'orchestration-bank.json')
const REPO_A = path.join(ROOT, 'repo-a').replace(/\\/g, '/')
const REPO_B = path.join(ROOT, 'repo-b').replace(/\\/g, '/')
const NOT_GIT = path.join(ROOT, 'not-git').replace(/\\/g, '/')
for (const d of [REPO_A, REPO_B, NOT_GIT, `${REPO_B}/sub`]) fs.mkdirSync(d, { recursive: true })
const CONFIG_TEXT = `{
  "repo": "${REPO_A}",
  "port": 4317,
  "coordinator": "Master",
  "codingAgents": {
    "Master": "Master",
    "Agent 1": "Agent 1",
    "Agent 2": "Agent 2"
  },
  "pinnedAgents": { "Agent 1": { "sessionId": "s1" } },
  "factory": { "chat": { "name": "Independent", "forkFrom": "f1" } }
}
`

const state = { chatBusy: false, relay: { pending: [], running: false }, restarts: [], restartResult: { ok: true }, sessions: ['Master', 'Agent 1'] }
let server
let base
let port
let route
const later = []

function makeRoute(running = { id: 'repo-a', name: 'Repo a', primary: true }) {
  route = makeProjectRoutes({
    port: () => port,
    running,
    files: { projectsFile: PROJECTS_FILE, configFile: CONFIG_FILE, root: DATA, bankFile: BANK_FILE },
    restart: async () => (state.restarts.push(Date.now()), state.restartResult),
    later: fn => later.push(fn),
    gitTop: async dir => {
      const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
      if (d === REPO_A || d === REPO_B) return d
      if (d.startsWith(`${REPO_B}/`)) return REPO_B
      return null
    },
    relay: { status: () => state.relay },
    chatBusy: () => state.chatBusy,
    sessionNames: async () => state.sessions,
    bootId: 'boot-1',
  })
}

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    route.track(req, res)
    if (url.pathname === '/slow' || url.pathname === '/api/script/generate') return void setTimeout(() => res.end('ok'), 400) // a write still running
    if (!(await route(req, res, url))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  base = `http://127.0.0.1:${port}`
})
after(() => {
  server.close()
  fs.rmSync(ROOT, { recursive: true, force: true })
})
beforeEach(() => {
  fs.rmSync(DATA, { recursive: true, force: true })
  fs.mkdirSync(DATA, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, CONFIG_TEXT)
  Object.assign(state, { chatBusy: false, relay: { pending: [], running: false }, restarts: [], restartResult: { ok: true }, sessions: ['Master', 'Agent 1'] })
  later.length = 0
  makeRoute()
})

const get = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() } }
const post = async (p, body = {}, origin = base) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
const runLater = async () => { for (const fn of later.splice(0)) await fn() }
const projectsNow = () => JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'))
const addB = (extra = {}) => post('/api/projects', { name: 'Repo B', repo: REPO_B, start: 'same', ...extra })

// ═══ the projects ═══

test('with no projects.json the menu lists the one project of config.json, current', async () => {
  const r = await get('/api/projects')
  assert.equal(r.status, 200)
  assert.equal(r.body.bootId, 'boot-1')
  assert.deepEqual(r.body.current, { id: 'repo-a', name: 'Repo a' })
  assert.deepEqual(r.body.projects.map(p => [p.id, p.name, p.current, p.primary]), [['repo-a', 'Repo a', true, true]])
  assert.equal(r.body.projects[0].repo, REPO_A)
  assert.equal(r.body.restartError, null)
  assert.ok(!fs.existsSync(PROJECTS_FILE), 'reading never writes projects.json')
})

test('every write needs the page own Origin', async () => {
  for (const [p, body] of [['/api/projects', {}], ['/api/projects/repo-a/rename', { name: 'x' }], ['/api/projects/repo-a/remove'], ['/api/projects/repo-a/switch'],
    ['/api/orchestrations', { name: 'x' }], ['/api/orchestrations/o00000001/rename', { name: 'x' }], ['/api/orchestrations/o00000001/duplicate'],
    ['/api/orchestrations/o00000001/delete'], ['/api/orchestrations/o00000001/use']]) {
    for (const origin of [null, 'http://evil.example', `http://127.0.0.1:${port + 1}`]) {
      const r = await post(p, body, origin)
      assert.equal(r.status, 403, `${p} from ${origin}`)
    }
  }
})

test('adding a project checks the name, the folder (there, a git repository, its top) and the start', async () => {
  const cases = [
    [{ name: '' }, 'Give the project a name.'],
    [{ name: 'x'.repeat(41) }, 'That name is too long. Keep it to 40 characters.'],
    [{ name: 'repo A' }, 'There is already a project called repo A.'],
    [{ repo: '' }, 'Give the folder of the project repository.'],
    [{ repo: 'relative/path' }, 'Give the full path of the folder, such as C:/work/my-repo.'],
    [{ repo: path.join(ROOT, 'missing') }, `There is no folder at ${path.join(ROOT, 'missing').replace(/\\/g, '/')}.`],
    [{ repo: NOT_GIT }, `${NOT_GIT} is not a git repository.`],
    [{ repo: `${REPO_B}/sub` }, `That folder is inside the git repository ${REPO_B}. Use ${REPO_B}.`],
    [{ repo: REPO_A, name: 'Another' }, 'That folder is already the project Repo a.'],
    [{ sessionCwdMatch: 'a\nb' }, 'How sessions are recognised must be one line of at most 100 characters.'],
    [{ start: 'nonsense' }, 'Choose how the project starts: the same orchestration, or one from the bank.'],
    [{ start: 'o12345678' }, 'That orchestration is not in the bank.'],
  ]
  for (const [extra, error] of cases) {
    const r = await addB(extra)
    assert.equal(r.status, 400, JSON.stringify(extra))
    assert.equal(r.body.error, error)
  }
  assert.ok(!fs.existsSync(PROJECTS_FILE))
})

test('a new project starts with the same orchestration: its own repo, the agents and pipeline, the rules, and nothing else', async () => {
  R.writeRules(R.applyChange({ agents: {} }, 'Agent 1', { spec: 'Builds.', rules: ['One.'] }), path.join(DATA, 'agent-rules.json'))
  const configBefore = fs.readFileSync(CONFIG_FILE, 'utf8')
  const r = await addB()
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.deepEqual(r.body.project, { id: 'repo-b', name: 'Repo B' })
  const store = projectsNow()
  assert.equal(store.active, 'repo-a')
  assert.deepEqual(store.projects.map(p => [p.id, !!p.primary]), [['repo-a', true], ['repo-b', false]])
  const cfg = store.projects[1].config
  assert.equal(cfg.repo, REPO_B)
  assert.equal(cfg.sessionCwdMatch, 'repo-b')
  assert.equal(cfg.coordinator, 'Master')
  assert.deepEqual(cfg.codingAgents, { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2' })
  assert.equal(cfg.pinnedAgents, undefined) // pins are the first project's own
  assert.equal(cfg.factory.chat.forkFrom, undefined)
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), configBefore) // config.json untouched
  const rules = R.readRules(path.join(DATA, 'projects', 'repo-b', 'agent-rules.json'))
  assert.deepEqual(R.rulesOf(rules, 'Agent 1').rules.map(x => x.text), ['One.'])
  const list = (await get('/api/projects')).body.projects
  assert.deepEqual(list.map(p => [p.id, p.current]), [['repo-a', true], ['repo-b', false]])
})

test('a new project can start from a bank entry, and remembers it', async () => {
  const saved = await post('/api/orchestrations', { name: 'Careful' })
  assert.equal(saved.status, 201)
  const r = await addB({ start: saved.body.entry.id, sessionCwdMatch: 'my-b' })
  assert.equal(r.status, 201)
  assert.equal(projectsNow().projects[1].config.sessionCwdMatch, 'my-b')
  const b = (await get('/api/projects')).body.projects.find(p => p.id === 'repo-b')
  assert.deepEqual(b.orchestration, { id: saved.body.entry.id, name: 'Careful' })
})

test('rename: checked, unique, and an unknown or bad id says so', async () => {
  await addB()
  assert.equal((await post('/api/projects/repo-b/rename', { name: 'Bee' })).status, 200)
  assert.equal(projectsNow().projects[1].name, 'Bee')
  assert.equal((await post('/api/projects/repo-b/rename', { name: 'repo a' })).body.error, 'There is already a project called repo a.')
  assert.equal((await post('/api/projects/nope/rename', { name: 'x' })).status, 404)
  assert.equal((await post('/api/projects/..%2Fx/rename', { name: 'x' })).status, 400)
  // the first project can be renamed too, which writes projects.json for it
  assert.equal((await post('/api/projects/repo-a/rename', { name: 'Flinki v2' })).status, 200)
  assert.equal(projectsNow().projects[0].name, 'Flinki v2')
})

test('remove: never the current one, never the first; another leaves the list and keeps its data', async () => {
  await addB()
  fs.writeFileSync(path.join(DATA, 'projects', 'repo-b', 'keep.txt'), 'x')
  assert.equal((await post('/api/projects/repo-a/remove')).body.error, 'This is the project the dashboard shows now. Switch to another one first.')
  makeRoute({ id: 'repo-b', name: 'Repo B' })
  assert.equal((await post('/api/projects/repo-a/remove')).body.error, 'The first project is the one the dashboard was set up with, and it cannot be removed.')
  makeRoute()
  const r = await post('/api/projects/repo-b/remove')
  assert.equal(r.status, 200)
  assert.deepEqual(projectsNow().projects.map(p => p.id), ['repo-a'])
  assert.ok(fs.existsSync(path.join(DATA, 'projects', 'repo-b', 'keep.txt')))
})

test('switch: writes the new active project, answers, THEN restarts', async () => {
  await addB()
  const r = await post('/api/projects/repo-b/switch')
  assert.equal(r.status, 202)
  assert.deepEqual(r.body.switching, { id: 'repo-b', name: 'Repo B' })
  assert.equal(projectsNow().active, 'repo-b')
  assert.equal(state.restarts.length, 0) // not before the answer has gone
  await runLater()
  assert.equal(state.restarts.length, 1)
})

test('switch: a restart that fails puts the active project back and says so on the next read', async () => {
  await addB()
  state.restartResult = { ok: false, error: 'The new dashboard could not start, so this one keeps running.' }
  await post('/api/projects/repo-b/switch')
  await runLater()
  assert.equal(projectsNow().active, 'repo-a')
  assert.equal((await get('/api/projects')).body.restartError, 'The new dashboard could not start, so this one keeps running.')
})

test('switch: bad id, unknown id, the current one, a folder that went away', async () => {
  assert.equal((await post('/api/projects/BAD!/switch')).status, 400)
  assert.equal((await post('/api/projects/nope/switch')).status, 404)
  const same = await post('/api/projects/repo-a/switch')
  assert.equal(same.status, 200)
  assert.equal(same.body.already, true)
  await addB()
  const store = projectsNow()
  store.projects[1].config.repo = path.join(ROOT, 'gone').replace(/\\/g, '/')
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(store))
  const gone = await post('/api/projects/repo-b/switch')
  assert.equal(gone.status, 409)
  assert.match(gone.body.error, /^The folder of Repo B is not there any more/)
})

test('switch is refused while something would be lost: a chat turn, an answer on its way, a write still running', async () => {
  await addB()
  state.chatBusy = true
  let r = await post('/api/projects/repo-b/switch')
  assert.equal(r.status, 409)
  assert.equal(r.body.error, 'Not now: the Ask chat is answering. Try again once it has finished.')
  state.chatBusy = false
  state.relay = { pending: [{ flowId: 'f', nodeId: 'n' }, { flowId: 'g', nodeId: 'n' }], running: true }
  r = await post('/api/projects/repo-b/switch')
  assert.equal(r.body.error, 'Not now: an answer is being sent to an agent and 2 answers are waiting to be sent. Try again once they have finished.')
  state.relay = { pending: [], running: false }
  const slow = fetch(`${base}/slow`, { method: 'POST', headers: { origin: base } })
  await new Promise(res => setTimeout(res, 80))
  r = await post('/api/projects/repo-b/switch')
  assert.equal(r.body.error, 'Not now: a change is still being saved. Try again once it has finished.')
  await slow
  // the page that writes prompts is called Brainstorming: the sentence uses the name the user sees
  const run = fetch(`${base}/api/script/generate`, { method: 'POST', headers: { origin: base } })
  await new Promise(res => setTimeout(res, 80))
  r = await post('/api/projects/repo-b/switch')
  assert.equal(r.body.error, 'Not now: a Brainstorming run is still writing. Try again once it has finished.')
  await run
  assert.equal((await post('/api/projects/repo-b/switch')).status, 202)
  assert.equal(projectsNow().active, 'repo-b')
})

// ═══ the bank ═══

test('the first read of an empty bank saves the current orchestration once, named after the project and the date', async () => {
  const r = await get('/api/orchestrations')
  assert.equal(r.status, 200)
  assert.equal(r.body.entries.length, 1)
  assert.match(r.body.entries[0].name, /^Repo a, \d{1,2} [A-Z][a-z]{2} \d{4}$/)
  assert.equal(r.body.entries[0].summary, 'Master hands to 2 agents, QA tests, no rules')
  assert.deepEqual(r.body.seeded, { id: r.body.entries[0].id, name: r.body.entries[0].name })
  assert.deepEqual(r.body.used, { id: r.body.entries[0].id, name: r.body.entries[0].name }) // it is the one in use
  const again = await get('/api/orchestrations')
  assert.equal(again.body.entries.length, 1)
  assert.equal(again.body.seeded, null)
  await post(`/api/orchestrations/${r.body.entries[0].id}/delete`)
  assert.equal((await get('/api/orchestrations')).body.entries.length, 0) // never seeded again
})

test('save, rename, duplicate and delete, with plain refusals', async () => {
  await get('/api/orchestrations')
  const s = await post('/api/orchestrations', { name: 'Careful' })
  assert.equal(s.status, 201)
  assert.equal((await post('/api/orchestrations', { name: 'careful' })).body.error, 'There is already an orchestration called careful.')
  const id = s.body.entry.id
  assert.equal((await post(`/api/orchestrations/${id}/rename`, { name: 'Very careful' })).body.entry.name, 'Very careful')
  const d = await post(`/api/orchestrations/${id}/duplicate`)
  assert.equal(d.status, 201)
  assert.equal(d.body.entry.name, 'Very careful (copy)')
  assert.equal((await post(`/api/orchestrations/${id}/delete`)).status, 200)
  assert.equal((await post(`/api/orchestrations/${id}/delete`)).status, 404)
  assert.equal((await post('/api/orchestrations/..%2F..%2Fx/delete')).status, 400)
  assert.equal((await get('/api/orchestrations/nothex00')).status, 400)
  assert.deepEqual((await get('/api/orchestrations')).body.entries.map(e => e.name).slice(0, 1), ['Very careful (copy)'])
})

test('one entry opened: its graph, each agent with specification and rules, and the agents with no session here yet', async () => {
  R.writeRules(R.applyChange({ agents: {} }, 'Agent 2', { spec: 'Writes the API.', rules: ['Tests first.'] }), path.join(DATA, 'agent-rules.json'))
  const s = await post('/api/orchestrations', { name: 'Now' })
  const r = await get(`/api/orchestrations/${s.body.entry.id}`)
  assert.equal(r.status, 200)
  assert.equal(r.body.entry.name, 'Now')
  assert.ok(r.body.view.graph.nodes.length > 3)
  const a2 = r.body.view.agents.find(a => a.label === 'Agent 2')
  assert.deepEqual([a2.role, a2.roleWords, a2.spec, a2.rules], ['producer', 'writes code', 'Writes the API.', ['Tests first.']])
  assert.deepEqual(r.body.noSession, ['Agent 2', 'QA'])
  assert.equal(r.body.current.summary, 'Master hands to 2 agents, QA tests, 1 rule')
  assert.equal((await get('/api/orchestrations/o99999999')).status, 404)
})

test('use on this project: saves the style in use first under a dated name, writes the new one, remembers it, restarts', async () => {
  const s = await post('/api/orchestrations', { name: 'Two builders' })
  // change what is in use now, so the autosave is a new style
  fs.writeFileSync(CONFIG_FILE, CONFIG_TEXT.replace('"Agent 2": "Agent 2"', '"Agent 2": "Agent 2",\n    "Agent 3": "Agent 3"'))
  R.writeRules(R.applyChange({ agents: {} }, 'Agent 3', { spec: 'Mobile.', rules: ['Never web.'] }), path.join(DATA, 'agent-rules.json'))
  const r = await post(`/api/orchestrations/${s.body.entry.id}/use`)
  assert.equal(r.status, 202, JSON.stringify(r.body))
  assert.match(r.body.autosaved.name, /^Repo a, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}$/)
  assert.deepEqual(r.body.noSession, ['Agent 2', 'QA'])
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  assert.deepEqual(cfg.codingAgents, { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2' })
  assert.deepEqual(cfg.pinnedAgents, { 'Agent 1': { sessionId: 's1' } })
  // Agent 3 is not in the style: its rules stay in the file, unseen, and come back with any style that has it again
  assert.equal(R.rulesOf(R.readRules(path.join(DATA, 'agent-rules.json')), 'Agent 3').spec, 'Mobile.')
  const bank = B.readBank(BANK_FILE)
  assert.deepEqual(B.usedBy(bank, 'repo-a'), { id: s.body.entry.id, name: 'Two builders' })
  const auto = bank.entries.find(e => e.id === r.body.autosaved.id)
  assert.deepEqual(auto.snapshot.parts.agents.codingAgents, { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', 'Agent 3': 'Agent 3' })
  assert.equal(state.restarts.length, 0)
  await runLater()
  assert.equal(state.restarts.length, 1)
})

test('use: no second copy when the style in use is already in the bank; refused while busy or when the bank is full', async () => {
  const a = await post('/api/orchestrations', { name: 'Same as now' })
  fs.writeFileSync(CONFIG_FILE, CONFIG_TEXT.replace('"Master",\n  "codingAgents"', '"Lead",\n  "codingAgents"'))
  const b = await post('/api/orchestrations', { name: 'Lead style' })
  fs.writeFileSync(CONFIG_FILE, CONFIG_TEXT) // back to the style of Same as now
  const r = await post(`/api/orchestrations/${b.body.entry.id}/use`)
  assert.equal(r.status, 202)
  assert.deepEqual(r.body.autosaved, { id: a.body.entry.id, name: 'Same as now', existing: true })
  fs.writeFileSync(CONFIG_FILE, CONFIG_TEXT)
  state.chatBusy = true
  assert.equal((await post(`/api/orchestrations/${b.body.entry.id}/use`)).status, 409)
  state.chatBusy = false
  let bank = B.readBank(BANK_FILE)
  for (let i = 0; bank.entries.length < 50; i++) bank = B.addEntry(bank, { name: `Filler ${i}`, from: { id: 'x', name: 'x' }, snapshot: { parts: { agents: { filler: i } } } }).bank
  B.writeBank(bank, BANK_FILE)
  fs.writeFileSync(CONFIG_FILE, CONFIG_TEXT.replace('"Agent 2": "Agent 2"', '"Agent 2": "Agent 2",\n    "Agent 3": "Agent 3"'))
  const full = await post(`/api/orchestrations/${b.body.entry.id}/use`)
  assert.equal(full.status, 409)
  assert.equal(full.body.error, 'The bank is full, so the orchestration in use now cannot be saved first. Delete one, then try again.')
})

test('a style already in use is never offered again: the entry says so, and a second Use is refused', async () => {
  const s = await post('/api/orchestrations', { name: 'Two builders' })
  fs.writeFileSync(CONFIG_FILE, CONFIG_TEXT.replace('"Agent 2": "Agent 2"', '"Agent 2": "Agent 2",\n    "Agent 3": "Agent 3"'))
  assert.equal((await post(`/api/orchestrations/${s.body.entry.id}/use`)).status, 202)
  const one = await get(`/api/orchestrations/${s.body.entry.id}`)
  assert.equal(one.body.same, true)
  assert.equal(one.body.inUse, true)
  assert.deepEqual(one.body.changes, [])
  const again = await post(`/api/orchestrations/${s.body.entry.id}/use`)
  assert.equal(again.status, 409)
  assert.equal(again.body.error, 'Two builders is already the orchestration in use on Repo a. There is nothing to change.')
  assert.equal(B.readBank(BANK_FILE).entries.length, 2) // no second dated copy
})

test('In use here shows only while the style of the project still equals the entry', async () => {
  const s = await post('/api/orchestrations', { name: 'Two builders' })
  fs.writeFileSync(CONFIG_FILE, CONFIG_TEXT.replace('"Agent 2": "Agent 2"', '"Agent 2": "Agent 2",\n    "Agent 3": "Agent 3"'))
  await post(`/api/orchestrations/${s.body.entry.id}/use`)
  assert.equal((await get('/api/orchestrations')).body.inUse, s.body.entry.id)
  R.writeRules(R.applyChange({ agents: {} }, 'Agent 1', { spec: 'Edited since.', rules: [] }), path.join(DATA, 'agent-rules.json'))
  const list = await get('/api/orchestrations')
  assert.equal(list.body.inUse, null)
  assert.equal(list.body.used.id, s.body.entry.id) // still the one it last took from the bank
  assert.equal((await get(`/api/orchestrations/${s.body.entry.id}`)).body.inUse, false)
})

test('one entry opened lists exactly what using it changes: agents, rules per agent, models', async () => {
  const { applyModel, readAgentSettings, writeAgentSettings } = await import('../agent-settings.mjs')
  const file = path.join(DATA, 'agent-settings.json')
  writeAgentSettings(applyModel(readAgentSettings(file), 'Agent 2', { model: 'claude-opus-5-5', effort: 'high' }).store, file)
  const now = await post('/api/orchestrations', { name: 'Now' })
  fs.writeFileSync(CONFIG_FILE, CONFIG_TEXT.replace('"coordinator": "Master",', '"coordinator": "Master",\n  "pipeline": { "qa": "QA", "planner": "Planner" },'))
  writeAgentSettings(applyModel(readAgentSettings(file), 'Agent 2', { model: 'claude-haiku-5-5', effort: 'low' }).store, file)
  R.writeRules(R.applyChange({ agents: {} }, 'Agent 1', { spec: '', rules: ['New one.', 'New two.'] }), path.join(DATA, 'agent-rules.json'))
  const next = await post('/api/orchestrations', { name: 'Next' })
  fs.writeFileSync(CONFIG_FILE, CONFIG_TEXT)
  writeAgentSettings(applyModel(readAgentSettings(file), 'Agent 2', { model: 'claude-opus-5-5', effort: 'high' }).store, file)
  R.writeRules({ agents: {} }, path.join(DATA, 'agent-rules.json'))
  const r = await get(`/api/orchestrations/${next.body.entry.id}`)
  assert.equal(r.body.same, false)
  assert.deepEqual(r.body.changes, [
    'Planner is added: plans the work and hands it out.',
    'Agent 1: 2 rules added.',
    'Agent 2 runs on Haiku 5.5 at low effort instead of Opus 5.5 at high effort.',
  ])
  assert.match(r.body.view.route, /^Master hands each request to Planner, who plans it and hands it to Agent 1 and Agent 2;/)
  assert.equal(r.body.view.agents.find(a => a.label === 'Planner').modelWords, 'Opus 5.5, high effort (fixed)')
  assert.equal(r.body.view.summary, 'Master hands to 2 agents through Planner, QA tests, 2 rules')
  assert.equal((await get(`/api/orchestrations/${now.body.entry.id}`)).body.same, true)
})
