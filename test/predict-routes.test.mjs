// Tests for predict-routes.mjs (server.mjs mounts it): GET /api/alerts (the alerts, the dismissed ones hidden, the
// raised ones logged), POST /api/alerts/dismiss (the page's own Origin required, the measure taken from the server's
// own alert, never the page's), GET /api/predict/flow (a flow's placed tokens, its estimate and its actual),
// GET /api/predict/ticket (an estimate for a ticket not yet started, computed on the fly), GET /api/predict/accuracy,
// the sweep that stores an estimate once on each open flow (keeping its updatedAt), and the placed line Pipeline
// tokens reads. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'predict-routes-test-'))
const F = await import('../flows.mjs')
const { makePredictRoute } = await import('../predict-routes.mjs')
const { readAlertState } = await import('../predict-state.mjs')

const DATA = process.env.FACTORY_DATA_DIR
const HOUR = 3_600_000
const MIN = 60_000
const NOW = Date.now()
const iso = t => new Date(t).toISOString()
const CONFIG = {
  port: 0, coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' }, pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 3 },
  tokens: { prices: { m: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } } }, factory: { collections: [] },
}
const STATE = path.join(DATA, 'alerts-state.json')
const put = flow => fs.writeFileSync(path.join(F.FLOWS_DIR, `${flow.id}.json`), JSON.stringify(flow))
const flow = (id, more = {}) => ({ id, title: `Work ${id}`, agent: 'Agent 1', tickets: [], status: 'open', why: '', createdAt: iso(NOW - 2 * HOUR), updatedAt: iso(NOW - MIN), nodes: [], ...more })
function done(id, start, minutes) {
  const at = start + minutes * MIN
  return flow(id, { status: 'done', createdAt: iso(start), updatedAt: iso(at), route: { type: 'build', steps: ['request', 'master', 'qa', 'push', 'outcome'], at: iso(start), by: 'Master' }, qa: { status: 'passed', attempt: 1, by: 'QA', startedAt: iso(at - 10 * MIN), at: iso(at), pushedAt: iso(at) } })
}
const hourKey = t => String(Math.floor(t / HOUR))
let files = []
const index = { snapshot: () => ({ files, building: false, builtAt: iso(NOW) }), refresh: async () => {} }

let server
let base
let route
let origin
const make = (more = {}) => makePredictRoute({
  index, config: CONFIG, port: Number(new URL(base).port), stateFile: STATE, labelOf: n => n,
  names: async () => new Map([['s1', 'Agent 1']]), live: async () => new Map([['s1', 'Agent 1']]),
  ticketsOf: async () => new Map([['FLA-1', { title: 'Speed up login', labels: ['Auth'], type: 'bug' }]]), log: () => {}, ...more,
})
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await route(req, res, url))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  origin = { origin: base }
})
after(() => {
  server.close()
  fs.rmSync(DATA, { recursive: true, force: true })
})
beforeEach(() => {
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
  fs.rmSync(STATE, { force: true })
  files = []
  route = make()
})
const get = async p => {
  const r = await fetch(base + p)
  return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') }
}
const post = async (p, body, headers = origin) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}

test('GET /api/alerts: a flow far past its plain limit, uncached, logged once as raised; other methods are refused', async () => {
  put(flow('a', { nodes: [{ id: 'q', type: 'ask', kind: 'yesno', title: 'Go on?', at: iso(NOW - 30 * HOUR), answer: null }] }))
  const r = await get('/api/alerts')
  assert.equal(r.status, 200)
  assert.equal(r.cache, 'no-store')
  assert.equal(r.body.enabled, true)
  assert.deepEqual(r.body.alerts.map(a => a.key), ['stuck:a:ask'])
  assert.equal(r.body.counts.shown, 1)
  assert.equal(r.body.counts.onYou, 1)
  await get('/api/alerts')
  assert.equal(readAlertState(STATE).raised.length, 1)
  assert.equal((await fetch(`${base}/api/alerts`, { method: 'DELETE' })).status, 405)
})

