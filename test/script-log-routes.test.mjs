// Tests for the SCRIPT run log routes (script-log-routes.mjs): GET /api/script/log, DELETE /api/script/log/<id>
// and DELETE /api/script/log, the deletes Origin checked. A real http server on port 0 with a temp log file.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'script-log-routes-test-'))
const { makeScriptLogRoute } = await import('../script-log-routes.mjs')
const L = await import('../script-log.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const FILE = path.join(process.env.FACTORY_DATA_DIR, 'script-log.json')
const entry = id => ({ id, at: '2026-11-24T10:00:00.000Z', ms: 3000, text: `idea ${id}`, output: 'Situation: x', ok: true, error: null, cancelled: false, cost: 0.03, context: { used: [], skipped: [] } })
const seed = (...ids) => {
  fs.rmSync(FILE, { force: true })
  for (const id of ids) L.appendRun(entry(id), FILE)
}

let server
let base
let port
before(async () => {
  let route
  server = createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, 'http://localhost')))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  route = makeScriptLogRoute({ port, file: FILE })
  base = `http://127.0.0.1:${port}`
})
after(() => server.close())

const call = (method, p, headers = {}) => fetch(`${base}${p}`, { method, headers })

test('GET: the runs newest first, each with its output, and the limits', async () => {
  seed('r-1', 'r-2')
  const res = await call('GET', '/api/script/log')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const v = await res.json()
  assert.deepEqual(v.runs.map(r => r.id), ['r-2', 'r-1'])
  assert.deepEqual(v.runs[0], entry('r-2'))
  assert.deepEqual(v.limits, { runsMax: 50, outputMax: 40_000 })
})

test('GET with no log yet is an empty list', async () => {
  fs.rmSync(FILE, { force: true })
  assert.deepEqual((await (await call('GET', '/api/script/log')).json()).runs, [])
})

test('DELETE one run; a second time is a 404 with a plain sentence', async () => {
  seed('r-1', 'r-2')
  const res = await call('DELETE', '/api/script/log/r-1')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.deepEqual(L.readLog(FILE).map(r => r.id), ['r-2'])
  const again = await call('DELETE', '/api/script/log/r-1')
  assert.equal(again.status, 404)
  assert.match((await again.json()).error, /\.$/)
})

test('DELETE the whole log clears it and says how many went', async () => {
  seed('r-1', 'r-2', 'r-3')
  const res = await call('DELETE', '/api/script/log')
  assert.deepEqual(await res.json(), { ok: true, removed: 3 })
  assert.deepEqual(L.readLog(FILE), [])
})

test('deletes check the Origin: another site is refused and nothing goes; the page itself is fine', async () => {
  seed('r-1')
  const evil = { origin: 'http://evil.example' }
  assert.equal((await call('DELETE', '/api/script/log/r-1', evil)).status, 403)
  assert.equal((await call('DELETE', '/api/script/log', evil)).status, 403)
  assert.equal(L.readLog(FILE).length, 1)
  assert.equal((await call('DELETE', '/api/script/log', { origin: `http://127.0.0.1:${port}` })).status, 200)
})

test('other methods and paths: 405 on the log paths, not answered elsewhere', async () => {
  assert.equal((await call('POST', '/api/script/log')).status, 405)
  assert.equal((await call('GET', '/api/script/log/r-1')).status, 405)
  assert.equal((await call('DELETE', '/api/script/log/BAD..id')).status, 404)
  assert.equal((await call('GET', '/api/script/logs')).status, 404)
})
