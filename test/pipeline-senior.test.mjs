// Tests for the Human task box and the optional Senior agent of pipeline.mjs (and pipeline-hand.mjs, the stage of a
// flow on the by-hand route): the `senior` setting, which label draws the Senior box (gateLabels), the graph with and
// without Senior, the planner, Security and the chat agent, and where a no-code flow stands (stageOf). All pure.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PIPELINE, gateLabels, pipelineGraph, pipelineSettings, producersOf, stageOf } from '../pipeline.mjs'

const BASE = {
  coordinator: 'Master',
  coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', 'Agent 3': 'Agent 3', Senior: 'Senior' },
  pipeline: { ...DEFAULT_PIPELINE },
}
const SENIOR = { ...BASE, pipeline: { ...DEFAULT_PIPELINE, senior: 'Senior' } }
const LIVE = {
  ...SENIOR,
  codingAgents: { ...SENIOR.codingAgents, Planner: 'Planner', Security: 'Security' },
  factory: { chat: { name: 'Independent' } },
  pipeline: { ...DEFAULT_PIPELINE, planner: 'Planner', security: 'Security', senior: 'Senior' },
}
const ids = list => list.map(x => x.id)
const edge = (g, from, to, kind) => g.edges.find(e => e.from === from && e.to === to && (!kind || e.kind === kind))

// ═══ settings ═══

test('pipelineSettings: senior is kept when it is a label, and left out when absent or null', () => {
  const warned = []
  assert.deepEqual(pipelineSettings({ senior: ' Senior ' }, w => warned.push(w)), { ...pipelineSettings(undefined), senior: 'Senior' })
  assert.deepEqual(pipelineSettings({ senior: null }, w => warned.push(w)), pipelineSettings(undefined))
  assert.deepEqual(warned, [])
})

test('pipelineSettings: a bad senior label is one warning and no Senior', () => {
  for (const bad of ['bad"name', 42, '', 'x'.repeat(41), ['Senior']]) {
    const warned = []
    assert.deepEqual(pipelineSettings({ senior: bad }, w => warned.push(w)), pipelineSettings(undefined), JSON.stringify(bad))
    assert.equal(warned.length, 1)
    assert.match(warned[0], /^config\.json: pipeline\.senior .*there is no Senior agent/)
  }
})

test('gateLabels: senior is its label, or null when unset or already used by another box', () => {
  assert.equal(gateLabels(SENIOR).senior, 'Senior')
  assert.equal(gateLabels(BASE).senior, null)
  for (const taken of ['Master', 'QA', 'Independent', 'Planner', 'Security']) {
    const c = { ...LIVE, pipeline: { ...LIVE.pipeline, senior: taken } }
    assert.equal(gateLabels(c).senior, null, taken)
  }
  assert.equal(gateLabels({ ...SENIOR, pipeline: { ...SENIOR.pipeline, producers: ['Agent 1', 'Senior'] } }).senior, null, 'a listed producer stays a producer')
})

test('producersOf: Senior is never a producer when the producers are derived', () => {
  assert.deepEqual(producersOf(SENIOR), ['Agent 1', 'Agent 2', 'Agent 3'])
  assert.deepEqual(producersOf(BASE), ['Agent 1', 'Agent 2', 'Agent 3', 'Senior'], 'not configured: an ordinary coding agent')
})

// ═══ the graph ═══

test('pipelineGraph: the Human task node is always there, a fixed step with id human; Senior is an agent after it', () => {
  const plain = pipelineGraph(BASE)
  assert.deepEqual(plain.nodes.find(n => n.id === 'human'), { id: 'human', kind: 'step', label: 'Human task', role: 'human' })
  assert.ok(!plain.nodes.some(n => n.role === 'senior'))
  const g = pipelineGraph(LIVE)
  assert.deepEqual(ids(g.nodes), ['request', 'master', 'planner', 'agent-1', 'agent-2', 'agent-3', 'independent', 'qa', 'security', 'human', 'senior', 'push', 'outcome'])
  assert.deepEqual(g.nodes.find(n => n.role === 'senior'), { id: 'senior', kind: 'agent', label: 'Senior', role: 'senior' })
})

test('pipelineGraph: Senior takes its id after every other agent, so no stored id moves', () => {
  const c = { ...LIVE, codingAgents: { ...LIVE.codingAgents, 'Agent 4': 'senior' }, pipeline: { ...LIVE.pipeline, producers: ['Agent 1', 'senior'] } }
  const g = pipelineGraph(c)
  assert.equal(g.nodes.find(n => n.label === 'senior').id, 'senior')
  assert.equal(g.nodes.find(n => n.role === 'senior').id, 'senior-2')
  const without = pipelineGraph({ ...c, pipeline: { ...c.pipeline, senior: null } })
  for (const n of without.nodes) assert.equal(g.nodes.find(x => x.label === n.label)?.id ?? n.id, n.id, `${n.label} keeps its id`)
})

