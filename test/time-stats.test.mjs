// Tests for time-stats.mjs, the Pipeline time block's numbers: how many tickets finished in the period (finished is
// the scorecard's delivered cell, score.mjs cellOf), per day, per active hour, how long a ticket took from start to
// finish, how long flows waited on the user, where the time went, the bars per day (per week for All) and the per
// agent table. Periods and days are the server's LOCAL time, so every time here is built with the local Date
// constructor and the tests read the same in any time zone. All pure: flows, a graph and a clock in, numbers out.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { periodOf, timeStats } from '../time-stats.mjs'

const G = pipelineGraph({
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2' },
  pipeline: { ...DEFAULT_PIPELINE },
})
const MIN = 60_000
const HOUR = 3_600_000
/** A local time in November 2026, as a flow file stores it. */
const local = (day, h = 0, m = 0) => new Date(2026, 10, day, h, m).toISOString()
const ms = iso => Date.parse(iso)
const NOW = new Date(2026, 10, 25, 14, 30).getTime() // Wednesday 25 November, 14:30 local
const code = [{ id: 'n1', type: 'step', title: 'Change it', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }]
const talk = [{ id: 'n1', type: 'step', title: 'Look into it', status: 'done', evidence: [{ kind: 'note', ref: 'Fine.' }] }]
const flow = (id, more = {}) => ({ id, title: `Flow ${id}`, agent: 'Agent 1', tickets: [], status: 'open', updatedAt: local(25, 14), nodes: code, ...more })
/** A code flow QA passed: created at `created`, handed to QA at `handed`, passed at `passed`. */
const passed = (id, created, handed, passedAt, more = {}) =>
  flow(id, { status: 'done', createdAt: created, updatedAt: passedAt, qa: { status: 'passed', attempt: 1, startedAt: handed, at: passedAt }, ...more })
const run = (flows, opts = {}) => timeStats(flows, G, { now: NOW, days: 7, ...opts })

// The main set: four finished flows in the last 7 days, one just before, and one of each that is not finished.
const MAIN = [
  passed('a', local(24, 9), local(24, 9, 40), local(24, 10), {
    tickets: ['FLA-1', 'FLA-2'],
    qa: { status: 'passed', attempt: 2, startedAt: local(24, 9, 40), at: local(24, 10), attempts: [{ attempt: 1, status: 'failed', startedAt: local(24, 9, 10), at: local(24, 9, 30), rework: { to: 'Agent 1' } }] },
  }),
  passed('b', local(25, 8), local(25, 8, 20), local(25, 8, 30), { agent: 'Agent 2', tickets: ['FLA-1'] }),
  flow('c', { agent: 'Master', status: 'done', nodes: talk, createdAt: local(23, 23), updatedAt: local(24, 0, 30) }),
  passed('i', local(18, 22), local(18, 23, 30), local(19, 0, 0), { tickets: ['FLA-3'] }),
  passed('h', local(10, 9), local(18, 23), local(18, 23, 59), { tickets: ['FLA-9'] }),
  flow('d-slipped', { status: 'done', updatedAt: local(24, 12) }),
  flow('e-dropped', { status: 'dropped', updatedAt: local(24, 12) }),
  flow('f-stopped', { agent: 'Agent 2', status: 'blocked', updatedAt: local(24, 11), qa: { status: 'qa-failed', attempt: 1, startedAt: local(24, 10, 30), at: local(24, 11) } }),
  flow('g-stalled', { updatedAt: local(15, 10) }),
]

test('periodOf: 7 and 30 days start at local midnight, today included; All starts on the day of the first start', () => {
  const seven = periodOf(NOW, 7, null)
  assert.equal(seven.from, new Date(2026, 10, 19).getTime())
  assert.equal(seven.dayCount, 7)
  assert.equal(seven.bucket, 'day')
  assert.equal(periodOf(NOW, 30, null).from, new Date(2026, 9, 27).getTime())
  const all = periodOf(NOW, null, ms(local(3, 15, 20)))
  assert.equal(all.from, new Date(2026, 10, 3).getTime())
  assert.equal(all.dayCount, 23)
  assert.equal(all.bucket, 'week')
  assert.equal(periodOf(NOW, null, null).from, null, 'nothing ever started: no period')
})

test('finished is the scorecard delivered cell; slipped, dropped, stopped and stalled are left out and counted', () => {
  const s = run(MAIN)
  assert.equal(s.finished.flows, 4)
  assert.deepEqual(s.left, { slipped: 1, dropped: 1, stopped: 1, stalled: 1 })
})

