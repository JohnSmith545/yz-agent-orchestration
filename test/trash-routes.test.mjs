// Tests for the flow archive routes (trash-routes.mjs, mounted by factory-routes.mjs): Archive and Delete
// on a flow, the archive list (Archived and Deleted), Restore and Delete for good, and the read-only view. A real http server on port 0
// calls factoryRoute with a recording relay (one test swaps in the real queue). FACTORY_DATA_DIR
// points at a fresh temp folder BEFORE the imports, so no test ever touches the real data/ folder.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-routes-test-'))
const F = await import('../flows.mjs')
const T = await import('../trash.mjs')
const { factoryRoute } = await import('../factory-routes.mjs')
const { makeRelay } = await import('../relay.mjs')
const { CONFIG } = await import('../config.mjs')

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
/** The fixture as flow `dark` (open, Agent 3, one open ask), refs moved to its evidence folder. */
function darkFixture(edit = () => {}) {
  const f = { ...structuredClone(FIXTURE), id: 'dark' }
  for (const r of f.output.result) r.ref = r.ref.replace('dark-mode/', 'dark/')
  for (const t of f.output.testing) t.shot = t.shot.replace('dark-mode/', 'dark/')
  edit(f)
  return f
}

const calls = []
const stub = {
  queue: (...a) => calls.push(['queue', ...a]),
  queueStatus: (...a) => calls.push(['queueStatus', ...a]),
  queueRequest: (...a) => calls.push(['queueRequest', ...a]),
  queueDeleted: (...a) => calls.push(['queueDeleted', ...a]),
  drop: (...a) => calls.push(['drop', ...a]),
  deliverNow: async () => ({ ok: true }),
}
let relay = stub

let server
let base
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await factoryRoute(req, res, url, { relay }))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  calls.length = 0
  relay = stub
  for (const dir of [F.FLOWS_DIR, F.EVIDENCE_DIR, T.TRASH_DIR]) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
  fs.writeFileSync(path.join(F.FLOWS_DIR, 'dark.json'), JSON.stringify(darkFixture()))
  fs.mkdirSync(path.join(F.EVIDENCE_DIR, 'dark'), { recursive: true })
  fs.writeFileSync(path.join(F.EVIDENCE_DIR, 'dark', 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
})

