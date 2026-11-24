// Tests for score.mjs, the pipeline's scorecard: the four counts (right delivered, slipped through, missed, right
// caught), the five scores built from them (precision, recall, F-score, accuracy, correctness), the time window, the
// per-agent table and the plain text. All pure: flows and a graph in, numbers out.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { MEANING, cellOf, fBeta, scoreOf, scoreText } from '../score.mjs'

const G = pipelineGraph({
  coordinator: 'Master',
  coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2' },
  pipeline: { ...DEFAULT_PIPELINE },
  factory: { chat: { name: 'Independent' } },
})
const DAY = 86_400_000
const NOW = Date.parse('2026-11-24T12:00:00Z')
const ago = ms => new Date(NOW - ms).toISOString()
const code = [{ id: 'n1', type: 'step', title: 'Change it', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }]
const talk = [{ id: 'n1', type: 'step', title: 'Look into it', status: 'done', evidence: [{ kind: 'note', ref: 'It is fine.' }] }]

/** A flow: by default Agent 1's code change, open, updated an hour ago. */
const flow = (id, more = {}) => ({ id, title: `Flow ${id}`, agent: 'Agent 1', status: 'open', updatedAt: ago(3_600_000), nodes: code, ...more })
const verdict = (status, at, more = {}) => ({ status, attempt: 1, at: ago(at), ...more })
const run = (flows, opts = {}) => scoreOf(flows, G, { now: NOW, days: 30, ...opts })

// ═══ the four boxes ═══

test('right, delivered: a code flow QA passed, and a finished flow with no code changes', () => {
  const s = run([
    flow('passed', { status: 'done', qa: verdict('passed', 1000, { pushedAt: ago(500) }) }),
    flow('passed-not-pushed', { qa: verdict('passed', 1000) }),
    flow('talk', { status: 'done', nodes: talk }),
    flow('chat', { agent: 'Independent', status: 'done', nodes: talk }),
  ])
  assert.deepEqual(s.counts, { delivered: 4, slipped: 0, missed: 0, caught: 0 })
})

test('wrong, slipped through: a finished code-producing flow with no QA pass, listed by id and title', () => {
  const s = run([flow('no-qa', { status: 'done' }), flow('chat-code', { agent: 'Independent', status: 'done' })])
  assert.equal(s.counts.slipped, 2)
  assert.deepEqual(s.lists.slipped.map(f => f.id).sort(), ['chat-code', 'no-qa'])
  assert.deepEqual(Object.keys(s.lists.slipped[0]).sort(), ['id', 'title'])
})

test('wrong, missed: dropped, stopped at QA (qa-failed, or failed with no producer), and stalled, each with why', () => {
  const s = run([
    flow('dropped', { status: 'dropped' }),
    flow('qa-failed', { status: 'blocked', qa: verdict('qa-failed', 1000) }),
    flow('no-producer', { agent: 'Master', qa: verdict('failed', 1000) }),
    flow('stalled', { updatedAt: ago(8 * DAY) }),
    flow('stalled-blocked', { status: 'blocked', updatedAt: ago(9 * DAY) }),
  ])
  assert.equal(s.counts.missed, 5)
  const why = Object.fromEntries(s.lists.missed.map(m => [m.id, m.why]))
  assert.deepEqual(why, { dropped: 'dropped', 'qa-failed': 'stopped', 'no-producer': 'stopped', stalled: 'stalled', 'stalled-blocked': 'stalled' })
})

test('right, caught: every QA failure verdict, the earlier attempts and the current one', () => {
  const s = run([
    flow('twice', {
      qa: { ...verdict('failed', 1000, { attempt: 3, rework: { to: 'Agent 1' } }), attempts: [verdict('failed', 5000, { rework: { to: 'Agent 1' } }), { ...verdict('qa-failed', 3000), attempt: 2 }] },
    }),
    flow('then-passed', { status: 'done', qa: { ...verdict('passed', 1000, { attempt: 2 }), attempts: [verdict('failed', 2000, { rework: { to: 'Agent 1' } })] } }),
  ])
  assert.equal(s.counts.caught, 4)
  assert.equal(s.counts.delivered, 1)
})

