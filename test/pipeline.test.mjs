// Tests for pipeline.mjs, the orchestration definition: the `pipeline` settings (pipelineSettings), the
// graph every page draws from (pipelineGraph), whether a flow produced code (isCodeProducing), and where
// a flow stands on that graph (stageOf). All pure: no file, no git, no config.json.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PIPELINE, isCodeProducing, pipelineGraph, pipelineSettings, producersOf, stageOf } from '../pipeline.mjs'

/** The user's shape: the coordinator Master, three producers (two session names for Agent 3), QA by default. */
const CONFIG = {
  coordinator: 'Master',
  coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', 'flinki-v2-a9': 'Agent 3', 'Agent 3': 'Agent 3', qa: 'QA' },
  pipeline: { ...DEFAULT_PIPELINE },
}
const G = pipelineGraph(CONFIG)
const ids = list => list.map(x => x.id)
const edge = (from, to) => G.edges.find(e => e.from === from && e.to === to)

// ═══ settings ═══

test('pipelineSettings: left out is the default; QA, every coding agent, the protected branches, three reworks', () => {
  const warned = []
  const s = pipelineSettings(undefined, w => warned.push(w))
  assert.deepEqual(s, { qa: 'QA', producers: null, protectedBranches: ['dev', 'stage', 'main', 'master'], maxReworks: 3 })
  assert.deepEqual(warned, [])
})

test('pipelineSettings: a good value is kept; each bad key keeps its default with one warning', () => {
  assert.deepEqual(pipelineSettings({ qa: 'Tester', producers: ['Agent 1'], protectedBranches: ['dev', 'release/*'], maxReworks: 0 }, () => {}),
    { qa: 'Tester', producers: ['Agent 1'], protectedBranches: ['dev', 'release/*'], maxReworks: 0 })
  const warned = []
  const s = pipelineSettings({ qa: 'bad"name', producers: 'Agent 1', protectedBranches: ['ok', '-x'], maxReworks: 99 }, w => warned.push(w))
  assert.deepEqual(s, pipelineSettings(undefined, () => {}))
  assert.equal(warned.length, 4, warned.join('\n'))
  for (const w of warned) assert.match(w, /^config\.json: pipeline\./)
  const notObject = []
  assert.deepEqual(pipelineSettings([], w => notObject.push(w)), pipelineSettings(undefined))
  assert.equal(notObject.length, 1)
})

test('producersOf: the coding agents labels other than the coordinator and QA, once each, in config order; or the configured list', () => {
  assert.deepEqual(producersOf(CONFIG), ['Agent 1', 'Agent 2', 'Agent 3'])
  assert.deepEqual(producersOf({ ...CONFIG, pipeline: { ...CONFIG.pipeline, producers: ['Agent 2'] } }), ['Agent 2'])
  assert.deepEqual(producersOf({ ...CONFIG, pipeline: undefined }), ['Agent 1', 'Agent 2', 'Agent 3'], 'no pipeline key: the defaults')
})

// ═══ the graph ═══

test('pipelineGraph: the nodes in execution order, with stable slug ids, kinds and roles', () => {
  assert.deepEqual(ids(G.nodes), ['request', 'master', 'agent-1', 'agent-2', 'agent-3', 'qa', 'push', 'outcome'])
  assert.deepEqual(G.nodes.map(n => n.role), ['request', 'coordinator', 'producer', 'producer', 'producer', 'qa', 'push', 'outcome'])
  assert.deepEqual(G.nodes.map(n => n.kind), ['start', 'agent', 'agent', 'agent', 'agent', 'agent', 'step', 'end'])
  assert.deepEqual(G.nodes.map(n => n.label), ['Request', 'Master', 'Agent 1', 'Agent 2', 'Agent 3', 'QA', 'Push', 'Output'])
  assert.deepEqual(pipelineGraph(CONFIG), G, 'the same config draws the same graph')
})

// ═══ the chat agent (factory.chat.name) ═══

const CHAT = { ...CONFIG, factory: { chat: { name: 'Independent' } } }
const GC = pipelineGraph(CHAT)

