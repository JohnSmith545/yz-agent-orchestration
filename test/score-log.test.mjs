// Tests for score-log.mjs, the orchestration log: one timeline of what happened to every flow, each event marked
// with the scorecard cell it put a count in. The load-bearing property: summing the log's cells over a window gives
// exactly scoreOf's counts for that window, on fixtures and (when the dashboard's own data folder is there) on
// the real flows. Pure: flows and a graph in, events out.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { scoreOf } from '../score.mjs'
import { LOG_CELLS, LOG_KINDS, orchestrationLog } from '../score-log.mjs'

const G = pipelineGraph({
  coordinator: 'Master',
  coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2' },
  pipeline: { ...DEFAULT_PIPELINE },
  factory: { chat: { name: 'Independent' } },
})
const DAY = 86_400_000
const NOW = Date.parse('2026-11-24T12:00:00Z')
const ago = ms => new Date(NOW - ms).toISOString()
const code = [{ id: 'n1', type: 'step', title: 'Change it', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }]
const talk = [{ id: 'n1', type: 'step', title: 'Look into it', status: 'done', evidence: [{ kind: 'note', ref: 'Fine.' }] }]
const flow = (id, more = {}) => ({ id, title: `Flow ${id}`, agent: 'Agent 1', status: 'open', createdAt: ago(2 * DAY), updatedAt: ago(3_600_000), nodes: code, ...more })
const log = (flows, opts = {}) => orchestrationLog(flows, G, { now: NOW, days: 30, ...opts })
const of = (events, id) => events.filter(e => e.flow?.id === id)
const kinds = events => events.map(e => e.kind)

/** A flow that went through two QA rounds: Master's work failed and went to Agent 2, then passed and was pushed. */
const REWORKED = flow('reworked', {
  agent: 'Master',
  status: 'done',
  updatedAt: ago(1000),
  route: { type: 'build', steps: ['request', 'master', 'agent-2', 'qa', 'push', 'outcome'], at: ago(DAY), by: 'Master',
    history: [{ type: 'ask', steps: ['request', 'master', 'outcome'], at: ago(2 * DAY - 1000), by: 'Master' }] },
  qa: {
    status: 'passed', attempt: 2, by: 'QA', startedAt: ago(5000), at: ago(4000), pushedAt: ago(3000),
    attempts: [{ status: 'failed', attempt: 1, by: 'QA', startedAt: ago(9000), at: ago(8000), rework: { to: 'Agent 2' } }],
  },
})

test('a reworked flow, step by step, newest first, each event with who and one plain sentence', () => {
  const ev = of(log([REWORKED]), 'reworked')
  assert.deepEqual(kinds(ev), ['pushed', 'passed', 'handed', 'failed', 'handed', 'route', 'route', 'started'])
  const text = Object.fromEntries(ev.map(e => [`${e.kind}@${e.at}`, [e.agent, e.text, e.cell]]))
  assert.deepEqual(text[`pushed@${ago(3000)}`], ['QA', 'QA pushed the change it tested.', null])
  assert.deepEqual(text[`passed@${ago(4000)}`], ['QA', 'QA passed this on attempt 2.', 'delivered'])
  assert.deepEqual(text[`handed@${ago(5000)}`], ['Agent 2', 'Agent 2 handed this to QA again, for attempt 2.', null])
  assert.deepEqual(text[`failed@${ago(8000)}`], ['QA', 'QA failed this and sent it back to Agent 2.', 'caught'])
  assert.deepEqual(text[`handed@${ago(9000)}`], ['Master', 'Master handed this to QA.', null])
  assert.deepEqual(text[`route@${ago(DAY)}`], ['Master', 'Master changed the plan to a code change, through Master, Agent 2, QA and Push.', null])
  assert.deepEqual(text[`route@${ago(2 * DAY - 1000)}`], ['Master', 'Master planned this as a question, through Master.', null])
  assert.deepEqual(text[`started@${ago(2 * DAY)}`], ['Master', 'Master started this.', null])
  for (const e of ev) {
    assert.deepEqual(e.flow, { id: 'reworked', title: 'Flow reworked' })
    assert.deepEqual(Object.keys(e).sort(), ['agent', 'at', 'cell', 'flow', 'kind', 'text'])
    assert.doesNotMatch(e.text, /reworked|\.json|\/|—/, 'no ids, file names or em dashes in a sentence')
  }
})

test('the end of a flow: done with no code (delivered), done with code and no QA (slipped), dropped, stopped, stalled (missed)', () => {
  const ev = log([
    flow('talk', { status: 'done', nodes: talk, updatedAt: ago(10) }),
    flow('slip', { status: 'done', updatedAt: ago(20) }),
    flow('drop', { status: 'dropped', updatedAt: ago(30) }),
    flow('stop', { status: 'blocked', qa: { status: 'qa-failed', attempt: 1, by: 'QA', at: ago(40) } }),
    flow('stall', { updatedAt: ago(8 * DAY) }),
  ])
  const last = id => of(ev, id)[0]
  assert.deepEqual([last('talk').kind, last('talk').cell, last('talk').text], ['done', 'delivered', 'This finished with no code changes.'])
  assert.deepEqual([last('slip').kind, last('slip').cell, last('slip').text], ['done', 'slipped', 'This finished with code changes that QA never tested.'])
  assert.deepEqual([last('drop').kind, last('drop').cell, last('drop').text], ['dropped', 'missed', 'This was dropped.'])
  assert.deepEqual(of(ev, 'stop').slice(0, 2).map(e => [e.kind, e.cell, e.text]), [
    ['stopped', 'missed', 'QA stopped this, so it will not reach the Output.'],
    ['failed', 'caught', 'QA failed this.'],
  ], 'stopped sorts after the verdict at the same time')
  assert.deepEqual([last('stall').kind, last('stall').cell, last('stall').at, last('stall').text], ['stalled', 'missed', ago(DAY), 'This had no update for 7 days.'])
})