test('still on their way: open or blocked and recent, at QA, or sent back; never one of the four', () => {
  const s = run([
    flow('working'),
    flow('blocked', { status: 'blocked', updatedAt: ago(6 * DAY) }),
    flow('waiting', { status: 'done', qa: verdict('pending', 1000) }),
    flow('testing', { qa: verdict('testing', 1000) }),
    flow('rework', { qa: verdict('failed', 1000, { rework: { to: 'Agent 1' } }) }),
  ])
  assert.deepEqual(s.counts, { delivered: 0, slipped: 0, missed: 0, caught: 1 }, 'the rework failure is still a catch')
  assert.equal(s.inFlight, 5)
})

test('a flow on its way with no update for the stall days is missed, whatever step it waits at', () => {
  const s = run([flow('at-qa', { status: 'done', updatedAt: ago(8 * DAY), qa: verdict('pending', 8 * DAY) }), flow('quiet', { updatedAt: ago(7 * DAY) })])
  assert.equal(s.counts.missed, 2)
  assert.equal(s.inFlight, 0)
  assert.equal(run([flow('quiet', { updatedAt: ago(3 * DAY) })], { stallDays: 2 }).counts.missed, 1, 'stallDays is honoured')
})

test('archived flows count like any other', () => {
  assert.equal(run([flow('a', { status: 'done', nodes: talk, archivedAt: ago(100) })]).counts.delivered, 1)
})

// ═══ the window ═══

test('the window: a flow by its updatedAt, from exactly days ago (inclusive), and the window says where it starts', () => {
  const s = run([flow('edge', { status: 'done', nodes: talk, updatedAt: ago(30 * DAY) }), flow('old', { status: 'done', nodes: talk, updatedAt: ago(30 * DAY + 1) })])
  assert.equal(s.counts.delivered, 1)
  assert.deepEqual(s.window, { days: 30, from: ago(30 * DAY), stallDays: 7 })
  const all = run([flow('old', { status: 'done', nodes: talk, updatedAt: ago(400 * DAY) })], { days: null })
  assert.equal(all.counts.delivered, 1)
  assert.deepEqual(all.window, { days: null, from: null, stallDays: 7 })
})

test('the window: a verdict counts by its own time, not the flow update', () => {
  const s = run([flow('f', { qa: { ...verdict('failed', 1000, { attempt: 2, rework: { to: 'Agent 1' } }), attempts: [verdict('failed', 10 * DAY, { rework: { to: 'Agent 1' } })] } })], { days: 7 })
  assert.equal(s.counts.caught, 1)
  assert.equal(run([flow('f', { qa: verdict('failed', 10 * DAY, { rework: { to: 'Agent 1' } }) })], { days: 7 }).counts.caught, 0)
})

test('the window: a stalled flow counts from the moment it stalled, so the 7 day window still sees new stalls', () => {
  const fresh = run([flow('s', { updatedAt: ago(10 * DAY) })], { days: 7 })
  assert.equal(fresh.counts.missed, 1, 'stalled 3 days ago')
  assert.equal(run([flow('s', { updatedAt: ago(15 * DAY) })], { days: 7 }).counts.missed, 0, 'stalled 8 days ago')
})

test('a flow or verdict with no time is never counted, all time included: the log could not place it', () => {
  const f = flow('t', { status: 'done', nodes: talk, updatedAt: undefined })
  assert.equal(run([f]).counts.delivered, 0)
  assert.equal(run([f], { days: null }).counts.delivered, 0)
  const noAt = flow('v', { qa: { status: 'failed', attempt: 1, rework: { to: 'Agent 1' } } })
  assert.equal(run([noAt], { days: null }).counts.caught, 0, 'a verdict with no at is not guessed from the flow update')
})

test('a flow QA passed or stopped counts at its final verdict, not at its last update', () => {
  const passed = flow('p', { status: 'done', updatedAt: ago(1000), qa: verdict('passed', 10 * DAY) })
  assert.equal(run([passed], { days: 7 }).counts.delivered, 0)
  assert.equal(run([passed], { days: 30 }).counts.delivered, 1)
  const stopped = flow('s', { status: 'blocked', updatedAt: ago(1000), qa: verdict('qa-failed', 10 * DAY) })
  assert.equal(run([stopped], { days: 7 }).counts.missed, 0)
  assert.equal(run([stopped], { days: 30 }).counts.missed, 1)
})

