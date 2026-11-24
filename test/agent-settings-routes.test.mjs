// Tests for the agent settings routes (agent-settings-routes.mjs): GET /api/agents/settings, PUT
// /api/agents/settings/<label>, POST /api/agents/files/<label>, PUT and DELETE /api/agents/files/<label>/<id>. A
// real http server on port 0 with a temp store, log and config: the real data/ folder and config.json are never used.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-settings-routes-test-'))
const { makeAgentSettingsRoute } = await import('../agent-settings-routes.mjs')
const S = await import('../agent-settings.mjs')
const TMP = process.env.FACTORY_DATA_DIR
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const FILE = path.join(TMP, 'agent-settings.json')
const LOG = path.join(TMP, 'agent-settings-log.jsonl')
const CONFIG = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', Planner: 'Planner', Security: 'Security' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 3, planner: 'Planner', security: 'Security' },
  factory: { chat: { name: 'Independent', model: 'claude-opus-5-5' } },
}

let server
let base
let origin
before(async () => {
  let route
  server = createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, 'http://localhost')))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  route = makeAgentSettingsRoute({ port, config: CONFIG, file: FILE, logFile: LOG })
  base = `http://127.0.0.1:${port}`
  origin = { origin: base }
})
after(() => server.close())
beforeEach(() => {
  fs.rmSync(FILE, { force: true })
  fs.rmSync(LOG, { force: true })
})

const call = async (method, p, body, headers = origin) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
const A1 = '/api/agents/settings/Agent%201'
const F1 = '/api/agents/files/Agent%201'

test('GET: every agent of the graph with its role, the fixed pair for the planner and Security, the models, the limits', async () => {
  const { status, body } = await call('GET', '/api/agents/settings', undefined, {})
  assert.equal(status, 200)
  assert.deepEqual(Object.keys(body.agents), ['Master', 'Planner', 'Agent 1', 'Independent', 'QA', 'Security'])
  assert.deepEqual(body.agents['Agent 1'], { role: 'producer', model: null, effort: null, fixed: false, files: [], chars: 0, updatedAt: null })
  assert.deepEqual({ model: body.agents.Security.model, effort: body.agents.Security.effort, fixed: body.agents.Security.fixed }, { model: 'claude-opus-5-5', effort: 'high', fixed: true })
  assert.equal(body.agents.Planner.fixed, true)
  assert.deepEqual(body.models.map(m => m.id), S.MODELS.map(m => m.id))
  assert.deepEqual(body.limits, S.FILE_LIMITS)
  assert.deepEqual(body.chat, { model: 'claude-opus-5-5' })
  assert.deepEqual(body.changes['Agent 1'], [])
})

test('every write needs the page Origin: none, or another site, is a 403 and nothing is written', async () => {
  for (const headers of [{}, { origin: 'https://evil.example' }]) {
    assert.equal((await call('PUT', A1, { model: 'claude-opus-5-5' }, headers)).status, 403)
    assert.equal((await call('POST', F1, { title: 'T', text: 'x', kind: 'note' }, headers)).status, 403)
  }
  assert.equal(fs.existsSync(FILE), false)
})

test('PUT a model and effort: saved, answered, and logged as one sentence; the planner, Security and chat refuse', async () => {
  const r = await call('PUT', A1, { model: 'claude-sonnet-5-5', effort: 'medium' })
  assert.equal(r.status, 200)
  assert.deepEqual({ model: r.body.agent.model, effort: r.body.agent.effort }, { model: 'claude-sonnet-5-5', effort: 'medium' })
  assert.deepEqual(r.body.changes.map(c => c.text), ['Agent 1 is to run on Sonnet 5.5 at medium effort.'])
  assert.equal(S.readAgentSettings(FILE).agents['Agent 1'].model, 'claude-sonnet-5-5')
  const same = await call('PUT', A1, { model: 'claude-sonnet-5-5' })
  assert.equal(same.body.changes.length, 1, 'no change, no new line')
  for (const label of ['Planner', 'Security']) {
    const x = await call('PUT', `/api/agents/settings/${label}`, { model: 'claude-haiku-5-5' })
    assert.equal(x.status, 400)
    assert.match(x.body.error, /always runs on Opus at high effort/)
  }
  assert.match((await call('PUT', '/api/agents/settings/Independent', { model: 'claude-haiku-5-5' })).body.error, /factory\.chat\.model/)
  assert.equal((await call('PUT', A1, { model: 'gpt' })).body.error, 'Pick one of the listed models.')
  assert.equal((await call('PUT', '/api/agents/settings/Nobody', { model: 'claude-opus-5-5' })).status, 404)
})

test('files and notes: add, switch off, remove; each answered with the list and logged', async () => {
  const added = await call('POST', F1, { title: 'Spec', text: 'Build the page.', kind: 'file', name: 'spec.md' })
  assert.equal(added.status, 201)
  const id = added.body.file.id
  assert.deepEqual(added.body.agent.files, [{ id, title: 'Spec', kind: 'file', name: 'spec.md', chars: 15, on: true, addedAt: added.body.file.addedAt }])
  assert.equal(added.body.agent.chars, 15)
  assert.equal(added.body.file.text, undefined, 'the text is not sent back')
  const off = await call('PUT', `${F1}/${id}`, { on: false })
  assert.equal(off.body.agent.files[0].on, false)
  assert.equal((await call('PUT', `${F1}/${id}`, { on: 'no' })).body.error, 'Say whether it is on or off.')
  const gone = await call('DELETE', `${F1}/${id}`)
  assert.deepEqual(gone.body.agent.files, [])
  assert.deepEqual(gone.body.changes.map(c => c.text), ['The file Spec was removed from Agent 1.', 'The file Spec of Agent 1 was switched off.', 'Agent 1 was given the file Spec.'])
  assert.equal((await call('DELETE', `${F1}/${id}`)).status, 404)
  assert.equal((await call('DELETE', `${F1}/..%2F..`)).status, 404)
})

test('a file that is not text, too long, or one too many is refused with its sentence, and nothing is saved', async () => {
  assert.match((await call('POST', F1, { title: 'Bin', text: 'PK\u0000\u0003', kind: 'file', name: 'x.zip' })).body.error, /not text/)
  assert.match((await call('POST', F1, { title: 'Big', text: 'x'.repeat(20001), kind: 'note' })).body.error, /20,000 characters/)
  assert.equal(fs.existsSync(FILE), false)
  const big = await fetch(`${base}${F1}`, { method: 'POST', headers: { 'content-type': 'application/json', ...origin }, body: JSON.stringify({ title: 'x', text: 'x'.repeat(300_000), kind: 'note' }) })
  assert.equal(big.status, 413)
})

test('GET is the only read; other methods on the list are a 405', async () => {
  assert.equal((await call('POST', '/api/agents/settings', {})).status, 405)
  assert.equal((await call('GET', F1)).status, 405)
})