test('pipelineGraph: every no code changes edge of the coordinator and the producers goes to Human task, the chat agent one to the Output', () => {
  for (const c of [BASE, SENIOR, LIVE]) {
    const g = pipelineGraph(c)
    for (const p of ['master', 'agent-1', 'agent-2', 'agent-3']) {
      assert.deepEqual(edge(g, p, 'human'), { from: p, to: 'human', label: 'no code changes', kind: 'skip' })
      assert.equal(edge(g, p, 'outcome'), undefined)
    }
  }
  assert.deepEqual(edge(pipelineGraph(LIVE), 'independent', 'outcome'), { from: 'independent', to: 'outcome', label: 'no code changes', kind: 'skip' })
  assert.equal(edge(pipelineGraph(LIVE), 'independent', 'human'), undefined, 'the chat agent changes nothing by hand')
})

test('pipelineGraph: with Senior, Human task -> Senior -> Output and a Senior failure back to Human task; without, Human task -> Output', () => {
  const g = pipelineGraph(SENIOR)
  assert.deepEqual(edge(g, 'human', 'senior'), { from: 'human', to: 'senior', label: 'done by hand', kind: 'skip' })
  assert.deepEqual(edge(g, 'senior', 'outcome'), { from: 'senior', to: 'outcome', label: 'reviewed', kind: 'skip' })
  assert.deepEqual(edge(g, 'senior', 'human'), { from: 'senior', to: 'human', label: 'redo', kind: 'rework' })
  assert.equal(edge(g, 'human', 'outcome'), undefined)
  assert.ok(!g.edges.some(e => e.from === 'senior' && e.to !== 'outcome' && e.to !== 'human'), 'Senior hands work nowhere else')
  const plain = pipelineGraph(BASE)
  assert.deepEqual(edge(plain, 'human', 'outcome'), { from: 'human', to: 'outcome', label: 'done by hand', kind: 'skip' })
  for (const graph of [g, plain, pipelineGraph(LIVE)]) for (const e of graph.edges) assert.ok(ids(graph.nodes).includes(e.from) && ids(graph.nodes).includes(e.to), JSON.stringify(e))
})

test('pipelineGraph: the chat agent edges stay last, so adding it moves no other edge', () => {
  const without = pipelineGraph(SENIOR)
  const withChat = pipelineGraph({ ...SENIOR, factory: { chat: { name: 'Independent' } } })
  assert.deepEqual(withChat.edges.slice(0, without.edges.length), without.edges)
})

test('pipelineGraph: a label that slugs to human gets a suffix; no producers still draws the coordinator into Human task', () => {
  const g = pipelineGraph({ coordinator: 'C', coordinatorLabel: 'Human', codingAgents: { C: 'Human' } })
  assert.deepEqual(ids(g.nodes), ['request', 'human-2', 'qa', 'human', 'push', 'outcome'])
  assert.deepEqual(edge(g, 'human-2', 'human'), { from: 'human-2', to: 'human', label: 'no code changes', kind: 'skip' })
})

// ═══ the stage of a no-code flow ═══

const G = pipelineGraph(SENIOR)
const GP = pipelineGraph(BASE)
const flow = (more = {}) => ({ id: 'f', title: 'T', agent: 'Agent 1', status: 'open', nodes: [], ...more })
const step = (id, done = false) => ({ id, do: `do ${id}`, expect: 'ok', at: '2026-11-20T09:00:00Z', done: done ? { by: 'you', at: '2026-11-20T10:00:00Z' } : null })
const hand = (...steps) => ({ hand: { steps } })
const senior = (status, more = {}) => ({ senior: { status, by: 'Senior', at: '2026-11-20T11:00:00Z', ...more } })
const to = ['request', 'master', 'agent-1']

test('stageOf: a no-code flow with no by-hand steps and no Senior record passes both boxes and ends at the Output as before', () => {
  for (const g of [G, GP]) {
    assert.deepEqual(stageOf(flow({ status: 'done' }), g), { node: 'outcome', status: 'done', path: [...to, 'outcome'], reworks: 0 })
    assert.deepEqual(stageOf(flow(), g), { node: 'agent-1', status: 'working', path: to, reworks: 0 })
  }
})

test('stageOf: by-hand steps stop the flow at Human task until every one is ticked', () => {
  assert.deepEqual(stageOf(flow(hand(step('h1'), step('h2', true))), G), { node: 'human', status: 'waiting', path: [...to, 'human'], reworks: 0 })
  assert.deepEqual(stageOf(flow({ status: 'blocked', ...hand(step('h1')) }), GP), { node: 'human', status: 'waiting', path: [...to, 'human'], reworks: 0 })
})

test('stageOf: every step ticked goes on to Senior, waiting; with no Senior it waits at Human task for the flow to be marked done', () => {
  assert.deepEqual(stageOf(flow(hand(step('h1', true))), G), { node: 'senior', status: 'waiting', path: [...to, 'human', 'senior'], reworks: 0 })
  assert.deepEqual(stageOf(flow(hand(step('h1', true))), GP), { node: 'human', status: 'waiting', path: [...to, 'human'], reworks: 0 })
  assert.deepEqual(stageOf(flow({ status: 'done', ...hand(step('h1', true)) }), GP), { node: 'outcome', status: 'done', path: [...to, 'human', 'outcome'], reworks: 0 })
})

