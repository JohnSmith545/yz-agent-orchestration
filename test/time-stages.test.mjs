// Tests for time-stages.mjs: how long one finished flow spent at each stage the flow file can date (with the
// coordinator and planner, with the producer, in QA, in Security, at Human task, with Senior, in reworks), and how
// long it waited on the user. Every number comes from two stored times; a part with a missing time is left out of
// that stage (listed as undated), never guessed. All pure: a flow and a graph in, milliseconds out.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { STAGES, stagesOf, waitingOf } from '../time-stages.mjs'

const BASE = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', Planner: 'Planner', Security: 'Security', Senior: 'Senior' },
}
const FULL = pipelineGraph({ ...BASE, pipeline: { ...DEFAULT_PIPELINE, planner: 'Planner', security: 'Security', senior: 'Senior' } })
const PLAIN = pipelineGraph({ ...BASE, pipeline: { ...DEFAULT_PIPELINE } })
const MIN = 60_000
const T0 = Date.parse('2026-11-20T09:00:00Z')
/** A time `m` minutes after T0, as a flow file stores it. */
const at = m => new Date(T0 + m * MIN).toISOString()
const flow = (more = {}) => ({ id: 'f', title: 'F', agent: 'Agent 1', status: 'done', createdAt: at(0), updatedAt: at(500), nodes: [], ...more })
const attempt = (n, startedAt, verdictAt, status, more = {}) => ({ attempt: n, status, startedAt: at(startedAt), at: at(verdictAt), ...more })

test('the stages, in the order the bar shows them', () => {
  assert.deepEqual(STAGES.map(s => s.key), ['planning', 'producing', 'qa', 'security', 'human', 'senior', 'rework'])
  assert.deepEqual(STAGES.map(s => s.label), ['Coordinator and planner', 'Producer', 'QA', 'Security', 'Human task', 'Senior', 'Reworks'])
})

test('a planned code flow: planner to the hand-out, producer to the QA start, QA from start to verdict', () => {
  const f = flow({
    plan: { status: 'handed', by: 'Planner', startedAt: at(2), at: at(10), to: 'Agent 1' },
    qa: attempt(1, 70, 85, 'passed'),
  })
  const s = stagesOf(f, PLAIN, { start: T0, finish: T0 + 85 * MIN })
  assert.deepEqual(s.times, { planning: 10 * MIN, producing: 60 * MIN, qa: 15 * MIN })
  assert.deepEqual(s.undated, [])
})

test('the FIRST hand-out counts: a task handed again later keeps the earliest time', () => {
  const f = flow({
    plan: { status: 'handed', by: 'Planner', at: at(40), to: 'Agent 2', history: [{ by: 'Planner', at: at(5), to: 'Agent 1' }] },
    qa: attempt(1, 70, 80, 'passed'),
  })
  const s = stagesOf(f, PLAIN, { start: T0, finish: T0 + 80 * MIN })
  assert.equal(s.times.planning, 5 * MIN)
  assert.equal(s.times.producing, 65 * MIN)
})

test('no planner: no planning stage, and the producer counts from the start (the hand-over has no time)', () => {
  const s = stagesOf(flow({ qa: attempt(1, 30, 45, 'passed') }), PLAIN, { start: T0, finish: T0 + 45 * MIN })
  assert.deepEqual(s.times, { producing: 30 * MIN, qa: 15 * MIN })
  assert.equal('planning' in s.times, false)
})

test('a planner still planning with no hand-out time: planning is undated, the producer counts from the start', () => {
  const f = flow({ plan: { status: 'planning', by: 'Planner', startedAt: at(1), at: at(1) }, qa: attempt(1, 30, 45, 'passed') })
  const s = stagesOf(f, PLAIN, { start: T0, finish: T0 + 45 * MIN })
  assert.deepEqual(s.undated, ['planning'])
  assert.equal(s.times.producing, 30 * MIN)
})

test('reworks: each failure to the next attempt start, QA summed over every attempt', () => {
  const f = flow({
    qa: {
      ...attempt(3, 200, 210, 'passed'),
      attempts: [attempt(1, 30, 40, 'failed', { rework: { to: 'Agent 1' } }), attempt(2, 100, 120, 'failed', { rework: { to: 'Agent 1' } })],
    },
  })
  const s = stagesOf(f, PLAIN, { start: T0, finish: T0 + 210 * MIN })
  assert.equal(s.times.producing, 30 * MIN)
  assert.equal(s.times.qa, (10 + 20 + 10) * MIN)
  assert.equal(s.times.rework, (60 + 80) * MIN)
})

test('Security: from QA pass to Security verdict on each reviewed attempt; a Security failure is a rework', () => {
  const f = flow({
    qa: {
      ...attempt(2, 100, 110, 'passed', { security: { status: 'passed', by: 'Security', startedAt: at(112), at: at(125) } }),
      attempts: [attempt(1, 30, 40, 'passed', { security: { status: 'failed', by: 'Security', at: at(50), rework: { to: 'Agent 1' } } })],
    },
  })
  const s = stagesOf(f, FULL, { start: T0, finish: T0 + 125 * MIN })
  assert.equal(s.times.security, (10 + 15) * MIN)
  assert.equal(s.times.rework, 50 * MIN, 'Security failure at 50, attempt 2 started at 100')
  assert.equal(s.times.qa, 20 * MIN)
})

test('Security data on a pipeline without Security is not counted', () => {
  const f = flow({ qa: attempt(1, 30, 40, 'passed', { security: { status: 'passed', by: 'Security', at: at(50) } }) })
  const s = stagesOf(f, PLAIN, { start: T0, finish: T0 + 40 * MIN })
  assert.equal('security' in s.times, false)
})

