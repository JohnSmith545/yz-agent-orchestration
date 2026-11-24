// Tests for trash.mjs, the deleted flows of the flow archive: a deleted flow is ONE file data/trash/<id>.json
// ({ deletedAt, flow }), its evidence left where it is so a restore is whole, and NOTHING leaves by a timer:
// only Delete for good (purge) removes an entry and its evidence. Calls take `now`, so no test reads the clock. FACTORY_DATA_DIR
// points at a fresh temp folder BEFORE the imports, so no test ever touches the real data/ folder.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-test-'))
const F = await import('../flows.mjs')
const T = await import('../trash.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
const T0 = Date.parse('2026-11-14T09:00:00Z')
const HOUR = 60 * 60 * 1000
const flowFile = id => path.join(F.FLOWS_DIR, `${id}.json`)
const entryFile = id => path.join(F.DATA_DIR, 'trash', `${id}.json`)
const evidence = id => path.join(F.EVIDENCE_DIR, id)

/** The fixture as flow `id` (refs moved to its evidence folder), written through writeFlow, with one evidence file. */
function seed(id, edit = () => {}) {
  const f = structuredClone(FIXTURE)
  f.id = id
  for (const r of f.output.result) r.ref = r.ref.replace('dark-mode/', `${id}/`)
  for (const t of f.output.testing) t.shot = t.shot.replace('dark-mode/', `${id}/`)
  edit(f)
  F.writeFlow(f)
  fs.mkdirSync(evidence(id), { recursive: true })
  fs.writeFileSync(path.join(evidence(id), 'out-after.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return f
}

beforeEach(() => {
  for (const dir of [F.FLOWS_DIR, F.EVIDENCE_DIR, path.join(F.DATA_DIR, 'trash')]) fs.rmSync(dir, { recursive: true, force: true })
})

test('no timer: the 24-hour expiry and its sweep are gone', () => {
  assert.equal(T.TRASH_MS, undefined)
  assert.equal(T.purgeExpired, undefined)
})

test('moving a flow to the Trash takes it out of listFlows, writes ONE entry with the flow as stored, and keeps its evidence', () => {
  seed('dark')
  const stored = JSON.parse(fs.readFileSync(flowFile('dark'), 'utf8'))
  const r = T.moveToTrash('dark', { now: T0 })
  assert.deepEqual(r, { deletedAt: new Date(T0).toISOString() })
  assert.equal(fs.existsSync(flowFile('dark')), false)
  assert.deepEqual(F.listFlows().flows.map(f => f.id), [])
  const entry = JSON.parse(fs.readFileSync(entryFile('dark'), 'utf8'))
  assert.deepEqual(Object.keys(entry), ['deletedAt', 'flow'])
  assert.deepEqual(entry.flow, stored)
  assert.ok(fs.existsSync(path.join(evidence('dark'), 'out-after.png')), 'evidence stays for a restore')
  assert.equal(T.inTrash('dark'), true)
})

test('moving an unknown flow throws a plain error; a stale entry with the same id is replaced', () => {
  assert.throws(() => T.moveToTrash('nope', { now: T0 }), /No flow nope/)
  seed('dark')
  T.moveToTrash('dark', { now: T0 })
  seed('dark', f => { f.title = 'The second one' })
  T.moveToTrash('dark', { now: T0 + HOUR })
  const entry = JSON.parse(fs.readFileSync(entryFile('dark'), 'utf8'))
  assert.equal(entry.flow.title, 'The second one')
  assert.equal(entry.deletedAt, new Date(T0 + HOUR).toISOString())
})

test('listTrash: id, title, agent, status, tickets and deletedAt, the most recently deleted first', () => {
  seed('older', f => { f.title = 'Older'; f.agent = 'Agent 1'; f.tickets = ['FLA-1'] })
  seed('newer', f => { f.title = 'Newer'; f.status = 'done' })
  T.moveToTrash('older', { now: T0 })
  T.moveToTrash('newer', { now: new Date(T0 + 2 * HOUR) })
  assert.deepEqual(T.listTrash(), [
    { id: 'newer', title: 'Newer', agent: FIXTURE.agent, status: 'done', tickets: FIXTURE.tickets, deletedAt: new Date(T0 + 2 * HOUR).toISOString() },
    { id: 'older', title: 'Older', agent: 'Agent 1', status: FIXTURE.status, tickets: ['FLA-1'], deletedAt: new Date(T0).toISOString() },
  ])
})

test('an entry a year old is still listed and still restores: nothing leaves by a timer', () => {
  seed('dark')
  T.moveToTrash('dark', { now: T0 - 365 * 24 * HOUR })
  assert.deepEqual(T.listTrash().map(i => i.id), ['dark'])
  T.restoreFromTrash('dark')
  assert.ok(F.readFlow('dark'))
  assert.ok(fs.existsSync(path.join(evidence('dark'), 'out-after.png')), 'its screenshots are still there')
})

test('an entry an earlier version wrote (the 24-hour Trash) shows unchanged, and its file is never rewritten', () => {
  fs.mkdirSync(path.join(F.DATA_DIR, 'trash'), { recursive: true })
  const raw = JSON.stringify({ deletedAt: new Date(T0 - 30 * HOUR).toISOString(), flow: { ...structuredClone(FIXTURE), id: 'legacy' } }, null, 1)
  fs.writeFileSync(entryFile('legacy'), raw)
  assert.deepEqual(T.listTrash().map(i => [i.id, i.title, i.deletedAt]), [['legacy', FIXTURE.title, new Date(T0 - 30 * HOUR).toISOString()]])
  assert.equal(fs.readFileSync(entryFile('legacy'), 'utf8'), raw)
})

test('readTrashed: the deleted flow as stored with its deletedAt, for the read-only view; null otherwise', () => {
  seed('dark')
  const stored = JSON.parse(fs.readFileSync(flowFile('dark'), 'utf8'))
  T.moveToTrash('dark', { now: T0 })
  assert.deepEqual(T.readTrashed('dark'), { ...stored, deletedAt: new Date(T0).toISOString() })
  assert.equal(T.readTrashed('nope'), null)
  assert.equal(T.readTrashed('../x'), null)
  seed('dark') // a live flow with that id again: not deleted
  assert.equal(T.readTrashed('dark'), null)
})

test('restore brings the flow back byte for byte, updatedAt unchanged, and empties its entry', () => {
  seed('dark')
  const before = fs.readFileSync(flowFile('dark'), 'utf8')
  T.moveToTrash('dark', { now: T0 })
  T.restoreFromTrash('dark')
  assert.equal(fs.readFileSync(flowFile('dark'), 'utf8'), before)
  assert.equal(fs.existsSync(entryFile('dark')), false)
  assert.equal(T.inTrash('dark'), false)
  assert.deepEqual(F.listFlows().flows.map(f => f.id), ['dark'])
})

test('restore refuses when a flow with that id exists again, and leaves both alone', () => {
  seed('dark')
  T.moveToTrash('dark', { now: T0 })
  seed('dark', f => { f.title = 'A new one' })
  assert.throws(() => T.restoreFromTrash('dark'), e => e.status === 409 && e.message === 'A flow called dark exists again. Delete or rename that one first.')
  assert.equal(F.readFlow('dark').title, 'A new one')
  assert.equal(T.inTrash('dark'), true)
})

test('restore refuses an entry that is missing, in plain words', () => {
  assert.throws(() => T.restoreFromTrash('nope'), e => e.status === 404 && e.message === 'No deleted flow nope in the archive.')
})

test('restore refuses a stored flow that no longer validates, and keeps the entry', () => {
  fs.mkdirSync(path.dirname(entryFile('x')), { recursive: true })
  fs.writeFileSync(entryFile('bad'), JSON.stringify({ deletedAt: new Date(T0).toISOString(), flow: { id: 'bad', title: '', nodes: [] } }))
  assert.throws(() => T.restoreFromTrash('bad'), /title must be non-empty text/)
  assert.equal(T.inTrash('bad'), true)
  assert.equal(fs.existsSync(flowFile('bad')), false)
})

test('purge removes the entry and the evidence folder, nothing outside it, and is safe when either is missing', () => {
  seed('dark')
  seed('other')
  const loose = path.join(F.EVIDENCE_DIR, 'dark-notes.txt')
  fs.writeFileSync(loose, 'keep me')
  T.moveToTrash('dark', { now: T0 })
  T.purge('dark')
  assert.equal(fs.existsSync(entryFile('dark')), false)
  assert.equal(fs.existsSync(evidence('dark')), false)
  assert.ok(fs.existsSync(path.join(evidence('other'), 'out-after.png')), 'another flow keeps its evidence')
  assert.ok(fs.existsSync(loose), 'a file next to the folder stays')
  assert.ok(fs.existsSync(flowFile('other')))
  assert.doesNotThrow(() => T.purge('dark'), 'nothing left: no error')
  assert.doesNotThrow(() => T.purge('never-was'))
})

test('purge leaves the evidence alone when a live flow has that id again', () => {
  seed('dark')
  T.moveToTrash('dark', { now: T0 })
  seed('dark')
  T.purge('dark')
  assert.equal(T.inTrash('dark'), false)
  assert.ok(fs.existsSync(path.join(evidence('dark'), 'out-after.png')), 'the live flow keeps its screenshots')
})

test('a broken entry is listed as broken by its file time, never thrown, and never removed by a listing', () => {
  fs.mkdirSync(path.join(F.DATA_DIR, 'trash'), { recursive: true })
  fs.writeFileSync(entryFile('broken'), '{ not json')
  const t = new Date(T0)
  fs.utimesSync(entryFile('broken'), t, t)
  let items
  assert.doesNotThrow(() => (items = T.listTrash()))
  assert.deepEqual(items, [{ id: 'broken', title: 'broken', agent: '', status: '', tickets: [], deletedAt: new Date(T0).toISOString(), broken: true }])
  assert.throws(() => T.restoreFromTrash('broken'), e => e.status === 400 && /cannot be read/.test(e.message))
  assert.equal(T.inTrash('broken'), true)
})

test('ids are held to the slug rule before any path is built', () => {
  for (const id of ['../x', '..', 'A', 'a/b', '', null]) {
    assert.throws(() => T.moveToTrash(id, { now: T0 }), /must match/, String(id))
    assert.throws(() => T.restoreFromTrash(id), /must match/, String(id))
    assert.throws(() => T.purge(id), /must match/, String(id))
    assert.equal(T.inTrash(id), false, String(id))
  }
})

// ═══ resilience: a removal that fails (a reader holding a file open on Windows) ═══
// trash.mjs takes an optional `remove` (tests only) instead of the retrying rm, so a failure is injected without
// touching node:fs.

const failingFor = (needle, calls = []) => p => {
  calls.push(p)
  if (p.includes(needle)) throw Object.assign(new Error('EPERM: held open'), { code: 'EPERM' })
  fs.rmSync(p, { recursive: true, force: true })
}

test('purge removes the evidence FIRST: when that fails the entry stays, so the next purge tries again', () => {
  seed('dark')
  T.moveToTrash('dark', { now: T0 })
  const calls = []
  assert.throws(() => T.purge('dark', { remove: failingFor(`${path.sep}evidence${path.sep}dark`, calls) }), /EPERM/)
  assert.ok(calls[0].includes(`${path.sep}evidence${path.sep}`), 'the evidence folder is the first thing removed')
  assert.equal(T.inTrash('dark'), true, 'the entry is still there to retry')
  T.purge('dark')
  assert.equal(T.inTrash('dark'), false)
  assert.equal(fs.existsSync(evidence('dark')), false)
})

test('restore: when the entry cannot be removed, the flow file is rolled back, so the flow is never in both places', () => {
  seed('dark')
  T.moveToTrash('dark', { now: T0 })
  assert.throws(() => T.restoreFromTrash('dark', { remove: failingFor(`${path.sep}trash${path.sep}dark.json`) }), /EPERM/)
  assert.equal(fs.existsSync(flowFile('dark')), false, 'no live copy left behind')
  assert.equal(T.inTrash('dark'), true, 'still restorable')
  T.restoreFromTrash('dark')
  assert.ok(F.readFlow('dark'))
})

test('restore says whether the flow comes back archived', () => {
  seed('kept')
  seed('put-away', f => { f.archivedAt = '2026-11-14T08:00:00.000Z' })
  T.moveToTrash('kept', { now: T0 })
  T.moveToTrash('put-away', { now: T0 })
  assert.deepEqual(T.restoreFromTrash('kept'), { archived: false })
  assert.deepEqual(T.restoreFromTrash('put-away'), { archived: true })
})

test('isTrashed, the guard the routes and the CLI share: an entry AND no live flow file', () => {
  seed('dark')
  T.moveToTrash('dark', { now: T0 })
  assert.equal(T.isTrashed('dark'), true)
  seed('dark') // a live flow with that id again (an entry left behind)
  assert.equal(T.inTrash('dark'), true)
  assert.equal(T.isTrashed('dark'), false)
  assert.equal(T.isTrashed('../x'), false)
})
