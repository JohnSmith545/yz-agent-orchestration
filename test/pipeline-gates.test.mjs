// Tests for the two optional agents of pipeline.mjs: the planner between the coordinator and the producers, and
// Security between QA and Push. Their settings (pipelineSettings), the graph (pipelineGraph), who is a producer
// (producersOf), which labels draw a box (gateLabels) and where a flow stands (stageOf). All pure.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PIPELINE, gateLabels, pipelineGraph, pipelineSettings, producersOf, stageOf } from '../pipeline.mjs'

const BASE = {
  coordinator: 'Master',
  coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', 'Agent 3': 'Agent 3', Planner: 'Planner', Security: 'Security' },
  pipeline: { ...DEFAULT_PIPELINE },
}
const BOTH = { ...BASE, pipeline: { ...DEFAULT_PIPELINE, planner: 'Planner', security: 'Security' } }
const G = pipelineGraph(BOTH)
const ids = list => list.map(x => x.id)
const edge = (g, from, to, kind) => g.edges.find(e => e.from === from && e.to === to && (!kind || e.kind === kind))

// ═══ settings ═══

test('pipelineSettings: planner and security are kept when they are labels, and left out when absent or null', () => {
  const warned = []
  assert.deepEqual(pipelineSettings({ planner: ' Planner ', security: 'Security' }, w => warned.push(w)),
    { ...pipelineSettings(undefined), planner: 'Planner', security: 'Security' })
  assert.deepEqual(pipelineSettings({ planner: null, security: null }, w => warned.push(w)), pipelineSettings(undefined))
  assert.deepEqual(Object.keys(pipelineSettings({})).sort(), ['maxReworks', 'producers', 'protectedBranches', 'qa'])
  assert.deepEqual(warned, [])
})

test('pipelineSettings: a bad planner or security label keeps the default (none) with one warning each', () => {
  const warned = []
  const s = pipelineSettings({ planner: 'bad"name', security: 42 }, w => warned.push(w))
  assert.deepEqual(s, pipelineSettings(undefined))
  assert.equal(warned.length, 2, warned.join('\n'))
  assert.match(warned[0], /^config\.json: pipeline\.planner /)
  assert.match(warned[1], /^config\.json: pipeline\.security /)
})

// ═══ who draws a box ═══

test('gateLabels: the configured labels, or null for one that is not set or is already in the graph', () => {
  assert.deepEqual(gateLabels(BOTH), { planner: 'Planner', security: 'Security' })
  assert.deepEqual(gateLabels(BASE), { planner: null, security: null })
  // a coding agent named as the planner is taken out of the derived producers (producersOf), so it is the planner
  assert.deepEqual(gateLabels({ ...BOTH, pipeline: { ...BOTH.pipeline, planner: 'Agent 2' } }).planner, 'Agent 2')
  for (const taken of ['Master', 'QA', 'Independent']) {
    const c = { ...BOTH, factory: { chat: { name: 'Independent' } }, pipeline: { ...BOTH.pipeline, planner: taken, security: taken } }
    assert.deepEqual(gateLabels(c), { planner: null, security: null }, taken)
  }
  assert.deepEqual(gateLabels({ ...BOTH, pipeline: { ...BOTH.pipeline, security: 'Planner' } }), { planner: 'Planner', security: null }, 'one label, one box')
  const listed = { ...BOTH, pipeline: { ...BOTH.pipeline, producers: ['Agent 1', 'Planner'] } }
  assert.equal(gateLabels(listed).planner, null, 'a label the producers list names stays a producer')
})

test('producersOf: the planner and Security are never producers when the producers are derived', () => {
  assert.deepEqual(producersOf(BOTH), ['Agent 1', 'Agent 2', 'Agent 3'])
  assert.deepEqual(producersOf(BASE), ['Agent 1', 'Agent 2', 'Agent 3', 'Planner', 'Security'], 'with neither configured they are ordinary coding agents')
})

// ═══ the graph ═══

test('pipelineGraph: with both, the planner sits after the coordinator and Security after QA, ids taken after the chat agent', () => {
  const c = { ...BOTH, factory: { chat: { name: 'Independent' } } }
  const g = pipelineGraph(c)
  assert.deepEqual(ids(g.nodes), ['request', 'master', 'planner', 'agent-1', 'agent-2', 'agent-3', 'independent', 'qa', 'security', 'push', 'outcome'])
  assert.deepEqual(g.nodes.find(n => n.role === 'planner'), { id: 'planner', kind: 'agent', label: 'Planner', role: 'planner' })
  assert.deepEqual(g.nodes.find(n => n.role === 'security'), { id: 'security', kind: 'agent', label: 'Security', role: 'security' })
  const plain = pipelineGraph({ ...c, pipeline: { ...DEFAULT_PIPELINE } })
  for (const n of plain.nodes) assert.equal(g.nodes.find(x => x.label === n.label)?.id, n.id, `${n.label} keeps its id`)
})