test('alerts off in config: an empty answer that says so', async () => {
  route = make({ config: { ...CONFIG, alerts: { enabled: false } } })
  put(flow('a', { nodes: [{ id: 'q', type: 'ask', kind: 'yesno', title: 'Go on?', at: iso(NOW - 30 * HOUR), answer: null }] }))
  const r = await get('/api/alerts')
  assert.equal(r.body.enabled, false)
  assert.deepEqual(r.body.alerts, [])
})

test('POST /api/alerts/dismiss needs the page s own Origin, an alert that stands, and hides it for the day', async () => {
  put(flow('a', { nodes: [{ id: 'q', type: 'ask', kind: 'yesno', title: 'Go on?', at: iso(NOW - 30 * HOUR), answer: null }] }))
  for (const headers of [{}, { origin: 'https://evil.example' }]) assert.equal((await post('/api/alerts/dismiss', { key: 'stuck:a:ask' }, headers)).status, 403)
  assert.equal((await post('/api/alerts/dismiss', { key: 42 })).status, 400)
  assert.equal((await post('/api/alerts/dismiss', { key: 'stuck:zzz:qa' })).status, 404)
  const ok = await post('/api/alerts/dismiss', { key: 'stuck:a:ask', measure: 1 })
  assert.equal(ok.status, 200)
  // the measure is the server's (30 hours), never the one the page sent
  assert.ok(readAlertState(STATE).dismissed['stuck:a:ask'].measure > 29 * HOUR)
  const after = await get('/api/alerts')
  assert.deepEqual(after.body.alerts, [])
  assert.equal(after.body.hidden, 1)
})

test('GET /api/alerts: token alerts from the index, a context alert naming the agent and carrying the handover request', async () => {
  files = [{ sessionId: 's1', sub: false, title: null, mtimeMs: NOW, days: {}, hours: {}, recent: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, at: NOW - (10 - i) * MIN, model: 'm', vec: [1, 1, 0, 0, 900_000, 1] })) }]
  const r = await get('/api/alerts')
  const ctx = r.body.alerts.find(a => a.kind === 'context')
  assert.equal(ctx.agent, 'Agent 1')
  assert.match(ctx.handover, /handover note/)
})

test('GET /api/predict/flow: its placed tokens and dollars, its stored estimate, and the actual once finished', async () => {
  const start = NOW - 6 * HOUR
  put({ ...done('f', start, 90), estimate: { at: iso(start), minutes: 60, usd: 2, tokens: 1000, basedOn: ['x', 'y', 'z'], spread: { minutes: [30, 80], usd: [1, 3], tokens: [500, 2000] } } })
  files = [{ sessionId: 's1', sub: false, title: null, mtimeMs: 0, days: {}, recent: [], hours: { [hourKey(start)]: { m: [0, 4000, 0, 0, 0, 1] } } }]
  const r = await get('/api/predict/flow?id=f')
  assert.equal(r.status, 200)
  assert.ok(r.body.tokens.tokens > 0)
  assert.ok(Number.isFinite(r.body.tokens.usd))
  assert.equal(r.body.stored, true)
  assert.equal(r.body.estimate.minutes, 60)
  assert.equal(r.body.actual.minutes, 90)
  assert.equal((await get('/api/predict/flow?id=Bad Id')).status, 400)
  assert.equal((await get('/api/predict/flow?id=nope')).status, 404)
})

test('GET /api/predict/ticket: on the fly from the flows finished so far; too few is no number; a started ticket names its flow', async () => {
  put(done('a', NOW - 30 * HOUR, 40))
  put(done('b', NOW - 20 * HOUR, 60))
  const few = await get('/api/predict/ticket?id=FLA-1')
  assert.equal(few.status, 200)
  assert.equal(few.body.estimate.few, true)
  put(done('c', NOW - 10 * HOUR, 80))
  const r = await get('/api/predict/ticket?id=FLA-1')
  assert.equal(r.body.estimate.minutes, 60)
  assert.deepEqual(r.body.estimate.basedOn.sort(), ['a', 'b', 'c'])
  assert.deepEqual(r.body.similar.map(s => s.id).sort(), ['a', 'b', 'c'])
  put(flow('d', { tickets: ['FLA-1'] }))
  const started = (await get('/api/predict/ticket?id=FLA-1')).body
  assert.equal(started.flow, 'd')
  assert.equal(started.flowDone, false)
  assert.equal((await get('/api/predict/ticket?id=nope')).status, 400)
  assert.equal((await get('/api/predict/ticket?id=FLA-404')).status, 404)
})

