// Tests for flow-route.mjs: the route a flow is planned to take through the pipeline (its type and its steps,
// from the Request to the Output), checked for shape (validateRoute, part of validateFlow) and against the graph
// (checkRoute), planned from a type and an agent (planRoute), inferred for a flow written before routes
// (inferRoute), kept across rewrites (keepRoute), changed only on purpose (changeRoute), and how far a flow has
// come along it (routeProgress), all derived from the flow alone. FACTORY_DATA_DIR points at a fresh temp folder
// BEFORE flows.mjs is imported.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-route-test-'))
const F = await import('../flows.mjs')
const { pipelineGraph, DEFAULT_PIPELINE } = await import('../pipeline.mjs')
const R = await import('../flow-route.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))

const CONFIG = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', 'Agent 3': 'Agent 3' },
  pipeline: { ...DEFAULT_PIPELINE }, factory: { chat: { name: 'Independent' } },
}
const G = pipelineGraph(CONFIG)
const NO_CHAT = pipelineGraph({ ...CONFIG, factory: undefined })
const AT = '2026-11-24T10:00:00.000Z'
const BUILD = ['request', 'master', 'agent-1', 'qa', 'push', 'outcome']
const route = (type, steps, more = {}) => ({ type, steps, at: AT, by: 'Agent 1', ...more })
const flow = (more = {}) => ({ id: 'f', title: 'T', agent: 'Agent 1', status: 'open', createdAt: AT, nodes: [], ...more })
const committed = { nodes: [{ id: 'n1', type: 'step', title: 'x', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }] }
const qa = (status, more = {}) => ({ status, attempt: 1, by: 'QA', at: AT, ...more })
const states = list => list.map(s => `${s.node}:${s.state}`)

// ═══ the shape (validateRoute, inside validateFlow) ═══

