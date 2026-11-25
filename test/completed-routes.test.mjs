// Tests for Completed's routes (completed-routes.mjs, mounted by factory-routes.mjs): POST /api/flows/<id>/complete
// needs the page's own Origin, present; only a finished flow; idempotent; 404 an unknown flow. It archives in the same
// write and moves nothing else (status, story, updatedAt), so the scorecard and Pipeline time count it as before.
// A completed flow leaves every board (Flows, Agents, Human review, Home, the pulse, the Tickets page chips) and stays
// in the flow archive with its completedAt; Unarchive refuses it (Uncomplete is the way). GET /api/outputs is the
// summary every reminder reads. A real http server on port 0 calls factoryRoute; FACTORY_DATA_DIR points at a fresh
// temp folder BEFORE the imports, so no test touches the real data folder.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-routes-test-'))
const F = await import('../flows.mjs')
const { factoryRoute } = await import('../factory-routes.mjs')
const { CONFIG } = await import('../config.mjs')
const { scoreGet } = await import('../score-routes.mjs')
const { timeGet } = await import('../time-routes.mjs')
const { pipelineGet } = await import('../pipeline-routes.mjs')
const { humanGet } = await import('../human-routes.mjs')
const { pulse } = await import('../orchestration.mjs')

let server
let base
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await factoryRoute(req, res, url, { git: async () => ({ ok: false, out: '', err: '' }), relay: { drop() {}, queue() {} } }))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
})
beforeEach(() => {
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
})

const DAY = 86_400_000
const OWN = { origin: `http://127.0.0.1:${CONFIG.port}` }
const post = (p, body = {}, headers = OWN) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const get = p => fetch(base + p)
const file = id => path.join(F.FLOWS_DIR, `${id}.json`)
const raw = id => fs.readFileSync(file(id), 'utf8')
const UPDATED = new Date(Date.now() - 3 * DAY).toISOString()
const talk = [{ id: 'n1', type: 'step', title: 'Look into it', status: 'done', evidence: [{ kind: 'note', ref: 'Fine.' }], verified: null }]
/** A flow written raw, so its times stay exactly as given. */
function put(id, status = 'done', more = {}) {
  const flow = { id, title: `Flow ${id}`, agent: 'Agent 1', tickets: ['FLA-1'], status, why: '', createdAt: new Date(Date.now() - 4 * DAY).toISOString(), updatedAt: UPDATED, nodes: talk, output: { summary: 'Done.', story: [{ id: 's1', who: 'Agent 1', did: 'Looked into it.' }] }, ...more }
  fs.writeFileSync(file(id), JSON.stringify(flow, null, 1))
}

// ═══ who may complete ═══

test('complete needs the page Origin PRESENT and the page own: none or another site is refused, nothing written', async () => {
  put('ship')
  const before = raw('ship')
  const none = await post('/api/flows/ship/complete', {}, {})
  assert.equal(none.status, 403)
  assert.equal((await none.json()).error, 'The user does this, only from the dashboard page.')
  assert.equal((await post('/api/flows/ship/complete', {}, { origin: 'http://evil.example' })).status, 403)
  assert.equal((await post('/api/flows/ship/complete', {}, { origin: 'http://localhost:1' })).status, 403)
  assert.equal(raw('ship'), before)
})

test('complete: completedAt, completedBy you and archivedAt in one write; status, story and updatedAt untouched', async () => {
  put('ship')
  const r = await post('/api/flows/ship/complete')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.ok, true)
  const f = F.readFlow('ship')
  assert.equal(j.completedAt, f.completedAt)
  assert.ok(Math.abs(Date.parse(f.completedAt) - Date.now()) < 60_000)
  assert.equal(f.completedBy, 'you')
  assert.equal(f.archivedAt, f.completedAt)
  assert.equal(f.status, 'done')
  assert.equal(f.updatedAt, UPDATED, 'the scorecard dates it by updatedAt: kept')
  assert.equal(f.output.story.length, 1, 'no new story line')
})