const get = p => fetch(base + p)
const post = (p, body = {}, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const plain = v => JSON.parse(JSON.stringify(v))

// ═══ Delete ═══

test('deleting an open flow without confirm asks first (409 needsConfirm) and changes nothing', async () => {
  const r = await post('/api/flows/dark/delete')
  assert.equal(r.status, 409)
  assert.deepEqual(await r.json(), { needsConfirm: true, message: 'Agent 3 may still be working on this. Delete it anyway?' })
  assert.ok(F.readFlow('dark'))
  assert.equal(T.inTrash('dark'), false)
  assert.deepEqual(calls, [])
  fs.writeFileSync(path.join(F.FLOWS_DIR, 'dark.json'), JSON.stringify(darkFixture(f => { f.status = 'blocked' })))
  assert.equal((await post('/api/flows/dark/delete', { confirm: 'yes' })).status, 409, 'blocked too, and only true confirms')
})

test('deleting an open flow with confirm: queued items dropped, the agent told once, the flow in Deleted', async () => {
  const r = await post('/api/flows/dark/delete', { confirm: true })
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.deepEqual(Object.keys(j), ['ok', 'deletedAt'], 'no expiry any more')
  assert.equal(j.ok, true)
  assert.ok(Date.parse(j.deletedAt))
  assert.deepEqual(plain(calls), [['drop', 'dark'], ['queueDeleted', 'dark', 'Add a dark mode toggle', 'Agent 3']])
  assert.equal(F.readFlow('dark'), null)
  assert.equal(T.inTrash('dark'), true)
  assert.ok(fs.existsSync(path.join(F.EVIDENCE_DIR, 'dark', 'shot.png')), 'evidence kept for a restore')
})

test('a done flow is deleted at once, and its agent is not told', async () => {
  fs.writeFileSync(path.join(F.FLOWS_DIR, 'dark.json'), JSON.stringify(darkFixture(f => { f.status = 'done' })))
  const r = await post('/api/flows/dark/delete')
  assert.equal(r.status, 200)
  assert.deepEqual(plain(calls), [['drop', 'dark']])
  assert.equal(T.inTrash('dark'), true)
})

test('the chat agent own open flow: deleted, and nothing relayed (no paid turn starts without the user)', async () => {
  fs.writeFileSync(path.join(F.FLOWS_DIR, 'dark.json'), JSON.stringify(darkFixture(f => { f.agent = CONFIG.factory.chat.name })))
  const r = await post('/api/flows/dark/delete', { confirm: true })
  assert.equal(r.status, 200)
  assert.deepEqual(plain(calls), [['drop', 'dark']])
})

test('with the real queue: an answer queued for the flow is dropped at delete time and only the stop line waits', async () => {
  relay = makeRelay({ run: async () => ({ ok: true, out: 'SENT', err: '' }), delayMs: 60_000 })
  assert.equal((await post('/api/flows/dark/answer', { node: 'n3', answer: 'yes' })).status, 200)
  assert.deepEqual(relay.status().pending, [{ flowId: 'dark', nodeId: 'n3' }])
  assert.equal((await post('/api/flows/dark/delete', { confirm: true })).status, 200)
  assert.deepEqual(relay.status().pending, [{ flowId: 'dark', nodeId: null }])
  relay.drop('dark') // no timer left behind
})

test('with the real queue: a restore (Undo) before the stop line went cancels it, so the agent is never told to stop a flow that is back', async () => {
  relay = makeRelay({ run: async () => ({ ok: true, out: 'SENT', err: '' }), delayMs: 60_000 })
  assert.equal((await post('/api/flows/dark/delete', { confirm: true })).status, 200)
  assert.deepEqual(relay.status().pending, [{ flowId: 'dark', nodeId: null }])
  assert.equal((await post('/api/trash/dark/restore')).status, 200)
  assert.deepEqual(relay.status().pending, [])
})

test('deleting an unknown flow is 404', async () => {
  const r = await post('/api/flows/nope/delete', { confirm: true })
  assert.equal(r.status, 404)
  assert.match((await r.json()).error, /No flow nope/)
})

// ═══ A deleted id ═══

test('every flow route that would change a deleted flow answers 404: <id> was deleted: it is in the flow archive.', async () => {
  await post('/api/flows/dark/delete', { confirm: true })
  for (const [p, body] of [['/api/flows/dark/answer', { node: 'n3', answer: 'yes' }], ['/api/flows/dark/archive', { archived: true }], ['/api/flows/dark/delete', { confirm: true }], ['/api/flows/dark/verify', { node: 'n1', verified: true }], ['/api/flows/dark/pr']]) {
    const r = body ? await post(p, body) : await get(p)
    assert.equal(r.status, 404, p)
    assert.deepEqual(await r.json(), { error: 'dark was deleted: it is in the flow archive.' }, p)
  }
  assert.equal(T.inTrash('dark'), true)
})

test('GET /api/flows/<id> on a deleted flow opens it read-only: the flow as stored, with derived, its route and deletedAt', async () => {
  await post('/api/flows/dark/delete', { confirm: true })
  const r = await get('/api/flows/dark')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.title, 'Add a dark mode toggle')
  assert.ok(Date.parse(j.deletedAt))
  assert.ok(j.derived && Array.isArray(j.derived.waiting))
  assert.ok(j.route && Array.isArray(j.progress))
  assert.equal(F.readFlow('dark'), null, 'reading never brings it back')
})

// ═══ The flow archive ═══

test('GET /api/archive: Archived and Deleted, each row with title, agent, status, tickets and its time; restore puts one back; again it is 404', async () => {
  fs.writeFileSync(path.join(F.FLOWS_DIR, 'kept.json'), JSON.stringify({ ...darkFixture(), id: 'kept', title: 'Kept away', output: undefined }))
  await post('/api/flows/kept/archive', { archived: true })
  await post('/api/flows/dark/delete', { confirm: true })
  const j = await (await get('/api/archive')).json()
  assert.deepEqual(Object.keys(j), ['archived', 'deleted'])
  assert.deepEqual(j.archived.map(i => [i.id, i.title, i.agent, i.status, i.tickets]), [['kept', 'Kept away', 'Agent 3', 'open', FIXTURE.tickets]])
  assert.ok(Date.parse(j.archived[0].archivedAt))
  assert.deepEqual(j.deleted.map(i => [i.id, i.title, i.agent, i.status, i.tickets]), [['dark', 'Add a dark mode toggle', 'Agent 3', 'open', FIXTURE.tickets]])
  assert.ok(Date.parse(j.deleted[0].deletedAt))
  const r = await post('/api/trash/dark/restore')
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, archived: false })
  assert.equal(F.readFlow('dark').title, 'Add a dark mode toggle')
  assert.equal((await post('/api/trash/dark/restore')).status, 404)
})

test('restoring a flow that was archived says so: { ok, archived: true }, and it is back in Archived', async () => {
  await post('/api/flows/dark/archive', { archived: true })
  await post('/api/flows/dark/delete', { confirm: true })
  const r = await post('/api/trash/dark/restore')
  assert.deepEqual(await r.json(), { ok: true, archived: true })
  assert.deepEqual((await (await get('/api/flows?archived=1')).json()).flows.map(f => f.id), ['dark'])
})