test('cellOf: the one rule for which cell a flow lands in, the event that puts it there, and when', () => {
  const stallMs = 7 * DAY
  const at = id => cellOf(id, G, NOW, stallMs)
  assert.deepEqual(at(flow('a', { status: 'done', qa: verdict('passed', 1000) })), { cell: 'delivered', why: null, kind: 'passed', time: NOW - 1000 })
  assert.deepEqual(at(flow('b', { status: 'done', nodes: talk, updatedAt: ago(5) })), { cell: 'delivered', why: null, kind: 'done', time: NOW - 5 })
  assert.deepEqual(at(flow('c', { status: 'done', updatedAt: ago(5) })), { cell: 'slipped', why: null, kind: 'done', time: NOW - 5 })
  assert.deepEqual(at(flow('d', { status: 'dropped', updatedAt: ago(5) })), { cell: 'missed', why: 'dropped', kind: 'dropped', time: NOW - 5 })
  assert.deepEqual(at(flow('e', { qa: verdict('qa-failed', 9) })), { cell: 'missed', why: 'stopped', kind: 'stopped', time: NOW - 9 })
  assert.deepEqual(at(flow('f', { updatedAt: ago(8 * DAY) })), { cell: 'missed', why: 'stalled', kind: 'stalled', time: NOW - DAY })
  assert.deepEqual(at(flow('g', { updatedAt: ago(5) })), { cell: null, why: null, kind: null, time: NOW - 5 })
})

// ═══ the scores ═══

test('precision, recall and accuracy: the value with the top and bottom it came from', () => {
  // 3 delivered, 1 slipped, 2 missed, 2 caught
  const s = run([
    flow('d1', { status: 'done', qa: verdict('passed', 1000) }),
    flow('d2', { status: 'done', nodes: talk }),
    flow('d3', { status: 'done', qa: { ...verdict('passed', 1000, { attempt: 2 }), attempts: [verdict('failed', 2000, { rework: { to: 'Agent 1' } })] } }),
    flow('s1', { status: 'done' }),
    flow('m1', { status: 'dropped' }),
    flow('m2', { qa: verdict('qa-failed', 1000) }),
  ])
  assert.deepEqual(s.counts, { delivered: 3, slipped: 1, missed: 2, caught: 2 })
  assert.deepEqual(s.precision, { value: 3 / 4, top: 3, bottom: 4 })
  assert.deepEqual(s.recall, { value: 3 / 5, top: 3, bottom: 5 })
  assert.deepEqual(s.accuracy, { value: 5 / 8, top: 5, bottom: 8 })
  assert.equal(s.f[1].value, fBeta(0.75, 0.6, 1))
  assert.equal(s.f[4].value, fBeta(0.75, 0.6, 4))
})

test('fBeta: the harmonic mean at 1, leaning to recall at 4; zero when both are zero; null when either is missing', () => {
  assert.equal(fBeta(0.5, 0.5, 1), 0.5)
  assert.ok(Math.abs(fBeta(1, 0.5, 1) - 2 / 3) < 1e-12)
  assert.ok(Math.abs(fBeta(1, 0.5, 4) - (17 * 0.5) / (16 + 0.5)) < 1e-12)
  assert.ok(fBeta(1, 0.5, 4) < fBeta(1, 0.5, 1), 'F4 sits near recall')
  assert.equal(fBeta(0, 0, 1), 0)
  assert.equal(fBeta(null, 0.5, 1), null)
  assert.equal(fBeta(0.5, null, 4), null)
})

test('no data: every score is null, never 0 or NaN', () => {
  const s = run([])
  for (const k of ['precision', 'recall', 'accuracy']) assert.deepEqual(s[k], { value: null, top: 0, bottom: 0 }, k)
  assert.equal(s.f[1].value, null)
  assert.equal(s.f[4].value, null)
  assert.deepEqual(s.correctness, { value: null, right: 0, judged: 0 })
  assert.deepEqual(s.agents, [])
})

test('a bottom of zero for one score leaves the others alone', () => {
  const s = run([flow('m', { status: 'dropped' })])
  assert.equal(s.precision.value, null)
  assert.deepEqual(s.recall, { value: 0, top: 0, bottom: 1 })
  assert.equal(s.f[1].value, null, 'no precision, so no F-score')
})

