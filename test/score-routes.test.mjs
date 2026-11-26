// Tests for GET /api/score (score-routes.mjs, mounted by factory-routes.mjs beside the pipeline routes): the
// scorecard of score.mjs over the flow files, for 7 days, 30 days (the default) or all time, a plain 400 for any
// other window, and the Trash never counted. A real http server on port 0 calls factoryRoute; FACTORY_DATA_DIR
// points at a fresh temp folder BEFORE the imports.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'score-routes-test-'))
const F = await import('../flows.mjs')
const { factoryRoute } = await import('../factory-routes.mjs')
const { CONFIG } = await import('../config.mjs')
const { pipelineGraph } = await import('../pipeline.mjs')
const { moveToTrash } = await import('../trash.mjs')

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const QA = CONFIG.pipeline.qa
// these tests read the live config.json: with pipeline.security set there, a QA pass is delivered only with a
// Security pass too (score.mjs), so the passed fixtures carry one (ignored without Security), and the log shows it
const SECURITY = CONFIG.pipeline.security && pipelineGraph(CONFIG).nodes.some(n => n.role === 'security')
const reviewed = at => ({ security: { status: 'passed', by: 'Security', at } })
const DAY = 86_400_000
const ago = ms => new Date(Date.now() - ms).toISOString()

let server
let base
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await factoryRoute(req, res, url, { git: async () => ({ ok: false, out: '', err: '' }), relay: {} }))) res.writeHead(404).end('not found')
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

/** Write flow `id` from the fixture (Agent 3's code change), with `more` on top; raw, so updatedAt stays as given. */
function put(id, more = {}) {
  fs.writeFileSync(path.join(F.FLOWS_DIR, `${id}.json`), JSON.stringify({ ...structuredClone(FIXTURE), id, title: `Flow ${id}`, ...more }))
}
const get = p => fetch(base + p)

test('GET /api/score: the scorecard over the flow files for the last 30 days by default, with builtAt', async () => {
  put('passed', { status: 'done', updatedAt: ago(1000), qa: { status: 'passed', attempt: 1, by: QA, at: ago(1000), ...reviewed(ago(900)) } })
  put('slipped', { status: 'done', updatedAt: ago(2 * DAY) })
  put('dropped', { status: 'dropped', updatedAt: ago(20 * DAY) })
  put('old', { status: 'dropped', updatedAt: ago(40 * DAY) })
  put('working', { updatedAt: ago(1000) })
  const r = await get('/api/score')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.window.days, 30)
  assert.ok(Date.parse(j.builtAt))
  assert.deepEqual(j.counts, { delivered: 1, slipped: 1, missed: 1, caught: 0 })
  assert.deepEqual(j.lists.slipped, [{ id: 'slipped', title: 'Flow slipped' }])
  assert.deepEqual(j.lists.missed, [{ id: 'dropped', title: 'Flow dropped', why: 'dropped' }])
  assert.equal(j.inFlight, 1)
  assert.deepEqual(j.precision, { value: 0.5, top: 1, bottom: 2 })
  assert.deepEqual(Object.keys(j).sort(), ['accuracy', 'agents', 'builtAt', 'correctness', 'counts', 'f', 'gates', 'inFlight', 'lists', 'precision', 'recall', 'selfCheck', 'window'])
})

test('GET /api/score?days=7 and days=all set the window', async () => {
  put('dropped', { status: 'dropped', updatedAt: ago(20 * DAY) })
  put('ancient', { status: 'dropped', updatedAt: ago(400 * DAY) })
  assert.equal((await (await get('/api/score?days=7')).json()).counts.missed, 0)
  const all = await (await get('/api/score?days=all')).json()
  assert.equal(all.counts.missed, 2)
  assert.deepEqual(all.window, { days: null, from: null, stallDays: 7 })
})

test('GET /api/score with any other window is a 400 with a plain sentence', async () => {
  for (const q of ['days=14', 'days=0', 'days=-7', 'days=7.0', 'days=ALL', 'days=30%20']) {
    const r = await get(`/api/score?${q}`)
    assert.equal(r.status, 400, q)
    const { error } = await r.json()
    assert.match(error, /^The window must be 7, 30 or all days\.$/, q)
  }
})

test('GET /api/score: archived flows count, the Trash never does', async () => {
  put('archived', { status: 'dropped', updatedAt: ago(DAY), archivedAt: ago(DAY) })
  put('gone', { status: 'dropped', updatedAt: ago(DAY) })
  moveToTrash('gone')
  const j = await (await get('/api/score')).json()
  assert.deepEqual(j.lists.missed.map(m => m.id), ['archived'])
})

test('POST /api/score is not a route', async () => {
  const r = await fetch(`${base}/api/score`, { method: 'POST' })
  assert.equal(r.status, 404)
})

// ═══ GET /api/log ═══

