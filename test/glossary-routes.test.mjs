// Tests for the glossary routes (GET /api/glossary, POST /api/glossary/learn,
// /term, /remove), POST /api/flows/<id>/ask-term and the glossary-first
// /api/explain. A real http server on port 0 calls factoryRoute with a stubbed
// learner, explainer and a recording relay: no Claude turn ever runs.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-routes-test-'))
const F = await import('../flows.mjs')
const G = await import('../glossary.mjs')
const { normalise } = await import('../terms.mjs')
const { factoryRoute } = await import('../factory-routes.mjs')
const { CONFIG } = await import('../config.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const fixture = name => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name + '.json'), 'utf8'))

const calls = []
const relay = { queueQuestion: (...a) => calls.push(['queueQuestion', ...a]) }
/** The learner, stubbed: records each call; `hold` makes it wait until released. */
const learned = []
let hold = null
const learn = async (terms, opts) => {
  learned.push({ terms, opts })
  if (hold) await hold.promise
  return { learned: terms.map(t => ({ key: normalise(t), term: t, short: 'x' })), skipped: [], cost: 0.002 }
}
const explained = []
const explain = async (text, opts) => (explained.push({ text, opts }), text === 'boom' ? { error: 'exited with code 1' } : { text: `About ${text}. It matters.`, cost: 0.003 })

let server
let base
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await factoryRoute(req, res, url, { relay, learn, explain }))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())
beforeEach(() => {
  calls.length = 0
  learned.length = 0
  explained.length = 0
  hold = null
  fs.rmSync(G.GLOSSARY_FILE, { force: true })
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
  fs.writeFileSync(path.join(F.FLOWS_DIR, 'dark-mode.json'), JSON.stringify(fixture('dark-mode')))
  fs.writeFileSync(path.join(F.FLOWS_DIR, 'chatty.json'), JSON.stringify({ ...fixture('no-visual'), id: 'chatty', agent: CONFIG.factory.chat.name }))
})

const get = p => fetch(base + p)
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const EVIL = { origin: 'http://evil.example' }

// ═══ GET /api/glossary ═══

test('GET /api/glossary lists every merged entry, built-in ones marked so, learned ones with their seenIn', async () => {
  G.saveTerm({ term: 'theme token', short: 'A named colour.', source: 'learned', flowId: 'dark-mode' })
  const r = await get('/api/glossary')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const { terms } = await r.json()
  const wt = terms.find(t => t.key === 'worktree')
  assert.deepEqual({ ...wt, short: typeof wt.short, more: typeof wt.more }, { key: 'worktree', term: 'worktree', short: 'string', more: 'string', source: 'built-in', at: null, seenIn: [] })
  const tt = terms.find(t => t.key === 'theme token')
  assert.equal(tt.source, 'learned')
  assert.deepEqual(tt.seenIn, ['dark-mode'])
  assert.equal(tt.more, null)
})

// ═══ POST /api/glossary/learn ═══

test('POST learn runs the learner once on the flow unknown marked words, with the sentences they came from', async () => {
  G.saveTerm({ term: 'theme token', short: 'Known.', source: 'agent' })
  const r = await post('/api/glossary/learn', { flowId: 'dark-mode' })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.cost, 0.002)
  assert.equal(learned.length, 1)
  assert.deepEqual(learned[0].terms, ['local storage', 'prefers-color-scheme'])
  assert.equal(learned[0].opts.flowId, 'dark-mode')
  assert.ok(learned[0].opts.context.some(s => s.includes('[local storage]')), learned[0].opts.context.join(' | '))
  assert.ok(!learned[0].opts.context.some(s => s.includes('[theme token]') && !s.includes('[local storage]') && !s.includes('[prefers')))
})

test('POST learn with every word known runs nothing and says so', async () => {
  for (const t of ['theme token', 'local storage', 'prefers-color-scheme']) G.saveTerm({ term: t, short: 'Known.', source: 'agent' })
  const r = await post('/api/glossary/learn', { flowId: 'dark-mode' })
  assert.deepEqual(await r.json(), { learned: [], skipped: [], cost: 0 })
  assert.equal(learned.length, 0)
})

test('POST learn a second time while one runs for the same flow answers busy and starts no second turn', async () => {
  let release
  hold = { promise: new Promise(r => (release = r)) }
  const first = post('/api/glossary/learn', { flowId: 'dark-mode' })
  while (!learned.length) await new Promise(r => setTimeout(r, 5))
  const second = await post('/api/glossary/learn', { flowId: 'dark-mode' })
  assert.deepEqual(await second.json(), { busy: true })
  release()
  assert.equal((await first).status, 200)
  assert.equal(learned.length, 1)
  hold = null
  await post('/api/glossary/learn', { flowId: 'dark-mode' })
  assert.equal(learned.length, 2, 'once the first is done, a new call runs')
})

test('POST learn is refused: another origin 403, a bad flow id 400, a missing flow 404', async () => {
  assert.equal((await post('/api/glossary/learn', { flowId: 'dark-mode' }, EVIL)).status, 403)
  for (const b of [{}, { flowId: 'Bad Id' }, { flowId: 5 }]) assert.equal((await post('/api/glossary/learn', b)).status, 400, JSON.stringify(b))
  assert.equal((await post('/api/glossary/learn', { flowId: 'gone' })).status, 404)
  assert.equal(learned.length, 0)
})

// ═══ POST /api/glossary/term and /remove ═══

