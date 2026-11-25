// Tests for GET /api/tokens (token-routes.mjs, mounted by server.mjs): Pipeline tokens over a temp folder shaped like
// Claude Code's, for 7 days, 30 days (the default) or all time, never cached, the score's plain 400 for any other
// window; while the first build runs it answers at once with building and a progress figure; the per job average
// divides by Pipeline time's own finished count; the dashboard's own runs ride beside the estimate; the live name of
// a session wins; the price table carries its source. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'token-routes-test-'))
const F = await import('../flows.mjs')
const { CONFIG } = await import('../config.mjs')
const { SPEND_FILE } = await import('../spend.mjs')
const { makeTokenIndex } = await import('../token-index.mjs')
const { makeTokenRoute } = await import('../token-routes.mjs')

const DATA = process.env.FACTORY_DATA_DIR
const claude = path.join(DATA, '..', `${path.basename(DATA)}-claude`)
const project = path.join(claude, 'projects', 'c--Users-me-my-repo')
const DAY = 86_400_000
const ago = ms => new Date(Date.now() - ms).toISOString()
const line = (id, { t = ago(60_000), model = 'claude-opus-5-5', input = 1_000_000, output = 0, read = 0 } = {}) => JSON.stringify({
  type: 'assistant', timestamp: t, requestId: `req_${id}`,
  message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: read } },
}) + '\n'
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const talk = [{ id: 'n1', type: 'step', title: 'Look into it', status: 'done', evidence: [{ kind: 'note', ref: 'Fine.' }] }]
const putFlow = (id, tickets = []) => {
  const now = Date.now()
  write(path.join(F.FLOWS_DIR, `${id}.json`), JSON.stringify({ id, title: id, agent: 'Agent 1', tickets, status: 'done', why: '', createdAt: new Date(now - 3_600_000).toISOString(), updatedAt: new Date(now - 60_000).toISOString(), nodes: talk }))
}

let server
let base
let index
let route
let names
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await route(req, res, url))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  fs.rmSync(DATA, { recursive: true, force: true })
  fs.rmSync(claude, { recursive: true, force: true })
})
beforeEach(() => {
  for (const d of [F.FLOWS_DIR, claude]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  fs.rmSync(SPEND_FILE, { force: true })
  const file = path.join(DATA, `token-index-${Math.random().toString(36).slice(2)}.json`)
  index = makeTokenIndex({ claudeDirs: [claude], match: 'my-repo', file })
  names = new Map()
  route = makeTokenRoute({ index, names: async () => names, labelOf: n => (n === 'flinki-v2-a9' ? 'Agent 3' : n), config: { ...CONFIG, tokens: undefined } })
})
const get = p => fetch(base + p)

test('a bad window is the score own 400 sentence; other paths and methods are not this route', async () => {
  for (const q of ['?days=8', '?days=al', '?days=-7']) {
    const r = await get(`/api/tokens${q}`)
    assert.equal(r.status, 400)
    assert.deepEqual(await r.json(), { error: 'The window must be 7, 30 or all days.' })
  }
  assert.equal((await get('/api/tokensx')).status, 404)
  assert.equal((await fetch(`${base}/api/tokens`, { method: 'POST' })).status, 405)
})

test('while the first build runs the route answers at once, building, with a progress figure; never cached', async () => {
  write(path.join(project, 's1.jsonl'), line('a'))
  const r = await get('/api/tokens?days=7')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const body = await r.json()
  assert.equal(body.building, true)
  assert.equal(typeof body.progress, 'number')
  await index.refresh()
  const done = await (await get('/api/tokens?days=7')).json()
  assert.equal(done.building, false)
  assert.equal(done.progress, 1)
  assert.equal(done.totals.input, 1_000_000)
  assert.ok(done.builtAt)
})

test('the numbers: by agent with the live name winning, by model, the estimate from the default prices and their source', async () => {
  write(path.join(project, 's1.jsonl'), JSON.stringify({ type: 'custom-title', customTitle: 'Old name' }) + '\n' + line('a', { output: 1_000_000 }))
  write(path.join(project, 's1', 'subagents', 'agent-q.jsonl'), line('b'))
  names.set('s1', 'flinki-v2-a9')
  await index.refresh()
  const body = await (await get('/api/tokens')).json()
  assert.equal(body.window.days, 30)
  assert.deepEqual(body.agents.map(a => [a.label, a.all, a.subs.all]), [['Agent 3', 3_000_000, 1_000_000]])
  assert.equal(body.cost.usd, 4 + 20 + 4)
  assert.equal(body.models[0].price.match, 'claude-opus-5-5')
  assert.equal(body.prices.source.url, 'https://platform.claude.com/docs/en/about-claude/pricing')
  assert.deepEqual(body.prices.errors, [])
})

test('per finished job divides by Pipeline time own count, and the dashboard own runs ride beside the estimate', async () => {
  write(path.join(project, 's1.jsonl'), line('a') + line('b'))
  putFlow('f1', ['ABC-1', 'ABC-2'])
  putFlow('f2')
  fs.writeFileSync(SPEND_FILE, [JSON.stringify({ at: ago(60_000), kind: 'chat', usd: 0.5 }), JSON.stringify({ at: ago(40 * DAY), kind: 'chat', usd: 9 })].join('\n') + '\n')
  await index.refresh()
  const body = await (await get('/api/tokens?days=7')).json()
  assert.deepEqual(body.perJob, { jobs: 3, tickets: 2, otherJobs: 1, tokens: 2_000_000 / 3, usd: 8 / 3 })
  assert.deepEqual(body.spend, { usd: 0.5, turns: 1 })
  assert.equal(body.cost.usd, 8) // never added to the spend
  const all = await (await get('/api/tokens?days=all')).json()
  assert.deepEqual(all.spend, { usd: 9.5, turns: 2 })
})

test('the user prices from config.json: a bad entry is named; with no price at all there is no dollar figure', async () => {
  write(path.join(project, 's1.jsonl'), line('a', { model: 'claude-haiku-5-5' }))
  route = makeTokenRoute({ index, names: async () => names, labelOf: n => n, config: { ...CONFIG, tokens: { prices: { 'claude-x': { input: 'free' } } } } })
  await index.refresh()
  const body = await (await get('/api/tokens?days=7')).json()
  assert.deepEqual(body.prices.errors, ['claude-x'])
  assert.equal(body.cost.usd, null)
  assert.deepEqual(body.cost.unpriced, ['claude-haiku-5-5'])
})

test('no transcripts at all: an honest empty answer, not an error', async () => {
  fs.rmSync(claude, { recursive: true, force: true })
  await index.refresh()
  const body = await (await get('/api/tokens?days=30')).json()
  assert.equal(body.building, false)
  assert.equal(body.totals.all, 0)
  assert.deepEqual(body.agents, [])
})

test('a request starts a refresh at most once in a while, in the background', async () => {
  let calls = 0
  const fake = { refresh: () => (calls++, Promise.resolve()), snapshot: () => ({ files: [], building: false, progress: 1, builtAt: null, lastRead: null }) }
  route = makeTokenRoute({ index: fake, names: async () => new Map(), labelOf: n => n, config: CONFIG, refreshMs: 60_000 })
  await get('/api/tokens')
  await get('/api/tokens')
  assert.equal(calls, 1)
  route.start()
  assert.equal(calls, 2) // the startup build is its own call
})