test('stageOf: a finished flow with by-hand steps and no Senior record reads finished, whatever the ticks (an old flow stays done)', () => {
  for (const g of [G, GP]) assert.deepEqual(stageOf(flow({ status: 'done', ...hand(step('h1')) }), g), { node: 'outcome', status: 'done', path: [...to, 'human', 'outcome'], reworks: 0 })
})

test('stageOf: Senior reviewing, passed, failed back to Human task, ticked again, and stopped', () => {
  const all = hand(step('h1', true))
  assert.deepEqual(stageOf(flow({ ...all, ...senior('reviewing') }), G), { node: 'senior', status: 'reviewing', path: [...to, 'human', 'senior'], reworks: 0 })
  assert.deepEqual(stageOf(flow({ status: 'done', ...all, ...senior('passed') }), G), { node: 'outcome', status: 'passed', path: [...to, 'human', 'senior', 'outcome'], reworks: 0 })
  const failed = senior('failed', { summary: 'The secret went to prod', redo: ['h1'] })
  assert.deepEqual(stageOf(flow({ ...hand(step('h1')), ...failed }), G), { node: 'human', status: 'rework', path: [...to, 'human', 'senior', 'human'], reworks: 1 })
  assert.deepEqual(stageOf(flow({ ...all, ...failed }), G), { node: 'senior', status: 'waiting', path: [...to, 'human', 'senior', 'human', 'senior'], reworks: 1 })
  assert.deepEqual(stageOf(flow({ status: 'blocked', ...hand(step('h1')), ...senior('senior-failed') }), G), { node: 'senior', status: 'failed', path: [...to, 'human', 'senior'], reworks: 0 })
})

test('stageOf: earlier failed verdicts count as reworks and visits, oldest first', () => {
  const history = [{ status: 'failed', by: 'Senior', at: '2026-11-20T10:00:00Z', summary: 'a' }, { status: 'failed', by: 'Senior', at: '2026-11-20T10:30:00Z', summary: 'b' }]
  const s = stageOf(flow({ status: 'done', ...hand(step('h1', true)), ...senior('passed', { history }) }), G)
  assert.deepEqual(s, { node: 'outcome', status: 'passed', path: [...to, 'human', 'senior', 'human', 'senior', 'human', 'senior', 'outcome'], reworks: 2 })
})

test('stageOf: a flow sent to Senior on purpose (senior-ask) with no steps waits at Senior, going past Human task', () => {
  const asked = senior('asked', { by: 'Agent 1', ask: { text: 'CI change', by: 'Agent 1', at: '2026-11-20T09:00:00Z' } })
  assert.deepEqual(stageOf(flow(asked), G), { node: 'senior', status: 'waiting', path: [...to, 'senior'], reworks: 0 })
  assert.deepEqual(stageOf(flow({ ...asked, ...senior('passed') }), G).node, 'outcome')
  assert.deepEqual(stageOf(flow(senior('failed')), G), { node: 'human', status: 'rework', path: [...to, 'senior', 'human'], reworks: 1 }, 'no steps to tick: it waits at Human task')
})

test('stageOf: Senior data on a graph without Senior is not drawn; a flow on the QA path ignores it', () => {
  assert.deepEqual(stageOf(flow({ ...hand(step('h1', true)), ...senior('passed') }), GP), { node: 'human', status: 'waiting', path: [...to, 'human'], reworks: 0 })
  assert.deepEqual(stageOf(flow(senior('asked')), GP), { node: 'agent-1', status: 'working', path: to, reworks: 0 })
  const tested = flow({ qa: { status: 'testing', attempt: 1, by: 'QA', at: '2026-11-20T10:00:00Z' }, ...hand(step('h1')), ...senior('reviewing') })
  assert.equal(stageOf(tested, G).node, 'qa')
})

test('stageOf: a done code flow with by-hand steps still waits for QA: code is tested first', () => {
  const committed = { nodes: [{ id: 'n1', type: 'step', title: 'x', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }] }
  assert.equal(stageOf(flow({ status: 'done', ...committed, ...hand(step('h1')) }), G).node, 'qa')
})

test('stageOf: the last entry of the path is always the node, on the by-hand route', () => {
  const cases = [
    flow(hand(step('h1'))), flow(hand(step('h1', true))), flow({ ...hand(step('h1', true)), ...senior('reviewing') }),
    flow({ ...hand(step('h1')), ...senior('failed') }), flow({ ...hand(step('h1', true)), ...senior('failed') }),
    flow({ ...hand(step('h1', true)), ...senior('passed') }), flow(senior('asked')), flow(senior('senior-failed')), flow({ status: 'done', ...hand(step('h1')) }),
  ]
  for (const c of cases) {
    const s = stageOf(c, G)
    assert.equal(s.path.at(-1), s.node, JSON.stringify(c))
  }
})