test('the sweep stores an estimate once on each open flow, keeping its updatedAt; a second sweep writes nothing', async () => {
  put(done('a', NOW - 30 * HOUR, 40))
  put(done('b', NOW - 20 * HOUR, 60))
  put(done('c', NOW - 10 * HOUR, 80))
  put(flow('n', { createdAt: iso(NOW - HOUR), route: { type: 'build', steps: ['request', 'master', 'qa', 'push', 'outcome'], at: iso(NOW - HOUR), by: 'Master' } }))
  const before = F.readFlow('n').updatedAt
  assert.equal(await route.sweep(), 1)
  const stored = F.readFlow('n')
  assert.equal(stored.estimate.minutes, 60)
  assert.equal(stored.updatedAt, before)
  assert.equal(await route.sweep(), 0)
  route = make({ config: { ...CONFIG, estimates: { enabled: false } } })
  put(flow('m'))
  assert.equal(await route.sweep(), 0)
})

// Broke when Routing read flowTokens: it answers from the last placement this route made, and the sweep only placed
// when an open flow lacked an estimate, so with none (or estimates off) flowTokens stayed null or stale for good.
test('the sweep keeps flowTokens current: it places every time the index is built, even with nothing to estimate', async () => {
  const { flowTokens } = await import('../predict-flow-tokens.mjs')
  const start = NOW - 3 * HOUR
  put(done('f', start, 60))
  files = [{ sessionId: 's1', sub: false, title: null, mtimeMs: 0, days: {}, recent: [], hours: { [hourKey(start)]: { m: [0, 1000, 0, 0, 0, 1] } } }]
  let building = true
  route = make({ index: { snapshot: () => ({ files, building, builtAt: building ? null : iso(NOW) }), refresh: async () => {} }, config: { ...CONFIG, estimates: { enabled: false } } })
  assert.equal(route.ready(), false)
  await route.sweep()
  assert.equal(route.ready(), false, 'nothing is placed while the index is still being built')
  assert.equal(flowTokens('f'), null)
  building = false
  await route.sweep()
  assert.equal(route.ready(), true)
  assert.ok(flowTokens('f')?.tokens > 0)
})

// Routing writes an outcome line once a flow's finishing hour is closed IN THE DATA the placement came from, so it
// needs that time, and the sweep must ask the index to read the transcripts again even when no page is open.
test('placedThrough is when the transcripts behind the last placement were read; the sweep asks for a fresh read', async () => {
  let refreshes = 0
  let builtAt = iso(NOW - 5 * MIN)
  route = make({ index: { snapshot: () => ({ files, building: false, builtAt }), refresh: async () => { refreshes++ } } })
  assert.equal(route.placedThrough(), null)
  await route.sweep()
  assert.equal(route.placedThrough(), NOW - 5 * MIN)
  assert.equal(refreshes, 1)
  builtAt = iso(NOW)
  await route.sweep()
  assert.equal(route.placedThrough(), NOW)
})

test('GET /api/predict/accuracy: per window, too few under 5; a bad window is the score s 400', async () => {
  const r = await get('/api/predict/accuracy?days=30')
  assert.equal(r.status, 200)
  assert.equal(r.body.stored.minutes.few, true)
  assert.equal((await get('/api/predict/accuracy?days=9')).status, 400)
})

