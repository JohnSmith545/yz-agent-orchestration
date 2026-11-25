// Tests for Completed in the flow store (flows.mjs) and the agent CLI (tools/flow-cli.mjs): `completedAt` and
// `completedBy` are the USER'S, like archivedAt. A `flow write` keeps or drops the stored mark exactly as it does
// archivedAt and never sets it; no CLI command sets it; a NEW open ask brings a completed flow back with its archive;
// and `flow new` reminds (stderr, exit 0) when the outputs waiting for sign-off reach outputs.max.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-store-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const { CONFIG } = await import('../config.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-store-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
const AT = '2026-11-20T09:00:00.000Z'
const MARK = { completedAt: AT, completedBy: 'you', archivedAt: AT }
function fx(id, edit = () => {}) {
  const f = structuredClone(FIXTURE)
  f.id = id
  for (const r of f.output.result) r.ref = r.ref.replace('dark-mode/', `${id}/`)
  for (const t of f.output.testing) t.shot = t.shot.replace('dark-mode/', `${id}/`)
  edit(f)
  return f
}
const run = (argv, config) => runFlow(argv, { by: 'Agent 3', cwd: TMP, ...(config ? { config } : {}) })

beforeEach(() => fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true }))

// ═══ validation ═══

test('validation: completedAt and uncompletedAt are real ISO times, completedBy is you', () => {
  assert.deepEqual(F.validateFlow(fx('dark', f => Object.assign(f, MARK, { uncompletedAt: AT }))), [])
  assert.deepEqual(F.validateFlow(fx('dark', f => { f.completedAt = '2026' })), ['completedAt must be a time'])
  assert.deepEqual(F.validateFlow(fx('dark', f => { f.uncompletedAt = 7 })), ['uncompletedAt must be a time'])
  assert.deepEqual(F.validateFlow(fx('dark', f => { f.completedBy = 'Agent 3' })), ['completedBy must be you'])
})

// ═══ flow write keeps or drops it like archivedAt, and never sets it ═══

test('flow write: the stored mark is kept, one the agent sends is ignored, and a flow never completed stays so', () => {
  const stored = fx('dark', f => Object.assign(f, MARK))
  const incoming = fx('dark')
  const kept = F.mergeKeepingAnswers(incoming, stored)
  assert.equal(kept.completedAt, AT, 'leaving it out does not uncomplete')
  assert.equal(kept.completedBy, 'you')
  assert.equal(kept.archivedAt, AT)
  const sneaky = F.mergeKeepingAnswers(fx('dark', f => Object.assign(f, { completedAt: '2026-11-25T00:00:00.000Z', completedBy: 'you' })), stored)
  assert.equal(sneaky.completedAt, AT, 'nor change it')
  const forged = F.mergeKeepingAnswers(fx('dark', f => Object.assign(f, MARK, { uncompletedAt: AT })), fx('dark'))
  for (const k of ['completedAt', 'completedBy', 'archivedAt', 'uncompletedAt']) assert.equal(k in forged, false, `an agent cannot set ${k}`)
  const fresh = F.mergeKeepingAnswers(fx('new-one', f => Object.assign(f, MARK)), null)
  assert.equal('completedAt' in fresh, false, 'nor on a new flow')
  const back = F.mergeKeepingAnswers(fx('dark'), fx('dark', f => { f.uncompletedAt = AT }))
  assert.equal(back.uncompletedAt, AT, 'the uncompleted note is the stored one too')
})

test('no CLI path sets completedAt: write, set and new all leave it unset', () => {
  const file = path.join(TMP, 'dark.json')
  fs.writeFileSync(file, JSON.stringify(fx('dark', f => Object.assign(f, MARK, { status: 'done', route: { type: 'ask' } }))))
  assert.equal(run(['write', file]).code, 0)
  assert.equal('completedAt' in F.readFlow('dark'), false)
  assert.equal('archivedAt' in F.readFlow('dark'), false)
  assert.equal(run(['set', 'dark', '--completedAt', AT, '--completedBy', 'you', '--status', 'done']).code, 0)
  assert.equal('completedAt' in F.readFlow('dark'), false, 'set takes no such flag')
  for (const cmd of ['complete', 'completed', 'uncomplete']) assert.equal(run([cmd, 'dark']).code, 1, `no ${cmd} command`)
  assert.doesNotMatch(run(['nope']).out, /^\s+(un)?complete/im, 'the usage names no such command')
})