test('complete is idempotent: a second press answers the same and writes nothing', async () => {
  put('ship')
  const first = await (await post('/api/flows/ship/complete')).json()
  const before = raw('ship')
  const again = await post('/api/flows/ship/complete', { completed: true })
  assert.equal(again.status, 200)
  assert.equal((await again.json()).completedAt, first.completedAt)
  assert.equal(raw('ship'), before)
})

test('only a finished flow can be completed: one plain sentence, nothing written', async () => {
  for (const [status, why] of [['open', 'it is still on its way'], ['blocked', 'it is blocked'], ['dropped', 'it was dropped']]) {
    put(`f-${status}`, status)
    const before = raw(`f-${status}`)
    const r = await post(`/api/flows/f-${status}/complete`)
    assert.equal(r.status, 400)
    assert.equal((await r.json()).error, `Only a finished flow can be marked completed: ${why}.`)
    assert.equal(raw(`f-${status}`), before)
  }
})

test('complete: 404 an unknown flow, 400 a bad id or a completed that is not true or false', async () => {
  const r = await post('/api/flows/nope/complete')
  assert.equal(r.status, 404)
  assert.equal((await r.json()).error, 'No flow nope.')
  assert.equal((await post('/api/flows/Bad_Id/complete')).status, 400)
  put('ship')
  const bad = await post('/api/flows/ship/complete', { completed: 'yes' })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'completed must be true or false')
})

test('uncomplete clears completed and archived and notes when; again changes nothing', async () => {
  put('ship')
  await post('/api/flows/ship/complete')
  const r = await post('/api/flows/ship/complete', { completed: false })
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.deepEqual([j.ok, j.completedAt, j.archivedAt], [true, null, null])
  const f = F.readFlow('ship')
  for (const k of ['completedAt', 'completedBy', 'archivedAt']) assert.equal(k in f, false)
  assert.ok(f.uncompletedAt)
  assert.equal(f.updatedAt, UPDATED)
  const before = raw('ship')
  assert.equal((await post('/api/flows/ship/complete', { completed: false })).status, 200)
  assert.equal(raw('ship'), before)
})

test('Unarchive refuses a completed flow (Uncomplete is the way); an archived one still unarchives', async () => {
  put('ship')
  await post('/api/flows/ship/complete')
  const r = await post('/api/flows/ship/archive', { archived: false })
  assert.equal(r.status, 409)
  assert.equal((await r.json()).error, 'This flow is completed. Take the mark off with Uncomplete in the flow archive.')
  assert.ok(F.readFlow('ship').archivedAt)
  put('away', 'done', { archivedAt: UPDATED })
  assert.equal((await post('/api/flows/away/archive', { archived: false })).status, 200)
})

// ═══ purged from every board, kept in the archive ═══

