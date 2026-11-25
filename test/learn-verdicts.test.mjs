// Tests for learn-verdicts.mjs: a verdict on every rule change.
// - THE MATHS (verdictOf): before against after for each number, and one overall word (better, worse, no clear
//   change, too few flows to tell), at the edges of every threshold and with too few flows.
// - THE STORE: a baseline recorded at the moment of each change (a Revert made on the Learn page is not judged
//   again), old log lines filled in from the stored flows, the Verdict due list, Keep, Wait two more weeks.
// - REVERT (revertBody): the exact rule text put back and the added one taken off, the specification too.
// Temp files only; the numbers come from a stub, so no flow file is read.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { VERDICT_RULES, backfillChanges, decideChange, readVerdicts, recordChange, revertBody, verdictOf, verdictView } from '../learn-verdicts.mjs'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-verdicts-test-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const DAY = 86_400_000
let k = 0
const fresh = () => path.join(TMP, `v${k++}.json`)

/** Numbers as learn-numbers.mjs gives them. */
const nums = ({ finished = 5, rft = 0.5, judged = finished, median = 3_600_000, cost = 2, jobs = finished, qa = 0.5 } = {}) => ({
  from: 'x', to: 'y', finished,
  rightFirstTime: { value: rft, right: rft === null ? 0 : Math.round(rft * judged), judged },
  medianMs: { value: median, flows: finished },
  costPerJob: { value: cost, usd: cost === null ? null : cost * jobs, jobs },
  qaFailures: { value: qa, failures: qa === null ? 0 : Math.round(qa * finished), flows: finished },
})

test('better: one number moved the right way by enough, and none the wrong way', () => {
  const v = verdictOf(nums({ rft: 0.5 }), nums({ rft: 0.6 }))
  assert.equal(v.overall, 'better')
  assert.equal(v.rows.find(r => r.key === 'rightFirstTime').change, 'better')
  assert.match(v.sentence, /^Better: right first time went up/)
})

test('the edges: exactly 10 points, exactly 20 percent and exactly a quarter of a failure count; just under does not', () => {
  assert.equal(verdictOf(nums({ rft: 0.65 }), nums({ rft: 0.75 })).overall, 'better') // 10 points, float noise and all
  assert.equal(verdictOf(nums({ rft: 0.65 }), nums({ rft: 0.749 })).overall, 'same')
  assert.equal(verdictOf(nums({ median: 1000 }), nums({ median: 800 })).overall, 'better') // 20 percent faster
  assert.equal(verdictOf(nums({ median: 1000 }), nums({ median: 801 })).overall, 'same')
  assert.equal(verdictOf(nums({ cost: 2 }), nums({ cost: 2.4 })).overall, 'worse') // 20 percent dearer
  assert.equal(verdictOf(nums({ cost: 2 }), nums({ cost: 2.39 })).overall, 'same')
  assert.equal(verdictOf(nums({ qa: 1 }), nums({ qa: 0.75 })).overall, 'better')
  assert.equal(verdictOf(nums({ qa: 1 }), nums({ qa: 0.76 })).overall, 'same')
  assert.deepEqual(Object.keys(VERDICT_RULES), ['rightFirstTime', 'medianMs', 'costPerJob', 'qaFailures'])
})

test('worse, and mixed: one better and one worse is no clear change, said with both', () => {
  assert.equal(verdictOf(nums({ qa: 0.2 }), nums({ qa: 1 })).overall, 'worse')
  const mixed = verdictOf(nums({ rft: 0.4, median: 1000 }), nums({ rft: 0.8, median: 2000 }))
  assert.equal(mixed.overall, 'same')
  assert.match(mixed.sentence, /^No clear change: right first time got better but the median time per job got worse\./)
  assert.equal(verdictOf(nums(), nums()).sentence, 'No clear change: no number moved by enough to count.')
})

test('too few flows: fewer than 3 finished before or after is too few to tell, whatever the numbers say', () => {
  const v = verdictOf(nums({ finished: 2, rft: 0 }), nums({ finished: 9, rft: 1 }))
  assert.equal(v.overall, 'few')
  assert.equal(v.sentence, 'Too few flows to tell: 2 finished before and 9 after. Each side needs at least 3.')
  assert.equal(verdictOf(nums({ finished: 3 }), nums({ finished: 3, rft: 0.9 })).overall, 'better') // 3 is enough
})