test('tickets: two on one flow count two, none is one other job, the same ticket finished twice counts once', () => {
  const s = run(MAIN)
  assert.deepEqual(s.finished, { tickets: 3, jobs: 1, flows: 4 })
})

test('the period edge is local midnight: 23:59 the night before is out, 00:00 is in', () => {
  const s = run(MAIN)
  assert.equal(s.window.from, new Date(2026, 10, 19).toISOString())
  assert.equal(s.window.dayCount, 7)
  assert.equal(s.took.flows, 4, 'flow h finished at 23:59 on the 18th, outside')
})

test('a flow belongs to the day it FINISHED, a ticket finished twice to the day of its last finish', () => {
  const s = run(MAIN)
  assert.deepEqual(s.bars.map(b => b.day), ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25'])
  // the 19th: FLA-3 at 00:00. The 23rd: nothing, though flow c started at 23:00 then. The 24th: FLA-2 and job c (00:30).
  // The 25th: FLA-1, last finished by flow b.
  assert.deepEqual(s.bars.map(b => b.count), [1, 0, 0, 0, 0, 2, 1])
})

test('per day over the days in the period, per hour over the active hours, and the clock rate beside it', () => {
  const flows = [
    passed('p1', local(25, 9, 10), local(25, 9, 50), local(25, 10, 5), { tickets: ['FLA-5'] }),
    flow('p2', { status: 'done', nodes: talk, createdAt: local(25, 9, 20), updatedAt: local(25, 9, 40) }),
    flow('p3', { updatedAt: local(17, 10) }), // stalled on the 24th at 10:00: a stall is no work, so not an active hour
  ]
  const s = run(flows)
  assert.equal(s.window.activeHours, 2, '09:00 to 10:00 and 10:00 to 11:00 on the 25th')
  assert.equal(s.rates.perDay, 2 / 7)
  assert.equal(s.rates.perHour, 1)
  assert.equal(s.rates.perClockHour, 2 / ((NOW - new Date(2026, 10, 19).getTime()) / HOUR))
  assert.equal(s.window.clockHours, (NOW - new Date(2026, 10, 19).getTime()) / HOUR)
})

test('time per ticket: the median from start to finish, with the mean, fastest and slowest', () => {
  const s = run(MAIN)
  // a 60 min, b 30 min, c 90 min, i 120 min
  assert.deepEqual(s.took, { median: 75 * MIN, mean: 75 * MIN, fastest: 30 * MIN, slowest: 120 * MIN, flows: 4 })
  assert.equal(s.fewer, false)
})

test('fewer than 3 finished flows is flagged; none at all gives no numbers, never a zero', () => {
  const two = run(MAIN.slice(0, 2))
  assert.equal(two.fewer, true)
  assert.equal(two.took.flows, 2)
  const none = run([flow('open-one')])
  assert.deepEqual(none.finished, { tickets: 0, jobs: 0, flows: 0 })
  assert.equal(none.took, null)
  assert.equal(none.waiting, null)
  assert.deepEqual(none.rates, { perDay: null, perHour: null, perClockHour: null })
  assert.deepEqual(none.stages, [])
})

test('a finished flow with no start time is counted as finished but left out of the time per ticket', () => {
  const s = run([passed('x', undefined, local(25, 9), local(25, 10)), ...MAIN])
  assert.equal(s.finished.flows, 5)
  assert.equal(s.took.flows, 4)
})

test('waiting on you: median and mean over the flows that can be dated, the share of their time, the undated counted', () => {
  const ask = (asked, answered) => ({ id: `q${asked}`, type: 'ask', title: 'Q', kind: 'yesno', answer: 'yes', at: asked, answeredAt: answered })
  const flows = [
    flow('w1', { status: 'done', nodes: [...talk, ask(local(25, 9, 10), local(25, 9, 30))], createdAt: local(25, 9), updatedAt: local(25, 10) }),
    flow('w2', { status: 'done', nodes: talk, createdAt: local(25, 9), updatedAt: local(25, 10) }),
    flow('w3', { status: 'done', nodes: [...talk, ask(undefined, local(25, 9, 30))], createdAt: local(25, 9), updatedAt: local(25, 10) }),
    flow('w4', { status: 'done', nodes: [...talk, ask(local(25, 9), local(25, 10))], createdAt: local(25, 9), updatedAt: local(25, 11) }),
  ]
  const s = run(flows)
  assert.equal(s.waiting.median, 20 * MIN)
  assert.equal(s.waiting.mean, 80 * MIN / 3)
  assert.equal(s.waiting.flows, 3)
  assert.equal(s.waiting.undated, 1)
  assert.equal(s.waiting.share, 80 / (60 + 60 + 120), 'of the time of the three dated flows')
})

test('where the time goes: each stage the median over the flows that went through it; none through it, left out', () => {
  const flows = [
    passed('s1', local(25, 9), local(25, 9, 30), local(25, 9, 40)),
    passed('s2', local(25, 9), local(25, 9, 50), local(25, 10, 10), { plan: { status: 'handed', by: 'Master', at: local(25, 9, 10), to: 'Agent 1' } }),
    passed('s3', local(25, 9), undefined, local(25, 10)),
  ]
  const s = run(flows)
  const by = Object.fromEntries(s.stages.map(x => [x.key, x]))
  assert.deepEqual(s.stages.map(x => x.key), ['planning', 'producing', 'qa'])
  assert.deepEqual(by.planning, { key: 'planning', label: 'Coordinator and planner', median: 10 * MIN, mean: 10 * MIN, flows: 1, undated: 0 })
  assert.equal(by.producing.median, 35 * MIN, '30 and 40 minutes')
  assert.equal(by.producing.undated, 1)
  assert.equal(by.qa.median, 15 * MIN, '10 and 20 minutes')
  assert.equal(by.qa.undated, 1)
})

test('All: from the day of the first start, the bars per week from Monday', () => {
  const flows = [
    passed('w-a', local(3, 15), local(4, 9), local(4, 10), { tickets: ['FLA-11'] }),
    passed('w-b', local(22, 20), local(22, 23), local(22, 23, 50), { tickets: ['FLA-12'] }),
    passed('w-c', local(22, 23), local(23, 0), local(23, 0, 10), { tickets: ['FLA-13'] }),
  ]
  const s = run(flows, { days: null })
  assert.equal(s.window.days, null)
  assert.equal(s.window.from, new Date(2026, 10, 3).toISOString())
  assert.equal(s.window.dayCount, 23)
  assert.equal(s.window.bucket, 'week')
  assert.deepEqual(s.bars.map(b => [b.day, b.count]), [['2026-11-02', 1], ['2026-11-09', 0], ['2026-11-16', 1], ['2026-11-23', 1]])
  assert.equal(s.rates.perDay, 3 / 23)
})

test('All with no flow at all: no period, no bars, nothing finished', () => {
  const s = run([], { days: null })
  assert.equal(s.window.from, null)
  assert.equal(s.window.dayCount, 0)
  assert.deepEqual(s.bars, [])
  assert.equal(s.finished.flows, 0)
})

test('per agent: tickets, other jobs, median time, per day and times sent back, the busiest first', () => {
  const s = run(MAIN)
  assert.deepEqual(JSON.parse(JSON.stringify(s.agents)), [
    { label: 'Agent 1', tickets: 2, jobs: 0, flows: 2, median: 90 * MIN, perDay: 2 / 7, sentBack: 1 },
    { label: 'Agent 2', tickets: 1, jobs: 0, flows: 1, median: 30 * MIN, perDay: 1 / 7, sentBack: 1 },
    { label: 'Master', tickets: 0, jobs: 1, flows: 1, median: 90 * MIN, perDay: 1 / 7, sentBack: 0 },
  ])
})

test('the 30 day and All periods hold the flow finished just before the 7 days', () => {
  assert.equal(run(MAIN, { days: 30 }).finished.flows, 5)
  assert.equal(run(MAIN, { days: null }).finished.flows, 5)
})

test('bad input is skipped, never thrown', () => {
  const s = run([null, 7, { id: 'no-title' }, ...MAIN])
  assert.equal(s.finished.flows, 4)
})

test('over All, finished is exactly the scorecard delivered count, archived flows included', async () => {
  const { scoreOf } = await import('../score.mjs')
  const flows = [...MAIN, passed('archived', local(20, 9), local(20, 9, 30), local(20, 10), { archivedAt: local(21, 9) })]
  const s = run(flows, { days: null })
  assert.equal(s.finished.flows, scoreOf(flows, G, { now: NOW, days: null }).counts.delivered)
  assert.equal(s.finished.flows, 6)
})