test('validateRoute: a full route is fine; every part is checked in plain words', () => {
  assert.deepEqual(R.validateRoute(route('build', BUILD)), [])
  assert.deepEqual(R.validateRoute([]), ['route must be a JSON object'])
  assert.match(R.validateRoute(route('fix', BUILD)).join('\n'), /route\.type must be one of build, review, ask/)
  assert.match(R.validateRoute(route('ask', 'request')).join('\n'), /route\.steps must be a list/)
  assert.match(R.validateRoute(route('ask', ['master', 'outcome'])).join('\n'), /start at request and end at outcome/)
  assert.match(R.validateRoute(route('ask', ['request', 'master'])).join('\n'), /start at request and end at outcome/)
  assert.match(R.validateRoute(route('ask', ['request', 'Master!', 'outcome'])).join('\n'), /route step Master! must match/)
  assert.match(R.validateRoute(route('ask', ['request', 'master', 'master', 'outcome'])).join('\n'), /route step master is there twice/)
  assert.match(R.validateRoute(route('ask', ['request', 'master', 'outcome'], { at: 'soon' })).join('\n'), /route\.at must be a time/)
  assert.match(R.validateRoute(route('ask', ['request', 'master', 'outcome'], { by: 'a"b' })).join('\n'), /route\.by must be a label/)
  assert.match(R.validateRoute(route('ask', ['request', 'master', 'outcome'], { inferred: true })).join('\n'), /route\.inferred is the dashboard's/)
})

test('validateRoute: history is a list of earlier routes, each with its type, steps, time and author', () => {
  const old = route('ask', ['request', 'master', 'agent-1', 'outcome'])
  assert.deepEqual(R.validateRoute(route('build', BUILD, { history: [old] })), [])
  assert.match(R.validateRoute(route('build', BUILD, { history: old })).join('\n'), /route\.history must be a list/)
  assert.match(R.validateRoute(route('build', BUILD, { history: [{ ...old, type: 'x' }] })).join('\n'), /route\.history #1/)
})

test('validateFlow: a flow with no route is still valid (older flows); a bad route is a problem line', () => {
  const base = { id: 'f', title: 'T', agent: 'Agent 1', status: 'open', nodes: [] }
  assert.deepEqual(F.validateFlow(base), [])
  assert.deepEqual(F.validateFlow({ ...base, route: route('build', BUILD) }), [])
  assert.match(F.validateFlow({ ...base, route: route('nope', BUILD) }).join('\n'), /route\.type/)
})

// ═══ against the graph (checkRoute) ═══

test('checkRoute: every step is a node of the pipeline, each hand-over is an edge of it, and a build passes QA and Push', () => {
  assert.deepEqual(R.checkRoute(route('build', BUILD), G), [])
  assert.match(R.checkRoute(route('build', ['request', 'master', 'agent-9', 'qa', 'push', 'outcome']), G).join('\n'), /agent-9 is not on the pipeline/)
  assert.match(R.checkRoute(route('ask', ['request', 'agent-1', 'outcome']), G).join('\n'), /from request to agent-1/)
  assert.match(R.checkRoute(route('build', ['request', 'master', 'outcome']), G).join('\n'), /a build route must go through QA and Push/)
  assert.match(R.checkRoute(route('review', ['request', 'master', 'outcome']), G).join('\n'), /a review route goes through Independent/)
})

// ═══ planning (planRoute) ═══

test('planRoute: build is Request, the coordinator, the producer, QA, Push, Output; the coordinator building its own skips the producer', () => {
  assert.deepEqual(R.planRoute('build', 'Agent 1', G), { steps: BUILD })
  assert.deepEqual(R.planRoute('build', 'Master', G), { steps: ['request', 'master', 'qa', 'push', 'outcome'] })
  assert.deepEqual(R.planRoute('build', 'CSP agent', G), { steps: ['request', 'master', 'qa', 'push', 'outcome'] }, 'an agent not on the pipeline works through the coordinator')
})

test('planRoute: review is the chat agent only; ask is the one agent that answers', () => {
  assert.deepEqual(R.planRoute('review', 'Independent', G), { steps: ['request', 'independent', 'outcome'] })
  assert.deepEqual(R.planRoute('ask', 'Independent', G), { steps: ['request', 'independent', 'outcome'] })
  // an ask ends past Human task (the graph has no edge from an agent straight to the Output any more)
  assert.deepEqual(R.planRoute('ask', 'Master', G), { steps: ['request', 'master', 'human', 'outcome'] })
  assert.deepEqual(R.planRoute('ask', 'Agent 2', G), { steps: ['request', 'master', 'agent-2', 'human', 'outcome'] })
})

test('planRoute: what has no route says why in one line', () => {
  for (const [type, agent, why] of [
    ['build', 'Independent', /makes no code changes/],
    ['build', 'QA', /QA tests/],
    ['review', 'Agent 1', /a review is Independent's/],
    ['ask', 'QA', /QA asks on the flow it tests/],
    ['fix', 'Agent 1', /--type build\|review\|ask/],
    [undefined, 'Agent 1', /--type build\|review\|ask/],
  ]) {
    const r = R.planRoute(type, agent, G)
    assert.equal(r.steps, undefined, `${type} ${agent}`)
    assert.match(r.error, why)
    assert.doesNotMatch(r.error, /\n/)
  }
  assert.match(R.planRoute('review', 'Independent', NO_CHAT).error, /no chat agent/)
})

test('planRoute: every route it plans passes checkRoute', () => {
  for (const type of R.ROUTE_TYPES) {
    for (const agent of ['Master', 'Agent 1', 'Agent 3', 'Independent', 'Someone']) {
      const r = R.planRoute(type, agent, G)
      if (r.steps) assert.deepEqual(R.checkRoute(route(type, r.steps), G), [], `${type} ${agent}`)
    }
  }
})

// ═══ older flows (inferRoute, routeOf) ═══

test('inferRoute: build when the flow changed code or QA has it, ask otherwise, with its own agent, flagged inferred', () => {
  assert.deepEqual(R.inferRoute(flow(), G), { type: 'ask', steps: ['request', 'master', 'agent-1', 'human', 'outcome'], at: AT, by: 'dashboard', inferred: true })
  assert.equal(R.inferRoute(flow(committed), G).type, 'build')
  assert.deepEqual(R.inferRoute(flow({ qa: qa('testing') }), G).steps, BUILD)
  assert.deepEqual(R.inferRoute(flow({ agent: 'Independent', ...committed }), G).steps, ['request', 'independent', 'outcome'], 'the chat agent never builds')
  assert.deepEqual(R.inferRoute(flow({ agent: 'QA' }), G).steps, ['request', 'master', 'human', 'outcome'], 'an agent with no route of its own: the coordinator')
})

test('routeOf: the stored route as it is, else the inferred one', () => {
  const stored = route('build', BUILD)
  assert.deepEqual(R.routeOf(flow({ route: stored }), G), stored)
  assert.equal(R.routeOf(flow(), G).inferred, true)
})

// ═══ keeping and changing it ═══

test('keepRoute: a rewrite keeps the stored route; a flow with none takes what the file gives', () => {
  const stored = route('build', BUILD)
  const incoming = flow({ route: route('ask', ['request', 'master', 'outcome']) })
  R.keepRoute(incoming, flow({ route: stored }))
  assert.deepEqual(incoming.route, stored)
  const fresh = flow({ route: route('ask', ['request', 'master', 'outcome']) })
  R.keepRoute(fresh, flow())
  assert.equal(fresh.route.type, 'ask')
  const none = flow()
  R.keepRoute(none, flow({ route: stored }))
  assert.deepEqual(none.route, stored, 'a rewrite with no route keeps it too')
})

test('mergeKeepingAnswers keeps the stored route over the agent file', () => {
  const stored = route('build', BUILD)
  const merged = F.mergeKeepingAnswers(flow({ route: route('ask', ['request', 'master', 'outcome']) }), flow({ route: stored }))
  assert.deepEqual(merged.route, stored)
})

test('changeRoute: the new route replaces it and the old one goes into history, newest last, at most 20', () => {
  const f = flow({ route: route('ask', ['request', 'master', 'agent-1', 'outcome']) })
  R.changeRoute(f, route('build', BUILD, { by: 'Master', at: '2026-11-24T11:00:00.000Z' }))
  assert.equal(f.route.type, 'build')
  assert.equal(f.route.by, 'Master')
  assert.deepEqual(f.route.history, [route('ask', ['request', 'master', 'agent-1', 'outcome'])])
  for (let i = 0; i < 25; i++) R.changeRoute(f, route(i % 2 ? 'build' : 'ask', i % 2 ? BUILD : ['request', 'master', 'agent-1', 'outcome']))
  assert.equal(f.route.history.length, 20)
  assert.ok(f.route.history.every(h => h.history === undefined), 'a history entry never nests another')
  const bare = flow()
  R.changeRoute(bare, route('ask', ['request', 'master', 'agent-1', 'outcome']))
  assert.equal(bare.route.history, undefined, 'a flow that had none has no history')
})

// ═══ how far along (routeProgress) ═══

const on = (more, steps = BUILD, type = 'build') => R.routeProgress(flow({ route: route(type, steps), ...more }), G)

test('routeProgress: an open build flow on its producer: what came before is done, the producer is current, the rest upcoming', () => {
  const p = on({})
  assert.deepEqual(states(p), ['request:done', 'master:done', 'agent-1:current', 'qa:upcoming', 'push:upcoming', 'outcome:upcoming'])
  assert.deepEqual(p.map(s => s.label), ['Request', 'Master', 'Agent 1', 'QA', 'Push', 'Output'])
  assert.deepEqual(p.map(s => s.role), ['request', 'coordinator', 'producer', 'qa', 'push', 'outcome'])
  assert.deepEqual(p.map(s => s.visits), [1, 1, 1, 0, 0, 0])
  assert.equal(p[2].status, 'working')
  assert.equal(p.filter(s => s.status !== undefined).length, 1, 'only the current step carries the stage status')
})

test('routeProgress: QA testing is current at QA; a failure sent back is current at the producer again, the loop counted in visits', () => {
  assert.deepEqual(states(on({ ...committed, qa: qa('testing') })), ['request:done', 'master:done', 'agent-1:done', 'qa:current', 'push:upcoming', 'outcome:upcoming'])
  const back = on({ ...committed, qa: qa('failed', { rework: { to: 'Agent 1' } }) })
  assert.deepEqual(states(back), ['request:done', 'master:done', 'agent-1:current', 'qa:upcoming', 'push:upcoming', 'outcome:upcoming'])
  assert.deepEqual(back.map(s => s.visits), [1, 1, 2, 1, 0, 0])
  assert.equal(back[2].status, 'rework')
})

test('routeProgress: passed and pushed is every step done, the Output included; passed and not pushed is current at Push', () => {
  const pushed = on({ status: 'done', ...committed, qa: qa('passed', { commit: 'abc1234', pushedAt: AT }) })
  assert.deepEqual(states(pushed), BUILD.map(s => `${s}:done`))
  assert.equal(pushed.at(-1).visits, 1)
  assert.deepEqual(states(on({ status: 'done', ...committed, qa: qa('passed', { commit: 'abc1234' }) })).slice(3), ['qa:done', 'push:current', 'outcome:upcoming'])
})

test('routeProgress: a done flow that went to the Output by the skip edge has QA and Push skipped', () => {
  assert.deepEqual(states(on({ status: 'done' })), ['request:done', 'master:done', 'agent-1:done', 'qa:skipped', 'push:skipped', 'outcome:done'])
})

test('routeProgress: a done flow that changed code and has no QA record yet is current at QA, waiting: done is not tested', () => {
  const p = on({ status: 'done', ...committed })
  assert.deepEqual(states(p).slice(3), ['qa:current', 'push:upcoming', 'outcome:upcoming'])
  assert.equal(p[3].status, 'waiting')
})

test('routeProgress: a done ask flow has every step done; one whose stage left its route is at the end', () => {
  const ask = ['request', 'master', 'agent-1', 'outcome']
  assert.deepEqual(states(on({ status: 'done' }, ask, 'ask')), ask.map(s => `${s}:done`))
  assert.deepEqual(states(on({ status: 'done', ...committed }, ask, 'ask')), ask.map(s => `${s}:done`), 'an ask that left a commit behind does not wait for a QA it never planned')
})

test('routeProgress: a dropped flow has no current step: what it got through is done, the rest skipped', () => {
  const p = on({ status: 'dropped' })
  assert.deepEqual(states(p), ['request:done', 'master:done', 'agent-1:skipped', 'qa:skipped', 'push:skipped', 'outcome:skipped'])
  assert.ok(!p.some(s => s.state === 'current'))
})

test('routeProgress: the chat agent flow is Request, Independent, Output', () => {
  const steps = ['request', 'independent', 'outcome']
  assert.deepEqual(states(on({ agent: 'Independent' }, steps, 'review')), ['request:done', 'independent:current', 'outcome:upcoming'])
  assert.deepEqual(states(on({ agent: 'Independent', status: 'done' }, steps, 'review')), steps.map(s => `${s}:done`))
})

test('routeProgress: an older flow with no route follows its inferred one; a flow whose agent left its route still has one current step', () => {
  assert.deepEqual(states(R.routeProgress(flow(), G)), ['request:done', 'master:done', 'agent-1:current', 'human:upcoming', 'outcome:upcoming'])
  const moved = on({ agent: 'Agent 2' })
  assert.equal(moved.filter(s => s.state === 'current').length, 1)
  assert.equal(moved.find(s => s.state === 'current').node, 'master')
})

test('routeProgress: a step the graph no longer has keeps its id as its label and never throws', () => {
  const p = on({}, ['request', 'master', 'agent-9', 'qa', 'push', 'outcome'])
  assert.equal(p[2].label, 'agent-9')
  assert.equal(p[2].role, null)
})

test('withRoute: the route and the progress a page reads, for any flow', () => {
  const w = R.withRoute(flow(), G)
  assert.deepEqual(Object.keys(w), ['route', 'progress'])
  assert.equal(w.route.inferred, true)
  assert.equal(w.progress.length, 5)
})