test('deleted flows that cannot be read never break the flows list (the count is left out) or the archive (an empty group and a sentence)', async () => {
  fs.writeFileSync(T.TRASH_DIR, 'not a folder')
  try {
    const r = await get('/api/flows')
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.deepEqual(j.flows.map(f => f.id), ['dark'])
    assert.deepEqual(j.counts, { archived: 0 })
    const a = await (await get('/api/archive')).json()
    assert.deepEqual(a.deleted, [])
    assert.match(a.deletedError, /^The deleted flows could not be read: /)
  } finally {
    fs.rmSync(T.TRASH_DIR, { force: true })
  }
})

test('an entry left behind beside a live flow of that id is not a deleted flow: the live flow answers', async () => {
  await post('/api/flows/dark/delete', { confirm: true })
  fs.writeFileSync(path.join(F.FLOWS_DIR, 'dark.json'), JSON.stringify(darkFixture(f => { f.title = 'A new one' })))
  const r = await get('/api/flows/dark')
  assert.equal(r.status, 200)
  assert.equal((await r.json()).title, 'A new one')
})

test('restore when a flow with that id exists again is 409 with the plain refusal', async () => {
  await post('/api/flows/dark/delete', { confirm: true })
  fs.writeFileSync(path.join(F.FLOWS_DIR, 'dark.json'), JSON.stringify(darkFixture(f => { f.title = 'A new one' })))
  const r = await post('/api/trash/dark/restore')
  assert.equal(r.status, 409)
  assert.deepEqual(await r.json(), { error: 'A flow called dark exists again. Delete or rename that one first.' })
})

test('purge (Delete for good) removes the entry and the evidence; an unknown id is 404; a bad id is 400', async () => {
  await post('/api/flows/dark/delete', { confirm: true })
  const r = await post('/api/trash/dark/purge')
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true })
  assert.equal(T.inTrash('dark'), false)
  assert.equal(fs.existsSync(path.join(F.EVIDENCE_DIR, 'dark')), false)
  assert.equal((await post('/api/trash/dark/purge')).status, 404)
  assert.equal((await post('/api/trash/..%2Fx/purge')).status, 400)
})

// ═══ Archive ═══

test('archive hides the flow from /api/flows, counts it, lists it under ?archived=1, and a direct link still opens it', async () => {
  const r = await post('/api/flows/dark/archive', { archived: true })
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.ok(Date.parse(j.archivedAt))
  const list = await (await get('/api/flows')).json()
  assert.deepEqual(list.flows, [])
  assert.deepEqual(list.counts, { archived: 1, deleted: 0 })
  assert.deepEqual((await (await get('/api/flows?archived=1')).json()).flows.map(f => f.id), ['dark'])
  assert.equal((await get('/api/flows/dark')).status, 200)
  const back = await post('/api/flows/dark/archive', { archived: false })
  assert.deepEqual(await back.json(), { ok: true, archivedAt: null })
  assert.equal('archivedAt' in F.readFlow('dark'), false)
  assert.deepEqual((await (await get('/api/flows')).json()).flows.map(f => f.id), ['dark'])
})

test('archive needs archived true or false', async () => {
  const r = await post('/api/flows/dark/archive', { archived: 'yes' })
  assert.equal(r.status, 400)
  assert.equal('archivedAt' in F.readFlow('dark'), false)
})

test('the plain /api/flows answer counts the deleted flows too, and keeps flows and invalid', async () => {
  await post('/api/flows/dark/delete', { confirm: true })
  const j = await (await get('/api/flows')).json()
  assert.deepEqual(Object.keys(j), ['flows', 'invalid', 'counts'])
  assert.deepEqual(j.counts, { archived: 0, deleted: 1 })
})

// ═══ Same origin ═══

test('a cross-origin POST to archive, delete, restore or purge is refused and changes nothing', async () => {
  const evil = { origin: 'http://evil.example' }
  assert.equal((await post('/api/flows/dark/archive', { archived: true }, evil)).status, 403)
  assert.equal((await post('/api/flows/dark/delete', { confirm: true }, evil)).status, 403)
  assert.equal(T.inTrash('dark'), false)
  await post('/api/flows/dark/delete', { confirm: true })
  assert.equal((await post('/api/trash/dark/restore', {}, evil)).status, 403)
  assert.equal((await post('/api/trash/dark/purge', {}, evil)).status, 403)
  assert.equal(T.inTrash('dark'), true)
})

// ═══ server.mjs wiring (it starts a server on import, so it is read, not run) ═══

test('server.mjs routes /api/trash and /api/archive, and no longer sweeps anything away on a timer', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server.mjs'), 'utf8')
  assert.match(src, /const FACTORY_PREFIXES = \[[^\]]*'\/api\/trash'/)
  assert.match(src, /const FACTORY_PREFIXES = \[[^\]]*'\/api\/archive'/)
  assert.doesNotMatch(src, /purgeExpired|sweepTrash/)
})