test('pipelineGraph: the chat agent is an agent node with role chat, after the producers; the end keeps its id outcome and reads Output', () => {
  assert.deepEqual(ids(GC.nodes), ['request', 'master', 'agent-1', 'agent-2', 'agent-3', 'independent', 'qa', 'push', 'outcome'])
  assert.deepEqual(GC.nodes.find(n => n.id === 'independent'), { id: 'independent', kind: 'agent', label: 'Independent', role: 'chat' })
  assert.deepEqual(GC.nodes.at(-1), { id: 'outcome', kind: 'end', label: 'Output', role: 'outcome' })
})

test('pipelineGraph: the chat agent takes requests and ends at the Output; rework never goes to it, and nothing else changes', () => {
  const from = (a, b) => GC.edges.find(e => e.from === a && e.to === b)
  assert.deepEqual(from('request', 'independent'), { from: 'request', to: 'independent', kind: 'branch' })
  assert.deepEqual(from('independent', 'outcome'), { from: 'independent', to: 'outcome', label: 'no code changes', kind: 'skip' })
  assert.equal(GC.edges.filter(e => e.to === 'independent' || e.from === 'independent').length, 2)
  assert.ok(!GC.edges.some(e => e.kind === 'rework' && e.to === 'independent'))
  assert.deepEqual(GC.edges.slice(0, G.edges.length), G.edges, 'the other edges keep their order, so their indices hold')
})

test('pipelineGraph: no chat agent when the config names none, or when its name is already the coordinator, a producer or QA', () => {
  assert.ok(!G.nodes.some(n => n.role === 'chat'))
  for (const name of ['Master', 'Agent 2', 'QA', '  ']) assert.ok(!pipelineGraph({ ...CONFIG, factory: { chat: { name } } }).nodes.some(n => n.role === 'chat'), name)
})

test('stageOf: a flow of the chat agent sits on it, from the request; done, it is at the Output whatever its evidence', () => {
  assert.deepEqual(stageOf(flow({ agent: 'Independent' }), GC), { node: 'independent', status: 'working', path: ['request', 'independent'], reworks: 0 })
  assert.deepEqual(stageOf(flow({ agent: 'Independent', status: 'done', ...committed }), GC), { node: 'outcome', status: 'done', path: ['request', 'independent', 'outcome'], reworks: 0 })
  assert.equal(stageOf(flow({ agent: 'Independent', status: 'blocked' }), GC).status, 'blocked')
})

test('pipelineGraph: the edges, request to coordinator to each producer to QA, pass to push, fail back, and the skips', () => {
  assert.deepEqual(edge('request', 'master'), { from: 'request', to: 'master', kind: 'main' })
  for (const p of ['agent-1', 'agent-2', 'agent-3']) {
    assert.equal(edge('master', p).kind, 'branch')
    assert.equal(edge(p, 'qa').kind, 'main')
    assert.deepEqual(edge('qa', p), { from: 'qa', to: p, label: 'failed', kind: 'rework' })
    assert.deepEqual(edge(p, 'outcome'), { from: p, to: 'outcome', label: 'no code changes', kind: 'skip' })
  }
  assert.deepEqual(edge('qa', 'push'), { from: 'qa', to: 'push', label: 'passed', kind: 'main' })
  assert.deepEqual(edge('push', 'outcome'), { from: 'push', to: 'outcome', kind: 'main' })
  // the coordinator's own work goes through QA too, and its asks and plans skip it
  assert.equal(edge('master', 'qa').kind, 'branch')
  assert.equal(edge('master', 'outcome').kind, 'skip')
  assert.equal(G.edges.filter(e => e.kind === 'rework').length, 3)
  for (const e of G.edges) assert.ok(ids(G.nodes).includes(e.from) && ids(G.nodes).includes(e.to), JSON.stringify(e))
})

test('pipelineGraph: no producers draws the coordinator straight into QA; a label that slugs to a reserved id gets a suffix', () => {
  const lone = pipelineGraph({ coordinator: 'C', coordinatorLabel: 'Coordinator', codingAgents: { C: 'Coordinator' } })
  assert.deepEqual(ids(lone.nodes), ['request', 'coordinator', 'qa', 'push', 'outcome'])
  assert.equal(lone.edges.find(e => e.from === 'coordinator' && e.to === 'qa').kind, 'main')
  const clash = pipelineGraph({ coordinator: 'C', coordinatorLabel: 'Push', codingAgents: { C: 'Push', a: 'Request', b: 'request' } })
  assert.deepEqual(ids(clash.nodes), ['request', 'push-2', 'request-2', 'request-3', 'qa', 'push', 'outcome'])
})