test('a number with too few under it, or missing on one side, is left out of the overall word', () => {
  const v = verdictOf(nums({ rft: 0.2, judged: 2 }), nums({ rft: 0.9, judged: 5, cost: null }))
  assert.equal(v.rows.find(r => r.key === 'rightFirstTime').change, 'few')
  assert.equal(v.rows.find(r => r.key === 'costPerJob').change, 'none')
  assert.equal(v.overall, 'same')
})

test('a change records its baseline at that moment: the 14 days before, the counts, the day it is due', () => {
  const file = fresh()
  const asked = []
  const at = '2026-11-10T10:00:00.000Z'
  const e = recordChange({ line: { at, label: 'Agent 1', spec: null, added: ['Test limits.'], removed: [] }, before: { spec: '', rules: [] }, after: { spec: '', rules: [{ text: 'Test limits.' }] } },
    { file, numbers: (from, to) => (asked.push([from, to]), nums()), afterDays: 14, newId: () => 'v1' })
  assert.equal(e.id, 'v1')
  assert.deepEqual(asked, [[Date.parse(at) - 14 * DAY, Date.parse(at)]])
  assert.equal(e.dueAt, '2026-11-24T10:00:00.000Z')
  assert.equal(e.state, 'waiting')
  assert.equal(e.by, 'you')
  assert.deepEqual(e.baseline, nums())
  assert.deepEqual(readVerdicts(file).changes.map(c => c.id), ['v1'])
})

test('a Learn change says so; a Revert made on the Learn page records nothing (it is judged already)', () => {
  const file = fresh()
  const base = { before: { spec: '', rules: [] }, after: { spec: '', rules: [] } }
  const e = recordChange({ ...base, line: { at: '2026-11-10T10:00:00.000Z', label: 'QA', spec: null, added: ['x'], removed: [], by: 'learn' } }, { file, numbers: () => nums(), afterDays: 14, link: { run: 'l1', n: 2 } })
  assert.equal(e.by, 'learn')
  assert.deepEqual(e.from, { run: 'l1', n: 2 })
  assert.equal(recordChange({ ...base, line: { at: '2026-11-11T10:00:00.000Z', label: 'QA', spec: null, added: [], removed: ['x'], by: 'revert' } }, { file, numbers: () => nums(), afterDays: 14 }), null)
  assert.equal(readVerdicts(file).changes.length, 1)
})

test('a specification change keeps the text before and after, for a Revert', () => {
  const e = recordChange({ line: { at: '2026-11-10T10:00:00.000Z', label: 'QA', spec: 'changed', added: [], removed: [] }, before: { spec: 'Old.', rules: [] }, after: { spec: 'New.', rules: [] } }, { file: fresh(), numbers: () => nums(), afterDays: 14 })
  assert.deepEqual([e.specFrom, e.specTo], ['Old.', 'New.'])
})

test('old log lines with no baseline are filled in from the stored flows, marked as worked out later; never twice', () => {
  const file = fresh()
  const lines = [{ at: '2026-11-01T10:00:00.000Z', label: 'Agent 1', spec: null, added: ['A.'], removed: [] }, { at: '2026-11-02T10:00:00.000Z', label: 'QA', spec: null, added: [], removed: ['B.'], by: 'revert' }]
  assert.equal(backfillChanges(lines, { file, numbers: () => nums(), afterDays: 14 }), 1)
  assert.equal(backfillChanges(lines, { file, numbers: () => nums(), afterDays: 14 }), 0)
  const [e] = readVerdicts(file).changes
  assert.equal(e.backfilled, true)
  assert.equal(e.label, 'Agent 1')
})

test('the view: a change is due once its day has come, with the numbers since and its verdict; the list is newest first', () => {
  const file = fresh()
  let id = 0
  const add = at => recordChange({ line: { at, label: 'Agent 1', spec: null, added: [`R${at}`], removed: [] }, before: { spec: '', rules: [] }, after: { spec: '', rules: [] } }, { file, numbers: () => nums({ rft: 0.5 }), afterDays: 14, newId: () => `v${++id}` })
  add('2026-11-01T10:00:00.000Z')
  add('2026-11-20T10:00:00.000Z')
  const now = Date.parse('2026-11-25T12:00:00.000Z')
  const asked = []
  const view = verdictView({ file, now, numbers: (from, to) => (asked.push([from, to]), nums({ rft: 0.9 })) })
  assert.deepEqual(view.due.map(d => d.id), ['v1'])
  assert.equal(view.due[0].verdict.overall, 'better')
  assert.deepEqual(asked[0], [Date.parse('2026-11-01T10:00:00.000Z'), Date.parse('2026-11-15T10:00:00.000Z')]) // the 14 days after, no more
  assert.deepEqual(view.changes.map(c => c.id), ['v2', 'v1'])
  assert.equal(view.changes[0].due, false)
})

