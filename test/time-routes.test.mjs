// Tests for GET /api/time (time-routes.mjs, mounted by factory-routes.mjs beside the score routes): the Pipeline time
// numbers of time-stats.mjs over every flow file, for 7 days, 30 days (the default) or all time, never cached, a
// plain 400 for any other window, archived flows counted and the Trash never. A real http server on port 0 calls
// factoryRoute; FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'time-routes-test-'))
const F = await import('../flows.mjs')
const { factoryRoute } = await import('../factory-routes.mjs')
const { moveToTrash } = await import('../trash.mjs')
const { timeGet } = await import('../time-routes.mjs')

const DAY = 86_400_000
const MIN = 60_000
const ago = ms => new Date(Date.now() - ms).toISOString()
const talk = [{ id: 'n1', type: 'step', title: 'Look into it', status: 'done', evidence: [{ kind: 'note', ref: 'Fine.' }] }]

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

/** A finished flow with no code changes (delivered), started `took` before it finished `ago` ago; raw, so the times stay. */
function put(id, finishedAgo, took, more = {}) {
  const now = Date.now() // one reading, so the time it took is exact
  const flow = { id, title: `Flow ${id}`, agent: 'Agent 1', tickets: [], status: 'done', why: '', createdAt: new Date(now - finishedAgo - took).toISOString(), updatedAt: new Date(now - finishedAgo).toISOString(), nodes: talk, ...more }
  fs.writeFileSync(path.join(F.FLOWS_DIR, `${id}.json`), JSON.stringify(flow))
}
const get = p => fetch(base + p)

test('GET /api/time: the numbers over the flow files for the last 30 days by default, never cached', async () => {
  put('a', 1000, 30 * MIN, { tickets: ['ABC-1', 'ABC-2'] })
  put('b', 2 * DAY, 60 * MIN)
  put('old', 40 * DAY, 10 * MIN)
  const r = await get('/api/time')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const j = await r.json()
  assert.deepEqual(Object.keys(j).sort(), ['agents', 'bars', 'builtAt', 'fewer', 'finished', 'left', 'rates', 'stages', 'took', 'waiting', 'window'])
  assert.equal(j.window.days, 30)
  assert.equal(j.bars.length, 30)
  assert.ok(Date.parse(j.builtAt))
  assert.deepEqual(j.finished, { tickets: 2, jobs: 1, flows: 2 })
  assert.equal(j.took.median, 45 * MIN)
})

test('GET /api/time?days=7 and days=all set the period', async () => {
  put('recent', 1000, MIN)
  put('month', 20 * DAY, MIN)
  put('ancient', 400 * DAY, MIN)
  const seven = await (await get('/api/time?days=7')).json()
  assert.equal(seven.finished.flows, 1)
  assert.equal(seven.bars.length, 7)
  const all = await (await get('/api/time?days=all')).json()
  assert.equal(all.window.days, null)
  assert.equal(all.window.bucket, 'week')
  assert.equal(all.finished.flows, 3)
})

test('GET /api/time with any other window is a 400 with a plain sentence', async () => {
  for (const q of ['days=14', 'days=0', 'days=-7', 'days=7.0', 'days=ALL', 'days=30%20']) {
    const r = await get(`/api/time?${q}`)
    assert.equal(r.status, 400, q)
    assert.deepEqual(await r.json(), { error: 'The window must be 7, 30 or all days.' }, q)
  }
})

test('GET /api/time: archived flows count, the Trash never does', async () => {
  put('archived', DAY, MIN, { archivedAt: ago(DAY / 2) })
  put('gone', DAY, MIN)
  moveToTrash('gone')
  assert.equal((await (await get('/api/time')).json()).finished.flows, 1)
})

test('GET /api/time with no flow files at all: an honest empty answer', async () => {
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  const j = await (await get('/api/time?days=all')).json()
  assert.equal(j.finished.flows, 0)
  assert.equal(j.took, null)
  assert.deepEqual(j.bars, [])
})

test('POST /api/time is not a route', async () => {
  assert.equal((await fetch(`${base}/api/time`, { method: 'POST' })).status, 404)
})

test('timeGet takes the clock from its caller', () => {
  put('x', 0, MIN)
  const now = Date.now() + 1000
  const { status, body } = timeGet('7', { now })
  assert.equal(status, 200)
  assert.equal(body.builtAt, new Date(now).toISOString())
  assert.equal(body.window.to, new Date(now).toISOString())
})