test('an earlier pass is not the delivery: only the final verdict carries the cell', () => {
  const ev = log([flow('twice', { status: 'done', qa: { status: 'passed', attempt: 2, by: 'QA', at: ago(10), attempts: [{ status: 'passed', attempt: 1, by: 'QA', at: ago(20) }] } })])
  assert.deepEqual(of(ev, 'twice').filter(e => e.kind === 'passed').map(e => [e.text, e.cell]), [['QA passed this on attempt 2.', 'delivered'], ['QA passed this.', null]])
})

test('what cannot be dated is left out: a refused push, an attempt with no start, a verdict with no time', () => {
  const ev = log([flow('x', { qa: { status: 'passed', attempt: 1, by: 'QA', at: ago(10), pushError: 'rejected' } }), flow('y', { qa: { status: 'failed', attempt: 1, rework: { to: 'Agent 1' } } })])
  assert.equal(ev.filter(e => e.kind === 'push-refused').length, 0)
  assert.deepEqual(kinds(of(ev, 'x')), ['passed', 'started'])
  assert.deepEqual(kinds(of(ev, 'y')), ['started'])
  assert.ok(!LOG_KINDS.includes('push-refused'))
})

test('the window keeps events from exactly days ago on; all time keeps everything dated', () => {
  const f = flow('w', { createdAt: ago(30 * DAY + 1), updatedAt: ago(30 * DAY), status: 'dropped' })
  assert.deepEqual(kinds(log([f])), ['dropped'])
  assert.deepEqual(kinds(log([f], { days: null })), ['dropped', 'started'])
})

test('extra events (rule changes) merge in by time, with no cell, and undated ones are dropped', () => {
  const rule = { at: ago(5000), kind: 'rule', agent: 'Master', text: 'Master changed a rule: QA tests every change.', flow: null, cell: 'caught' }
  const ev = log([REWORKED], { extra: [rule, { kind: 'rule', text: 'no time' }, null] })
  const i = ev.findIndex(e => e.kind === 'rule')
  assert.deepEqual(ev[i], { ...rule, cell: null })
  assert.equal(ev[i - 1].at, ago(4000))
  assert.equal(ev[i + 1].at, ago(5000), 'the handed event at the same time follows it')
  assert.equal(ev.filter(e => e.kind === 'rule').length, 1)
})

test('bad input is skipped, not thrown on', () => {
  assert.deepEqual(log([null, 'x', { id: 'n' }]), [])
  assert.deepEqual([...LOG_CELLS], ['delivered', 'caught', 'missed', 'slipped'])
})

// ═══ the property: the log's cells add up to the scorecard ═══

/** The cells the log carries in a window, counted. */
function sums(events) {
  const out = { delivered: 0, slipped: 0, missed: 0, caught: 0 }
  for (const e of events) if (e.cell) out[e.cell]++
  return out
}

const MIXED = [
  REWORKED,
  flow('talk', { status: 'done', nodes: talk, updatedAt: ago(3 * DAY) }),
  flow('slip', { status: 'done', updatedAt: ago(12 * DAY) }),
  flow('drop', { status: 'dropped', updatedAt: ago(40 * DAY) }),
  flow('stop', { status: 'blocked', qa: { status: 'qa-failed', attempt: 2, at: ago(9 * DAY), attempts: [{ status: 'failed', attempt: 1, at: ago(20 * DAY), rework: { to: 'Agent 1' } }] } }),
  flow('old-stall', { updatedAt: ago(50 * DAY) }),
  flow('new-stall', { updatedAt: ago(9 * DAY) }),
  flow('rework', { qa: { status: 'failed', attempt: 1, at: ago(DAY), rework: { to: 'Agent 1' } } }),
  flow('testing', { qa: { status: 'testing', attempt: 1, startedAt: ago(100) } }),
  flow('chat', { agent: 'Independent', status: 'done', nodes: talk, updatedAt: ago(31 * DAY) }),
  flow('undated', { status: 'done', nodes: talk, updatedAt: undefined }),
]

test('summing the log cells over a window gives exactly the scorecard counts (7, 30, all; fixtures)', () => {
  for (const days of [7, 30, null]) {
    assert.deepEqual(sums(log(MIXED, { days })), scoreOf(MIXED, G, { now: NOW, days }).counts, `days ${days}`)
  }
})

const REAL = 'C:/Users/jjt_j/agent-dashboard/data/flows'
test('the same property on the dashboard real flows, when that folder is there', { skip: !fs.existsSync(REAL) && 'no real flows on this machine' }, async () => {
  const { pipelineGraph: graphOf } = await import('../pipeline.mjs')
  const { CONFIG } = await import('../config.mjs')
  const flows = fs.readdirSync(REAL).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(REAL, f), 'utf8')))
  const graph = graphOf(CONFIG)
  const now = Date.now()
  for (const days of [7, 30, null]) {
    assert.deepEqual(sums(orchestrationLog(flows, graph, { now, days })), scoreOf(flows, graph, { now, days }).counts, `days ${days}`)
  }
})
