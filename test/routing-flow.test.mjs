// Tests for routing-flow.mjs: the flow's `routing` block (its task type, size, the suggestion, what was used and
// whether the suggestion was followed): its shape, that a rewrite keeps the stored one, the user's correction, and
// `used` read from the agent settings at the time.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { validateRouting, keepRouting, planRouting, usedFrom, withUsed, correctType } = await import('../routing-flow.mjs')
const { DEFAULT_RULES } = await import('../routing-rules.mjs')

const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'
const AT = '2026-11-25T10:00:00.000Z'
const graph = { nodes: [
  { id: 'master', kind: 'agent', label: 'Master', role: 'coordinator' },
  { id: 'a2', kind: 'agent', label: 'Agent 2', role: 'producer' },
  { id: 'planner', kind: 'agent', label: 'Planner', role: 'planner' },
] }
const store = { agents: { 'Agent 2': { model: SONNET, effort: 'medium', files: [] }, Master: { model: OPUS, effort: null, files: [] } } }

test('planRouting: the type, size and suggestion for the flow, from its title and why, for its agent', () => {
  const flow = { id: 'f', title: 'Fix a typo on the sign-up page', why: '', agent: 'Agent 2' }
  const r = planRouting(flow, { rules: DEFAULT_RULES, graph, now: () => AT })
  assert.equal(r.type, 'wording')
  assert.equal(r.size, 'small')
  assert.equal(r.confidence, 'likely')
  assert.deepEqual(r.suggested, { agent: null, model: SONNET, effort: 'medium', rule: 1, why: 'small wording fixes rarely fail QA' })
  assert.equal(r.used, null)
  assert.equal(r.followed, null)
  assert.equal(r.at, AT)
  assert.deepEqual(validateRouting(r), [])
})

test('planRouting: the risk provider and a plan file count are used when given', () => {
  const flow = { id: 'f', title: 'Fix a typo', agent: 'Agent 2' }
  const risky = planRouting(flow, { rules: DEFAULT_RULES, graph, riskOf: () => 'high', now: () => AT })
  assert.equal(risky.risk, 'high')
  assert.equal(risky.suggested.model, OPUS)
  const big = planRouting(flow, { rules: DEFAULT_RULES, graph, files: 14, now: () => AT })
  assert.equal(big.size, 'large')
  assert.equal(planRouting(flow, { rules: DEFAULT_RULES, graph, riskOf: () => { throw new Error('boom') }, now: () => AT }).risk, null, 'a failing provider is no risk')
})

test('planRouting: a correction already on the flow is kept and wins', () => {
  const flow = { id: 'f', title: 'Fix a typo', agent: 'Agent 2', routing: { type: 'style', typeBy: 'you' } }
  const r = planRouting(flow, { rules: DEFAULT_RULES, graph, now: () => AT })
  assert.equal(r.type, 'style')
  assert.equal(r.typeBy, 'you')
  assert.equal(r.reason, 'Set by you.')
})

test('planRouting: an unsure type fits only a rule that names no type', () => {
  const flow = { id: 'f', title: 'Fix login', agent: 'Agent 2' }
  const r = planRouting(flow, { rules: DEFAULT_RULES, graph, now: () => AT })
  assert.equal(r.confidence, 'unsure')
  assert.equal(r.suggested, null)
  const any = planRouting(flow, { rules: [{ when: { size: 'small' }, model: SONNET, why: 'small' }], graph, now: () => AT })
  assert.equal(any.suggested.model, SONNET)
})

test('usedFrom: the agent settings at the time; a fixed role is Opus high; nothing saved is null', () => {
  assert.deepEqual(usedFrom('Agent 2', store, graph), { agent: 'Agent 2', model: SONNET, effort: 'medium' })
  assert.deepEqual(usedFrom('Planner', store, graph), { agent: 'Planner', model: OPUS, effort: 'high' })
  assert.deepEqual(usedFrom('Master', store, graph), { agent: 'Master', model: OPUS, effort: null })
  assert.deepEqual(usedFrom('Agent 9', store, graph), { agent: 'Agent 9', model: null, effort: null })
})

test('withUsed: followed is computed from what happened, against the suggestion', () => {
  const base = planRouting({ id: 'f', title: 'Fix a typo', agent: 'Agent 2' }, { rules: DEFAULT_RULES, graph, now: () => AT })
  const r = withUsed(base, usedFrom('Agent 2', store, graph), () => AT)
  assert.deepEqual(r.used, { agent: 'Agent 2', model: SONNET, effort: 'medium', at: AT })
  assert.equal(r.followed, true)
  assert.equal(withUsed(base, usedFrom('Master', store, graph), () => AT).followed, false)
  assert.equal(withUsed(base, usedFrom('Agent 9', store, graph), () => AT).followed, null)
  assert.deepEqual(validateRouting(r), [])
})

test('correctType: the user sets the type; the suggestion follows it; null takes the correction off', () => {
  const flow = { id: 'f', title: 'Fix a typo', agent: 'Agent 2' }
  flow.routing = planRouting(flow, { rules: DEFAULT_RULES, graph, now: () => AT })
  const r = correctType(flow, 'docs', { rules: DEFAULT_RULES, graph, now: () => AT })
  assert.equal(r.type, 'docs')
  assert.equal(r.typeBy, 'you')
  assert.equal(r.suggested.rule, 3)
  const back = correctType({ ...flow, routing: r }, null, { rules: DEFAULT_RULES, graph, now: () => AT })
  assert.equal(back.type, 'wording')
  assert.equal(back.typeBy, undefined)
  assert.throws(() => correctType(flow, 'poems', { rules: DEFAULT_RULES, graph }), /task type/)
})

test('correctType keeps what was used and works followed out again', () => {
  const flow = { id: 'f', title: 'Fix a typo', agent: 'Agent 2' }
  flow.routing = withUsed(planRouting(flow, { rules: DEFAULT_RULES, graph, now: () => AT }), usedFrom('Agent 2', store, graph), () => AT)
  const r = correctType(flow, 'feature', { rules: DEFAULT_RULES, graph, now: () => AT })
  assert.equal(r.suggested, null, 'no default rule fits a medium feature')
  assert.equal(r.followed, null)
  assert.deepEqual(r.used, flow.routing.used)
})

test('validateRouting: plain lines for a bad shape', () => {
  assert.deepEqual(validateRouting('x'), ['routing must be a JSON object'])
  const p = validateRouting({ type: 'poems', size: 'huge', confidence: 'maybe', suggested: 'x', used: 3, followed: 'yes', at: 'later', typeBy: 'them' })
  assert.equal(p.length, 8)
  assert.deepEqual(validateRouting({ type: null, size: 'small', suggested: null, used: null, followed: null }), [])
})

test('keepRouting: a rewrite never brings, changes or drops the routing block: only the stored one counts', () => {
  const stored = { routing: { type: 'docs', size: 'small', suggested: null, used: null, followed: null } }
  const incoming = { routing: { type: 'feature' } }
  keepRouting(incoming, stored)
  assert.deepEqual(incoming.routing, stored.routing)
  const none = { routing: { type: 'feature' } }
  keepRouting(none, {})
  assert.equal(none.routing, undefined)
  const kept = {}
  keepRouting(kept, stored)
  assert.deepEqual(kept.routing, stored.routing)
})
