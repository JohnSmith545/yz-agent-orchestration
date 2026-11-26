// Tests for the one hook the automatic retrospective needs in factory-routes.mjs: after the user marks a flow
// Completed (POST /api/flows/<id>/complete, the page's own Origin), `onCompleted(id)` hears it; Uncomplete, a refused
// press and a press from elsewhere do not. learn-retro.mjs decides from there (autoRetro, one at a time). A real http
// server on port 0; FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-completed-hook-test-'))
const F = await import('../flows.mjs')
const { factoryRoute } = await import('../factory-routes.mjs')
const { CONFIG } = await import('../config.mjs')
const { archiveList } = await import('../trash-routes.mjs')

let heard = []
let server
let base
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await factoryRoute(req, res, url, { git: async () => ({ ok: false, out: '', err: '' }), relay: { drop() {}, queue() {} }, onCompleted: id => heard.push(id) }))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
})
beforeEach(() => {
  heard = []
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
})

const OWN = { origin: `http://127.0.0.1:${CONFIG.port}` }
const post = (p, body = {}, headers = OWN) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
function put(id, status = 'done', more = {}) {
  const flow = { id, title: `Flow ${id}`, agent: 'Agent 1', status, createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-21T10:00:00.000Z', nodes: [], ...more }
  fs.writeFileSync(path.join(F.FLOWS_DIR, `${id}.json`), JSON.stringify(flow))
}

test('Completed on a finished flow is heard once, after the mark is saved', async () => {
  put('a1')
  assert.equal((await post('/api/flows/a1/complete')).status, 200)
  assert.deepEqual(heard, ['a1'])
  assert.ok(F.readFlow('a1').completedAt, 'heard after the write')
})

test('Uncomplete, a flow still on its way and a press from no page are not heard', async () => {
  put('b1')
  await post('/api/flows/b1/complete')
  heard = []
  assert.equal((await post('/api/flows/b1/complete', { completed: false })).status, 200)
  put('b2', 'open')
  assert.equal((await post('/api/flows/b2/complete')).status, 400)
  put('b3')
  assert.equal((await post('/api/flows/b3/complete', {}, {})).status, 403)
  assert.deepEqual(heard, [])
})

test('the flow archive row carries the retrospective, so the archive can show it', async () => {
  const retro = { at: '2026-11-21T11:00:00.000Z', right: 'r', wrong: 'w', next: 'n', cost: 0.01, source: 'completed' }
  put('c1', 'done', { archivedAt: '2026-11-21T11:00:00.000Z', retro })
  put('c2', 'done', { archivedAt: '2026-11-21T11:00:00.000Z' })
  const rows = archiveList().body.archived
  assert.deepEqual(rows.find(r => r.id === 'c1').retro, retro)
  assert.equal('retro' in rows.find(r => r.id === 'c2'), false)
})
