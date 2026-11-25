// Regression tests for QA round two (2026-11-25) around Senior, the dashboard side:
//   B-F1  the user's own routes (the by-hand tick, Finish without Senior) need the page's Origin, present: a request
//         with none (curl, a script) is refused; other routes are unchanged
//   B-F3  the dashboard (the user) still moves a stopped flow on
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-origin-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const { factoryRoute } = await import('../factory-routes.mjs')
const { CONFIG } = await import('../config.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-origin-files-'))

const SENIOR = {
  repo: 'C:/watched/repo', coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', sen: 'Senior' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2, senior: 'Senior' },
}
const A1 = (...argv) => runFlow(argv, { by: 'Agent 1', cwd: TMP, config: SENIOR })
let n = 0
const fresh = (type = 'ask') => {
  const id = `r2-${++n}`
  assert.equal(A1('new', id, 'Rotate the keys', '--type', type).code, 0)
  return id
}
const store = fn => F.withPipeline(SENIOR, fn)

let server
let base
before(async () => {
  server = createServer(async (req, res) => {
    if (!(await factoryRoute(req, res, new URL(req.url, 'http://localhost'), { relay: { queue() {}, queueStatus() {}, queueRequest() {} } }))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})
const PAGE = { origin: `http://127.0.0.1:${CONFIG.port}` }
const post = (p, body = {}, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

const stopped = {
  senior: f => ({ ...f, status: 'blocked', hand: { steps: [{ id: 'h1', do: 'x', expect: 'y', done: null }] }, senior: { status: 'senior-failed', by: 'Senior', at: '2026-11-25T10:00:00Z', summary: 'no' } }),
  qa: f => ({ ...f, status: 'blocked', qa: { status: 'qa-failed', attempt: 3, by: 'QA', at: '2026-11-25T10:00:00Z' } }),
  security: f => ({ ...f, status: 'blocked', qa: { status: 'passed', attempt: 1, by: 'QA', at: '2026-11-25T10:00:00Z', commit: 'abc1234', security: { status: 'security-failed', by: 'Security', at: '2026-11-25T11:00:00Z', commit: 'abc1234' } } }),
}
test('the dashboard moves a stopped flow on: the user status route sets it done', async () => {
  const id = fresh()
  store(() => F.writeFlow(stopped.qa(F.readFlow(id))))
  const r = await post(`/api/flows/${id}/status`, { status: 'done' }, PAGE)
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
  assert.equal(F.readFlow(id).status, 'done')
})

// ═══ B-F1 ═══

test('the by-hand tick and Finish without Senior need the page Origin: none (curl) or another one is refused', async () => {
  const id = fresh()
  assert.equal(A1('hand-step', id, 'Rotate the key', '--expect', 'A new key').code, 0)
  for (const headers of [{}, { origin: 'http://evil.example' }]) {
    const tick = await post(`/api/flows/${id}/hand`, { step: 'h1', done: true }, headers)
    assert.equal(tick.status, 403, JSON.stringify(headers))
    assert.match((await tick.json()).error, headers.origin ? /Cross-origin request refused/ : /only from the dashboard page/)
    assert.equal((await post(`/api/flows/${id}/senior-release`, {}, headers)).status, 403)
  }
  assert.equal(F.readFlow(id).hand.steps[0].done, null)
  assert.notEqual(F.readFlow(id).status, 'done')
  // the page itself
  assert.equal((await post(`/api/flows/${id}/hand`, { step: 'h1', done: true }, PAGE)).status, 200)
  assert.ok(F.readFlow(id).hand.steps[0].done)
})

test('other routes keep their rule: a POST with no Origin is still taken (an agent tool may call them)', async () => {
  const id = fresh()
  const r = await post(`/api/flows/${id}/status`, { status: 'blocked' })
  assert.equal(r.status, 200)
})

test('the header comment says the Origin check stops an accident, not a determined process, and why a release scores slipped', () => {
  const src = fs.readFileSync(new URL('../factory-routes.mjs', import.meta.url), 'utf8').replace(/\s*\n\/\/\s*/g, ' ')
  assert.match(src, /stops an accident, not a determined process on the same machine/)
  assert.match(src, /a release is always scored as slipped through/)
})