// ═══ code producing ═══

const flow = (more = {}) => ({ id: 'f', title: 'T', agent: 'Agent 1', status: 'open', nodes: [], ...more })
const committed = { nodes: [{ id: 'n1', type: 'step', title: 'x', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }] }

test('isCodeProducing: commit or diff evidence, a change in the summary, or a recorded pull request; nothing else', () => {
  assert.equal(isCodeProducing(flow()), false)
  assert.equal(isCodeProducing(flow({ nodes: [{ id: 'n1', type: 'step', title: 'x', status: 'done', evidence: [{ kind: 'test', ref: 'ok' }] }] })), false)
  assert.equal(isCodeProducing(flow(committed)), true)
  assert.equal(isCodeProducing(flow({ nodes: [{ id: 'n1', type: 'step', title: 'x', status: 'done', evidence: [{ kind: 'diff', ref: 'wt' }] }] })), true)
  assert.equal(isCodeProducing(flow({ output: { summary: 'x', changes: [{ kind: 'commit', ref: 'abc1234' }] } })), true)
  assert.equal(isCodeProducing(flow({ output: { summary: 'x', changes: [] } })), false)
  assert.equal(isCodeProducing(flow({ output: { merge: { head: 'f', base: 'dev', title: 't', body: '' } } })), true)
  assert.equal(isCodeProducing({}), false, 'a malformed flow is not code producing')
})

// ═══ the stage ═══

const qa = (status, more = {}) => ({ status, attempt: 1, by: 'QA', at: '2026-11-20T10:00:00Z', ...more })

test('stageOf: an open flow with no QA sits on its agent; a blocked one says blocked; an unknown agent sits on the coordinator', () => {
  assert.deepEqual(stageOf(flow(), G), { node: 'agent-1', status: 'working', path: ['request', 'master', 'agent-1'], reworks: 0 })
  assert.equal(stageOf(flow({ status: 'blocked' }), G).status, 'blocked')
  assert.deepEqual(stageOf(flow({ agent: 'Master' }), G).path, ['request', 'master'])
  assert.deepEqual(stageOf(flow({ agent: 'Independent' }), G), { node: 'master', status: 'working', path: ['request', 'master'], reworks: 0 })
})

test('stageOf: a dropped flow has no node', () => {
  assert.deepEqual(stageOf(flow({ status: 'dropped', qa: qa('testing') }), G), { node: null, status: 'dropped', path: [], reworks: 0 })
})

test('stageOf: a done flow that changed no code goes straight to the outcome by the skip edge; one that did waits for QA', () => {
  assert.deepEqual(stageOf(flow({ status: 'done' }), G), { node: 'outcome', status: 'done', path: ['request', 'master', 'agent-1', 'outcome'], reworks: 0 })
  assert.deepEqual(stageOf(flow({ status: 'done', ...committed }), G), { node: 'qa', status: 'waiting', path: ['request', 'master', 'agent-1', 'qa'], reworks: 0 })
})

test('stageOf: pending and testing sit on QA', () => {
  assert.deepEqual(stageOf(flow({ ...committed, qa: qa('pending') }), G), { node: 'qa', status: 'pending', path: ['request', 'master', 'agent-1', 'qa'], reworks: 0 })
  assert.equal(stageOf(flow({ ...committed, qa: qa('testing') }), G).status, 'testing')
})

test('stageOf: passed and pushed is the outcome; passed but not pushed waits on push; a failed push says failed there', () => {
  const pushed = stageOf(flow({ status: 'done', ...committed, qa: qa('passed', { commit: 'abc1234', pushedAt: '2026-11-20T11:00:00Z' }) }), G)
  assert.deepEqual(pushed, { node: 'outcome', status: 'passed', path: ['request', 'master', 'agent-1', 'qa', 'push', 'outcome'], reworks: 0 })
  assert.deepEqual(stageOf(flow({ status: 'done', qa: qa('passed', { commit: 'abc1234' }) }), G),
    { node: 'push', status: 'waiting', path: ['request', 'master', 'agent-1', 'qa', 'push'], reworks: 0 })
  assert.equal(stageOf(flow({ status: 'done', qa: qa('passed', { commit: 'abc1234', pushError: 'refused' }) }), G).status, 'failed')
})

