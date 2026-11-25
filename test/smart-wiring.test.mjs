// Tests for smart-wiring.mjs: the adapters that connect the four smart features at merge. Each consumer was built
// against a CONTRACT with a safe default; here the real providers are shaped to it, and a provider that throws or
// answers something odd never breaks its consumer:
//   Learn's pack    <- quality's listLessons (lessons) and predict's signals (alerts and estimate misses)
//   Predict         <- quality's risk label, as a level string, for similarity
//   Routing         <- the same risk level, and predict's flowTokens, through setRoutingProviders

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { learnLessons, learnSignals, riskLevelOf, routingTokens, wireRouting } from '../smart-wiring.mjs'
import { buildPack } from '../learn-pack.mjs'
import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { rankSimilar, targetOf } from '../predict-estimate.mjs'
import { planRouting } from '../routing-flow.mjs'
import { DEFAULT_RULES } from '../routing-rules.mjs'
import { routingProviders, setRoutingProviders } from '../routing-providers.mjs'
import { riskOf as qualityRiskOf } from '../quality-risk.mjs'

const boom = () => {
  throw new Error('provider failed')
}
const DAY = 86_400_000
const NOW = new Date(2026, 10, 25, 12, 0).getTime()
const iso = t => new Date(t).toISOString()
const GRAPH = pipelineGraph({ coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' }, pipeline: { ...DEFAULT_PIPELINE }, factory: { chat: { name: 'Independent' } } })

// ═══ risk: quality's { level, reasons, needs } to the level string predict and routing compare ═══

test('riskLevelOf: the stored label wins, without working it out again', () => {
  let called = 0
  const level = riskLevelOf(() => (called++, { level: 'low' }))
  assert.equal(level({ id: 'f', risk: { level: 'high', reasons: ['x'], needs: [] } }), 'high')
  assert.equal(called, 0)
})

test('riskLevelOf: no stored label is worked out from the flow, its facts and the rules', () => {
  const seen = []
  const level = riskLevelOf((flow, opts) => (seen.push(opts), { level: 'medium', reasons: [], needs: [] }), {
    factsOf: () => ({ labels: ['Billing'], planText: 'plan', files: [] }), rules: () => ['R'],
  })
  assert.equal(level({ id: 'f', title: 'x' }), 'medium')
  assert.deepEqual(seen, [{ labels: ['Billing'], planText: 'plan', files: [], rules: ['R'] }])
})

test('riskLevelOf: with the real quality rules, a sign-in task is not low', () => {
  const level = riskLevelOf(qualityRiskOf)
  const got = level({ id: 'f', title: 'Fix the sign-in session cookie', why: 'Users are logged out' })
  assert.ok(['medium', 'high'].includes(got), got)
  assert.equal(level({ id: 'g', title: 'Reword a button' }), 'low')
})

test('riskLevelOf: a bad stored level is worked out again; a throw or an odd answer is null', () => {
  assert.equal(riskLevelOf(() => ({ level: 'low' }))({ risk: { level: 'urgent' } }), 'low')
  assert.equal(riskLevelOf(boom)({ id: 'f' }), null)
  assert.equal(riskLevelOf(() => ({ level: 'odd' }))({ id: 'f' }), null)
  assert.equal(riskLevelOf(() => 'high')({ id: 'f' }), null, 'a bare string is not the contract')
  assert.equal(riskLevelOf(() => ({ level: 'low' }), { factsOf: boom })({ id: 'f' }), null)
  assert.equal(riskLevelOf(() => ({ level: 'low' }))(null), null)
  assert.equal(riskLevelOf(null)({ id: 'f' }), null)
})

test('predict: a throwing risk provider leaves the estimate working, without the risk part', () => {
  const finished = id => ({ id, title: `Fix the cart ${id}`, agent: 'Agent 1', status: 'done', nodes: [], createdAt: iso(NOW - 3 * DAY), updatedAt: iso(NOW - 2 * DAY), qa: { status: 'passed', attempt: 1, by: 'QA', startedAt: iso(NOW - 2 * DAY - 1000), at: iso(NOW - 2 * DAY), attempts: [] } })
  const flows = [finished('a'), finished('b'), finished('c')]
  const open = { id: 'new', title: 'Fix the cart total', agent: 'Agent 1', status: 'open', createdAt: iso(NOW), updatedAt: iso(NOW), nodes: [] }
  const safe = riskLevelOf(boom)
  const target = targetOf({ flow: open }, safe)
  assert.equal(target.risk, null)
  assert.doesNotThrow(() => rankSimilar(target, flows, { graph: GRAPH, now: NOW, riskOf: safe }))
  // and the same risk level scores one point more
  const high = riskLevelOf(() => ({ level: 'high' }))
  const ranked = rankSimilar(targetOf({ flow: open }, high), flows, { graph: GRAPH, now: NOW, riskOf: high })
  const plain = rankSimilar(target, flows, { graph: GRAPH, now: NOW, riskOf: safe })
  assert.equal(ranked[0].score, plain[0].score + 1)
})

// ═══ Learn: lessons and signals in the shape the pack reads ═══

const LESSONS = [
  { id: 'L1', text: 'Write the failing test first.', area: 'tests', count: 3, status: 'active', sources: [{ flow: 'a', at: iso(NOW), gate: 'qa' }], by: 'you' },
  { id: 'L2', text: 'Stop the preview server.', area: 'process', count: 1, status: 'retired', sources: [], by: 'you' },
]

test('learnLessons: active lessons only, as { id, text, area, count }, since passed as a date', () => {
  const asked = []
  const lessons = learnLessons(opts => (asked.push(opts), LESSONS))
  assert.deepEqual(lessons({ since: NOW - 7 * DAY }), [{ id: 'L1', text: 'Write the failing test first.', area: 'tests', count: 3 }])
  assert.deepEqual(asked, [{ since: iso(NOW - 7 * DAY) }], 'listLessons reads since with Date.parse: a number would match nothing')
  lessons({})
  assert.deepEqual(asked[1], { since: undefined })
})

test('learnLessons: an odd answer is no lessons; a throw reaches the pack, which leaves the section out and says so', () => {
  assert.deepEqual(learnLessons(() => null)({ since: NOW }), [])
  assert.deepEqual(learnLessons(() => [null, 'x', { id: 'L', text: '' }])({ since: NOW }), [])
  assert.throws(() => learnLessons(boom)({ since: NOW }))
  const pack = buildPack({
    now: NOW, graph: GRAPH, flows: () => [], rules: () => ({ agents: {} }), tokens: () => ({ usd: null }),
    verdicts: () => [], rejected: () => [], lessons: learnLessons(boom), signals: learnSignals(boom),
  })
  assert.match(pack.left, /the lessons/)
  assert.match(pack.left, /the alerts/)
  assert.ok(pack.text.length > 0)
})

test('learnSignals: kind and text kept, flow and agent when there, odd rows dropped, since passed on', () => {
  const asked = []
  const signals = learnSignals(opts => (asked.push(opts), [
    { kind: 'stuck', text: 'Flow a sat at QA for 5 hours.', flow: 'a' },
    { kind: 'estimate-miss', text: 'Flow b took 3 hours against about 1.', agent: 'Agent 1' },
    { kind: '', text: 'no kind' }, null, 'x',
  ]))
  assert.deepEqual(signals({ since: NOW - DAY }), [
    { kind: 'stuck', text: 'Flow a sat at QA for 5 hours.', flow: 'a' },
    { kind: 'estimate-miss', text: 'Flow b took 3 hours against about 1.', agent: 'Agent 1' },
  ])
  assert.deepEqual(asked, [{ since: NOW - DAY }])
  assert.deepEqual(learnSignals(() => undefined)({}), [])
})

test('the pack carries both sections when the providers answer', () => {
  const pack = buildPack({
    now: NOW, graph: GRAPH, flows: () => [], rules: () => ({ agents: {} }), tokens: () => ({ usd: null }),
    verdicts: () => [], rejected: () => [],
    lessons: learnLessons(() => LESSONS), signals: learnSignals(() => [{ kind: 'spike', text: 'Agent 1 burned 40M tokens in an hour.' }]),
  })
  assert.match(pack.text, /LESSONS LEARNED[\s\S]*\[tests\] Write the failing test first\. \(seen 3 times\)/)
  assert.doesNotMatch(pack.text, /Stop the preview server/)
  assert.match(pack.text, /ALERTS AND ESTIMATES[\s\S]*- spike: Agent 1 burned 40M tokens/)
  assert.equal(pack.left, '')
})

// ═══ Routing: the risk level and the tokens, through setRoutingProviders ═══

test('routingTokens: { tokens, usd } from predict, or null', () => {
  assert.deepEqual(routingTokens(() => ({ tokens: 1200, usd: 0.4, unpriced: 0 }))('f'), { tokens: 1200, usd: 0.4 })
  assert.equal(routingTokens(() => null)('f'), null)
  assert.equal(routingTokens(() => ({ tokens: 5, usd: null }))('f'), null, 'an unpriced flow is not known')
  assert.equal(routingTokens(boom)('f'), null)
  assert.equal(routingTokens(null)('f'), null)
})

test('wireRouting: routing reads the level and the tokens; a throwing provider is no risk and no tokens', () => {
  const before = routingProviders()
  try {
    wireRouting({ riskOf: () => ({ level: 'high' }), flowTokens: () => ({ tokens: 10, usd: 1 }) })
    assert.equal(routingProviders().riskOf({ id: 'f' }), 'high')
    assert.deepEqual(routingProviders().flowTokens('f'), { tokens: 10, usd: 1 })
    assert.equal(planRouting({ id: 'f', title: 'Fix a typo in the footer', agent: 'Agent 1' }, { rules: DEFAULT_RULES, graph: GRAPH }).risk, null)
    assert.equal(planRouting({ id: 'f', title: 'Fix a typo in the footer', agent: 'Agent 1' }, { rules: DEFAULT_RULES, graph: GRAPH, riskOf: routingProviders().riskOf }).risk, 'high')

    wireRouting({ riskOf: boom, flowTokens: boom })
    assert.equal(routingProviders().riskOf({ id: 'f' }), null)
    assert.equal(routingProviders().flowTokens('f'), null)
    assert.doesNotThrow(() => planRouting({ id: 'f', title: 'Fix a typo', agent: 'Agent 1' }, { rules: DEFAULT_RULES, graph: GRAPH, riskOf: routingProviders().riskOf }))
  } finally {
    setRoutingProviders(before)
  }
})

// ═══ the two entry points really wire them ═══

test('server.mjs wires Learn, Predict and Routing through smart-wiring.mjs', () => {
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(src, /from '\.\/smart-wiring\.mjs'/)
  assert.match(src, /makeLearnServerRoute\(\{[^\n]*lessons: learnLessons\(listLessons\)[^\n]*signals: learnSignals\(signals\)/)
  assert.match(src, /makePredictRoute\(\{[^\n]*riskOf: riskLevelOf\(riskOf\)/)
  assert.match(src, /wireRouting\(\{ riskOf, flowTokens \}\)/)
})

test('the CLI entry wires Routing too', () => {
  const src = readFileSync(new URL('../tools/factory.mjs', import.meta.url), 'utf8')
  assert.match(src, /wireRouting\(\{ riskOf, flowTokens \}\)/)
})