test('flow write on a completed flow keeps it completed and archived, and keeps its updatedAt moving as usual', () => {
  F.writeFlow(fx('dark', f => Object.assign(f, MARK, { status: 'done' })))
  const file = path.join(TMP, 'dark2.json')
  fs.writeFileSync(file, JSON.stringify(fx('dark', f => { f.status = 'done'; f.title = 'Retitled' })))
  assert.equal(run(['write', file]).code, 0)
  const now = F.readFlow('dark')
  assert.equal(now.title, 'Retitled')
  assert.equal(now.completedAt, AT)
  assert.equal(now.archivedAt, AT)
})

// ═══ a new question brings it back ═══

test('a NEW open ask on a completed flow clears the mark with the archive, so a question is never hidden', () => {
  F.writeFlow(fx('dark', f => Object.assign(f, MARK)))
  const same = F.readFlow('dark')
  same.title = 'Retitled'
  F.writeFlow(same)
  assert.equal(F.readFlow('dark').completedAt, AT, 'a write with no new ask holds')
  const more = F.readFlow('dark')
  F.addNode(more, { type: 'ask', title: 'Ship it now?', why: 'The build is green.' })
  F.writeFlow(more)
  const after = F.readFlow('dark')
  for (const k of ['completedAt', 'completedBy', 'archivedAt']) assert.equal(k in after, false, `${k} goes`)
})

// ═══ a write that keeps updatedAt ═══

test('writeFlow { stamp: false } keeps the stored updatedAt; the default still stamps', () => {
  F.writeFlow(fx('dark'))
  const was = F.readFlow('dark').updatedAt
  const f = F.readFlow('dark')
  f.updatedAt = '2026-01-01T00:00:00.000Z'
  F.writeFlow(f, { stamp: false })
  assert.equal(F.readFlow('dark').updatedAt, '2026-01-01T00:00:00.000Z')
  const g = F.readFlow('dark')
  F.writeFlow(g)
  assert.notEqual(F.readFlow('dark').updatedAt, '2026-01-01T00:00:00.000Z')
  assert.ok(was)
})

// ═══ flow new: the pile-up reminder ═══

const done = id => F.writeFlow(fx(id, f => { f.status = 'done'; f.nodes = []; delete f.route; delete f.output.changes; delete f.output.merge }))

test('flow new at 7 outputs waiting prints the reminder on stderr, exits 0 and still creates the flow', () => {
  for (let i = 1; i <= 7; i++) done(`out-${i}`)
  const r = run(['new', 'next-one', 'The next request', '--type', 'ask'])
  assert.equal(r.code, 0)
  assert.match(r.out, /Flow next-one created/)
  assert.equal(r.err, '7 outputs wait for your sign-off. Mark them completed before a new request.')
  assert.ok(F.readFlow('next-one'), 'the flow is there')
})

test('flow new at 6 waiting says nothing extra; completed and archived ones do not count', () => {
  for (let i = 1; i <= 6; i++) done(`out-${i}`)
  F.writeFlow(fx('gone', f => Object.assign(f, MARK, { status: 'done' })))
  F.writeFlow(fx('away', f => { f.status = 'done'; f.archivedAt = AT }))
  const r = run(['new', 'next-one', 'The next request', '--type', 'ask'])
  assert.equal(r.code, 0)
  assert.equal(r.err, undefined)
})

test('flow new reads outputs.max from the config it runs with', () => {
  for (let i = 1; i <= 3; i++) done(`out-${i}`)
  const r = run(['new', 'next-one', 'The next request', '--type', 'ask'], { ...CONFIG, outputs: { max: 3, warnAfterDays: 2 } })
  assert.equal(r.code, 0)
  assert.equal(r.err, '3 outputs wait for your sign-off. Mark them completed before a new request.')
})

test('a refused flow new prints no reminder', () => {
  for (let i = 1; i <= 7; i++) done(`out-${i}`)
  const r = run(['new', 'out-1', 'Taken', '--type', 'ask'])
  assert.equal(r.code, 1)
  assert.equal(r.err, undefined)
})