test('GET /api/log: the timeline for the last 30 days by default, newest first, with total, window and builtAt', async () => {
  put('dropped', { status: 'dropped', createdAt: ago(3 * DAY), updatedAt: ago(DAY) })
  put('passed', { status: 'done', createdAt: ago(40 * DAY), updatedAt: ago(1000), qa: { status: 'passed', attempt: 1, by: QA, startedAt: ago(5000), at: ago(4000), ...reviewed(ago(3000)) } })
  const r = await get('/api/log')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.deepEqual(Object.keys(j).sort(), ['builtAt', 'events', 'total', 'window'])
  assert.equal(j.window.days, 30)
  assert.ok(Date.parse(j.builtAt))
  assert.deepEqual(j.events.map(e => [e.kind, e.flow.id, e.cell]), [
    ...(SECURITY ? [['security', 'passed', 'delivered'], ['passed', 'passed', null]] : [['passed', 'passed', 'delivered']]),
    ['handed', 'passed', null], ['dropped', 'dropped', 'missed'], ['started', 'dropped', null],
  ], 'the passed flow started 40 days ago, outside the window')
  assert.equal(j.total, SECURITY ? 5 : 4)
})

test('GET /api/log?cell= keeps one cell, ?kind=rule one kind; the counts match /api/score', async () => {
  put('dropped', { status: 'dropped', updatedAt: ago(DAY) })
  put('failing', { qa: { status: 'failed', attempt: 1, by: QA, at: ago(2000), rework: { to: 'Agent 1' } }, updatedAt: ago(1000) })
  const missed = await (await get('/api/log?cell=missed&days=all')).json()
  assert.deepEqual(missed.events.map(e => e.flow.id), ['dropped'])
  const score = await (await get('/api/score?days=all')).json()
  for (const cell of ['delivered', 'caught', 'missed', 'slipped']) {
    assert.equal((await (await get(`/api/log?cell=${cell}&days=all`)).json()).total, score.counts[cell], cell)
  }
  assert.deepEqual((await (await get('/api/log?kind=rule')).json()).events, [], 'no rule store is wired in yet')
})

test('GET /api/log: at most 300 events, total says how many matched', async () => {
  for (let i = 0; i < 310; i++) put(`f${i}`, { createdAt: ago(1000 + i), updatedAt: ago(500) })
  const j = await (await get('/api/log')).json()
  assert.equal(j.events.length, 300)
  assert.equal(j.total, 310)
})

test('GET /api/log with a bad window, cell or kind is a 400 with a plain sentence', async () => {
  const cases = {
    'days=14': 'The window must be 7, 30 or all days.',
    'cell=wrong': 'The cell must be delivered, caught, missed or slipped.',
    // the kinds of the planner, Security and Senior are named only when the live config.json has them (score-routes.mjs)
    'kind=nope': `The kind must be one of started, route, handed, passed, failed, pushed, done, dropped, stopped, stalled, rule${SECURITY ? ', security' : ''}${pipelineGraph(CONFIG).nodes.some(n => n.role === 'planner') ? ', planned' : ''}${pipelineGraph(CONFIG).nodes.some(n => n.role === 'senior') ? ', senior' : ''}, completed, uncompleted, reopened`.replace(/, ([a-z]+)$/, ' or $1') + '.',
  }
  for (const [q, error] of Object.entries(cases)) {
    const r = await get(`/api/log?${q}`)
    assert.equal(r.status, 400, q)
    assert.deepEqual(await r.json(), { error }, q)
  }
})

test('GET /api/log carries the saved rule changes as rule events, inside the window only', async () => {
  const logFile = path.join(process.env.FACTORY_DATA_DIR, 'agent-rules-log.jsonl')
  fs.writeFileSync(logFile, [
    JSON.stringify({ at: ago(2 * DAY), label: 'Agent 1', spec: null, added: ['Run the tests first.', 'Never push.'], removed: [] }),
    JSON.stringify({ at: ago(20 * DAY), label: QA, spec: 'set', added: [], removed: [] }),
  ].map(l => l + String.fromCharCode(10)).join(''))
  try {
    const week = await (await fetch(`${base}/api/log?days=7&kind=rule`)).json()
    assert.equal(week.total, 1)
    assert.deepEqual({ kind: week.events[0].kind, agent: week.events[0].agent, text: week.events[0].text, cell: week.events[0].cell, flow: week.events[0].flow },
      { kind: 'rule', agent: 'Agent 1', text: 'Agent 1 got 2 new rules.', cell: null, flow: null })
    const all = await (await fetch(`${base}/api/log?days=all&kind=rule`)).json()
    assert.equal(all.total, 2)
    // a rule change never puts a count in a scorecard cell
    const caught = await (await fetch(`${base}/api/log?days=all&cell=caught`)).json()
    assert.ok(caught.events.every(e => e.kind !== 'rule'))
  } finally {
    fs.rmSync(logFile, { force: true })
  }
})
