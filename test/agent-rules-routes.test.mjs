// Tests for agent-rules-routes.mjs: GET /api/agents/rules and PUT /api/agents/rules/<label>, as handlers (with
// their own config and file) and through factory-routes.mjs on a real http server on port 0. FACTORY_DATA_DIR
// points at a fresh temp folder BEFORE the imports, so the default rules file is a temp one.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rules-routes-test-'))
const { RULES_FILE, readLog, readRules } = await import('../agent-rules.mjs')
const { rulesGet, rulesPut } = await import('../agent-rules-routes.mjs')
const { factoryRoute } = await import('../factory-routes.mjs')
const { CONFIG } = await import('../config.mjs')
const { DEFAULT_PIPELINE, pipelineGraph } = await import('../pipeline.mjs')

const CFG = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' },
  pipeline: { ...DEFAULT_PIPELINE }, factory: { chat: { name: 'Independent' } },
}
const PORT = 4999
const OWN = { origin: `http://127.0.0.1:${PORT}` }
const AT = '2026-11-24T10:00:00.000Z'
let file
let logFile
const deps = () => ({ config: CFG, file, logFile, port: PORT, now: () => AT, newId: () => 'r1' })

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rules-routes-file-'))
  file = path.join(dir, 'agent-rules.json')
  logFile = path.join(dir, 'agent-rules-log.jsonl')
})

test('GET: every agent of the graph with an empty spec and no rules, and the limits', () => {
  const r = rulesGet(deps())
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body.agents), ['Master', 'Agent 1', 'Independent', 'QA'])
  assert.deepEqual(r.body.agents.QA, { spec: '', rules: [], updatedAt: null })
  assert.deepEqual(r.body.limits, { spec: 2000, rule: 300, rules: 30 })
  assert.deepEqual(r.body.changes.QA, [], 'no changes yet')
})

test('PUT saves what is given and GET shows it', () => {
  const r = rulesPut('Agent 1', { spec: 'Builds the web pages.', rules: ['Never touch the mobile app.'] }, OWN, deps())
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, {
    ok: true, label: 'Agent 1', agent: { spec: 'Builds the web pages.', rules: [{ id: 'r1', text: 'Never touch the mobile app.', addedAt: AT }], updatedAt: AT },
    changes: [{ at: AT, text: 'Agent 1 got 1 new rule and its specification was set.' }],
  })
  assert.equal(rulesGet(deps()).body.agents['Agent 1'].spec, 'Builds the web pages.')
  assert.equal(readRules(file).agents['Agent 1'].rules[0].text, 'Never touch the mobile app.')
})

test('PUT with only rules keeps the spec, and keeps the id of a rule whose text did not change', () => {
  rulesPut('QA', { spec: 'Tests.', rules: ['Keep me.'] }, OWN, { ...deps(), newId: () => 'old' })
  const r = rulesPut('QA', { rules: ['Keep me.', 'New one.'] }, OWN, { ...deps(), newId: () => 'new' })
  assert.equal(r.body.agent.spec, 'Tests.')
  assert.deepEqual(r.body.agent.rules.map(x => x.id), ['old', 'new'])
})

test('PUT refuses a label that is not an agent of the graph: 404, nothing written', () => {
  for (const label of ['Nobody', 'Request', 'Push', 'Output', 'outcome']) {
    const r = rulesPut(label, { spec: 'x' }, OWN, deps())
    assert.equal(r.status, 404, label)
    assert.match(r.body.error, /no agent called/)
  }
  assert.equal(fs.existsSync(file), false)
})

test('PUT: a limit problem is a 400 with one plain sentence, and nothing is written', () => {
  const r = rulesPut('Agent 1', { spec: 'x'.repeat(2001) }, OWN, deps())
  assert.equal(r.status, 400)
  assert.match(r.body.error, /too long/)
  assert.equal(rulesPut('Agent 1', { rules: Array(31).fill('x') }, OWN, deps()).status, 400)
  assert.equal(rulesPut('Agent 1', {}, OWN, deps()).status, 400)
  assert.equal(fs.existsSync(file), false)
})

test('PUT needs the page own Origin: another site, or none at all, is a 403 and nothing is written', () => {
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'http://127.0.0.1:1' }, {}]) {
    const r = rulesPut('Agent 1', { spec: 'x' }, headers, deps())
    assert.equal(r.status, 403)
  }
  assert.equal(fs.existsSync(file), false)
})