test('placed: the tokens of the period placed on flows and those left unplaced, for Pipeline tokens', async () => {
  const start = NOW - 3 * HOUR
  put(done('f', start, 60))
  files = [{ sessionId: 's1', sub: false, title: null, mtimeMs: 0, days: {}, recent: [], hours: { [hourKey(start)]: { m: [0, 1000, 0, 0, 0, 1] }, [hourKey(NOW - 30 * HOUR)]: { m: [0, 500, 0, 0, 0, 1] } } }]
  const p = await route.placed({ from: NOW - 24 * HOUR, now: NOW })
  assert.ok(p.placed.tokens > 0)
  assert.ok(p.placed.tokens <= 1000)
  assert.ok(p.unplaced.tokens >= 0)
  assert.equal(Math.round(p.placed.tokens + p.unplaced.tokens), 1000, 'the hour 30 hours back is outside the period')
})

test('Pipeline tokens carries the placed line from the provider it is given, none without one, and shares its index', async () => {
  const { makeTokenRoute } = await import('../token-routes.mjs')
  const fake = { snapshot: () => ({ files: [], building: false, progress: 1, builtAt: null, lastRead: null }), refresh: async () => {} }
  const seen = []
  const tokens = makeTokenRoute({ index: fake, config: CONFIG, placed: async o => (seen.push(o), { placed: { tokens: 7, usd: 1 }, unplaced: { tokens: 3, usd: null } }), log: () => {} })
  assert.equal(tokens.index, fake)
  const res = { writeHead() {}, end(s) { this.body = JSON.parse(s) } }
  await tokens({ method: 'GET' }, res, new URL('http://x/api/tokens?days=7'))
  assert.deepEqual(res.body.placed, { placed: { tokens: 7, usd: 1 }, unplaced: { tokens: 3, usd: null } })
  assert.ok(Number.isFinite(seen[0].from))
  const plain = makeTokenRoute({ index: fake, config: CONFIG, log: () => {} })
  await plain({ method: 'GET' }, res, new URL('http://x/api/tokens?days=7'))
  assert.equal(res.body.placed, null)
})

const askedLong = id => flow(id, { nodes: [{ id: 'q', type: 'ask', kind: 'yesno', title: 'Go on?', at: iso(NOW - 30 * HOUR), answer: null }] })

test('POST /api/alerts/dismiss with keys dismisses a group at once; keys that no longer stand are skipped', async () => {
  for (const id of ['a', 'b', 'c']) put(askedLong(id))
  assert.equal((await post('/api/alerts/dismiss', { keys: [] })).status, 400)
  assert.equal((await post('/api/alerts/dismiss', { keys: Array.from({ length: 101 }, (_, i) => `stuck:f${i}:ask`) })).status, 400)
  assert.equal((await post('/api/alerts/dismiss', { keys: ['stuck:zzz:ask'] })).status, 404)
  const r = await post('/api/alerts/dismiss', { keys: ['stuck:a:ask', 'stuck:b:ask', 'stuck:gone:ask'] })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.keys, ['stuck:a:ask', 'stuck:b:ask'])
  const after = await get('/api/alerts')
  assert.deepEqual(after.body.alerts.map(a => a.key), ['stuck:c:ask'])
  assert.equal(after.body.hidden, 2)
})

test('POST /api/alerts/snooze: the page s own Origin, a flow alert that stands, hidden for a week and counted apart', async () => {
  put(askedLong('a'))
  files = [{ sessionId: 's1', sub: false, title: null, mtimeMs: NOW, days: {}, hours: {}, recent: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, at: NOW - (10 - i) * MIN, model: 'm', vec: [1, 1, 0, 0, 900_000, 1] })) }]
  assert.equal((await post('/api/alerts/snooze', { key: 'stuck:a:ask' }, {})).status, 403)
  assert.equal((await post('/api/alerts/snooze', { key: 'context:s1' })).status, 400, 'only a flow alert can be snoozed')
  assert.equal((await post('/api/alerts/snooze', { key: 'stuck:nope:ask' })).status, 404)
  const r = await post('/api/alerts/snooze', { key: 'stuck:a:ask' })
  assert.equal(r.status, 200)
  assert.ok(Date.parse(r.body.until) - NOW > 6.9 * 24 * HOUR)
  const after = await get('/api/alerts')
  assert.deepEqual(after.body.alerts.map(a => a.kind), ['context'])
  assert.equal(after.body.snoozed, 1)
  assert.equal(after.body.counts.snoozed, 1)
})
