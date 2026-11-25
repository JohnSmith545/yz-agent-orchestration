// Tests for predict-stage.mjs and predict-alerts.mjs: where an open flow stands now and since when, and the four
// alerts, each at its boundary and with too little history. Stuck: longer than stuckFactor times the stage's median
// over the last 30 days and at least stuckMinMinutes; with fewer than 5 past flows for the stage, the plain limit
// stuckHours; a stage waiting on the user is named as waiting on you. Spike: a session's last hour above spikeFactor
// times its own median active hour over 7 days and above spikeMinTokens. Context: the median cache read of a live
// session's last 10 replies above contextTokens. Daily: today's estimate above dailyUsd or dailyTokens, when set.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pipelineGraph } from '../pipeline.mjs'
import { ALERT_DEFAULTS } from '../predict-settings.mjs'
import { contextAlerts, dailyAlerts, spikeAlerts, stuckAlerts } from '../predict-alerts.mjs'
import { currentStage } from '../predict-stage.mjs'
import { localDay } from '../token-usage.mjs'

const HOUR = 3_600_000
const MIN = 60_000
const NOW = Date.parse('2026-11-25T12:30:00.000Z')
const iso = t => new Date(t).toISOString()
const graph = pipelineGraph({ coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' }, pipeline: { qa: 'QA' } })
const S = { ...ALERT_DEFAULTS }
const PRICES = { 'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 } }

const open = (id, more = {}) => ({ id, title: `Work ${id}`, agent: 'Agent 1', status: 'open', createdAt: iso(NOW - 2 * HOUR), updatedAt: iso(NOW - MIN), nodes: [], ...more })
/** A finished flow whose QA stage took `qaMin` minutes (and producing 30), finished a day ago. */
const past = (id, qaMin) => {
  const start = NOW - 26 * HOUR
  const qaStart = start + 30 * MIN
  return {
    id, title: id, agent: 'Agent 1', status: 'done', createdAt: iso(start), updatedAt: iso(qaStart + qaMin * MIN), nodes: [],
    qa: { status: 'passed', attempt: 1, by: 'QA', startedAt: iso(qaStart), at: iso(qaStart + qaMin * MIN), pushedAt: iso(qaStart + qaMin * MIN + MIN) },
  }
}
const history = n => Array.from({ length: n }, (_, i) => past(`p${i}`, 20))

// ═══ where a flow stands ═══

test('the stage of an open flow: with its agent since the start, at QA since the attempt began, back for a fix since the failure', () => {
  assert.deepEqual(currentStage(open('a'), graph), { key: 'producing', since: NOW - 2 * HOUR, onYou: false, who: 'Agent 1' })
  const testing = open('b', { qa: { status: 'testing', attempt: 1, by: 'QA', startedAt: iso(NOW - HOUR) } })
  assert.deepEqual(currentStage(testing, graph), { key: 'qa', since: NOW - HOUR, onYou: false, who: 'QA' })
  const back = open('c', { qa: { status: 'failed', attempt: 1, by: 'QA', startedAt: iso(NOW - HOUR), at: iso(NOW - 40 * MIN), rework: { to: 'Agent 1' } } })
  assert.deepEqual(currentStage(back, graph), { key: 'rework', since: NOW - 40 * MIN, onYou: false, who: 'Agent 1' })
})

test('a question, a blocked flow and a stop all wait on you, since they began', () => {
  const asked = open('a', { nodes: [{ id: 'q', type: 'ask', kind: 'yesno', title: 'Go on?', at: iso(NOW - 3 * HOUR), answer: null }] })
  assert.deepEqual(currentStage(asked, graph), { key: 'ask', since: NOW - 3 * HOUR, onYou: true, who: 'you' })
  const blocked = open('b', { status: 'blocked', updatedAt: iso(NOW - 5 * HOUR) })
  assert.equal(currentStage(blocked, graph).onYou, true)
  assert.equal(currentStage(blocked, graph).key, 'blocked')
  const stopped = open('c', { qa: { status: 'qa-failed', attempt: 3, by: 'QA', startedAt: iso(NOW - 2 * HOUR), at: iso(NOW - HOUR) } })
  assert.deepEqual(currentStage(stopped, graph), { key: 'stopped', since: NOW - HOUR, onYou: true, who: 'you' })
})

test('a flow at the Output, done or dropped stands nowhere that can be stuck', () => {
  assert.equal(currentStage(past('d', 10), graph), null)
  assert.equal(currentStage(open('x', { status: 'dropped' }), graph), null)
})

// ═══ stuck ═══

test('stuck: past 3 times the median for the stage with 5 past flows, and not a minute before', () => {
  const flows = [...history(5), open('a', { qa: { status: 'testing', attempt: 1, by: 'QA', startedAt: iso(NOW - 61 * MIN) } })]
  const [alert] = stuckAlerts({ flows, graph, now: NOW, settings: S })
  assert.equal(alert.key, 'stuck:a:qa')
  assert.equal(alert.kind, 'stuck')
  assert.equal(alert.flow, 'a')
  assert.match(alert.text, /Work a has been with QA for 1 h 1 min/)
  assert.match(alert.text, /usual 20 min/)
  assert.equal(alert.measure, 61 * MIN)
  // 3 times 20 minutes is 60, and the 60 minute minimum: at 59 minutes nothing
  const early = [...history(5), open('a', { qa: { status: 'testing', attempt: 1, by: 'QA', startedAt: iso(NOW - 59 * MIN) } })]
  assert.deepEqual(stuckAlerts({ flows: early, graph, now: NOW, settings: S }), [])
})

test('stuck: the minimum holds even when 3 times the median is shorter', () => {
  const flows = [...history(5), open('a', { qa: { status: 'testing', attempt: 1, by: 'QA', startedAt: iso(NOW - 70 * MIN) } })]
  assert.equal(stuckAlerts({ flows, graph, now: NOW, settings: { ...S, stuckMinMinutes: 90 } }).length, 0)
  assert.equal(stuckAlerts({ flows, graph, now: NOW, settings: { ...S, stuckMinMinutes: 60 } }).length, 1)
})

test('stuck with too little history: fewer than 5 past flows for the stage fall back to the plain limit, and say so', () => {
  const qaFor = h => open('a', { qa: { status: 'testing', attempt: 1, by: 'QA', startedAt: iso(NOW - h * HOUR) } })
  assert.deepEqual(stuckAlerts({ flows: [...history(4), qaFor(23)], graph, now: NOW, settings: S }), [])
  const [alert] = stuckAlerts({ flows: [...history(4), qaFor(25)], graph, now: NOW, settings: S })
  assert.match(alert.text, /too few past flows/)
  assert.match(alert.text, /24 h/)
})

test('stuck: waiting on you is named as waiting on you, never as an agent being stuck', () => {
  const asked = open('a', { nodes: [{ id: 'q', type: 'ask', kind: 'yesno', title: 'Go on?', at: iso(NOW - 30 * HOUR), answer: null }] })
  const [alert] = stuckAlerts({ flows: [asked], graph, now: NOW, settings: S })
  assert.equal(alert.onYou, true)
  assert.match(alert.text, /waited on you/)
  assert.match(alert.text, /question/)
  assert.doesNotMatch(alert.text, /stuck/i)
})

test('stuck: an archived flow, or one stalled for a week (the score counts it stalled), raises nothing', () => {
  const testing = { qa: { status: 'testing', attempt: 1, by: 'QA', startedAt: iso(NOW - 50 * HOUR) } }
  assert.deepEqual(stuckAlerts({ flows: [open('a', { ...testing, archivedAt: iso(NOW - HOUR) })], graph, now: NOW, settings: S }), [])
  assert.deepEqual(stuckAlerts({ flows: [open('b', { ...testing, updatedAt: iso(NOW - 8 * 24 * HOUR) })], graph, now: NOW, settings: S }), [])
})

// ═══ spike ═══

/** A session file with `perHour` tokens in each of the last 7 days' hours given (offsets in hours back from NOW). */
const sessionFile = (sessionId, hours, { sub = false } = {}) => ({
  sessionId, sub, title: null, mtimeMs: 0, days: {}, recent: [],
  hours: Object.fromEntries(Object.entries(hours).map(([back, n]) => [String(Math.floor((NOW - Number(back) * HOUR) / HOUR)), { 'claude-opus-5-5': [0, n, 0, 0, 0, 1] }])),
})
const usual = Object.fromEntries([5, 10, 20, 30, 40, 50].map(h => [h, 5_000_000]))

test('spike: the last hour above 4 times the usual active hour and above 20 million: which session and both figures', () => {
  const files = [sessionFile('s1', { ...usual, 0: 30_000_000 })]
  const [alert] = spikeAlerts({ files, labelOf: () => 'Agent 1', names: new Map([['s1', 'flinki-v2-a1']]), now: NOW, settings: S })
  assert.equal(alert.key, 'spike:s1')
  assert.equal(alert.agent, 'Agent 1')
  assert.match(alert.text, /Agent 1/)
  assert.match(alert.text, /flinki-v2-a1/)
  assert.match(alert.text, /30M/)
  assert.match(alert.text, /5M/)
})

test('spike: at exactly 4 times, or under the 20 million floor, nothing', () => {
  assert.deepEqual(spikeAlerts({ files: [sessionFile('s1', { ...usual, 0: 20_000_000 })], labelOf: () => 'A', now: NOW, settings: S }), [])
  const small = Object.fromEntries([5, 10, 20, 30, 40].map(h => [h, 1_000_000]))
  assert.deepEqual(spikeAlerts({ files: [sessionFile('s1', { ...small, 0: 15_000_000 })], labelOf: () => 'A', now: NOW, settings: S }), [])
})

test('spike: a session with fewer than 5 active hours in 7 days has too little history to judge', () => {
  const few = Object.fromEntries([5, 10, 20, 30].map(h => [h, 1_000_000]))
  assert.deepEqual(spikeAlerts({ files: [sessionFile('s1', { ...few, 0: 90_000_000 })], labelOf: () => 'A', now: NOW, settings: S }), [])
})

test('spike: a subagent s tokens count with its session', () => {
  const files = [sessionFile('s1', { ...usual, 0: 15_000_000 }), sessionFile('s1', { 0: 10_000_000 }, { sub: true })]
  assert.equal(spikeAlerts({ files, labelOf: () => 'A', now: NOW, settings: S }).length, 1)
})

// ═══ context ═══

const reply = (i, read) => ({ id: `r${i}`, at: NOW - (10 - i) * MIN, model: 'claude-opus-5-5', vec: [10, 500, 0, 0, read, 1] })
const liveFile = (sessionId, reads, more = {}) => ({ sessionId, sub: false, title: null, mtimeMs: NOW, days: {}, hours: {}, recent: reads.map((r, i) => reply(i, r)), ...more })

test('context: the median cache read of the last 10 replies above 400,000 marks the session, with what a turn costs', () => {
  const files = [liveFile('s1', Array(10).fill(650_000))]
  const [alert] = contextAlerts({ files, live: new Map([['s1', 'flinki-v2-a1']]), labelOf: () => 'Agent 1', prices: PRICES, now: NOW, settings: S })
  assert.equal(alert.key, 'context:s1')
  assert.equal(alert.agent, 'Agent 1')
  assert.match(alert.text, /650K/)
  // 650,000 cache reads at $0.20 a million is $0.13, plus 10 input at $4 and 500 output at $20 a million: $0.14
  assert.match(alert.text, /\$0\.14/)
  assert.match(alert.text, /fresh session/)
  assert.match(alert.handover, /handover note/)
  assert.equal(alert.measure, 650_000)
})

test('context: at the limit, a closed session, or fewer than 3 replies, nothing; the median, not one large reply', () => {
  const live = new Map([['s1', 'x']])
  const one = { live, labelOf: () => 'A', prices: PRICES, now: NOW, settings: S }
  assert.deepEqual(contextAlerts({ ...one, files: [liveFile('s1', Array(10).fill(400_000))] }), [])
  assert.deepEqual(contextAlerts({ ...one, files: [liveFile('s1', [900_000, 900_000])] }), [])
  assert.deepEqual(contextAlerts({ ...one, live: new Map(), files: [liveFile('s1', Array(10).fill(900_000))] }), [])
  assert.deepEqual(contextAlerts({ ...one, files: [liveFile('s1', [...Array(9).fill(100_000), 5_000_000])] }), [])
})

test('context: a session moved to the second account reads its newest transcript', () => {
  const files = [liveFile('s1', Array(10).fill(100_000), { mtimeMs: NOW - HOUR }), liveFile('s1', Array(10).fill(700_000), { mtimeMs: NOW })]
  assert.equal(contextAlerts({ files, live: new Map([['s1', 'x']]), labelOf: () => 'A', prices: PRICES, now: NOW, settings: S }).length, 1)
})

// ═══ daily ═══

test('daily spend: off by default; one alert once today passes the limit, by dollars or by tokens', () => {
  const day = localDay(NOW)
  const files = [{ sessionId: 's1', sub: false, days: { [day]: { 'claude-opus-5-5': [0, 1_000_000, 0, 0, 0, 1] } }, hours: {}, recent: [] }]
  assert.deepEqual(dailyAlerts({ files, prices: PRICES, now: NOW, settings: S }), [])
  const [usd] = dailyAlerts({ files, prices: PRICES, now: NOW, settings: { ...S, dailyUsd: 15 } })
  assert.equal(usd.key, `daily:usd:${day}`)
  assert.match(usd.text, /\$20\.00/)
  assert.deepEqual(dailyAlerts({ files, prices: PRICES, now: NOW, settings: { ...S, dailyUsd: 20 } }), [])
  const [tok] = dailyAlerts({ files, prices: PRICES, now: NOW, settings: { ...S, dailyTokens: 999_999 } })
  assert.equal(tok.key, `daily:tokens:${day}`)
  assert.equal(dailyAlerts({ files, prices: PRICES, now: NOW, settings: { ...S, dailyTokens: 1, dailyUsd: 1 } }).length, 2)
})