test('a label left out of the graph keeps its rules in the file, and GET does not show them', () => {
  rulesPut('Agent 1', { spec: 'Pages.' }, OWN, deps())
  const smaller = { ...CFG, codingAgents: { Master: 'Master' } }
  const g = rulesGet({ ...deps(), config: smaller })
  assert.equal(g.body.agents['Agent 1'], undefined)
  assert.equal(readRules(file).agents['Agent 1'].spec, 'Pages.')
})

// ═══ through factory-routes.mjs ═══

let server
let base
let port
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await factoryRoute(req, res, url, { port }))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  base = `http://127.0.0.1:${port}`
})
after(() => {
  server.close()
  fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true })
})

const label = () => pipelineGraph(CONFIG).nodes.find(n => n.role === 'qa').label

test('over http: GET, then a PUT with the page Origin to an encoded label, then GET again', async () => {
  const g = await (await fetch(`${base}/api/agents/rules`)).json()
  assert.ok(g.agents[label()])
  const put = await fetch(`${base}/api/agents/rules/${encodeURIComponent(label())}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ rules: ['Use Playwright.'] }),
  })
  assert.equal(put.status, 200)
  assert.equal((await put.json()).agent.rules[0].text, 'Use Playwright.')
  const again = await (await fetch(`${base}/api/agents/rules`)).json()
  assert.equal(again.agents[label()].rules[0].text, 'Use Playwright.')
  assert.ok(fs.existsSync(RULES_FILE), 'written to the data folder')
})

test('over http: a PUT from another origin is 403; an unknown or malformed label 404; bad JSON 400', async () => {
  const put = (path, headers, body = '{"spec":"x"}') => fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body })
  assert.equal((await put(`/api/agents/rules/${encodeURIComponent(label())}`, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await put('/api/agents/rules/Nobody', { origin: base })).status, 404)
  assert.equal((await put('/api/agents/rules/%E0%A4%A', { origin: base })).status, 404)
  assert.equal((await put(`/api/agents/rules/${encodeURIComponent(label())}`, { origin: base }, '{nope')).status, 400)
  assert.equal((await fetch(`${base}/api/agents/rules/x/y`)).status, 404)
})

// ═══ the change log ═══

test('each saved change is one log line; GET shows each agent last changes as sentences', () => {
  rulesPut('Agent 1', { spec: 'Pages.', rules: ['A', 'B'] }, OWN, deps())
  rulesPut('Agent 1', { rules: ['B'] }, OWN, { ...deps(), now: () => '2026-11-24T11:00:00.000Z' })
  assert.deepEqual(readLog(logFile), [
    { at: AT, label: 'Agent 1', spec: 'set', added: ['A', 'B'], removed: [] },
    { at: '2026-11-24T11:00:00.000Z', label: 'Agent 1', spec: null, added: [], removed: ['A'] },
  ])
  const g = rulesGet(deps()).body
  assert.deepEqual(g.changes['Agent 1'], [
    { at: '2026-11-24T11:00:00.000Z', text: '1 rule was removed from Agent 1.' },
    { at: AT, text: 'Agent 1 got 2 new rules and its specification was set.' },
  ])
  assert.deepEqual(g.changes.Master, [])
})

test('a save that changes nothing writes no log line', () => {
  rulesPut('QA', { spec: 'Tests.', rules: ['A'] }, OWN, deps())
  const r = rulesPut('QA', { spec: '  Tests.  ', rules: ['A'] }, OWN, deps())
  assert.equal(r.status, 200)
  assert.equal(readLog(logFile).length, 1)
})

test('the log line is written only after the store was: a store that cannot be written logs nothing', () => {
  file = path.dirname(logFile) // a folder: the store write fails
  assert.throws(() => rulesPut('QA', { spec: 'Tests.' }, OWN, deps()))
  assert.deepEqual(readLog(logFile), [])
})

test('GET shows at most the last ten changes of an agent', () => {
  for (let i = 0; i < 12; i++) rulesPut('QA', { rules: [`rule ${i}`] }, OWN, { ...deps(), now: () => `2026-11-24T10:${String(i).padStart(2, '0')}:00.000Z` })
  const c = rulesGet(deps()).body.changes.QA
  assert.equal(c.length, 10)
  assert.equal(c[0].at, '2026-11-24T10:11:00.000Z')
})
