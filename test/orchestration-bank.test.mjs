// Tests for orchestration-bank.mjs: the saved orchestration styles, shared by every project, in ONE file under the
// data root (never a project's folder). The store functions are pure (bank in, bank out); reads and writes take
// the file. FACTORY_DATA_DIR is a temp folder BEFORE the import, so the default file is never the real one.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bank-test-'))
process.env.FACTORY_DATA_DIR = ROOT
const B = await import('../orchestration-bank.mjs')
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const SNAP = {
  parts: {
    agents: { coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2' }, pipeline: { qa: 'QA' }, chatName: 'Independent' },
    rules: { agents: { 'Agent 1': { spec: 'Builds.', rules: ['One.', 'Two.'] } } },
  },
}
let n = 0
const deps = (at = '2026-11-25T10:00:00.000Z') => ({ now: () => at, newId: () => `o${String(++n).padStart(8, '0')}` })
const FROM = { id: 'flinki-v2', name: 'Flinki v2' }
const add = (bank, name, at) => B.addEntry(bank, { name, from: FROM, snapshot: SNAP }, deps(at))

test('the bank is one file under the data ROOT, shared by every project', () => {
  assert.equal(B.BANK_FILE, path.join(ROOT, 'orchestration-bank.json'))
  assert.deepEqual({ ...B.BANK_LIMITS }, { name: 60, entries: 50, entryBytes: 262144 })
})

test('a missing or broken file is an empty bank that was never seeded', () => {
  const file = path.join(ROOT, 'none.json')
  assert.deepEqual(B.readBank(file), { seeded: false, entries: [], used: {} })
  fs.writeFileSync(file, '{ nope')
  assert.deepEqual(B.readBank(file), { seeded: false, entries: [], used: {} })
})

test('saving: the entry gets an id, the time, the project it came from and the snapshot', () => {
  const r = add(B.emptyBank(), '  Flinki default  ')
  assert.equal(r.entry.name, 'Flinki default')
  assert.match(r.entry.id, B.ENTRY_ID)
  assert.equal(r.entry.savedAt, '2026-11-25T10:00:00.000Z')
  assert.deepEqual(r.entry.from, FROM)
  assert.deepEqual(r.entry.snapshot, SNAP)
  assert.equal(r.bank.entries.length, 1)
})

test('names: required, at most 60 characters, one line, not one the bank already has', () => {
  assert.equal(B.checkName('').error, 'Give the orchestration a name.')
  assert.equal(B.checkName('   ').error, 'Give the orchestration a name.')
  assert.equal(B.checkName(7).error, 'Give the orchestration a name.')
  assert.equal(B.checkName('x'.repeat(61)).error, 'That name is too long. Keep it to 60 characters.')
  assert.equal(B.checkName('a\nb').error, 'Keep the name on one line.')
  assert.equal(B.checkName('x'.repeat(60)).name.length, 60)
  const { bank } = add(B.emptyBank(), 'Flinki default')
  assert.equal(add(bank, 'flinki DEFAULT').error, 'There is already an orchestration called flinki DEFAULT.')
})

test('at most 50 entries, then a plain refusal', () => {
  let bank = B.emptyBank()
  for (let i = 0; i < 50; i++) bank = add(bank, `Style ${i}`).bank
  assert.equal(add(bank, 'One more').error, 'The bank is full: it keeps 50 orchestrations. Delete one first.')
})

test('an entry over the size cap is refused, not cut', () => {
  const big = structuredClone(SNAP)
  big.parts.extra = 'x'.repeat(B.BANK_LIMITS.entryBytes)
  assert.equal(B.addEntry(B.emptyBank(), { name: 'Big', from: FROM, snapshot: big }, deps()).error, 'This orchestration is too large to save (over 256 KB).')
})

test('the list is newest first, with a one-line summary and never the whole snapshot', () => {
  let bank = add(B.emptyBank(), 'Old', '2026-11-20T10:00:00.000Z').bank
  bank = add(bank, 'New', '2026-11-25T10:00:00.000Z').bank
  const list = B.listEntries(bank)
  assert.deepEqual(list.map(e => e.name), ['New', 'Old'])
  assert.equal(list[0].summary, 'Master hands to 2 agents, QA tests, 2 rules')
  assert.equal(list[0].snapshot, undefined)
  assert.deepEqual(list[0].from, FROM)
})

test('rename, duplicate and delete, each with a plain refusal for an unknown id', () => {
  const first = add(B.emptyBank(), 'Flinki default')
  const id = first.entry.id
  const renamed = B.renameEntry(first.bank, id, 'Careful')
  assert.equal(renamed.entry.name, 'Careful')
  assert.equal(B.renameEntry(first.bank, 'o99999999', 'x').error, 'That orchestration is not in the bank.')
  assert.equal(B.renameEntry(first.bank, id, '').error, 'Give the orchestration a name.')
  assert.ok(!B.renameEntry(first.bank, id, 'Flinki default').error, 'its own name again is fine')

  const dup = B.duplicateEntry(renamed.bank, id, deps('2026-11-25T11:00:00.000Z'))
  assert.equal(dup.entry.name, 'Careful (copy)')
  assert.notEqual(dup.entry.id, id)
  assert.deepEqual(dup.entry.snapshot, SNAP)
  assert.equal(B.duplicateEntry(dup.bank, id, deps()).entry.name, 'Careful (copy 2)')
  assert.equal(B.duplicateEntry(dup.bank, 'o99999999', deps()).error, 'That orchestration is not in the bank.')

  const gone = B.deleteEntry(dup.bank, id)
  assert.deepEqual(gone.bank.entries.map(e => e.name), ['Careful (copy)'])
  assert.equal(B.deleteEntry(gone.bank, id).error, 'That orchestration is not in the bank.')
})

test('which entry a project last used: remembered by id, shown by its name now', () => {
  const first = add(B.emptyBank(), 'Flinki default')
  let bank = B.markUsed(first.bank, 'flinki-v2', first.entry)
  assert.deepEqual(B.usedBy(bank, 'flinki-v2'), { id: first.entry.id, name: 'Flinki default' })
  bank = B.renameEntry(bank, first.entry.id, 'Renamed').bank
  assert.deepEqual(B.usedBy(bank, 'flinki-v2'), { id: first.entry.id, name: 'Renamed' })
  bank = B.deleteEntry(bank, first.entry.id).bank
  assert.deepEqual(B.usedBy(bank, 'flinki-v2'), { id: first.entry.id, name: 'Renamed', removed: true }) // the name it had
  assert.equal(B.usedBy(bank, 'other'), null)
})

test('seeding: the first read of an empty bank saves the current style once, and never again', () => {
  let made = 0
  const make = () => (made++, { name: 'Flinki v2, 25 Nov 2026', from: FROM, snapshot: SNAP })
  const s1 = B.seedIfEmpty(B.emptyBank(), make, deps())
  assert.equal(s1.entry.name, 'Flinki v2, 25 Nov 2026')
  assert.equal(s1.bank.seeded, true)
  assert.equal(made, 1)
  const s2 = B.seedIfEmpty(B.deleteEntry(s1.bank, s1.entry.id).bank, make, deps())
  assert.equal(s2.entry, null) // the user deleted it: it does not come back
  assert.equal(made, 1)
  const s3 = B.seedIfEmpty({ seeded: false, entries: add(B.emptyBank(), 'Mine').bank.entries, used: {} }, make, deps())
  assert.equal(s3.entry, null) // a bank with any entry is never seeded
})

test('a dated name: the project and a short local date, with the time when asked; made unique in the bank', () => {
  const d = new Date(2026, 10, 25, 9, 5)
  assert.equal(B.datedName('Flinki v2', d), 'Flinki v2, 25 Nov 2026')
  assert.equal(B.datedName('Flinki v2', d, { time: true }), 'Flinki v2, 25 Nov 2026 09:05')
  const bank = add(B.emptyBank(), 'Flinki v2, 25 Nov 2026').bank
  assert.equal(B.uniqueName(bank, 'Flinki v2, 25 Nov 2026'), 'Flinki v2, 25 Nov 2026 (2)')
  assert.equal(B.uniqueName(bank, 'Other'), 'Other')
  assert.equal(B.datedName('x'.repeat(60), d).length, 60)
})

test('the file round-trips; a hand-edited entry that is not well formed is left out', () => {
  const file = path.join(ROOT, 'bank.json')
  const { bank } = add(B.emptyBank(), 'Kept')
  B.writeBank({ ...bank, entries: [...bank.entries, { id: '../x', name: 'Bad' }, { id: 'o12345678', name: '', snapshot: SNAP }] }, file)
  const back = B.readBank(file)
  assert.deepEqual(back.entries.map(e => e.name), ['Kept'])
  assert.equal(back.seeded, false)
  assert.deepEqual(fs.readdirSync(ROOT).filter(f => f.endsWith('.tmp')), [])
})

test('an entry id is checked before it is used for anything', () => {
  for (const ok of ['o00000001', 'oabcdef12']) assert.ok(B.ENTRY_ID.test(ok))
  for (const bad of ['', 'o1', 'x00000001', 'o0000000g', '../o0000001', 'o000000011']) assert.ok(!B.ENTRY_ID.test(bad), bad)
})
