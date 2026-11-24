// Tests for the SCRIPT context routes (script-context-routes.mjs) and the gatherer the generate route uses:
// GET /api/script/context, PUT /api/script/context, POST /api/script/context/notes, PUT and DELETE
// /api/script/context/notes/<id>. A real http server on port 0 with a temp data file, a stub brief and a stub
// session list: the real data/ folder and ~/.claude are never read.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'script-context-routes-test-'))
const { makeScriptContextRoute, makeContextGatherer } = await import('../script-context-routes.mjs')
const C = await import('../script-context.mjs')
const TMP = process.env.FACTORY_DATA_DIR
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const FILE = path.join(TMP, 'script-context.json')
const BRIEF = '### What it is\nA team of agents.'
const transcript = path.join(TMP, 'master.jsonl')
fs.writeFileSync(transcript, [
  { type: 'user', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'Ship the release notes.' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Drafting them now.' }] } },
].map(r => JSON.stringify(r)).join('\n'))
const SESSIONS = async () => [
  { label: 'Master', state: 'working', transcript: async () => transcript },
  { label: 'Agent 1', state: 'idle', transcript: async () => null },
]

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
  route = makeScriptContextRoute({ port, file: FILE, brief: () => BRIEF, sessions: SESSIONS })
  base = `http://127.0.0.1:${port}`
})
after(() => server.close())

const call = (method, p, body, headers = {}) =>
  fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
const reset = () => fs.rmSync(FILE, { force: true })

test('GET: the defaults, the brief text, the running sessions as choices, the limits', async () => {
  reset()
  const res = await call('GET', '/api/script/context')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const v = await res.json()
  assert.deepEqual(v.orchestration, { on: true, chars: BRIEF.length, text: BRIEF })
  assert.deepEqual(v.session, { on: null, choices: [{ label: 'Master', state: 'working' }, { label: 'Agent 1', state: 'idle' }], max: 12_000 })
  assert.deepEqual(v.notes, [])
  assert.equal(v.total, BRIEF.length)
  assert.deepEqual(v.limits, { titleMax: 80, textMax: 20_000, notesMax: 40, totalMax: 60_000, sessionMax: 12_000 })
})

test('POST a note: 201 with the note; it shows in GET and counts in the total', async () => {
  reset()
  const res = await call('POST', '/api/script/context/notes', { title: 'Product', text: 'Lumen is a reading app.' })
  assert.equal(res.status, 201)
  const { note } = await res.json()
  assert.equal(note.title, 'Product')
  assert.equal(note.on, true)
  assert.equal(note.chars, 23)
  const v = await (await call('GET', '/api/script/context')).json()
  assert.deepEqual(v.notes.map(n => [n.id, n.title, n.text, n.on, n.chars]), [[note.id, 'Product', 'Lumen is a reading app.', true, 23]])
  assert.ok(v.notes[0].updatedAt)
  assert.equal(v.total, BRIEF.length + 23)
})

test('a bad note is a 400 with a plain sentence, and nothing is written', async () => {
  reset()
  for (const body of [{}, { title: '', text: 'x' }, { title: 'T', text: '' }, { title: 'T', text: 'x'.repeat(20_001) }]) {
    const res = await call('POST', '/api/script/context/notes', body)
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40))
    assert.match((await res.json()).error, /\.$/)
  }
  assert.equal((await call('POST', '/api/script/context/notes', '{nope')).status, 400)
  assert.equal(fs.existsSync(FILE), false)
})

test('PUT a note: its switch, title and text; an unknown id is a 404', async () => {
  reset()
  const { note } = await (await call('POST', '/api/script/context/notes', { title: 'T', text: 'one' })).json()
  const res = await call('PUT', `/api/script/context/notes/${note.id}`, { on: false, text: 'two' })
  assert.equal(res.status, 200)
  const out = await res.json()
  assert.equal(out.note.on, false)
  assert.equal(out.note.text, 'two')
  const v = await (await call('GET', '/api/script/context')).json()
  assert.equal(v.total, BRIEF.length, 'a note that is off counts for nothing')
  assert.equal((await call('PUT', '/api/script/context/notes/n-missing', { on: true })).status, 404)
  assert.equal((await call('PUT', `/api/script/context/notes/${note.id}`, { on: 'yes' })).status, 400)
})

test('DELETE a note; a second delete is a 404', async () => {
  reset()
  const { note } = await (await call('POST', '/api/script/context/notes', { title: 'T', text: 'x' })).json()
  assert.equal((await call('DELETE', `/api/script/context/notes/${note.id}`)).status, 200)
  assert.equal((await call('DELETE', `/api/script/context/notes/${note.id}`)).status, 404)
  assert.deepEqual((await (await call('GET', '/api/script/context')).json()).notes, [])
})

