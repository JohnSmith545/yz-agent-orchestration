// Tests for completed.mjs: what counts as waiting for the user's sign-off, overdue and piled up, at the boundaries
// (2 days, 7 outputs, local midnight), the `outputs` settings, the two sentences, and the mark itself. Pure: no file.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyComplete, completeRefusal, finishedAt, isCompleted, isFinished, isOverdue, OUTPUT_DEFAULTS, outputSettings,
  outputsSummary, reminderLine, waitingLine, waitsForSignOff,
} from '../completed.mjs'
import { pipelineGraph } from '../pipeline.mjs'

const G = pipelineGraph({ coordinator: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' }, pipeline: { qa: 'QA', producers: ['Agent 1'] } })
const DAY = 86_400_000
const T0 = Date.parse('2026-11-20T10:00:00.000Z')
const iso = t => new Date(t).toISOString()

let n = 0
/** A flow with no QA record and no code (a review or an ask): done means at the Output, finished at updatedAt. */
const flow = (status, extra = {}) => ({ id: extra.id || `f${++n}`, title: `Flow ${n}`, agent: 'Master', status, nodes: [], updatedAt: iso(T0), ...extra })
/** A code flow QA passed and pushed: at the Output while its status is still open. */
const pushed = (extra = {}) => flow('open', {
  route: { type: 'build', steps: ['request', 'master', 'qa', 'push', 'outcome'] },
  nodes: [{ id: 'n1', type: 'step', title: 'Code', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }], verified: null }],
  qa: { status: 'passed', attempt: 1, by: 'QA', startedAt: iso(T0 - DAY), at: iso(T0 - 3600_000), pushedAt: iso(T0 - 1800_000), commit: 'abc1234' },
  ...extra,
})

// ═══ settings ═══

test('outputs settings: left out is max 7 and warnAfterDays 2, with no warning', () => {
  const warned = []
  assert.deepEqual(outputSettings(undefined, w => warned.push(w)), { max: 7, warnAfterDays: 2 })
  assert.deepEqual(OUTPUT_DEFAULTS, { max: 7, warnAfterDays: 2 })
  assert.equal(warned.length, 0)
})

test('outputs settings: good values are kept, each bad one keeps its default with one warning', () => {
  const warned = []
  assert.deepEqual(outputSettings({ max: 3, warnAfterDays: 5 }, w => warned.push(w)), { max: 3, warnAfterDays: 5 })
  assert.equal(warned.length, 0)
  for (const bad of [0, -1, 7.5, '7', null, 1001, true]) {
    const w = []
    assert.deepEqual(outputSettings({ max: bad, warnAfterDays: 4 }, x => w.push(x)), { max: 7, warnAfterDays: 4 }, `max ${bad}`)
    assert.equal(w.length, 1)
    assert.match(w[0], /^config\.json: outputs\.max needs a whole number from 1 to 1000; 7 is used\.$/)
  }
  const w = []
  assert.deepEqual(outputSettings({ max: 'x', warnAfterDays: 0 }, x => w.push(x)), OUTPUT_DEFAULTS)
  assert.equal(w.length, 2, 'one warning per bad key')
  assert.match(w[1], /outputs\.warnAfterDays needs a whole number from 1 to 365; 2 is used/)
})

test('outputs settings: not an object keeps the defaults with ONE warning', () => {
  for (const raw of [7, 'seven', [], null]) {
    const w = []
    assert.deepEqual(outputSettings(raw, x => w.push(x)), OUTPUT_DEFAULTS)
    assert.equal(w.length, 1)
    assert.match(w[0], /outputs should be an object/)
  }
})

// ═══ finished, waiting ═══

test('finished: done, or standing at the Output while still open; never open on its way, blocked or dropped', () => {
  assert.equal(isFinished(flow('done'), G), true)
  assert.equal(isFinished(pushed(), G), true, 'QA pushed it: at the Output')
  assert.equal(isFinished(flow('open'), G), false)
  assert.equal(isFinished(flow('blocked'), G), false)
  assert.equal(isFinished(flow('dropped'), G), false)
  assert.equal(isFinished(null, G), false)
})

test('waiting for sign-off: finished and neither completed, archived nor deleted', () => {
  assert.equal(waitsForSignOff(flow('done'), G), true)
  assert.equal(waitsForSignOff(flow('done', { completedAt: iso(T0), archivedAt: iso(T0) }), G), false)
  assert.equal(waitsForSignOff(flow('done', { archivedAt: iso(T0) }), G), false, 'put away by the user')
  assert.equal(waitsForSignOff(flow('done', { deletedAt: iso(T0) }), G), false)
  assert.equal(waitsForSignOff(flow('open'), G), false)
  assert.equal(isCompleted(flow('done', { completedAt: iso(T0) })), true)
  assert.equal(isCompleted(flow('done')), false)
})

test('finished at: the time the scorecard counts it, else the last update', () => {
  assert.equal(finishedAt(flow('done'), G), T0, 'no QA: done at its last update, as the scorecard counts it')
  assert.equal(finishedAt(pushed(), G), T0 - 3600_000, 'QA passed: the verdict time')
  assert.equal(finishedAt(flow('done', { updatedAt: 'nonsense' }), G), null)
})

// ═══ overdue: 2 days of elapsed time ═══

test('overdue at exactly warnAfterDays days, not a millisecond before', () => {
  const f = flow('done')
  assert.equal(isOverdue(f, G, T0 + 2 * DAY - 1, OUTPUT_DEFAULTS), false)
  assert.equal(isOverdue(f, G, T0 + 2 * DAY, OUTPUT_DEFAULTS), true)
  assert.equal(isOverdue(f, G, T0 + 2 * DAY, { max: 7, warnAfterDays: 3 }), false)
  assert.equal(isOverdue(f, G, new Date(T0 + 3 * DAY), { max: 7, warnAfterDays: 3 }), true, 'a Date works as now')
  assert.equal(isOverdue(flow('done', { updatedAt: '' }), G, T0 + 9 * DAY), false, 'no time: never overdue')
})