test('pipelineGraph: the coordinator hands to the planner, the planner to each producer; the own-changes and skip edges stay', () => {
  assert.deepEqual(edge(G, 'master', 'planner'), { from: 'master', to: 'planner', kind: 'main' })
  for (const p of ['agent-1', 'agent-2', 'agent-3']) {
    assert.equal(edge(G, 'master', p), undefined, 'no direct hand-out')
    assert.deepEqual(edge(G, 'planner', p), { from: 'planner', to: p, kind: 'branch' })
    assert.equal(edge(G, p, 'qa').kind, 'main')
  }
  assert.deepEqual(edge(G, 'master', 'qa'), { from: 'master', to: 'qa', label: 'own changes', kind: 'branch' })
  assert.equal(edge(G, 'master', 'outcome').kind, 'skip')
})

test('pipelineGraph: QA passes to Security, Security passes to Push, and a Security failure goes back to each producer', () => {
  assert.deepEqual(edge(G, 'qa', 'security'), { from: 'qa', to: 'security', label: 'passed', kind: 'main' })
  assert.deepEqual(edge(G, 'security', 'push'), { from: 'security', to: 'push', label: 'passed', kind: 'main' })
  assert.equal(edge(G, 'qa', 'push'), undefined)
  for (const p of ['agent-1', 'agent-2', 'agent-3']) assert.deepEqual(edge(G, 'security', p), { from: 'security', to: p, label: 'failed', kind: 'rework' })
  for (const e of G.edges) assert.ok(ids(G.nodes).includes(e.from) && ids(G.nodes).includes(e.to), JSON.stringify(e))
})