test('PUT the options: the brief off, a session chosen; a chosen session that stops running stays listed as not running', async () => {
  reset()
  assert.equal((await call('PUT', '/api/script/context', { orchestration: false, session: 'Master' })).status, 200)
  let v = await (await call('GET', '/api/script/context')).json()
  assert.equal(v.orchestration.on, false)
  assert.equal(v.total, 0)
  assert.equal(v.session.on, 'Master')
  assert.equal((await call('PUT', '/api/script/context', { session: 'Agent 9' })).status, 200)
  v = await (await call('GET', '/api/script/context')).json()
  assert.deepEqual(v.session.choices.at(-1), { label: 'Agent 9', state: 'not running' })
  assert.equal((await call('PUT', '/api/script/context', { orchestration: 'no' })).status, 400)
  assert.equal((await call('PUT', '/api/script/context', {})).status, 400)
})

test('every write checks the Origin: another site is refused, the page itself is fine', async () => {
  reset()
  const evil = { origin: 'http://evil.example' }
  assert.equal((await call('POST', '/api/script/context/notes', { title: 'T', text: 'x' }, evil)).status, 403)
  assert.equal((await call('PUT', '/api/script/context', { orchestration: false }, evil)).status, 403)
  assert.equal((await call('PUT', '/api/script/context/notes/n-1', { on: false }, evil)).status, 403)
  assert.equal((await call('DELETE', '/api/script/context/notes/n-1', undefined, evil)).status, 403)
  assert.equal(fs.existsSync(FILE), false)
  assert.equal((await call('POST', '/api/script/context/notes', { title: 'T', text: 'x' }, { origin: `http://localhost:${port}` })).status, 201)
})

test('a broken session list still answers GET, with no choices', async () => {
  const route = makeScriptContextRoute({ port, file: FILE, brief: () => BRIEF, sessions: async () => { throw new Error('x') } })
  const s = createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, 'http://localhost')))) res.writeHead(404).end()
  })
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const v = await (await fetch(`http://127.0.0.1:${s.address().port}/api/script/context`)).json()
  assert.deepEqual(v.session.choices, [])
  s.close()
})

test('other paths and methods are not this route', async () => {
  assert.equal((await call('GET', '/api/script/other')).status, 404)
  assert.equal((await call('POST', '/api/script/generate', {})).status, 404)
  assert.equal((await call('PATCH', '/api/script/context', {})).status, 405)
  assert.equal((await call('GET', '/api/script/context/notes/BAD..id')).status, 404)
})

// ═══ the gatherer the generate route calls ═══

test('the gatherer: the brief when on, the chosen session, then the notes that are on, oldest first', async () => {
  reset()
  const ctx = C.defaults()
  C.addNote(ctx, { title: 'First', text: 'one' }, { now: '2026-11-24T10:00:00.000Z', id: 'n-1' })
  C.addNote(ctx, { title: 'Off', text: 'hidden' }, { now: '2026-11-24T10:01:00.000Z', id: 'n-2' })
  C.addNote(ctx, { title: 'Second', text: 'two' }, { now: '2026-11-24T10:02:00.000Z', id: 'n-3' })
  C.editNote(ctx, 'n-2', { on: false })
  ctx.session = 'Master'
  C.writeContext(ctx, FILE)
  const gather = makeContextGatherer({ file: FILE, brief: () => BRIEF, sessions: SESSIONS })
  const { parts, skipped } = await gather()
  assert.deepEqual(parts.map(p => p.title), ['Your orchestration', 'Live session: Master', 'First', 'Second'])
  assert.equal(parts[1].text, 'User: Ship the release notes.\n\nAssistant: Drafting them now.')
  assert.equal(parts[1].keep, 'end')
  assert.deepEqual(skipped, [])
})

test('the gatherer: nothing on is no parts; a session that is gone and a brief that fails are skipped with reasons', async () => {
  reset()
  C.writeContext({ orchestration: false, session: null, notes: [] }, FILE)
  assert.deepEqual(await makeContextGatherer({ file: FILE, brief: () => BRIEF, sessions: SESSIONS })(), { parts: [], skipped: [] })
  C.writeContext({ orchestration: true, session: 'Agent 7', notes: [] }, FILE)
  const out = await makeContextGatherer({ file: FILE, brief: () => { throw new Error('no config') }, sessions: SESSIONS })()
  assert.deepEqual(out.parts, [])
  assert.deepEqual(out.skipped, [
    { title: 'Your orchestration', why: 'It could not be written just now.' },
    { title: 'Live session: Agent 7', why: 'Agent 7 is not running now.' },
  ])
})
