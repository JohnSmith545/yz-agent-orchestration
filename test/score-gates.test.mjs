// Tests for the scorecard (score.mjs) and the log (score-log.mjs) once the planner and Security are on the
// pipeline: a Security failure is a catch like a QA failure; a code flow is delivered only when QA AND Security
// passed it, and finished without a Security pass it slipped through; correctness counts a Security failure as a
// failure; the log tags Security verdicts and the planner's hand-outs as their own kinds; and summing the log's cells
// still gives exactly the scorecard's counts. Pure.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { cellOf, scoreOf } from '../score.mjs'
import { GATE_KINDS, LOG_KINDS, orchestrationLog } from '../score-log.mjs'

const BASE = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', Planner: 'Planner', Security: 'Security' },
  pipeline: { ...DEFAULT_PIPELINE, planner: 'Planner', security: 'Security' },
}
const G = pipelineGraph(BASE)
const PLAIN = pipelineGraph({ ...BASE, pipeline: { ...DEFAULT_PIPELINE } })
const DAY = 86_400_000
const NOW = Date.parse('2026-11-24T12:00:00Z')
const ago = ms => new Date(NOW - ms).toISOString()
const code = [{ id: 'n1', type: 'step', title: 'Change it', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }]
const flow = (id, more = {}) => ({ id, title: `Flow ${id}`, agent: 'Agent 1', status: 'open', createdAt: ago(2 * DAY), updatedAt: ago(3_600_000), nodes: code, ...more })
const qa = (status, more = {}) => ({ status, attempt: 1, by: 'QA', startedAt: ago(9000), at: ago(8000), commit: 'abc1234', ...more })
const sec = (status, more = {}) => ({ status, by: 'Security', startedAt: ago(7000), at: ago(6000), commit: 'abc1234', ...more })
const score = (flows, g = G) => scoreOf(flows, g, { now: NOW, days: 30 })
const cell = (f, g = G) => cellOf(f, g, NOW, 7 * DAY)

test('cellOf: QA passed and Security passed is delivered, at the Security verdict; QA alone is not yet', () => {
  assert.deepEqual(cell(flow('a', { status: 'done', qa: qa('passed', { security: sec('passed') }) })), { cell: 'delivered', why: null, kind: 'security', time: NOW - 6000 })
  assert.deepEqual(cell(flow('b', { qa: qa('passed') })).cell, null, 'waiting for Security: on its way')
  assert.deepEqual(cell(flow('c', { qa: qa('passed', { security: sec('reviewing') }) })).cell, null)
  assert.deepEqual(cell(flow('d', { qa: qa('passed', { security: sec('failed', { rework: { to: 'Agent 1' } }) }) })).cell, null, 'sent back: on its way')
})

test('cellOf: finished without a Security pass slipped through; stopped by Security is missed', () => {
  assert.deepEqual(cell(flow('e', { status: 'done', updatedAt: ago(500), qa: qa('passed') })), { cell: 'slipped', why: null, kind: 'done', time: NOW - 500 })
  assert.deepEqual(cell(flow('f', { status: 'blocked', qa: qa('passed', { security: sec('security-failed') }) })), { cell: 'missed', why: 'stopped', kind: 'stopped', time: NOW - 6000 })
})

test('cellOf: without Security on the graph a QA pass is delivered as before, whatever the data says', () => {
  assert.deepEqual(cell(flow('g', { status: 'done', qa: qa('passed') }), PLAIN), { cell: 'delivered', why: null, kind: 'passed', time: NOW - 8000 })
})

test('scoreOf: each Security failure is one catch, against the work it reviewed; correctness counts it as a failure', () => {
  const twice = flow('twice', {
    status: 'done',
    qa: qa('passed', {
      attempt: 2, startedAt: ago(5000), at: ago(4000), security: sec('passed', { at: ago(3000) }),
      attempts: [qa('passed', { security: sec('failed', { rework: { to: 'Agent 2' } }) })],
    }),
  })
  const clean = flow('clean', { status: 'done', qa: qa('passed', { security: sec('passed') }) })
  const s = score([twice, clean])
  assert.deepEqual(s.counts, { delivered: 2, slipped: 0, missed: 0, caught: 1 })
  assert.deepEqual(s.correctness, { value: 0.5, right: 1, judged: 2 })
  const a1 = s.agents.find(a => a.label === 'Agent 1')
  const a2 = s.agents.find(a => a.label === 'Agent 2')
  assert.equal(a1.sentBack, 1, 'Security failed Agent 1 work')
  assert.equal(a2.handed, 1, 'the next attempt was Agent 2 work, where Security sent it')
  // a stop by Security puts in two counts: its failure (caught) and the flow (missed)
  const stopped = score([flow('stop', { status: 'blocked', qa: qa('passed', { security: sec('security-failed') }) })])
  assert.deepEqual(stopped.counts, { delivered: 0, slipped: 0, missed: 1, caught: 1 })
  assert.deepEqual(stopped.correctness, { value: 0, right: 0, judged: 1 })
})

