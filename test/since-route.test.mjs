// Tests for GET /api/since in factory-routes.mjs (spec F2): it gathers the
// inputs server-side (the status build through deps.getStatus, git through
// deps.git, the flow store and the change records) and answers with the pure
// digest. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports,
// so no test ever touches the real data/ folder.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'since-route-test-'))
const F = await import('../flows.mjs')
const S = await import('../since-store.mjs')
const { factoryRoute } = await import('../factory-routes.mjs')
// The tickets here use the made-up prefixes ABC and XYZ, whatever config.json says.
const { useTicketPrefixes } = await import('../transcripts.mjs')
useTicketPrefixes(['ABC', 'XYZ'])

const recent = new Date(Date.now() - 3600_000).toISOString()
const baseline = new Date(Date.now() - 8 * 3600_000).toISOString()

const gitCalls = []
async function git(args) {
  gitCalls.push(args)
  if (args[0] === 'log' && args[1] === 'origin/dev..abc-102-x') return { ok: true, out: `a1\t${recent}\tfix: ABC-102 one\na2\t${recent}\tfix: ABC-102 two`, err: '' }
  return { ok: false, out: '', err: 'bad revision' }
}
let statusCalls = 0
const getStatus = async force => {
  statusCalls++
  assert.equal(force, false, 'the cached status build, as the pulse uses')
  return { worktrees: [{ name: 'a1', path: 'C:/r/a1', branch: 'abc-102-x', isAgentTree: true, agent: 'Agent 1' }] }
}

let server
let base
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await factoryRoute(req, res, url, { git, getStatus, relay: {} }))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  const flow = F.createFlow({ id: 'dark', title: 'Add a dark mode toggle', agent: 'Agent 3' })
  flow.status = 'done'
  F.writeFlow(flow) // notes open -> done now, after baseline
})
after(() => {
  server.close()
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
})

test('GET /api/since returns the digest of commits and flow changes since t', async () => {
  const r = await fetch(`${base}/api/since?t=${encodeURIComponent(baseline)}`)
  assert.equal(r.status, 200)
  const d = await r.json()
  assert.deepEqual(d.flows.map(l => l.text), ['Add a dark mode toggle is done'])
  assert.deepEqual(d.commits.map(l => l.text), ['Agent 1 committed 2 times on ABC-102'])
  assert.deepEqual(d.levels, [])
  assert.deepEqual(d.deliveries, [])
  assert.deepEqual(d.tickets, [])
  assert.equal(d.since, baseline)
  assert.ok(gitCalls.some(a => a.includes(`--since=${baseline}`)))
})

test('GET /api/since reads the level records', async () => {
  S.recordLevels({ 'ABC-101': 'dev' }, new Date(Date.now() - 9 * 3600_000).toISOString())
  S.recordLevels({ 'ABC-101': 'stage' }, recent)
  const d = await (await fetch(`${base}/api/since?t=${encodeURIComponent(baseline)}`)).json()
  assert.deepEqual(d.levels.map(l => l.text), ['ABC-101 moved to Stage'])
})

test('a future, unparsable or missing t is an empty digest, 200, with no git or status work', async () => {
  const future = new Date(Date.now() + 3600_000).toISOString()
  for (const t of [future, 'yesterday-ish', '']) {
    gitCalls.length = 0
    statusCalls = 0
    const r = await fetch(`${base}/api/since?t=${encodeURIComponent(t)}`)
    assert.equal(r.status, 200, t)
    const d = await r.json()
    for (const k of ['commits', 'levels', 'flows', 'deliveries', 'tickets']) assert.deepEqual(d[k], [], `${t} ${k}`)
    assert.equal(gitCalls.length, 0, t)
    assert.equal(statusCalls, 0, t)
  }
  const none = await (await fetch(`${base}/api/since`)).json()
  assert.deepEqual(none.flows, [])
})

test('a status build that fails still answers with the flow lines', async () => {
  const s2 = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    await factoryRoute(req, res, url, { git, getStatus: async () => { throw new Error('busy') }, relay: {} })
  })
  await new Promise(r => s2.listen(0, '127.0.0.1', r))
  try {
    const d = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/since?t=${encodeURIComponent(baseline)}`)).json()
    assert.deepEqual(d.flows.map(l => l.text), ['Add a dark mode toggle is done'])
    assert.deepEqual(d.commits, [])
  } finally {
    s2.close()
  }
})

test('GET /api/since is a GET only', async () => {
  const r = await fetch(`${base}/api/since?t=${encodeURIComponent(baseline)}`, { method: 'POST' })
  assert.equal(r.status, 404)
})
