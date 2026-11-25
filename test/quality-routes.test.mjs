// Tests for the quality routes (quality-routes.mjs), over a real HTTP server on a free port: every POST needs the
// page's own Origin; the Lessons page's data (lessons, candidates, failures waiting, areas, settings); typing a
// lesson, Accept (with an edit), Reject, Retire, Restore; Extract lessons and Second opinion run ONE at a time (409
// while one runs) through STUB runners, so no model is ever run; the flow page's panel data (risk, the gates the label
// asks for that the pipeline lacks, self-check, critic). FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-routes-test-'))
const F = await import('../flows.mjs')
const L = await import('../quality-lessons.mjs')
const { makeQualityRoute } = await import('../quality-routes.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const CONFIG = {
  repo: 'C:/watched/repo', coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2, security: 'Security' },
}
let config = CONFIG

/** Stub runners: each call recorded; `hold` keeps a run going until released. */
const extracted = []
const criticised = []
let hold = null
const extractor = {
  busy: () => !!hold,
  async extract(f) {
    extracted.push(f.key)
    if (hold) return { error: 'Lessons are already being extracted.', busy: true }
    return { ok: true, candidates: 1, cost: 0.003 }
  },
}
const critic = {
  busy: () => false,
  async run(id) {
    criticised.push(id)
    if (id === 'busy') return { error: 'A second opinion is already being written.', busy: true }
    if (id === 'off') return { error: 'The second opinion is switched off (config.json quality.critic is off).' }
    return { ok: true, critic: { at: '2026-11-25T10:00:00.000Z', verdict: 'ok', points: [], cost: 0.01 } }
  },
}

let server
let base
let port
before(async () => {
  let route
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await route(req, res, url))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  base = `http://127.0.0.1:${port}`
  route = makeQualityRoute({ port, extractor, critic, config: () => config })
})
after(() => server.close())