test('the log tags Security verdicts and the planners hand-outs as their own kinds, each one plain sentence', () => {
  assert.deepEqual(GATE_KINDS, ['security', 'planned'])
  assert.ok(!LOG_KINDS.includes('security'), 'the base kinds stay as they were')
  const f = flow('gated', {
    status: 'done',
    plan: { status: 'handed', by: 'Planner', startedAt: ago(DAY), at: ago(DAY - 1000), to: 'Agent 1', file: 'gated/plan-2.md', history: [{ by: 'Planner', at: ago(DAY + 5000), to: 'Agent 2', file: 'gated/plan-1.md' }] },
    qa: qa('passed', { attempt: 2, startedAt: ago(5000), at: ago(4000), security: sec('passed', { at: ago(3000) }), attempts: [qa('passed', { security: sec('failed', { rework: { to: 'Agent 1' } }) })] }),
  })
  const ev = orchestrationLog([f], G, { now: NOW, days: 30 })
  const byKind = k => ev.filter(e => e.kind === k).map(e => [e.agent, e.text, e.cell])
  assert.deepEqual(byKind('security'), [['Security', 'Security passed this.', 'delivered'], ['Security', 'Security failed this and sent it back to Agent 1.', 'caught']])
  assert.deepEqual(byKind('planned'), [['Planner', 'Planner handed this to Agent 1, with a plan.', null], ['Planner', 'Planner handed this to Agent 2, with a plan.', null]])
  assert.deepEqual(byKind('passed').map(x => x[2]), [null, null], 'the QA passes carry no cell: the Security pass does')
})

test('the log: a stop by Security is said by Security; a finish with no Security pass slipped through', () => {
  const ev = orchestrationLog([
    flow('stop', { status: 'blocked', qa: qa('passed', { security: sec('security-failed') }) }),
    flow('slip', { status: 'done', updatedAt: ago(500), qa: qa('passed') }),
  ], G, { now: NOW, days: 30 })
  const stop = ev.find(e => e.kind === 'stopped')
  assert.deepEqual([stop.agent, stop.text, stop.cell], ['Security', 'Security stopped this, so it will not reach the Output.', 'missed'])
  const slip = ev.find(e => e.flow.id === 'slip' && e.cell === 'slipped')
  assert.deepEqual([slip.kind, slip.text], ['done', 'This finished with code changes that Security never passed.'])
})

test('summing the log cells gives the scorecard counts, with the planner and Security on the pipeline', () => {
  const flows = [
    flow('a', { status: 'done', qa: qa('passed', { security: sec('passed') }) }),
    flow('b', { qa: qa('passed', { security: sec('failed', { rework: { to: 'Agent 1' } }) }) }),
    flow('c', { status: 'blocked', qa: qa('passed', { security: sec('security-failed') }) }),
    flow('d', { status: 'done', qa: qa('passed') }),
    flow('e', { qa: qa('failed', { rework: { to: 'Agent 1' } }) }),
    flow('f', { status: 'dropped', updatedAt: ago(DAY) }),
    flow('g', { updatedAt: ago(10 * DAY), qa: qa('passed', { at: ago(10 * DAY) }) }),
    flow('h', { status: 'done', nodes: [], plan: { status: 'handed', by: 'Planner', startedAt: ago(DAY), at: ago(DAY), to: 'Agent 1', file: 'h/plan-1.md' } }),
  ]
  for (const days of [7, 30, null]) {
    const s = scoreOf(flows, G, { now: NOW, days })
    const ev = orchestrationLog(flows, G, { now: NOW, days })
    const sum = { delivered: 0, slipped: 0, missed: 0, caught: 0 }
    for (const e of ev) if (e.cell) sum[e.cell]++
    assert.deepEqual(sum, s.counts, `days ${days}`)
  }
})

test('GET /api/log takes kind=security and kind=planned only on a pipeline with that agent, and names them then', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'score-gates-test-'))
  const { logGet } = await import('../score-routes.mjs')
  const opts = config => ({ config, now: NOW, extra: [] })
  assert.equal(logGet({ kind: 'security' }, opts(BASE)).status, 200)
  assert.equal(logGet({ kind: 'planned' }, opts(BASE)).status, 200)
  const plain = { ...BASE, pipeline: { ...DEFAULT_PIPELINE } }
  assert.equal(logGet({ kind: 'security' }, opts(plain)).status, 400)
  assert.match(logGet({ kind: 'nope' }, opts(BASE)).body.error, /stalled, rule, security or planned\.$/)
  fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true })
})