test('POST term saves the user wording as you, which wins over everything', async () => {
  G.saveTerm({ term: 'race', short: 'Agent words.', source: 'agent' })
  const r = await post('/api/glossary/term', { term: 'Race', short: 'Two things at once, and the order matters.', more: 'Like two people booking one seat.' })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.ok, true)
  assert.equal(body.entry.key, 'race')
  assert.equal(body.entry.source, 'you')
  assert.equal(G.lookup('race').short, 'Two things at once, and the order matters.')
})

test('POST term is refused: another origin 403, a bad body 400', async () => {
  assert.equal((await post('/api/glossary/term', { term: 'race', short: 'x' }, EVIL)).status, 403)
  for (const b of [{}, { term: 'race' }, { term: 'x', short: 'ok' }, { term: 'race', short: 's'.repeat(301) }, { term: 'race', short: 'ok', more: 5 }]) {
    const r = await post('/api/glossary/term', b)
    assert.equal(r.status, 400, JSON.stringify(b))
    assert.ok((await r.json()).error)
  }
  assert.equal(G.lookup('race'), null)
})

test('POST remove removes a saved entry and answers what shows now; a built-in one is 400, an unknown 404', async () => {
  G.saveTerm({ term: 'worktree', short: 'Mine.', source: 'you' })
  G.saveTerm({ term: 'replay', short: 'Again.', source: 'learned' })
  const r = await post('/api/glossary/remove', { key: 'worktree' })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.ok, true)
  assert.equal(body.key, 'worktree')
  assert.equal(body.fallback.source, 'built-in')
  assert.equal((await (await post('/api/glossary/remove', { key: 'replay' })).json()).fallback, null)
  assert.equal((await post('/api/glossary/remove', { key: 'worktree' })).status, 400)
  assert.equal((await post('/api/glossary/remove', { key: 'never' })).status, 404)
  assert.equal((await post('/api/glossary/remove', {})).status, 400)
  assert.equal((await post('/api/glossary/remove', { key: 'replay' }, EVIL)).status, 403)
})

// ═══ POST /api/flows/<id>/ask-term ═══

test('ask-term on a coding agent flow queues one question for the relay and stamps nothing on the flow', async () => {
  const before = fs.readFileSync(path.join(F.FLOWS_DIR, 'dark-mode.json'), 'utf8')
  const r = await post('/api/flows/dark-mode/ask-term', { term: 'local storage', sentence: 'Saved the choice in [local storage].' })
  assert.deepEqual(await r.json(), { ok: true, via: 'relay' })
  assert.deepEqual(calls, [['queueQuestion', 'dark-mode', 'local storage', 'Saved the choice in [local storage].']])
  assert.equal(fs.readFileSync(path.join(F.FLOWS_DIR, 'dark-mode.json'), 'utf8'), before)
})

test('ask-term on the chat agent flow hands the question back for the drawer and queues nothing', async () => {
  const r = await post('/api/flows/chatty/ask-term', { term: 'service account', sentence: 'Give the scheduler its own [service account]' })
  const body = await r.json()
  assert.equal(body.ok, true)
  assert.equal(body.via, 'chat')
  assert.ok(body.text.startsWith('What does "service account" mean here, in plain words, and why did it matter for this work?'), body.text)
  assert.match(body.text, /Give the scheduler its own \[service account\]/)
  assert.match(body.text, /chatty/)
  assert.deepEqual(calls, [])
})

test('ask-term is refused: another origin 403, a bad term or sentence 400, a missing flow 404', async () => {
  assert.equal((await post('/api/flows/dark-mode/ask-term', { term: 'cache' }, EVIL)).status, 403)
  for (const b of [{}, { term: 'x' }, { term: 'two\nlines' }, { term: 'cache', sentence: 's'.repeat(301) }, { term: 'cache', sentence: 7 }]) {
    assert.equal((await post('/api/flows/dark-mode/ask-term', b)).status, 400, JSON.stringify(b))
  }
  assert.equal((await post('/api/flows/gone/ask-term', { term: 'cache' })).status, 404)
  assert.deepEqual(calls, [])
})

// ═══ POST /api/explain, glossary first ═══

test('explain answers a word the glossary knows from the glossary, with no turn and no cost', async () => {
  G.saveTerm({ term: 'theme token', short: 'A named colour.', more: 'One switch changes them all.', source: 'agent' })
  const r = await post('/api/explain', { text: 'Theme tokens' })
  assert.deepEqual(await r.json(), {
    text: 'A named colour. One switch changes them all.', cost: 0, from: 'glossary',
    entry: { key: 'theme token', term: 'theme token', short: 'A named colour.', more: 'One switch changes them all.', source: 'agent' },
  })
  assert.equal((await (await post('/api/explain', { text: 'merge base' })).json()).entry.source, 'built-in')
  assert.deepEqual(explained, [])
})

test('explain of an unknown short selection runs the turn with related entries and saves the answer as learned', async () => {
  G.saveTerm({ term: 'idempotency key', short: 'A unique id sent with a request.', source: 'agent' })
  const r = await post('/api/explain', { text: 'idempotency' })
  assert.deepEqual(await r.json(), { text: 'About idempotency. It matters.', cost: 0.003, from: 'model', saved: true })
  assert.deepEqual(explained[0].opts.related.map(e => e.key), ['idempotency key'])
  const e = G.lookup('idempotency')
  assert.equal(e.source, 'learned')
  assert.equal(e.short, 'About idempotency. It matters.')
})

test('explain of a selection over 4 words is answered but not saved', async () => {
  const r = await post('/api/explain', { text: 'why does the page reload twice' })
  assert.equal((await r.json()).saved, false)
  assert.equal(G.lookup('why does the page reload twice'), null)
})