const origin = () => ({ origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' })
const get = async p => {
  const r = await fetch(base + p)
  return { status: r.status, body: await r.json() }
}
const post = async (p, body = {}, headers = origin()) => {
  const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}

beforeEach(() => {
  config = CONFIG
  extracted.length = 0
  criticised.length = 0
  hold = null
  fs.rmSync(L.LESSONS_FILE, { force: true })
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
})

function failedFlow() {
  F.writeFlow({
    id: 'login', title: 'Add the login page', agent: 'Agent 1', status: 'open', nodes: [],
    qa: { status: 'failed', attempt: 1, by: 'QA', at: new Date().toISOString(), summary: 'No test for the empty password.', rework: { to: 'Agent 1', queuedAt: null, sentAt: null, error: null } },
  })
}

test('every POST needs the page own Origin: none or another site is 403, and nothing changes', async () => {
  for (const headers of [{ 'content-type': 'application/json' }, { origin: 'http://evil.example', 'content-type': 'application/json' }]) {
    const r = await post('/api/lessons', { text: 'Stop the server.', area: 'infra' }, headers)
    assert.equal(r.status, 403)
  }
  assert.equal(L.readLessons().lessons.length, 0)
  assert.equal((await post('/api/quality/critic/login', {}, { 'content-type': 'application/json' })).status, 403)
  assert.equal(criticised.length, 0)
})

test('GET /api/lessons: lessons, candidates, the failures waiting, the areas and the settings', async () => {
  failedFlow()
  const r = await get('/api/lessons')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.lessons, [])
  assert.deepEqual(r.body.candidates, [])
  assert.deepEqual(r.body.failures.map(f => f.key), ['login:qa:1'])
  assert.equal(r.body.failures[0].title, 'Add the login page')
  assert.equal(r.body.failures[0].summary, 'No test for the empty password.')
  assert.ok(r.body.areas.includes('tests'))
  assert.deepEqual(r.body.settings, { autoLessons: true, critic: 'manual' })
  assert.equal(r.body.busy, false)
  assert.equal(r.body.limits.text, 160)
})

test('POST /api/lessons: the user types a lesson; a bad one is a 400 with one plain sentence', async () => {
  const ok = await post('/api/lessons', { text: 'Stop the preview server you started.', area: 'infra' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.lesson.by, 'you')
  assert.equal(L.readLessons().lessons.length, 1)
  const bad = await post('/api/lessons', { text: 'x'.repeat(170), area: 'infra' })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /160 characters/)
  assert.equal((await post('/api/lessons', { text: 'Stop the preview server you started.', area: 'infra' })).status, 400)
})

test('Retire and Restore; an unknown lesson is a 404', async () => {
  const { body } = await post('/api/lessons', { text: 'Stop the preview server you started.', area: 'infra' })
  const id = body.lesson.id
  assert.equal((await post(`/api/lessons/${id}/retire`)).status, 200)
  assert.equal(L.readLessons().lessons[0].status, 'retired')
  assert.equal((await post(`/api/lessons/${id}/restore`)).status, 200)
  assert.equal(L.readLessons().lessons[0].status, 'active')
  assert.equal((await post('/api/lessons/L99/retire')).status, 404)
})

test('Accept (with an edit) and Reject a candidate', async () => {
  const s = L.readLessons()
  const [a, b] = L.addCandidates(s, { key: 'login:qa:1', flow: 'login', at: '2026-11-25T09:00:00.000Z', gate: 'qa' }, [{ kind: 'new', text: 'Test it.', area: 'tests' }, { kind: 'new', text: 'Look at it.', area: 'ui' }])
  L.writeLessons(s)
  const acc = await post(`/api/lessons/candidates/${a.id}/accept`, { text: 'Test the empty password before the happy path.' })
  assert.equal(acc.status, 200)
  assert.equal(acc.body.lesson.text, 'Test the empty password before the happy path.')
  assert.equal((await post(`/api/lessons/candidates/${b.id}/reject`)).status, 200)
  const after1 = L.readLessons()
  assert.equal(after1.lessons.length, 1)
  assert.equal(after1.candidates.length, 0)
  assert.equal((await post(`/api/lessons/candidates/${b.id}/reject`)).status, 404)
  const bad = L.readLessons()
  const [c] = L.addCandidates(bad, { key: 'k', flow: 'login', at: '2026-11-25T09:00:00.000Z', gate: 'qa' }, [{ kind: 'new', text: 'Check it.', area: 'tests' }])
  L.writeLessons(bad)
  assert.equal((await post(`/api/lessons/candidates/${c.id}/accept`, { area: 'cooking' })).status, 400)
})

test('POST /api/lessons/extract runs one failure through the extractor; unknown is 404; busy is 409', async () => {
  failedFlow()
  const r = await post('/api/lessons/extract', { key: 'login:qa:1' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, candidates: 1, cost: 0.003 })
  assert.deepEqual(extracted, ['login:qa:1'])
  assert.equal((await post('/api/lessons/extract', { key: 'nope:qa:1' })).status, 404)
  assert.equal((await post('/api/lessons/extract', {})).status, 400)
  hold = true
  const busy = await post('/api/lessons/extract', { key: 'login:qa:1' })
  assert.equal(busy.status, 409)
})

test('POST /api/quality/critic/<flow>: the second opinion runs through the critic; busy 409, off 400', async () => {
  const r = await post('/api/quality/critic/login')
  assert.equal(r.status, 200)
  assert.equal(r.body.critic.verdict, 'ok')
  assert.equal((await post('/api/quality/critic/busy')).status, 409)
  const off = await post('/api/quality/critic/off')
  assert.equal(off.status, 400)
  assert.match(off.body.error, /switched off/)
  assert.equal((await post('/api/quality/critic/Bad%20Id')).status, 400)
})

test('GET /api/quality/flow/<id>: the risk, the gates it asks for that are missing, the self-check and critic', async () => {
  F.writeFlow({ id: 'db', title: 'Add a migration for clubs', agent: 'Agent 1', status: 'open', nodes: [], risk: { level: 'high', reasons: ['It changes the database schema or a migration.'], needs: ['senior', 'deep-qa'] } })
  const r = await get('/api/quality/flow/db')
  assert.equal(r.status, 200)
  assert.equal(r.body.risk.level, 'high')
  assert.deepEqual(r.body.missing, ['Senior'])
  assert.match(r.body.missingLine, /asks for a Senior review, but there is no Senior agent on the pipeline/)
  assert.equal(r.body.selfcheck, null)
  assert.equal(r.body.critic, null)
  assert.equal(r.body.criticMode, 'manual')
  assert.equal((await get('/api/quality/flow/none')).status, 404)
})

test('GET /api/quality/flow/<id>: a gate the pipeline has but this route never passes says who checks it instead', async () => {
  config = { ...CONFIG, pipeline: { ...CONFIG.pipeline, senior: 'Senior' } }
  const at = new Date().toISOString()
  F.writeFlow({ id: 'tf', title: 'Change the terraform module', agent: 'Agent 1', status: 'open', nodes: [], route: { type: 'build', steps: ['request', 'master', 'agent-1', 'qa', 'security', 'push', 'outcome'], at, by: 'Agent 1' }, risk: { level: 'high', reasons: ['It touches infrastructure or CI.'], needs: ['security', 'senior'] } })
  const r = await get('/api/quality/flow/tf')
  assert.deepEqual(r.body.missing, [])
  assert.equal(r.body.missingLine, 'This risk would ask for Senior, but Senior only reviews work with no code, so QA and Security check this change.')
})