test('Keep stores the verdict as it stood; Wait moves the day two weeks on; neither changes a rule', () => {
  const file = fresh()
  recordChange({ line: { at: '2026-11-01T10:00:00.000Z', label: 'Agent 1', spec: null, added: ['A.'], removed: [] }, before: { spec: '', rules: [] }, after: { spec: '', rules: [] } }, { file, numbers: () => nums(), afterDays: 14, newId: () => 'v1' })
  const now = Date.parse('2026-11-25T12:00:00.000Z')
  const w = decideChange('v1', 'wait', { file, now, numbers: () => nums() })
  assert.equal(w.status, 200)
  assert.equal(readVerdicts(file).changes[0].dueAt, '2026-12-09T12:00:00.000Z') // two weeks from the press, not from the day it fell due
  assert.equal(readVerdicts(file).changes[0].waits, 1)
  assert.deepEqual(verdictView({ file, now, numbers: () => nums() }).due, [])
  const k1 = decideChange('v1', 'keep', { file, now, numbers: () => nums({ rft: 0.9 }) })
  assert.equal(k1.status, 200)
  const kept = readVerdicts(file).changes[0]
  assert.equal(kept.state, 'kept')
  assert.equal(kept.verdict.overall, 'better')
  assert.equal(decideChange('v1', 'keep', { file, now, numbers: () => nums() }).status, 409) // decided already
  assert.equal(decideChange('nope', 'keep', { file, now, numbers: () => nums() }).status, 404)
  assert.equal(decideChange('v1', 'maybe', { file, now, numbers: () => nums() }).status, 400)
})

test('Revert goes through the rules path it is given, and only a good save marks the change reverted', () => {
  const file = fresh()
  recordChange({ line: { at: '2026-11-01T10:00:00.000Z', label: 'Agent 1', spec: null, added: ['A.'], removed: [] }, before: { spec: '', rules: [] }, after: { spec: '', rules: [] } }, { file, numbers: () => nums(), afterDays: 14, newId: () => 'v1' })
  const now = Date.parse('2026-11-25T12:00:00.000Z')
  const failed = decideChange('v1', 'revert', { file, now, numbers: () => nums(), revert: () => ({ status: 400, body: { error: 'Rule 1 is too long.' } }) })
  assert.equal(failed.status, 400)
  assert.equal(readVerdicts(file).changes[0].state, 'waiting')
  const seen = []
  const ok = decideChange('v1', 'revert', { file, now, numbers: () => nums(), revert: e => (seen.push(e.id), { status: 200, body: { ok: true } }) })
  assert.equal(ok.status, 200)
  assert.deepEqual(seen, ['v1'])
  assert.equal(readVerdicts(file).changes[0].state, 'reverted')
})

test('revertBody: the added rule comes off, the removed one goes back with its exact text, the rest untouched', () => {
  const e = { label: 'Agent 1', added: ['New rule.'], removed: ['Old rule, exactly so.'], spec: null }
  const r = revertBody(e, { spec: 'S', rules: [{ text: 'Keep me.' }, { text: 'New rule.' }] })
  assert.deepEqual(r.body, { rules: ['Keep me.', 'Old rule, exactly so.'] })
  assert.deepEqual(r.notes, [])
})

test('revertBody: a rule changed since is said, not guessed; nothing left to undo is an error', () => {
  const e = { label: 'Agent 1', added: ['New rule.'], removed: [], spec: null }
  assert.deepEqual(revertBody(e, { spec: '', rules: [{ text: 'Other.' }] }), { error: 'Nothing to revert: the rules of Agent 1 already read as they did before this change.' })
  const two = revertBody({ label: 'QA', added: ['Gone already.'], removed: ['Back.'], spec: null }, { spec: '', rules: [] })
  assert.deepEqual(two.body, { rules: ['Back.'] })
  assert.deepEqual(two.notes, ['Gone already. was already removed.'])
})

test('revertBody: the specification goes back only while it still reads as the change left it', () => {
  const e = { label: 'QA', added: [], removed: [], spec: 'changed', specFrom: 'Old.', specTo: 'New.' }
  assert.deepEqual(revertBody(e, { spec: 'New.', rules: [] }).body, { spec: 'Old.' })
  assert.match(revertBody(e, { spec: 'Edited since.', rules: [] }).error, /^Nothing to revert/)
  const backfilled = { label: 'QA', added: [], removed: [], spec: 'changed', backfilled: true }
  assert.match(revertBody(backfilled, { spec: 'New.', rules: [] }).error, /^Nothing to revert/)
})
