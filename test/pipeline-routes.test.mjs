// Tests for the pipeline routes (pipeline-routes.mjs, mounted by factory-routes.mjs): GET /api/pipeline (the graph
// and where each flow stands on it), GET /api/qa (what QA recorded, with the report text and links to the commit),
// POST /api/flows/<id>/rework (send a failure back again), and the narrow evidence exception that serves a QA
// report as plain text. A real http server on port 0 calls factoryRoute with a STUB git; FACTORY_DATA_DIR points
// at a fresh temp folder BEFORE the imports.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-routes-test-'))
const F = await import('../flows.mjs')
const { factoryRoute } = await import('../factory-routes.mjs')
const { CONFIG } = await import('../config.mjs')
const { pipelineGraph } = await import('../pipeline.mjs')
const { resetPipelineState, webUrlOf } = await import('../pipeline-routes.mjs')
const { moveToTrash } = await import('../trash.mjs')

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const QA = CONFIG.pipeline.qa
const SHA = 'cd34ef5000000000000000000000000000000000'
const DAY = 86_400_000

/** The dashboard's own folder, as pipeline-routes.mjs names it (forward slashes). */
const DASHBOARD = path.resolve(HERE, '..').replace(/\\/g, '/')
const OTHER = 'C:/repos/other'
/** Each repo's remote (the watched one with a token in it) and the commits each holds. */
const REMOTE_OF = {
  [CONFIG.repo]: 'https://bob:ghp_abcdefghijklmnop@github.com/acme/app.git',
  [DASHBOARD]: 'git@github.com:yz/dashboard.git',
  [OTHER]: 'https://github.com/acme/other.git',
}
let holds = {}
/** The stub git (`git -C <repo> …`): get-url from REMOTE_OF, cat-file -e from `holds`; every call recorded. */
const gitCalls = []
async function git(args) {
  gitCalls.push(args)
  const repo = args[1]
  if (args.includes('get-url')) return REMOTE_OF[repo] ? { ok: true, out: REMOTE_OF[repo], err: '' } : { ok: false, out: '', err: 'no remote' }
  if (args[2] === 'cat-file') return (holds[repo] || []).includes(args.at(-1).replace('^{commit}', '')) ? { ok: true, out: '', err: '' } : { ok: false, out: '', err: 'fatal' }
  return { ok: false, out: '', err: 'no' }
}
const catFiles = () => gitCalls.filter(a => a[2] === 'cat-file')
const queued = []
const relay = { queueRework: id => queued.push(id) }

let server
let base
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await factoryRoute(req, res, url, { git, relay }))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
})

/** Write flow `id` from the fixture, with `more` on top. */
function put(id, more = {}) {
  const f = { ...structuredClone(FIXTURE), id, title: `Flow ${id}`, ...more }
  fs.writeFileSync(path.join(F.FLOWS_DIR, `${id}.json`), JSON.stringify(f))
}
const ago = ms => new Date(Date.now() - ms).toISOString()
const passed = id => ({
  status: 'passed', attempt: 1, by: QA, at: ago(1000), commit: SHA, report: `${id}/qa-1-report.md`, shots: [`${id}/qa-1-home.png`],
  steps: [{ do: 'Open Home.', expect: 'The card.', shot: `${id}/qa-1-step1-home.png` }], summary: 'Green.', branch: 'feature/card', remote: 'origin', pushedAt: ago(500),
})

beforeEach(() => {
  gitCalls.length = queued.length = 0
  holds = { [CONFIG.repo]: [SHA] }
  resetPipelineState()
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.rmSync(F.EVIDENCE_DIR, { recursive: true, force: true })
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
})