test('stageOf: a failure sent back sits on the producer as rework, with one path entry per attempt', () => {
  const failed = flow({ ...committed, qa: qa('failed', { attempt: 2, rework: { to: 'Agent 1', sentAt: null, error: null }, attempts: [qa('failed', { attempt: 1, rework: { to: 'Agent 1', sentAt: 'x' } })] }) })
  assert.deepEqual(stageOf(failed, G), { node: 'agent-1', status: 'rework', path: ['request', 'master', 'agent-1', 'qa', 'agent-1', 'qa', 'agent-1'], reworks: 2 })
  const passedAfter = flow({ status: 'done', ...committed, qa: qa('passed', { attempt: 2, commit: 'abc1234', pushedAt: 'y', attempts: [qa('failed', { attempt: 1, rework: { to: 'Agent 1' } })] }) })
  assert.deepEqual(stageOf(passedAfter, G), { node: 'outcome', status: 'passed', path: ['request', 'master', 'agent-1', 'qa', 'agent-1', 'qa', 'push', 'outcome'], reworks: 1 })
  const retesting = flow({ ...committed, qa: qa('testing', { attempt: 2, attempts: [qa('failed', { attempt: 1, rework: { to: 'Agent 1' } })] }) })
  assert.deepEqual(stageOf(retesting, G).path, ['request', 'master', 'agent-1', 'qa', 'agent-1', 'qa'])
})

test('stageOf: qa-failed stops on QA, failed; a failure whose producer left the graph stops there too', () => {
  assert.deepEqual(stageOf(flow({ status: 'blocked', ...committed, qa: qa('qa-failed', { attempt: 4 }) }), G),
    { node: 'qa', status: 'failed', path: ['request', 'master', 'agent-1', 'qa'], reworks: 0 })
  assert.deepEqual(stageOf(flow({ ...committed, qa: qa('failed', { rework: { to: 'Gone' } }) }), G).node, 'qa')
})

test('stageOf: the last entry of the path is always the node', () => {
  const cases = [flow(), flow({ status: 'done' }), flow({ ...committed, qa: qa('testing') }), flow({ qa: qa('failed', { rework: { to: 'Agent 1' } }) }), flow({ qa: qa('passed', { pushedAt: 'x' }) })]
  for (const c of cases) {
    const s = stageOf(c, G)
    assert.equal(s.path.at(-1), s.node, JSON.stringify(c.qa))
  }
})

test('config.mjs carries the pipeline settings, checked, with every key', async () => {
  const { CONFIG } = await import('../config.mjs')
  // planner and security are there only when the live config.json names them (pipeline.mjs gateSetting)
  assert.deepEqual(Object.keys(CONFIG.pipeline).filter(k => k !== 'planner' && k !== 'security').sort(), ['maxReworks', 'producers', 'protectedBranches', 'qa'])
  assert.equal(typeof CONFIG.pipeline.qa, 'string')
  assert.ok(pipelineGraph(CONFIG).nodes.some(n => n.role === 'qa' && n.label === CONFIG.pipeline.qa))
})

// ═══ pushes outside QA (flow.mjs pushCount, for server.mjs's agent records) ═══

test('pushCount: git push commands in Bash or PowerShell since a time, in any spelling; nothing else counts', async () => {
  const { pushCount } = await import('../flow.mjs')
  const at = t => `2026-11-24T${t}:00.000Z`
  const tool = (t, command, name = 'Bash') => ({ t: at(t), kind: 'tool', tool: name, command })
  const events = [
    tool('01:00', 'git push origin feature/x'), // before the window
    tool('10:00', 'git push origin feature/x'),
    tool('10:01', 'git -C C:/repo push origin HEAD:refs/heads/y', 'PowerShell'),
    tool('10:02', 'git add . && git commit -m "x" && git push'),
    tool('10:03', 'git status; echo "git push"'),
    tool('10:04', 'git pushd'),
    tool('10:05', 'node tools/factory.mjs flow qa-push f --branch x --by QA'),
    { t: at('10:06'), kind: 'text', text: 'I will git push now' },
    tool('10:07', 'git push origin x', 'Read'),
  ]
  assert.equal(pushCount(events, Date.parse(at('09:00'))), 3)
  assert.equal(pushCount([], 0), 0)
})