test('a completed flow leaves the Flows board, Agents, Human review, the pulse and the Tickets chips; the archive lists it', async () => {
  put('ship', 'done', { nodes: [...talk, { id: 'q1', type: 'ask', title: 'Happy?', kind: 'yesno', yes: '', no: '', answer: null, after: ['n1'] }] })
  put('kept')
  put('pushed', 'open', {
    route: { type: 'build', steps: ['request', 'coordinator', 'qa', 'push', 'outcome'], at: UPDATED, by: 'Agent 1' },
    nodes: [{ id: 'n1', type: 'step', title: 'Code', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }], verified: null }],
    qa: { status: 'passed', attempt: 1, by: CONFIG.pipeline.qa, startedAt: UPDATED, at: UPDATED, pushedAt: UPDATED, commit: 'abc1234', ...(CONFIG.pipeline.security ? { security: { status: 'passed', attempt: 1, by: CONFIG.pipeline.security, startedAt: UPDATED, at: UPDATED, commit: 'abc1234' } } : {}) },
  })
  assert.equal((await post('/api/flows/ship/complete')).status, 200)
  const pr = await post('/api/flows/pushed/complete')
  assert.equal(pr.status, 200, JSON.stringify(await pr.json()))
  const flows = await (await get('/api/flows')).json()
  assert.deepEqual(flows.flows.map(f => f.id), ['kept'])
  assert.equal(flows.counts.archived, 2)
  const pipe = pipelineGet().body.tickets
  assert.deepEqual(pipe.filter(t => t.completed).map(t => t.id).sort(), ['pushed', 'ship'], 'flagged, so the diagram leaves them out')
  assert.equal(pipe.find(t => t.id === 'kept').completed, false)
  assert.equal(pipe.find(t => t.id === 'kept').waiting, true)
  assert.equal(pipe.find(t => t.id === 'ship').waiting, false)
  assert.deepEqual(humanGet().body.items.map(i => i.flowId), [], 'its open ask no longer waits on you')
  assert.deepEqual((await pulse({ getStatus: async () => ({}), chatStatus: () => ({}) })).flows.map(f => f.id), ['kept'])
  assert.deepEqual(F.listFlows({ open: true }).flows.map(f => f.id), [], 'the Tickets page chips read the open flows')
  const arch = await (await get('/api/archive')).json()
  const row = arch.archived.find(r => r.id === 'ship')
  assert.ok(row.completedAt)
  assert.equal(row.archivedAt, row.completedAt)
  assert.equal(arch.archived.find(r => r.id === 'pushed').status, 'open')
  const one = await (await get('/api/flows/ship')).json()
  assert.equal(one.completedBy, 'you', 'it still opens by link, read-only')
})

test('a flow waiting for sign-off is on /api/pipeline however old; a completed one past 14 days is not', async () => {
  put('old', 'done', { updatedAt: new Date(Date.now() - 30 * DAY).toISOString() })
  put('done-old', 'done', { updatedAt: new Date(Date.now() - 30 * DAY).toISOString(), completedAt: UPDATED, completedBy: 'you', archivedAt: UPDATED })
  const ids = pipelineGet().body.tickets.map(t => t.id)
  assert.deepEqual(ids, ['old'])
})

// ═══ the score and the time are unchanged by completing ═══

test('the scorecard and Pipeline time are exactly the same before and after completing (and uncompleting)', async () => {
  put('a', 'done', { updatedAt: new Date(Date.now() - DAY).toISOString() })
  put('b', 'done', { updatedAt: new Date(Date.now() - 2 * DAY).toISOString() })
  put('c', 'open')
  const now = Date.now()
  const snap = () => ['7', '30', 'all'].map(w => {
    const { builtAt: _s, ...score } = scoreGet(w, { now }).body
    const { builtAt: _t, ...time } = timeGet(w, { now }).body
    return { score, time }
  })
  const before = snap()
  assert.equal(before[0].score.counts.delivered, 2)
  await post('/api/flows/a/complete')
  await post('/api/flows/b/complete')
  assert.deepEqual(snap(), before)
  await post('/api/flows/a/complete', { completed: false })
  assert.deepEqual(snap(), before)
})

// ═══ GET /api/outputs ═══

test('GET /api/outputs: what waits, overdue after 2 days, piled at outputs.max', async () => {
  put('new', 'done', { updatedAt: new Date(Date.now() - 60_000).toISOString() })
  put('old', 'done')
  put('busy', 'open')
  put('gone', 'done', { completedAt: UPDATED, completedBy: 'you', archivedAt: UPDATED })
  const j = await (await get('/api/outputs')).json()
  assert.deepEqual(j.waiting.map(w => [w.id, w.overdue]), [['old', true], ['new', false]])
  assert.deepEqual(j.counts, { waiting: 2, overdue: 1 })
  assert.equal(j.max, CONFIG.outputs.max)
  assert.equal(j.warnAfterDays, CONFIG.outputs.warnAfterDays)
  assert.equal(j.piled, false)
  assert.ok(j.builtAt)
  for (let i = 0; i < 5; i++) put(`more-${i}`)
  assert.equal((await (await get('/api/outputs')).json()).piled, true, '7 waiting')
})