test('correctness: flows QA passed with no failure on the way, of those QA gave a final verdict on', () => {
  const s = run([
    flow('first', { status: 'done', qa: verdict('passed', 1000) }),
    flow('again-passed', { status: 'done', qa: { ...verdict('passed', 1000, { attempt: 2 }), attempts: [verdict('passed', 2000)] } }),
    flow('fixed', { status: 'done', qa: { ...verdict('passed', 1000, { attempt: 2 }), attempts: [verdict('failed', 2000, { rework: { to: 'Agent 1' } })] } }),
    flow('passed-then-failed', { status: 'done', qa: { ...verdict('passed', 1000, { attempt: 3 }), attempts: [verdict('passed', 3000), { ...verdict('qa-failed', 2000), attempt: 2 }] } }),
    flow('stopped', { qa: verdict('qa-failed', 1000) }),
    flow('rework', { qa: verdict('failed', 1000, { rework: { to: 'Agent 1' } }) }),
    flow('testing', { qa: verdict('testing', 1000) }),
  ])
  assert.deepEqual(s.correctness, { value: 2 / 5, right: 2, judged: 5 })
})

test('correctness: a final verdict counts by its own time', () => {
  const f = flow('old', { status: 'done', updatedAt: ago(1000), qa: verdict('passed', 9 * DAY) })
  assert.equal(run([f], { days: 7 }).correctness.judged, 0)
  assert.equal(run([f], { days: 30 }).correctness.judged, 1)
})

// ═══ per agent ═══

test('per agent: handed to QA, passed first time and sent back, a rework counted for the producer it went back to', () => {
  const s = run([
    flow('a', { agent: 'Master', status: 'done', qa: verdict('passed', 1000) }),
    flow('b', {
      agent: 'Master',
      qa: { ...verdict('testing', 1000, { attempt: 3 }), attempts: [verdict('failed', 5000, { rework: { to: 'Agent 2' } }), { ...verdict('failed', 3000, { rework: { to: 'Agent 2' } }), attempt: 2 }] },
    }),
    flow('c', { agent: 'Agent 1', qa: verdict('qa-failed', 1000) }),
    flow('quiet', { agent: 'Agent 1' }),
  ])
  assert.deepEqual(s.agents, [
    { label: 'Agent 2', handed: 2, firstTime: 0, sentBack: 1 },
    { label: 'Master', handed: 2, firstTime: 1, sentBack: 1 },
    { label: 'Agent 1', handed: 1, firstTime: 0, sentBack: 1 },
  ])
  assert.equal(s.agents.reduce((n, a) => n + a.sentBack, 0), s.counts.caught, 'every catch belongs to one agent')
  assert.equal(s.agents.reduce((n, a) => n + a.firstTime, 0), s.correctness.right)
})

test('per agent: an attempt outside the window is not counted', () => {
  const s = run([flow('a', { qa: { ...verdict('passed', 1000, { attempt: 2 }), attempts: [verdict('failed', 20 * DAY, { rework: { to: 'Agent 1' } })] } })], { days: 7 })
  assert.deepEqual(s.agents, [{ label: 'Agent 1', handed: 1, firstTime: 0, sentBack: 0 }])
})

// ═══ the lists ═══

test('the lists hold only flows in the window, newest first', () => {
  const s = run([flow('m-old', { status: 'dropped', updatedAt: ago(3 * DAY) }), flow('m-new', { status: 'dropped', updatedAt: ago(DAY) }), flow('m-out', { status: 'dropped', updatedAt: ago(40 * DAY) })])
  assert.deepEqual(s.lists.missed.map(m => m.id), ['m-new', 'm-old'])
})

test('bad input is skipped, not thrown on', () => {
  const s = run([null, 'x', { id: 'n' }, flow('ok', { status: 'done', nodes: talk, qa: { status: 'passed', at: ago(1000), attempts: 'no' } })], { days: null })
  assert.equal(s.counts.delivered, 1)
})

// ═══ the text ═══

test('scoreText: the five scores with their counts and meanings, a plain line for no data', () => {
  const s = run([flow('d', { status: 'done', qa: verdict('passed', 1000) }), flow('m', { status: 'dropped' })])
  const text = scoreText(s)
  assert.match(text, /last 30 days/)
  assert.match(text, /Precision 100% \(1 of 1\)/)
  assert.match(text, /Recall 50% \(1 of 2\)/)
  assert.match(text, /F1 67%/)
  assert.match(text, /F4 52%/)
  assert.match(text, /Accuracy 50% \(1 of 2\)/)
  assert.match(text, /Correctness 100% \(1 of 1\)/)
  for (const m of Object.values(MEANING)) assert.ok(text.includes(m[0].toLowerCase() + m.slice(1)), m)
  assert.doesNotMatch(text, /NaN|undefined|—/)
  const none = scoreText(run([], { days: null }))
  assert.match(none, /all time/)
  assert.match(none, /Precision: not enough data yet/)
  assert.doesNotMatch(none, /0%|NaN/)
})