test('local midnight does not count as a day: 23:59 to 00:01 two dates later is 24 hours, not 2 days', () => {
  const late = new Date(2026, 10, 20, 23, 59).getTime()
  const f = flow('done', { updatedAt: iso(late) })
  assert.equal(isOverdue(f, G, new Date(2026, 10, 22, 0, 1).getTime()), false)
  assert.equal(isOverdue(f, G, new Date(2026, 10, 22, 23, 58).getTime()), false)
  assert.equal(isOverdue(f, G, late + 2 * DAY), true)
})

// ═══ the summary: waiting, overdue, piled ═══

const doneFlows = (k, at = T0) => Array.from({ length: k }, (_, i) => flow('done', { id: `d${i + 1}`, updatedAt: iso(at + i * 60_000) }))

test('piled up at 7 waiting, not at 6', () => {
  assert.equal(outputsSummary(doneFlows(6), G, OUTPUT_DEFAULTS, T0).piled, false)
  const s = outputsSummary(doneFlows(7), G, OUTPUT_DEFAULTS, T0)
  assert.equal(s.piled, true)
  assert.deepEqual(s.counts, { waiting: 7, overdue: 0 })
  assert.equal(s.max, 7)
  assert.equal(s.warnAfterDays, 2)
  assert.equal(outputsSummary(doneFlows(3), G, { max: 3, warnAfterDays: 2 }, T0).piled, true, 'the setting is the limit')
})

test('the summary lists only what waits, the oldest finish first, each with overdue', () => {
  const list = [
    flow('done', { id: 'new', updatedAt: iso(T0) }),
    flow('done', { id: 'old', updatedAt: iso(T0 - 3 * DAY) }),
    flow('done', { id: 'gone', completedAt: iso(T0), archivedAt: iso(T0) }),
    flow('done', { id: 'away', archivedAt: iso(T0) }),
    flow('open', { id: 'busy' }),
    flow('dropped', { id: 'drop' }),
    pushed({ id: 'push' }),
    null,
  ]
  const s = outputsSummary(list, G, OUTPUT_DEFAULTS, T0 + DAY)
  assert.deepEqual(s.waiting.map(w => w.id), ['old', 'push', 'new'])
  assert.deepEqual(s.waiting.map(w => w.overdue), [true, false, false])
  assert.deepEqual(s.counts, { waiting: 3, overdue: 1 })
  assert.deepEqual(Object.keys(s.waiting[0]), ['id', 'title', 'agent', 'finishedAt', 'overdue'])
  assert.equal(s.waiting[0].finishedAt, iso(T0 - 3 * DAY))
  assert.deepEqual(outputsSummary([], G, OUTPUT_DEFAULTS, T0), { waiting: [], counts: { waiting: 0, overdue: 0 }, max: 7, warnAfterDays: 2, piled: false })
  assert.deepEqual(outputsSummary(undefined, G, undefined, T0).counts, { waiting: 0, overdue: 0 })
})

// ═══ the sentences ═══

test('the waiting line and the reminder, singular and plural', () => {
  assert.equal(waitingLine(3), '3 outputs wait for your sign-off')
  assert.equal(waitingLine(1), '1 output waits for your sign-off')
  assert.equal(reminderLine(7), '7 outputs wait for your sign-off. Mark them completed before a new request.')
  assert.equal(reminderLine(1), '1 output waits for your sign-off. Mark it completed before a new request.')
})

// ═══ the mark ═══

test('only a finished flow can be completed, refused with one plain sentence', () => {
  assert.equal(completeRefusal(flow('done'), G), '')
  assert.equal(completeRefusal(pushed(), G), '')
  assert.equal(completeRefusal(flow('open'), G), 'Only a finished flow can be marked completed: it is still on its way.')
  assert.equal(completeRefusal(flow('blocked'), G), 'Only a finished flow can be marked completed: it is blocked.')
  assert.equal(completeRefusal(flow('dropped'), G), 'Only a finished flow can be marked completed: it was dropped.')
})

test('completing sets completedAt, completedBy you and archivedAt at once; a second press changes nothing', () => {
  const f = flow('done', { updatedAt: '2026-11-01T00:00:00.000Z' })
  assert.equal(applyComplete(f, true, T0), true)
  assert.equal(f.completedAt, iso(T0))
  assert.equal(f.completedBy, 'you')
  assert.equal(f.archivedAt, iso(T0))
  assert.equal(f.status, 'done', 'no status change')
  assert.equal(f.updatedAt, '2026-11-01T00:00:00.000Z', 'updatedAt is the writer\'s business, untouched here')
  assert.equal(applyComplete(f, true, T0 + 5000), false)
  assert.equal(f.completedAt, iso(T0), 'the first time stands')
})

test('uncompleting clears completed and archived and notes when; on a flow not completed it changes nothing', () => {
  const f = flow('done')
  applyComplete(f, true, T0)
  assert.equal(applyComplete(f, false, T0 + DAY), true)
  assert.equal(f.completedAt, undefined)
  assert.equal(f.completedBy, undefined)
  assert.equal(f.archivedAt, undefined)
  assert.equal(f.uncompletedAt, iso(T0 + DAY))
  const g = flow('done', { archivedAt: iso(T0) })
  assert.equal(applyComplete(g, false, T0), false)
  assert.equal(g.archivedAt, iso(T0), 'an archived flow that was never completed stays archived')
})
