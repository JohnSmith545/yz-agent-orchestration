// Tests for predict-spans.mjs and predict-flow-tokens.mjs: the PLACEMENT rule that puts the transcripts' tokens on the
// flows that spent them. A reply counts for a flow when its session's label is on the flow (an agent with a span there)
// and its hour falls in that agent's span on the flow, split evenly when the same agent has several flows open at
// once; a subagent counts with the session that started it; whatever cannot be placed stays unplaced. Hours are spread
// evenly (the index keeps per hour totals): a span that covers a quarter of an hour takes a quarter of it.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pipelineGraph } from '../pipeline.mjs'
import { agentSpans } from '../predict-spans.mjs'
import { flowTokens, placeTokens, setFlowTokenSource } from '../predict-flow-tokens.mjs'

const HOUR = 3_600_000
const MIN = 60_000
const T0 = Date.parse('2026-11-25T08:00:00.000Z')
const iso = t => new Date(t).toISOString()
const CONFIG = { coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2' }, pipeline: { qa: 'QA' } }
const graph = pipelineGraph(CONFIG)
const PRICES = { m: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } }

const flow = (id, more = {}) => ({ id, title: id, agent: 'Agent 1', status: 'open', createdAt: iso(T0), updatedAt: iso(T0), nodes: [], ...more })
const qa = (attempts, last) => ({ ...last, attempts })
/** A file of session `sessionId` with `tokens` (all as output) in each epoch hour given. */
const file = (sessionId, hours, { sub = false } = {}) => ({
  sessionId, sub, title: null, mtimeMs: 0, days: {},
  hours: Object.fromEntries(Object.entries(hours).map(([h, n]) => [String(Math.floor(Number(h) / HOUR)), { m: [0, n, 0, 0, 0, 1] }])),
})
const labelsBy = map => id => map[id] ?? 'Unnamed sessions'

// ═══ the spans ═══

test('an open flow with no QA yet: its agent from the start to now', () => {
  const spans = agentSpans(flow('a'), graph, { now: T0 + 2 * HOUR })
  assert.deepEqual(spans, [{ label: 'Agent 1', from: T0, to: T0 + 2 * HOUR }])
})

test('a delivered flow: the producer until QA started, QA while it tested, the producer again for a rework', () => {
  const f = flow('a', {
    status: 'done',
    qa: qa(
      [{ status: 'failed', attempt: 1, by: 'QA', startedAt: iso(T0 + HOUR), at: iso(T0 + HOUR + 30 * MIN), rework: { to: 'Agent 1' } }],
      { status: 'passed', attempt: 2, by: 'QA', startedAt: iso(T0 + 2 * HOUR), at: iso(T0 + 2 * HOUR + 20 * MIN), pushedAt: iso(T0 + 3 * HOUR) },
    ),
  })
  const spans = agentSpans(f, graph, { now: T0 + 10 * HOUR })
  assert.deepEqual(spans, [
    { label: 'Agent 1', from: T0, to: T0 + HOUR },
    { label: 'QA', from: T0 + HOUR, to: T0 + HOUR + 30 * MIN },
    { label: 'QA', from: T0 + 2 * HOUR, to: T0 + 2 * HOUR + 20 * MIN },
    { label: 'Agent 1', from: T0 + HOUR + 30 * MIN, to: T0 + 2 * HOUR },
  ])
})

test('a flow QA is testing now: its span runs to now; a flow with no time to start from has no spans', () => {
  const f = flow('a', { qa: { status: 'testing', attempt: 1, by: 'QA', startedAt: iso(T0 + HOUR) } })
  assert.deepEqual(agentSpans(f, graph, { now: T0 + 90 * MIN }).at(-1), { label: 'QA', from: T0 + HOUR, to: T0 + 90 * MIN })
  assert.deepEqual(agentSpans(flow('b', { createdAt: 'whenever' }), graph, { now: T0 }), [])
})

test('an open flow put away (archived) or left for a week (stalled) stops taking tokens at that point', () => {
  const archived = flow('a', { archivedAt: iso(T0 + HOUR) })
  assert.equal(agentSpans(archived, graph, { now: T0 + 5 * HOUR })[0].to, T0 + HOUR)
  const stalled = flow('b', { updatedAt: iso(T0 + HOUR) })
  assert.equal(agentSpans(stalled, graph, { now: T0 + 8 * 24 * HOUR })[0].to, T0 + HOUR)
})

// ═══ the placement ═══

test('one flow: its agent s tokens in its span are the flow s, the rest of that session s hours are unplaced', () => {
  const flows = [flow('a', { status: 'done', updatedAt: iso(T0 + HOUR) })]
  const files = [file('s1', { [T0]: 1000, [T0 + HOUR]: 400 })]
  const p = placeTokens({ files, flows, graph, labelOf: labelsBy({ s1: 'Agent 1' }), prices: PRICES, now: T0 + 5 * HOUR })
  assert.equal(p.flows.get('a').tokens, 1000)
  assert.equal(p.unplaced.tokens, 400)
  assert.equal(p.placed.tokens, 1000)
  assert.equal(p.flows.get('a').usd, 1000 / 1e6)
})

