// Tests for the routes of flow-route.mjs once the planner and Security are on the pipeline (pipeline.planner,
// pipeline.security): a build goes through both, a review or an ask does not change, neither agent has a route
// of its own, and the progress reads where the flow stands. FACTORY_DATA_DIR points at a fresh temp folder BEFORE
// flows.mjs is imported (flow-route.mjs is imported through it elsewhere).

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-route-gates-test-'))
await import('../flows.mjs')
const { pipelineGraph, DEFAULT_PIPELINE } = await import('../pipeline.mjs')
const R = await import('../flow-route.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const CONFIG = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', Planner: 'Planner', Security: 'Security' },
  pipeline: { ...DEFAULT_PIPELINE, planner: 'Planner', security: 'Security' }, factory: { chat: { name: 'Independent' } },
}
const G = pipelineGraph(CONFIG)
const ONLY_SECURITY = pipelineGraph({ ...CONFIG, pipeline: { ...DEFAULT_PIPELINE, security: 'Security' } })
const AT = '2026-11-24T10:00:00.000Z'
const BUILD = ['request', 'master', 'planner', 'agent-1', 'qa', 'security', 'push', 'outcome']
const route = (type, steps) => ({ type, steps, at: AT, by: 'Agent 1' })
const flow = (more = {}) => ({ id: 'f', title: 'T', agent: 'Agent 1', status: 'open', createdAt: AT, nodes: [], ...more })
const states = list => list.map(s => `${s.node}:${s.state}`)

test('planRoute: a producer build goes through the planner and Security; the coordinator builds its own through Security only', () => {
  assert.deepEqual(R.planRoute('build', 'Agent 1', G), { steps: BUILD })
  assert.deepEqual(R.planRoute('build', 'Master', G), { steps: ['request', 'master', 'qa', 'security', 'push', 'outcome'] })
  assert.deepEqual(R.planRoute('build', 'Agent 1', ONLY_SECURITY), { steps: ['request', 'master', 'agent-1', 'qa', 'security', 'push', 'outcome'] })
})

test('planRoute: review and ask routes do not change', () => {
  assert.deepEqual(R.planRoute('ask', 'Agent 1', G), { steps: ['request', 'master', 'agent-1', 'outcome'] })
  assert.deepEqual(R.planRoute('ask', 'Master', G), { steps: ['request', 'master', 'outcome'] })
  assert.deepEqual(R.planRoute('review', 'Independent', G), { steps: ['request', 'independent', 'outcome'] })
})

test('planRoute: the planner and Security have no route of their own, each refusal one line saying what to do', () => {
  for (const [label, word] of [['Planner', /flow plan/], ['Security', /security commands/]]) {
    for (const type of ['build', 'ask']) {
      const r = R.planRoute(type, label, G)
      assert.ok(r.error && !r.steps, `${label} ${type}`)
      assert.match(r.error, type === 'build' ? word : /flow ask/)
    }
  }
})

test('checkRoute: the planned build fits the graph; a build that skips Security is refused; an ask may go from the coordinator to a producer', () => {
  assert.deepEqual(R.checkRoute(route('build', BUILD), G), [])
  assert.deepEqual(R.checkRoute(route('build', ['request', 'master', 'qa', 'security', 'push', 'outcome']), G), [])
  assert.match(R.checkRoute(route('build', ['request', 'master', 'qa', 'push', 'outcome']), G).join('\n'), /must go through Security/)
  assert.deepEqual(R.checkRoute(route('ask', ['request', 'master', 'agent-1', 'outcome']), G), [], 'the planner hands out build work only')
  assert.match(R.checkRoute(route('build', ['request', 'master', 'agent-1', 'qa', 'security', 'push', 'outcome']), G).join('\n'), /from master to agent-1/)
})

test('routeProgress: Master, the planner, the producer, QA, Security, Push and the Output, each the current step in turn', () => {
  const r = route('build', BUILD)
  const plan = (status, more = {}) => ({ status, by: 'Planner', startedAt: AT, at: AT, ...more })
  const qa = (status, more = {}) => ({ status, attempt: 1, by: 'QA', at: AT, commit: 'abc1234', ...more })
  const cur = f => R.routeProgress(f, G, r).find(s => s.state === 'current')
  assert.equal(cur(flow({ agent: 'Master', route: r })).node, 'master')
  assert.equal(cur(flow({ agent: 'Master', route: r, plan: plan('planning') })).node, 'planner')
  assert.equal(cur(flow({ route: r, plan: plan('handed', { to: 'Agent 1' }) })).node, 'agent-1')
  assert.equal(cur(flow({ route: r, plan: plan('handed', { to: 'Agent 1' }), qa: qa('testing') })).node, 'qa')
  assert.deepEqual(cur(flow({ route: r, plan: plan('handed', { to: 'Agent 1' }), qa: qa('passed', { security: { status: 'reviewing', by: 'Security', at: AT } }) })),
    { node: 'security', label: 'Security', role: 'security', state: 'current', visits: 1, status: 'reviewing' })
  assert.equal(cur(flow({ route: r, plan: plan('handed', { to: 'Agent 1' }), qa: qa('passed', { security: { status: 'passed', by: 'Security', at: AT } }) })).node, 'push')
  const pushed = R.routeProgress(flow({ status: 'done', route: r, plan: plan('handed', { to: 'Agent 1' }), qa: qa('passed', { pushedAt: AT, security: { status: 'passed', by: 'Security', at: AT } }) }), G, r)
  assert.deepEqual(states(pushed), BUILD.map(s => `${s}:done`))
})