const get = p => fetch(base + p)
const post = (p, body = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// ═══ GET /api/pipeline ═══

test('GET /api/pipeline: the graph from the config, and each flow with its stage, newest first', async () => {
  put('open-one', { updatedAt: ago(1000) })
  put('shipped', { status: 'done', updatedAt: ago(2000), qa: passed('shipped') })
  const r = await get('/api/pipeline')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.deepEqual(j.graph, pipelineGraph(CONFIG))
  assert.ok(Date.parse(j.builtAt))
  assert.deepEqual(j.tickets.map(t => t.id), ['open-one', 'shipped'])
  const [open, shipped] = j.tickets
  assert.deepEqual(Object.keys(open).sort(), ['agent', 'archived', 'codeProducing', 'hasOutput', 'id', 'progress', 'qa', 'route', 'stage', 'status', 'tickets', 'title', 'updatedAt'])
  assert.deepEqual([open.title, open.agent, open.tickets, open.status, open.qa, open.archived, open.codeProducing], ['Flow open-one', 'Agent 3', ['ABC-102'], 'open', null, false, true])
  assert.equal(open.stage.path[0], 'request')
  assert.deepEqual([shipped.stage.node, shipped.stage.status], ['outcome', 'passed'])
  assert.equal(shipped.qa.status, 'passed')
  assert.deepEqual(shipped.qa.attempts, [])
})

test('GET /api/pipeline: done and dropped flows only from the last 14 days; the Trash never; archived flagged', async () => {
  put('old-done', { status: 'done', updatedAt: ago(15 * DAY) })
  put('new-done', { status: 'done', updatedAt: ago(DAY) })
  put('old-open', { status: 'blocked', updatedAt: ago(40 * DAY) })
  put('old-dropped', { status: 'dropped', updatedAt: ago(15 * DAY) })
  put('archived', { archivedAt: ago(DAY), updatedAt: ago(DAY) })
  put('gone')
  moveToTrash('gone')
  // writeFlow stamps updatedAt, so these are written raw above; listFlows keeps what the file says
  const ids = (await (await get('/api/pipeline')).json()).tickets.map(t => t.id).sort()
  assert.deepEqual(ids, ['archived', 'new-done', 'old-open'])
  const archived = (await (await get('/api/pipeline')).json()).tickets.find(t => t.id === 'archived')
  assert.equal(archived.archived, true)
})

test('route and progress: every page reads the one answer, on /api/pipeline, /api/qa and /api/flows alike', async () => {
  const graph = pipelineGraph(CONFIG)
  const own = graph.nodes.find(n => n.role === 'coordinator')
  const route = { type: 'build', steps: ['request', own.id, graph.nodes.find(n => n.role === 'qa').id, 'push', 'outcome'], at: ago(5000), by: 'Agent 3' }
  put('planned', { updatedAt: ago(1000), route, qa: passed('planned'), status: 'done' })
  put('legacy', { updatedAt: ago(2000) })
  const tickets = (await (await get('/api/pipeline')).json()).tickets
  const planned = tickets.find(t => t.id === 'planned')
  assert.deepEqual(planned.route, route)
  assert.deepEqual(planned.progress.map(s => s.state), ['done', 'done', 'done', 'done', 'done'])
  const legacy = tickets.find(t => t.id === 'legacy')
  assert.equal(legacy.route.inferred, true)
  assert.equal(legacy.route.type, 'build', 'the fixture has commits: a code change')
  assert.equal(legacy.progress.filter(s => s.state === 'current').length, 1)
  const qa = (await (await get('/api/qa')).json()).flows.find(f => f.id === 'planned')
  assert.deepEqual([qa.route, qa.progress], [planned.route, planned.progress])
  const flows = (await (await get('/api/flows')).json()).flows
  assert.deepEqual(flows.find(f => f.id === 'legacy').progress, legacy.progress)
  assert.deepEqual(flows.find(f => f.id === 'legacy').route, legacy.route)
  const one = await (await get('/api/flows/planned')).json()
  assert.deepEqual([one.route, one.progress], [planned.route, planned.progress])
  assert.equal(F.readFlow('legacy').route, undefined, 'an inferred route is never written to the file')
})

// ═══ GET /api/qa ═══

test('GET /api/qa: each flow QA recorded, with the report text, the evidence links and the commit link; no token anywhere', async () => {
  put('shipped', { status: 'done', updatedAt: ago(1000), qa: passed('shipped') })
  put('untested')
  fs.mkdirSync(path.join(F.EVIDENCE_DIR, 'shipped'), { recursive: true })
  fs.writeFileSync(path.join(F.EVIDENCE_DIR, 'shipped', 'qa-1-report.md'), '# QA\n\n1340 tests pass.')
  const r = await get('/api/qa')
  assert.equal(r.status, 200)
  const text = await r.text()
  assert.doesNotMatch(text, /ghp_|bob/)
  const j = JSON.parse(text)
  assert.equal(j.qa, QA)
  assert.deepEqual(j.remotes, { repo: 'https://github.com/acme/app', dashboard: 'https://github.com/yz/dashboard' })
  assert.deepEqual(j.flows.map(f => f.id), ['shipped'])
  const f = j.flows[0]
  assert.deepEqual(f.report, { ref: 'shipped/qa-1-report.md', url: '/evidence/shipped/qa-1-report.md', text: '# QA\n\n1340 tests pass.', truncated: false })
  assert.deepEqual(f.shots, [{ ref: 'shipped/qa-1-home.png', url: '/evidence/shipped/qa-1-home.png' }])
  assert.equal(f.qa.steps[0].url, '/evidence/shipped/qa-1-step1-home.png')
  assert.deepEqual(f.links, { repo: 'https://github.com/acme/app', commit: `https://github.com/acme/app/commit/${SHA}`, branch: 'https://github.com/acme/app/tree/feature/card' })
  assert.deepEqual([f.qa.commit, f.qa.branch], [SHA, 'feature/card'])
  assert.ok(Date.parse(f.qa.pushedAt))
})

test('GET /api/qa?status=passed lists only the passed ones; a missing report is null text, never an error', async () => {
  put('shipped', { status: 'done', qa: passed('shipped') })
  put('broken', { qa: { status: 'failed', attempt: 1, by: QA, at: ago(1), commit: SHA, report: 'broken/qa-1-report.md', rework: { to: 'Agent 3' } } })
  const all = (await (await get('/api/qa')).json()).flows.map(f => f.id).sort()
  assert.deepEqual(all, ['broken', 'shipped'])
  const j = await (await get('/api/qa?status=passed')).json()
  assert.deepEqual(j.flows.map(f => f.id), ['shipped'])
  assert.equal(j.flows[0].report.text, null)
})

// ═══ the commit link names the repo that HOLDS the tested commit (regression: QA attempt 2 of qa-pipeline) ═══

/** The links of flow `id` on /api/qa. */
const linksOf = async id => (await (await get('/api/qa')).json()).flows.find(f => f.id === id).links

test('the commit is in the watched repo: the commit and branch link to its remote, checked with cat-file -e', async () => {
  put('shipped', { status: 'done', qa: passed('shipped') })
  assert.deepEqual(await linksOf('shipped'), { repo: 'https://github.com/acme/app', commit: `https://github.com/acme/app/commit/${SHA}`, branch: 'https://github.com/acme/app/tree/feature/card' })
  assert.deepEqual(catFiles()[0], ['-C', CONFIG.repo, 'cat-file', '-e', `${SHA}^{commit}`])
})

test('the commit is only in the dashboard repo: the links name the dashboard remote, never the watched repo', async () => {
  holds = { [DASHBOARD]: [SHA] }
  put('shipped', { status: 'done', qa: passed('shipped') })
  assert.deepEqual(await linksOf('shipped'), { repo: 'https://github.com/yz/dashboard', commit: `https://github.com/yz/dashboard/commit/${SHA}`, branch: 'https://github.com/yz/dashboard/tree/feature/card' })
})

test('the commit is in neither repo: no commit link and no branch link', async () => {
  holds = {}
  put('shipped', { status: 'done', qa: passed('shipped') })
  assert.deepEqual(await linksOf('shipped'), { repo: null, commit: null, branch: null })
})

test('qa.repo is set (qa-push --repo): that repo is used, with no cat-file guess', async () => {
  holds = { [CONFIG.repo]: [SHA], [DASHBOARD]: [SHA] }
  put('shipped', { status: 'done', qa: { ...passed('shipped'), repo: OTHER } })
  assert.deepEqual(await linksOf('shipped'), { repo: 'https://github.com/acme/other', commit: `https://github.com/acme/other/commit/${SHA}`, branch: 'https://github.com/acme/other/tree/feature/card' })
  assert.equal(catFiles().length, 0)
})

test('the repo holding a commit is cached per sha: a second /api/qa runs no cat-file', async () => {
  holds = { [DASHBOARD]: [SHA] }
  put('shipped', { status: 'done', qa: passed('shipped') })
  await linksOf('shipped')
  const n = catFiles().length
  assert.equal(n, 2, 'the watched repo first, then the dashboard')
  await linksOf('shipped')
  assert.equal(catFiles().length, n)
})

test('webUrlOf: GitHub https and git@ addresses become the web page; anything else is null', () => {
  assert.equal(webUrlOf('https://github.com/acme/app.git'), 'https://github.com/acme/app')
  assert.equal(webUrlOf('git@github.com:acme/app.git'), 'https://github.com/acme/app')
  assert.equal(webUrlOf('https://x:tok@github.com/acme/app'), 'https://github.com/acme/app')
  assert.equal(webUrlOf('https://gitlab.com/acme/app.git'), null)
  assert.equal(webUrlOf('C:/repos/app'), null)
  assert.equal(webUrlOf(''), null)
})

// ═══ POST /api/flows/<id>/rework ═══

test('POST rework sends a failure back again after it was not delivered; 409 when there is nothing to send', async () => {
  put('broken', { qa: { status: 'failed', attempt: 1, by: QA, at: ago(1), commit: SHA, rework: { to: 'Agent 3', queuedAt: ago(1000), sentAt: null, error: 'not sent: the dashboard restarted' } } })
  const r = await post('/api/flows/broken/rework')
  assert.equal(r.status, 200)
  assert.equal((await r.json()).to, 'Agent 3')
  assert.deepEqual(queued, ['broken'])
  assert.equal(F.readFlow('broken').qa.rework.error, null)
  assert.equal((await post('/api/flows/broken/rework')).status, 409, 'on its way: not twice')
  put('fine')
  assert.equal((await post('/api/flows/fine/rework')).status, 409)
})

// ═══ the QA report on /evidence ═══

test('/evidence serves a QA report (.md) as plain text with nosniff; any other .md, and every .html, is refused', async () => {
  fs.mkdirSync(path.join(F.EVIDENCE_DIR, 'shipped'), { recursive: true })
  fs.writeFileSync(path.join(F.EVIDENCE_DIR, 'shipped', 'qa-1-report.md'), '<script>alert(1)</script>')
  fs.writeFileSync(path.join(F.EVIDENCE_DIR, 'shipped', 'qa-2-report-2.md'), 'again')
  fs.writeFileSync(path.join(F.EVIDENCE_DIR, 'shipped', 'notes.md'), 'x')
  fs.writeFileSync(path.join(F.EVIDENCE_DIR, 'shipped', 'qa-1-report.html'), '<b>x</b>')
  const r = await get('/evidence/shipped/qa-1-report.md')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(await r.text(), '<script>alert(1)</script>')
  assert.equal((await get('/evidence/shipped/qa-2-report-2.md')).status, 200)
  assert.equal((await get('/evidence/shipped/notes.md')).status, 404)
  assert.equal((await get('/evidence/shipped/qa-1-report.html')).status, 404)
})
