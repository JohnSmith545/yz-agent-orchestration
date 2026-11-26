// Tests for learn-numbers.mjs: the four numbers a rule change is judged by, over ONE window with both ends fixed
// (from, to): right-first-time, median time per job, estimated cost per job and QA failures per finished flow. Built on
// the scorecard's and Pipeline time's own rules (score.mjs, time-stats.mjs); a flow that finished after `to` is not in
// the window even though those blocks count up to "now". Pure: flows and a token reader are passed in.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { windowNumbers } from '../learn-numbers.mjs'

const DAY = 86_400_000
const H = 3_600_000
const GRAPH = pipelineGraph({ coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' }, pipeline: { ...DEFAULT_PIPELINE }, factory: { chat: { name: 'Independent' } } })
const TO = new Date(2026, 10, 25, 12, 0).getTime()
const FROM = TO - 14 * DAY
const iso = t => new Date(t).toISOString()

/** A code flow QA passed at `done`, started `took` earlier, after `fails` failed attempts. */
function flow(id, done, { took = 2 * H, fails = 0, tickets = [] } = {}) {
  const start = done - took
  const attempts = Array.from({ length: fails }, (_, i) => ({ status: 'failed', attempt: i + 1, by: 'QA', startedAt: iso(start + (i + 1) * 60_000), at: iso(start + (i + 1) * 60_000 + 1000), summary: 'fail' }))
  return {
    id, title: id, agent: 'Agent 1', status: 'done', nodes: [], tickets, createdAt: iso(start), updatedAt: iso(done),
    qa: { status: 'passed', attempt: fails + 1, by: 'QA', startedAt: iso(done - 1000), at: iso(done), summary: 'ok', attempts },
  }
}

test('three flows in the window: right-first-time, the median time, QA failures per finished flow, the cost per job', () => {
  const flows = [
    flow('a', TO - 1 * DAY, { took: 1 * H }),
    flow('b', TO - 2 * DAY, { took: 3 * H, fails: 2 }),
    flow('c', TO - 3 * DAY, { took: 2 * H }),
  ]
  const n = windowNumbers({ flows, graph: GRAPH, from: FROM, to: TO, tokens: ({ from, to }) => ({ usd: 6 }) })
  assert.equal(n.finished, 3)
  assert.deepEqual(n.rightFirstTime, { value: 2 / 3, right: 2, judged: 3 })
  assert.equal(n.medianMs.value, 2 * H)
  assert.equal(n.medianMs.flows, 3)
  assert.deepEqual(n.qaFailures, { value: 2 / 3, failures: 2, flows: 3 })
  assert.deepEqual(n.costPerJob, { value: 2, usd: 6, jobs: 3 })
  assert.equal(n.from, iso(FROM))
  assert.equal(n.to, iso(TO))
})

test('a flow that finished after the window end is left out, though the score itself would count it', () => {
  const flows = [flow('in', TO - 1 * DAY), flow('later', TO + 2 * DAY, { fails: 1 })]
  const n = windowNumbers({ flows, graph: GRAPH, from: FROM, to: TO, tokens: null })
  assert.equal(n.finished, 1)
  assert.deepEqual(n.rightFirstTime, { value: 1, right: 1, judged: 1 })
  assert.deepEqual(n.qaFailures, { value: 0, failures: 0, flows: 1 })
})

test('a flow that finished before the window start is left out too', () => {
  const n = windowNumbers({ flows: [flow('old', FROM - DAY)], graph: GRAPH, from: FROM, to: TO })
  assert.equal(n.finished, 0)
})

test('nothing finished: every number null with its count at 0, never a zero that reads as a result', () => {
  const n = windowNumbers({ flows: [], graph: GRAPH, from: FROM, to: TO, tokens: () => ({ usd: 4 }) })
  assert.equal(n.finished, 0)
  assert.deepEqual(n.rightFirstTime, { value: null, right: 0, judged: 0 })
  assert.deepEqual(n.medianMs, { value: null, flows: 0 })
  assert.deepEqual(n.qaFailures, { value: null, failures: 0, flows: 0 })
  assert.deepEqual(n.costPerJob, { value: null, usd: 4, jobs: 0 })
})

test('no token reader, one that throws, or no price: the cost is left out, the rest still counts', () => {
  const flows = [flow('a', TO - DAY)]
  assert.deepEqual(windowNumbers({ flows, graph: GRAPH, from: FROM, to: TO }).costPerJob, { value: null, usd: null, jobs: 1 })
  assert.deepEqual(windowNumbers({ flows, graph: GRAPH, from: FROM, to: TO, tokens: () => { throw new Error('index gone') } }).costPerJob, { value: null, usd: null, jobs: 1 })
  assert.deepEqual(windowNumbers({ flows, graph: GRAPH, from: FROM, to: TO, tokens: () => ({ usd: null }) }).costPerJob, { value: null, usd: null, jobs: 1 })
  assert.equal(windowNumbers({ flows, graph: GRAPH, from: FROM, to: TO }).finished, 1)
})

test('a job is a ticket at its last finish, else a flow: two flows on one ticket are one job', () => {
  const flows = [flow('a', TO - DAY, { tickets: ['FLA-1'] }), flow('b', TO - 2 * DAY, { tickets: ['FLA-1'] }), flow('c', TO - 3 * DAY)]
  const n = windowNumbers({ flows, graph: GRAPH, from: FROM, to: TO, tokens: () => ({ usd: 10 }) })
  assert.equal(n.costPerJob.jobs, 2)
  assert.equal(n.costPerJob.value, 5)
})
