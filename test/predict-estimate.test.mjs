// Tests for predict-estimate.mjs and predict-keep.mjs: estimates from similar finished flows. Similar is the same
// route type first, then shared ticket labels and type, the same agent, the same risk level when a provider gives one,
// and title words in common; the estimate is the MEDIAN time and cost of the nearest 3 to 8 with the range; fewer
// than 3 is never a number. Only flows that finished before the flow started count. The estimate is kept on the flow
// as the server wrote it (an agent rewrite cannot change it), and set against the actual once the flow finishes.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pipelineGraph } from '../pipeline.mjs'
import { accuracyOf, estimateFor, misses, rankSimilar, targetOf, wordsOf } from '../predict-estimate.mjs'
import { keepEstimate, validateEstimate } from '../predict-keep.mjs'

const HOUR = 3_600_000
const MIN = 60_000
const T0 = Date.parse('2026-11-20T08:00:00.000Z')
const iso = t => new Date(t).toISOString()
const graph = pipelineGraph({ coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' }, pipeline: { qa: 'QA' } })

/** A flow QA passed: started at `start`, passed `minutes` later. */
function done(id, { start = T0, minutes = 60, agent = 'Agent 1', tickets = [], title = id, type = 'build' } = {}) {
  const at = start + minutes * MIN
  return {
    id, title, agent, tickets, status: 'done', createdAt: iso(start), updatedAt: iso(at), nodes: [],
    route: { type, steps: ['request', 'master', 'qa', 'push', 'outcome'], at: iso(start), by: 'Master' },
    qa: { status: 'passed', attempt: 1, by: 'QA', startedAt: iso(at - 5 * MIN), at: iso(at), pushedAt: iso(at + MIN) },
  }
}
const TICKETS = new Map([
  ['FLA-1', { title: 'Login page is slow', labels: ['Auth', 'Speed'], type: 'bug' }],
  ['FLA-2', { title: 'Login form error', labels: ['Auth'], type: 'bug' }],
  ['FLA-3', { title: 'Album upload', labels: ['Media'], type: 'feature' }],
  ['FLA-9', { title: 'Login timeout', labels: ['Auth', 'Speed'], type: 'bug' }],
])

test('title words are lower case, three letters or more, without the common small words', () => {
  assert.deepEqual([...wordsOf('Fix the Login page: it is SLOW and the login form')].sort(), ['fix', 'form', 'login', 'page', 'slow'])
  assert.deepEqual([...wordsOf('')], [])
})

test('the same route type comes first: a flow of another type is never similar', () => {
  const flows = [done('a', { type: 'ask' }), done('b'), done('c')]
  const target = { routeType: 'build', tickets: [], agent: 'Agent 1', title: 'x', start: T0 + 100 * HOUR }
  assert.deepEqual(rankSimilar(target, flows, { graph, tickets: TICKETS, now: T0 + 200 * HOUR }).map(r => r.id).sort(), ['b', 'c'])
})

test('shared ticket labels and type, the same agent and title words rank a flow nearer', () => {
  const flows = [
    done('labels', { tickets: ['FLA-1'], agent: 'Master', title: 'Something else' }),
    done('media', { tickets: ['FLA-3'], agent: 'Master', title: 'Album upload' }),
    done('agent', { agent: 'Agent 1', title: 'Unrelated work' }),
    done('words', { agent: 'Master', title: 'Login timeout fix' }),
  ]
  const target = { routeType: 'build', tickets: ['FLA-9'], agent: 'Agent 1', title: 'Fix login timeout', start: T0 + 100 * HOUR }
  const ranked = rankSimilar(target, flows, { graph, tickets: TICKETS, now: T0 + 200 * HOUR }).map(r => r.id)
  assert.equal(ranked[0], 'labels')
  assert.equal(ranked.at(-1), 'media')
})

test('a risk provider makes the same risk level nearer; without one risk plays no part', () => {
  const flows = [done('low', { title: 'Same words here' }), done('high', { title: 'Same words here' })]
  const target = { routeType: 'build', tickets: [], agent: 'Agent 1', title: 'Same words here', start: T0 + 100 * HOUR, risk: 'high' }
  const riskOf = f => (f.id === 'high' ? 'high' : 'low')
  assert.equal(rankSimilar(target, flows, { graph, tickets: TICKETS, now: T0 + 200 * HOUR, riskOf })[0].id, 'high')
  const plain = rankSimilar(target, flows, { graph, tickets: TICKETS, now: T0 + 200 * HOUR })
  assert.equal(plain[0].score, plain[1].score)
})

test('only flows that finished before the flow started count, never the flow itself', () => {
  const flows = [done('before', { start: T0 }), done('after', { start: T0 + 50 * HOUR }), done('self', { start: T0 })]
  const target = { id: 'self', routeType: 'build', tickets: [], agent: 'Agent 1', title: 'x', start: T0 + 10 * HOUR }
  assert.deepEqual(rankSimilar(target, flows, { graph, tickets: TICKETS, now: T0 + 200 * HOUR }).map(r => r.id), ['before'])
})

test('three similar flows give the median time and cost with the range; two give no number at all', () => {
  const flows = [done('a', { minutes: 40 }), done('b', { minutes: 70, start: T0 + HOUR }), done('c', { minutes: 120, start: T0 + 2 * HOUR })]
  const cost = { a: { tokens: 1e6, usd: 10 }, b: { tokens: 3e6, usd: 40 }, c: { tokens: 5e6, usd: 90 } }
  const target = { routeType: 'build', tickets: [], agent: 'Agent 1', title: 'x', start: T0 + 100 * HOUR }
  const opts = { graph, tickets: TICKETS, now: T0 + 100 * HOUR, tokensOf: id => cost[id] ?? null }
  const e = estimateFor(target, flows, opts)
  assert.equal(e.minutes, 70)
  assert.equal(e.usd, 40)
  assert.equal(e.tokens, 3e6)
  assert.deepEqual(e.basedOn.sort(), ['a', 'b', 'c'])
  assert.deepEqual(e.spread, { minutes: [40, 120], usd: [10, 90], tokens: [1e6, 5e6] })
  assert.equal(e.at, iso(T0 + 100 * HOUR))
  const few = estimateFor(target, flows.slice(0, 2), opts)
  assert.equal(few.minutes, null)
  assert.equal(few.usd, null)
  assert.equal(few.spread, null)
  assert.equal(few.few, true)
})

test('at most the nearest 8 count; a cost is left out when fewer than 3 of them have a placed cost', () => {
  const flows = Array.from({ length: 12 }, (_, i) => done(`f${i}`, { minutes: 10 + i, start: T0 + i * HOUR }))
  const target = { routeType: 'build', tickets: [], agent: 'Agent 1', title: 'x', start: T0 + 100 * HOUR }
  const e = estimateFor(target, flows, { graph, tickets: TICKETS, now: T0 + 100 * HOUR, tokensOf: id => (id === 'f11' ? { tokens: 5, usd: 1 } : null), nearest: 8 })
  assert.equal(e.basedOn.length, 8)
  assert.equal(e.usd, null)
  assert.equal(e.tokens, null)
  assert.equal(e.spread.usd, null)
  assert.ok(Number.isFinite(e.minutes))
})

test('a flow and a ticket not yet started make targets: the route type, tickets, agent, title and start', () => {
  const f = done('a', { tickets: ['FLA-1'] })
  assert.deepEqual(targetOf({ flow: f }), { id: 'a', routeType: 'build', tickets: ['FLA-1'], agent: 'Agent 1', title: 'a', start: T0, risk: null })
  assert.deepEqual(targetOf({ ticket: { id: 'FLA-3', title: 'Album upload' }, now: T0 }), { id: null, routeType: null, tickets: ['FLA-3'], agent: null, title: 'Album upload', start: T0, risk: null })
})

test('accuracy: the median error and how many fell in the range, stored apart from worked out afterwards; under 5 is too few', () => {
  const flows = [0, 1, 2, 3, 4].map(i => ({ ...done(`s${i}`, { minutes: 60 + i * 10, start: T0 + i * HOUR }), estimate: { at: iso(T0 + i * HOUR), minutes: 60, usd: null, tokens: null, basedOn: ['x', 'y', 'z'], spread: { minutes: [50, 80], usd: null, tokens: null } } }))
  const acc = accuracyOf(flows, { graph, tickets: TICKETS, now: T0 + 200 * HOUR })
  assert.equal(acc.stored.minutes.flows, 5)
  // errors 0, 10, 20, 30, 40 minutes of 60: the median is 20 of 60
  assert.ok(Math.abs(acc.stored.minutes.median - 1 / 3) < 1e-9)
  assert.equal(acc.stored.minutes.inRange, 3)
  assert.equal(acc.stored.minutes.few, false)
  const four = accuracyOf(flows.slice(0, 4), { graph, tickets: TICKETS, now: T0 + 200 * HOUR })
  assert.equal(four.stored.minutes.few, true)
})

test('estimate misses: a finished flow outside its estimate s range, in the window, says how far', () => {
  const late = { ...done('late', { minutes: 200, title: 'Slow one' }), estimate: { at: iso(T0), minutes: 60, usd: null, tokens: null, basedOn: ['a', 'b', 'c'], spread: { minutes: [40, 90], usd: null, tokens: null } } }
  const fine = { ...done('fine', { minutes: 60 }), estimate: late.estimate }
  const list = misses([late, fine], { graph, since: T0 - HOUR, now: T0 + 10 * HOUR })
  assert.equal(list.length, 1)
  assert.equal(list[0].flow, 'late')
  assert.match(list[0].text, /Slow one/)
  assert.match(list[0].text, /3 h 20 min/)
  assert.match(list[0].text, /about 1 h/)
  assert.deepEqual(misses([late], { graph, since: T0 + 100 * HOUR, now: T0 + 200 * HOUR }), [])
})

// ═══ kept on the flow ═══

test('the estimate is the server s: an agent rewrite keeps the stored one and cannot add or change it', () => {
  const stored = { estimate: { at: iso(T0), minutes: 60, usd: 4, tokens: 1e6, basedOn: ['a', 'b', 'c'], spread: null } }
  const incoming = { estimate: { at: iso(T0), minutes: 1, usd: 0, tokens: 0, basedOn: [], spread: null } }
  keepEstimate(incoming, stored)
  assert.deepEqual(incoming.estimate, stored.estimate)
  const forged = { estimate: stored.estimate }
  keepEstimate(forged, {})
  assert.equal('estimate' in forged, false)
})

test('a stored estimate is checked: a time, numbers or null, at most 20 flow ids, a range of two numbers', () => {
  assert.deepEqual(validateEstimate({ at: iso(T0), minutes: 60, usd: null, tokens: 5, basedOn: ['a-1', 'b'], spread: { minutes: [1, 2], usd: null, tokens: [3, 4] } }), [])
  assert.deepEqual(validateEstimate({ at: iso(T0), minutes: null, usd: null, tokens: null, basedOn: [], spread: null, few: true }), [])
  const bad = validateEstimate({ at: 'soon', minutes: -1, usd: 'x', tokens: Infinity, basedOn: ['Bad Id'], spread: { minutes: [1] } })
  assert.equal(bad.length, 6)
  assert.deepEqual(validateEstimate('x'), ['estimate must be a JSON object'])
  assert.equal(validateEstimate({ at: iso(T0), minutes: 1, usd: 1, tokens: 1, basedOn: Array.from({ length: 21 }, (_, i) => `f${i}`), spread: null }).length, 1)
})
