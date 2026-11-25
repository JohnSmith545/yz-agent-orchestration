// Tests for the routes and the Agents highlight around the Human task box and Senior (pipeline.mjs): an ask ends
// past both, an old stored route that goes straight from its agent to the Output still reads and still checks, a
// flow waiting on the user says so on its progress, and the diagram lights the no code changes lane and Senior's
// redo arrow. flow-route.mjs for the server side, public/flow-route.js in a vm for the page.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-route-senior-test-'))
const { DEFAULT_PIPELINE, pipelineGraph } = await import('../pipeline.mjs')
const R = await import('../flow-route.mjs')

const window = {}
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'flow-route.js'), 'utf8'), { window })
const UI = window.FlowRoute
const plain = v => JSON.parse(JSON.stringify(v))

const CONFIG = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2' },
  pipeline: { ...DEFAULT_PIPELINE, senior: 'Senior' },
}
const G = pipelineGraph(CONFIG)
const GP = pipelineGraph({ ...CONFIG, pipeline: { ...DEFAULT_PIPELINE } })
const AT = '2026-11-24T10:00:00.000Z'
const route = (type, steps) => ({ type, steps, at: AT, by: 'Agent 1' })
const flow = (more = {}) => ({ id: 'f', title: 'T', agent: 'Agent 1', status: 'open', createdAt: AT, nodes: [], ...more })
const step = (id, done = false) => ({ id, do: `do ${id}`, expect: 'ok', at: AT, done: done ? { by: 'you', at: AT } : null })
const states = p => p.map(s => `${s.node}:${s.state}${s.status ? `:${s.status}` : ''}`)
const OLD_ASK = ['request', 'master', 'agent-1', 'outcome']
const ASK = ['request', 'master', 'agent-1', 'human', 'senior', 'outcome']

test('planRoute: an ask ends past Human task and Senior; a build does not go through them; Senior has no route of its own', () => {
  assert.deepEqual(R.planRoute('ask', 'Agent 1', G), { steps: ASK })
  assert.deepEqual(R.planRoute('ask', 'Agent 1', GP), { steps: ['request', 'master', 'agent-1', 'human', 'outcome'] })
  assert.deepEqual(R.planRoute('build', 'Agent 1', G), { steps: ['request', 'master', 'agent-1', 'qa', 'push', 'outcome'] })
  for (const type of ['build', 'ask']) assert.match(R.planRoute(type, 'Senior', G).error, /Senior/)
  for (const type of R.ROUTE_TYPES) {
    const r = R.planRoute(type, 'Agent 2', G)
    if (r.steps) assert.deepEqual(R.checkRoute(route(type, r.steps), G), [], type)
  }
})

test('checkRoute: an old route straight from an agent to the Output still fits, through the by-hand boxes; a made-up hop does not', () => {
  assert.deepEqual(R.checkRoute(route('ask', OLD_ASK), G), [])
  assert.deepEqual(R.checkRoute(route('ask', OLD_ASK), GP), [])
  assert.deepEqual(R.checkRoute(route('ask', ['request', 'master', 'agent-1', 'senior', 'outcome']), G), [], 'past Human task to Senior')
  assert.match(R.checkRoute(route('ask', ['request', 'agent-1', 'outcome']), G).join('\n'), /from request to agent-1/)
  assert.match(R.checkRoute(route('ask', ['request', 'master', 'push', 'outcome']), G).join('\n'), /from master to push/)
})

test('routeProgress: an answer with no by-hand steps reads Human task and Senior skipped once it is done', () => {
  assert.deepEqual(states(R.routeProgress(flow({ status: 'done', route: route('ask', ASK) }), G)),
    ['request:done', 'master:done', 'agent-1:done', 'human:skipped', 'senior:skipped', 'outcome:done'])
  assert.deepEqual(states(R.routeProgress(flow({ status: 'done', route: route('ask', OLD_ASK) }), G)),
    ['request:done', 'master:done', 'agent-1:done', 'outcome:done'], 'an old route reads exactly as before')
})

test('routeProgress: a flow waiting on the user is current at Human task, even on an old route that does not name it', () => {
  const waiting = { hand: { steps: [step('h1')] } }
  assert.deepEqual(states(R.routeProgress(flow({ ...waiting, route: route('ask', ASK) }), G)),
    ['request:done', 'master:done', 'agent-1:done', 'human:current:waiting', 'senior:upcoming', 'outcome:upcoming'])
  assert.deepEqual(states(R.routeProgress(flow({ ...waiting, route: route('ask', OLD_ASK) }), G)),
    ['request:done', 'master:done', 'agent-1:done', 'human:current:waiting', 'outcome:upcoming'])
  const atSenior = { hand: { steps: [step('h1', true)] }, senior: { status: 'reviewing', by: 'Senior', at: AT } }
  assert.deepEqual(states(R.routeProgress(flow({ ...atSenior, route: route('ask', OLD_ASK) }), G)),
    ['request:done', 'master:done', 'agent-1:done', 'human:done', 'senior:current:reviewing', 'outcome:upcoming'])
})

test('highlight: the no code changes lane lights through the boxes it went past; Senior sending work back lights its redo arrow', () => {
  const idx = (a, b, rework = false) => G.edges.findIndex(e => e.from === a && e.to === b && (e.kind === 'rework') === rework)
  const past = plain(UI.highlight(G, R.routeProgress(flow({ status: 'done', route: route('ask', ASK) }), G)))
  for (const [a, b] of [['agent-1', 'human'], ['human', 'senior'], ['senior', 'outcome']]) assert.ok(past.edges.includes(idx(a, b)), `${a} ${b}`)
  assert.ok(!past.nodes.includes('human') && !past.nodes.includes('senior'))
  const old = plain(UI.highlight(G, R.routeProgress(flow({ status: 'done', route: route('ask', OLD_ASK) }), G)))
  assert.ok(old.edges.includes(idx('agent-1', 'human')) && old.edges.includes(idx('senior', 'outcome')), 'an old route lights the same lane')
  const redo = { hand: { steps: [step('h1')] }, senior: { status: 'failed', by: 'Senior', at: AT, summary: 'wrong project' } }
  const back = plain(UI.highlight(G, R.routeProgress(flow({ ...redo, route: route('ask', ASK) }), G)))
  assert.ok(back.edges.includes(idx('senior', 'human', true)))
  assert.ok(back.nodes.includes('human'))
  assert.equal(UI.detailOf('human'), 'agents')
  assert.equal(UI.detailOf('senior'), 'agents')
})