test('Human task and Senior: steps from the first written to Senior starting, each review, a Senior failure a rework', () => {
  const f = flow({
    hand: { steps: [{ id: 'h1', do: 'a', expect: 'b', at: at(20), done: { by: 'you', at: at(170) } }, { id: 'h2', do: 'c', expect: 'd', at: at(25), done: { by: 'you', at: at(60) } }] },
    senior: { status: 'passed', by: 'Senior', startedAt: at(180), at: at(190), history: [{ status: 'failed', by: 'Senior', startedAt: at(70), at: at(80), redo: ['h1'] }] },
  })
  const s = stagesOf(f, FULL, { start: T0, finish: T0 + 190 * MIN })
  assert.equal(s.times.producing, 20 * MIN, 'to the first by-hand step')
  assert.equal(s.times.human, 50 * MIN, 'first step written (20) to Senior starting (70)')
  assert.equal(s.times.senior, (10 + 10) * MIN)
  assert.equal(s.times.rework, 100 * MIN, 'failure at 80, next review started at 180')
  assert.deepEqual(s.undated, [])
})

test('Human task with no Senior: the first step written to the last tick', () => {
  const f = flow({ hand: { steps: [{ id: 'h1', do: 'a', expect: 'b', at: at(10), done: { by: 'you', at: at(40) } }] } })
  const s = stagesOf(f, PLAIN, { start: T0, finish: T0 + 50 * MIN })
  assert.deepEqual(s.times, { producing: 10 * MIN, human: 30 * MIN })
})

test('a no-code flow with no by-hand steps: the producer from start to finish', () => {
  const s = stagesOf(flow(), PLAIN, { start: T0, finish: T0 + 42 * MIN })
  assert.deepEqual(s.times, { producing: 42 * MIN })
})

test('missing times leave that stage out, never guessed', () => {
  const noStart = flow({ qa: { status: 'passed', attempt: 1, at: at(45) } })
  const a = stagesOf(noStart, PLAIN, { start: T0, finish: T0 + 45 * MIN })
  assert.deepEqual(a.times, {})
  assert.deepEqual(a.undated.sort(), ['producing', 'qa'])

  const oneUndated = flow({ qa: { ...attempt(2, 100, 110, 'passed'), attempts: [{ attempt: 1, status: 'failed', startedAt: at(30), rework: { to: 'Agent 1' } }] } })
  const b = stagesOf(oneUndated, PLAIN, { start: T0, finish: T0 + 110 * MIN })
  assert.equal(b.times.producing, 30 * MIN)
  assert.deepEqual(b.undated.sort(), ['qa', 'rework'], 'the failure has no verdict time: QA and the rework are both left out whole')

  const noCreated = stagesOf(flow({ createdAt: undefined, qa: attempt(1, 30, 45, 'passed') }), PLAIN, { start: null, finish: T0 + 45 * MIN })
  assert.deepEqual(noCreated.times, { qa: 15 * MIN })
  assert.deepEqual(noCreated.undated, ['producing'])

  const step = flow({ hand: { steps: [{ id: 'h1', do: 'a', expect: 'b', at: at(10), done: null }] } })
  assert.deepEqual(stagesOf(step, PLAIN, { start: T0, finish: T0 + 50 * MIN }).undated, ['human'])
})

test('a time that runs backwards is undated, never a negative stage', () => {
  const s = stagesOf(flow({ qa: attempt(1, 30, 20, 'passed') }), PLAIN, { start: T0, finish: T0 + 30 * MIN })
  assert.deepEqual(s.undated, ['qa'])
  assert.equal(s.times.producing, 30 * MIN)
})

// ═══ waiting on the user ═══

const ask = (askedAt, answeredAt, more = {}) => ({ id: `a${askedAt}`, type: 'ask', title: 'Q', kind: 'yesno', answer: answeredAt === null ? null : 'yes', at: askedAt === null ? undefined : at(askedAt), answeredAt: answeredAt === null ? null : at(answeredAt), ...more })

test('waiting: from each question to its answer and each by-hand step to its tick, overlaps counted once', () => {
  const f = flow({
    nodes: [ask(10, 30), ask(20, 40), ask(100, 105)],
    hand: { steps: [{ id: 'h1', do: 'a', expect: 'b', at: at(200), done: { by: 'you', at: at(260) } }] },
  })
  assert.deepEqual(waitingOf(f, { start: T0, finish: T0 + 300 * MIN }), { ms: (30 + 5 + 60) * MIN })
})

test('waiting: nothing asked is a real zero; a question with no time makes the flow undated', () => {
  assert.deepEqual(waitingOf(flow(), { start: T0, finish: T0 + 60 * MIN }), { ms: 0 })
  assert.equal(waitingOf(flow({ nodes: [ask(null, 30)] }), { start: T0, finish: T0 + 60 * MIN }), null)
  assert.equal(waitingOf(flow({ nodes: [ask(10, null)] }), { start: T0, finish: T0 + 60 * MIN }), null, 'never answered: when the wait ended is not stored')
  const step = flow({ hand: { steps: [{ id: 'h1', do: 'a', expect: 'b', at: at(10), done: null }] } })
  assert.equal(waitingOf(step, { start: T0, finish: T0 + 60 * MIN }), null)
})

test('waiting is clipped to the flow start and finish', () => {
  const f = flow({ nodes: [ask(-30, 20), ask(50, 90)] })
  assert.deepEqual(waitingOf(f, { start: T0, finish: T0 + 60 * MIN }), { ms: (20 + 10) * MIN })
})