test('a span that covers part of an hour takes that part of it', () => {
  const flows = [flow('a', { status: 'done', createdAt: iso(T0 + 15 * MIN), updatedAt: iso(T0 + 45 * MIN) })]
  const files = [file('s1', { [T0]: 1000 })]
  const p = placeTokens({ files, flows, graph, labelOf: labelsBy({ s1: 'Agent 1' }), prices: PRICES, now: T0 + 5 * HOUR })
  assert.equal(p.flows.get('a').tokens, 500)
  assert.equal(p.unplaced.tokens, 500)
})

test('the hour going on now is spread over the part of it that has passed, not the whole hour', () => {
  const flows = [flow('a', { createdAt: iso(T0 + 10 * MIN) })]
  const files = [file('s1', { [T0]: 900 })]
  const p = placeTokens({ files, flows, graph, labelOf: labelsBy({ s1: 'Agent 1' }), prices: PRICES, now: T0 + 30 * MIN })
  assert.equal(Math.round(p.flows.get('a').tokens), 600)
  assert.equal(Math.round(p.unplaced.tokens), 300)
})

test('overlapping flows of the same agent split the overlap evenly; each keeps what only it covers', () => {
  const flows = [
    flow('a', { status: 'done', createdAt: iso(T0), updatedAt: iso(T0 + 2 * HOUR) }),
    flow('b', { status: 'done', createdAt: iso(T0 + HOUR), updatedAt: iso(T0 + 2 * HOUR) }),
  ]
  const files = [file('s1', { [T0]: 1000, [T0 + HOUR]: 1000 })]
  const p = placeTokens({ files, flows, graph, labelOf: labelsBy({ s1: 'Agent 1' }), prices: PRICES, now: T0 + 5 * HOUR })
  assert.equal(p.flows.get('a').tokens, 1500)
  assert.equal(p.flows.get('b').tokens, 500)
  assert.equal(p.unplaced.tokens, 0)
})

test('a subagent counts with the session that started it', () => {
  const flows = [flow('a', { status: 'done', updatedAt: iso(T0 + HOUR) })]
  const files = [file('s1', { [T0]: 100 }), file('s1', { [T0]: 50 }, { sub: true })]
  const p = placeTokens({ files, flows, graph, labelOf: labelsBy({ s1: 'Agent 1' }), prices: PRICES, now: T0 + 5 * HOUR })
  assert.equal(p.flows.get('a').tokens, 150)
})

test('a session on no flow, an unnamed one, and hours outside every span are unplaced; another agent s flow takes none', () => {
  const flows = [flow('a', { agent: 'Agent 2', status: 'done', updatedAt: iso(T0 + HOUR) })]
  const files = [file('s1', { [T0]: 100 }), file('s9', { [T0]: 70 }), file('s2', { [T0 - 5 * HOUR]: 30 })]
  const p = placeTokens({ files, flows, graph, labelOf: labelsBy({ s1: 'Agent 1', s2: 'Agent 2' }), prices: PRICES, now: T0 + 5 * HOUR })
  assert.equal(p.flows.get('a')?.tokens ?? 0, 0)
  assert.equal(p.unplaced.tokens, 200)
  assert.equal(p.total.tokens, 200)
})

test('only the hours from `from` count toward the period figures; the flows still get every hour', () => {
  const flows = [flow('a', { status: 'done', createdAt: iso(T0 - 3 * HOUR), updatedAt: iso(T0 + HOUR) })]
  const files = [file('s1', { [T0 - 2 * HOUR]: 100, [T0]: 100 })]
  const p = placeTokens({ files, flows, graph, labelOf: labelsBy({ s1: 'Agent 1' }), prices: PRICES, now: T0 + 5 * HOUR, from: T0 })
  assert.equal(p.placed.tokens, 100)
  assert.equal(p.flows.get('a').tokens, 200)
})

test('a model with no price leaves the flow s dollars out and says so', () => {
  const flows = [flow('a', { status: 'done', updatedAt: iso(T0 + HOUR) })]
  const files = [file('s1', { [T0]: 100 })]
  const p = placeTokens({ files, flows, graph, labelOf: labelsBy({ s1: 'Agent 1' }), prices: {}, now: T0 + 5 * HOUR })
  assert.equal(p.flows.get('a').usd, null)
  assert.equal(p.flows.get('a').unpriced, true)
})

test('flowTokens answers through the source the server sets, and null with none', () => {
  setFlowTokenSource(null)
  assert.equal(flowTokens('a'), null)
  setFlowTokenSource(id => (id === 'a' ? { tokens: 5, usd: 1 } : null))
  assert.deepEqual(flowTokens('a'), { tokens: 5, usd: 1 })
  assert.equal(flowTokens('b'), null)
  setFlowTokenSource(() => {
    throw new Error('broken')
  })
  assert.equal(flowTokens('a'), null)
  setFlowTokenSource(null)
})