test('pipelineGraph: each one alone, and neither, which is exactly the graph of a config without the keys', () => {
  const onlyPlanner = pipelineGraph({ ...BOTH, pipeline: { ...DEFAULT_PIPELINE, planner: 'Planner' } })
  assert.ok(edge(onlyPlanner, 'qa', 'push'))
  assert.ok(!onlyPlanner.nodes.some(n => n.role === 'security'))
  const onlySecurity = pipelineGraph({ ...BOTH, pipeline: { ...DEFAULT_PIPELINE, security: 'Security' } })
  assert.ok(edge(onlySecurity, 'master', 'agent-1'))
  assert.ok(!onlySecurity.nodes.some(n => n.role === 'planner'))
  const without = { ...BASE, codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' } }
  assert.deepEqual(pipelineGraph({ ...without, pipeline: { ...DEFAULT_PIPELINE, planner: null, security: null } }), pipelineGraph(without))
})

test('pipelineGraph: a planner with no producers still draws, handing nothing out; the coordinator goes straight to QA', () => {
  const g = pipelineGraph({ coordinatorLabel: 'Master', codingAgents: { Master: 'Master', Planner: 'Planner' }, pipeline: { ...DEFAULT_PIPELINE, planner: 'Planner' } })
  assert.deepEqual(ids(g.nodes), ['request', 'master', 'planner', 'qa', 'push', 'outcome'])
  assert.equal(edge(g, 'master', 'qa').kind, 'main')
})

// ═══ the stage ═══

const flow = (more = {}) => ({ id: 'f', title: 'T', agent: 'Agent 1', status: 'open', nodes: [], ...more })
const committed = { nodes: [{ id: 'n1', type: 'step', title: 'x', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }] }
const plan = (status, more = {}) => ({ status, by: 'Planner', startedAt: '2026-11-20T09:00:00Z', at: '2026-11-20T09:30:00Z', ...more })
const qa = (status, more = {}) => ({ status, attempt: 1, by: 'QA', at: '2026-11-20T10:00:00Z', commit: 'abc1234', ...more })
const sec = (status, more = {}) => ({ status, by: 'Security', at: '2026-11-20T11:00:00Z', commit: 'abc1234', ...more })

test('stageOf: with Master, with the planner, then with the producer it handed the task to', () => {
  assert.deepEqual(stageOf(flow({ agent: 'Master' }), G), { node: 'master', status: 'working', path: ['request', 'master'], reworks: 0 })
  assert.deepEqual(stageOf(flow({ agent: 'Master', plan: plan('planning') }), G), { node: 'planner', status: 'working', path: ['request', 'master', 'planner'], reworks: 0 })
  assert.deepEqual(stageOf(flow({ plan: plan('handed', { to: 'Agent 1', file: 'f/plan-1.md' }) }), G),
    { node: 'agent-1', status: 'working', path: ['request', 'master', 'planner', 'agent-1'], reworks: 0 })
  assert.deepEqual(stageOf(flow(), G).path, ['request', 'master', 'agent-1'], 'a flow the producer started itself was never planned')
  assert.deepEqual(stageOf(flow({ plan: plan('handed', { to: 'Agent 1' }) }), pipelineGraph(BASE)).path, ['request', 'master', 'agent-1'], 'no planner in the graph: the record is not drawn')
})

test('stageOf: QA passed waits for Security; reviewing, passed (then Push), failed back to the producer, and stopped', () => {
  const base = { ...committed, plan: plan('handed', { to: 'Agent 1' }) }
  const before = ['request', 'master', 'planner', 'agent-1', 'qa', 'security']
  assert.deepEqual(stageOf(flow({ ...base, qa: qa('passed') }), G), { node: 'security', status: 'waiting', path: before, reworks: 0 })
  assert.deepEqual(stageOf(flow({ ...base, qa: qa('passed', { security: sec('reviewing') }) }), G), { node: 'security', status: 'reviewing', path: before, reworks: 0 })
  assert.deepEqual(stageOf(flow({ ...base, qa: qa('passed', { security: sec('passed') }) }), G), { node: 'push', status: 'waiting', path: [...before, 'push'], reworks: 0 })
  assert.deepEqual(stageOf(flow({ ...base, status: 'done', qa: qa('passed', { pushedAt: '2026-11-20T12:00:00Z', security: sec('passed') }) }), G),
    { node: 'outcome', status: 'passed', path: [...before, 'push', 'outcome'], reworks: 0 })
  assert.deepEqual(stageOf(flow({ ...base, qa: qa('passed', { security: sec('failed', { rework: { to: 'Agent 1' } }) }) }), G),
    { node: 'agent-1', status: 'rework', path: [...before, 'agent-1'], reworks: 1 })
  assert.deepEqual(stageOf(flow({ ...base, status: 'blocked', qa: qa('passed', { security: sec('security-failed') }) }), G),
    { node: 'security', status: 'failed', path: before, reworks: 0 })
})

test('stageOf: a Security failure, a fix, and a new QA attempt counts the rework and visits Security again only when it starts', () => {
  const earlier = qa('passed', { security: sec('failed', { rework: { to: 'Agent 1' } }) })
  const f = flow({ ...committed, qa: qa('testing', { attempt: 2, attempts: [earlier] }) })
  assert.deepEqual(stageOf(f, G), { node: 'qa', status: 'testing', path: ['request', 'master', 'agent-1', 'qa', 'security', 'agent-1', 'qa'], reworks: 1 })
  const g = flow({ ...committed, qa: qa('passed', { attempt: 2, attempts: [earlier] }) })
  assert.equal(stageOf(g, G).node, 'security', 'QA passed the new attempt: a new Security verdict is needed')
})

test('stageOf: Security data on a graph without Security is not drawn: QA passed waits on Push as before', () => {
  const g = pipelineGraph(BASE)
  assert.deepEqual(stageOf(flow({ ...committed, qa: qa('passed', { security: sec('failed', { rework: { to: 'Agent 1' } }) }) }), g),
    { node: 'push', status: 'waiting', path: ['request', 'master', 'agent-1', 'qa', 'push'], reworks: 0 })
})

test('stageOf: the last entry of the path is always the node, with both agents', () => {
  const cases = [
    flow({ agent: 'Master', plan: plan('planning') }), flow({ qa: qa('passed') }), flow({ qa: qa('passed', { security: sec('reviewing') }) }),
    flow({ qa: qa('passed', { security: sec('failed', { rework: { to: 'Agent 1' } }) }) }), flow({ qa: qa('passed', { pushedAt: 'x', security: sec('passed') }) }),
    flow({ qa: qa('passed', { security: sec('failed', { rework: { to: 'Gone' } }) }) }),
  ]
  for (const c of cases) {
    const s = stageOf(c, G)
    assert.equal(s.path.at(-1), s.node, JSON.stringify(c))
  }
})
