// Tests for trash.mjs, the 24-hour Trash for flows: a deleted flow is ONE file data/trash/<id>.json
// ({ deletedAt, flow }), its evidence left where it is so a restore is whole, and an entry 24 hours
// old is purged with its evidence. Every call takes `now`, so no test waits a day. FACTORY_DATA_DIR
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

test('TRASH_MS is 24 hours', () => {
  assert.equal(T.TRASH_MS, 24 * HOUR)
})

test('moving a flow to the Trash takes it out of listFlows, writes ONE entry with the flow as stored, and keeps its evidence', () => {
  seed('dark')
  const stored = JSON.parse(fs.readFileSync(flowFile('dark'), 'utf8'))
  const r = T.moveToTrash('dark', { now: T0 })
  assert.equal(r.deletedAt, new Date(T0).toISOString())
  assert.equal(r.expiresAt, new Date(T0 + 24 * HOUR).toISOString())
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

test('listTrash: id, title, agent, status, deletedAt, expiresAt and leftMs, soonest to expire first', () => {
  seed('older', f => { f.title = 'Older'; f.agent = 'Agent 1' })
  seed('newer', f => { f.title = 'Newer'; f.status = 'done' })
  T.moveToTrash('newer', { now: T0 + 2 * HOUR })
  T.moveToTrash('older', { now: T0 })
  const items = T.listTrash({ now: T0 + 3 * HOUR })
  assert.deepEqual(items, [
    { id: 'older', title: 'Older', agent: 'Agent 1', status: 'open', deletedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 24 * HOUR).toISOString(), leftMs: 21 * HOUR },
    { id: 'newer', title: 'Newer', agent: 'Agent 3', status: 'done', deletedAt: new Date(T0 + 2 * HOUR).toISOString(), expiresAt: new Date(T0 + 26 * HOUR).toISOString(), leftMs: 23 * HOUR },
  ])
  assert.deepEqual(T.listTrash({ now: new Date(T0) }).map(i => i.leftMs), [24 * HOUR, 26 * HOUR], 'now may be a Date')
})

test('restore brings the flow back byte for byte, updatedAt unchanged, and empties its entry', () => {
  seed('dark')
  const before = fs.readFileSync(flowFile('dark'), 'utf8')
  T.moveToTrash('dark', { now: T0 })
  T.restoreFromTrash('dark', { now: T0 + HOUR })
  assert.equal(fs.readFileSync(flowFile('dark'), 'utf8'), before)
  assert.equal(fs.existsSync(entryFile('dark')), false)
  assert.equal(T.inTrash('dark'), false)
  assert.deepEqual(F.listFlows().flows.map(f => f.id), ['dark'])
})

test('restore refuses when a flow with that id exists again, and leaves both alone', () => {
  seed('dark')
  T.moveToTrash('dark', { now: T0 })
  seed('dark', f => { f.title = 'A new one' })
  assert.throws(() => T.restoreFromTrash('dark', { now: T0 + HOUR }), e => e.status === 409 && e.message === 'A flow called dark exists again. Delete or rename that one first.')
  assert.equal(F.readFlow('dark').title, 'A new one')
  assert.equal(T.inTrash('dark'), true)
})

test('restore refuses an entry that is missing, or past 24 hours (and purges that one)', () => {
  assert.throws(() => T.restoreFromTrash('nope', { now: T0 }), e => e.status === 404 && /nope/.test(e.message))
  seed('dark')
  T.moveToTrash('dark', { now: T0 })
  assert.throws(() => T.restoreFromTrash('dark', { now: T0 + 24 * HOUR }), e => e.status === 404 && /gone for good/.test(e.message))
  assert.equal(fs.existsSync(entryFile('dark')), false)
  assert.equal(fs.existsSync(evidence('dark')), false)
  assert.equal(fs.existsSync(flowFile('dark')), false)
})

test('restore refuses a stored flow that no longer validates, and keeps the entry', () => {
  fs.mkdirSync(path.dirname(entryFile('x')), { recursive: true })
  fs.writeFileSync(entryFile('bad'), JSON.stringify({ deletedAt: new Date(T0).toISOString(), flow: { id: 'bad', title: '', nodes: [] } }))
  assert.throws(() => T.restoreFromTrash('bad', { now: T0 + HOUR }), /title must be non-empty text/)
  assert.equal(T.inTrash('bad'), true)
  assert.equal(fs.existsSync(flowFile('bad')), false)
})

test('the expiry boundary: 24 hours minus 1 ms is kept, exactly 24 hours is purged', () => {
  seed('dark')
  T.moveToTrash('dark', { now: T0 })
  assert.deepEqual(T.purgeExpired({ now: T0 + 24 * HOUR - 1 }), [])
  assert.equal(T.inTrash('dark'), true)
  assert.equal(T.listTrash({ now: T0 + 24 * HOUR - 1 })[0].leftMs, 1)
  assert.deepEqual(T.purgeExpired({ now: T0 + 24 * HOUR }), ['dark'])
  assert.equal(T.inTrash('dark'), false)
  assert.equal(fs.existsSync(evidence('dark')), false, 'its evidence goes with it')
})

test('survives a restart: entries an earlier process wrote are purged from their stored time, with no memory of them', () => {
  // plain files, as an earlier run of the dashboard left them: nothing in this process ever saw them
  fs.mkdirSync(path.join(F.DATA_DIR, 'trash'), { recursive: true })
  const old = structuredClone(FIXTURE)
  for (const [id, at] of [['stale', T0 - 30 * HOUR], ['fresh', T0 - 2 * HOUR]]) {
    fs.writeFileSync(entryFile(id), JSON.stringify({ deletedAt: new Date(at).toISOString(), flow: { ...old, id } }))
    fs.mkdirSync(evidence(id), { recursive: true })
  }
  assert.deepEqual(T.purgeExpired({ now: T0 }), ['stale'])
  assert.equal(fs.existsSync(entryFile('stale')), false)
  assert.equal(fs.existsSync(evidence('stale')), false)
  assert.equal(fs.existsSync(entryFile('fresh')), true)
  assert.equal(fs.existsSync(evidence('fresh')), true)
})

test('listTrash purges the expired entries first', () => {
  seed('dark')
  T.moveToTrash('dark', { now: T0 })
  assert.deepEqual(T.listTrash({ now: T0 + 25 * HOUR }), [])
  assert.equal(fs.existsSync(entryFile('dark')), false)
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

test('a broken entry is listed as broken, never thrown, and is purged by its file time after 24 hours', () => {
  fs.mkdirSync(path.join(F.DATA_DIR, 'trash'), { recursive: true })
  fs.writeFileSync(entryFile('broken'), '{ not json')
  const t = new Date(T0)
  fs.utimesSync(entryFile('broken'), t, t)
  let items
  assert.doesNotThrow(() => (items = T.listTrash({ now: T0 + HOUR })))
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'broken')
  assert.equal(items[0].title, 'broken')
  assert.equal(items[0].broken, true)
  assert.equal(items[0].leftMs, 23 * HOUR)
  assert.deepEqual(T.purgeExpired({ now: T0 + 24 * HOUR }), ['broken'])
})

test('ids are held to the slug rule before any path is built', () => {
  for (const id of ['../x', '..', 'A', 'a/b', '', null]) {
    assert.throws(() => T.moveToTrash(id, { now: T0 }), /must match/, String(id))
    assert.throws(() => T.restoreFromTrash(id, { now: T0 }), /must match/, String(id))
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

test('purgeExpired keeps going past an entry that throws, and returns only the ids really purged', () => {
  seed('stuck')
  seed('fine')
  T.moveToTrash('stuck', { now: T0 })
  T.moveToTrash('fine', { now: T0 })
  let gone
  assert.doesNotThrow(() => (gone = T.purgeExpired({ now: T0 + 25 * HOUR, remove: failingFor(`${path.sep}evidence${path.sep}stuck`) })))
  assert.deepEqual(gone, ['fine'])
  assert.equal(T.inTrash('stuck'), true)
  assert.equal(T.inTrash('fine'), false)
  assert.deepEqual(T.purgeExpired({ now: T0 + 25 * HOUR }), ['stuck'], 'the next sweep finishes it')
})

test('restore: when the entry cannot be removed, the flow file is rolled back, so the flow is never in both places', () => {
  seed('dark')
  T.moveToTrash('dark', { now: T0 })
  assert.throws(() => T.restoreFromTrash('dark', { now: T0 + HOUR, remove: failingFor(`${path.sep}trash${path.sep}dark.json`) }), /EPERM/)
  assert.equal(fs.existsSync(flowFile('dark')), false, 'no live copy left behind')
  assert.equal(T.inTrash('dark'), true, 'still restorable')
  T.restoreFromTrash('dark', { now: T0 + HOUR })
  assert.ok(F.readFlow('dark'))
})

test('restore says whether the flow comes back archived', () => {
  seed('kept')
  seed('put-away', f => { f.archivedAt = '2026-11-14T08:00:00.000Z' })
  T.moveToTrash('kept', { now: T0 })
  T.moveToTrash('put-away', { now: T0 })
  assert.deepEqual(T.restoreFromTrash('kept', { now: T0 + HOUR }), { archived: false })
  assert.deepEqual(T.restoreFromTrash('put-away', { now: T0 + HOUR }), { archived: true })
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
