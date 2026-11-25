// Tests for learn-proposals.mjs: the Learn run's answer, parsed and CHECKED by the server. At most 3 proposals; each
// names a target (an agent of the graph, or settings), the exact rule text, and evidence that names a flow of the pack;
// one that names none is dropped, and so is a rule the agent already has, a change to a rule it does not have, and an
// idea the user rejected before. "Nothing worth changing" is a valid answer.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROPOSALS_MAX, parseProposals } from '../learn-proposals.mjs'

const CTX = {
  labels: ['Master', 'Agent 1', 'QA'],
  flowIds: new Set(['agent-rules', 'dark-mode']),
  rules: { 'Agent 1': ['Write the failing test first.'], QA: [] },
  rejected: [{ target: 'QA', rule: 'Ask before every push.' }],
}
const one = (over = {}) => ({ target: 'Agent 1', action: 'add', rule: 'Test every limit before handing to QA.', flows: ['agent-rules'], evidence: 'agent-rules failed QA once on a cut limit.', effect: 'Fewer QA failures.', check: 'QA failures per flow go down.', ...over })
const answer = (proposals, extra = {}) => JSON.stringify({ proposals, ...extra })

test('a good answer: each proposal with its target, action, rule, flows, evidence, effect and check, numbered', () => {
  const r = parseProposals(answer([one(), one({ target: 'settings', action: 'change', rule: 'Set outputs.max to 5.', flows: ['dark-mode'] })]), CTX)
  assert.equal(r.proposals.length, 2)
  assert.deepEqual(r.proposals[0], { n: 1, target: 'Agent 1', action: 'add', rule: 'Test every limit before handing to QA.', old: '', flows: ['agent-rules'], evidence: 'agent-rules failed QA once on a cut limit.', effect: 'Fewer QA failures.', check: 'QA failures per flow go down.', state: 'open' })
  assert.equal(r.proposals[1].target, 'settings')
  assert.deepEqual(r.dropped, [])
  assert.equal(r.nothing, null)
})

test('the answer may come in a code fence or after a line of text', () => {
  assert.equal(parseProposals('Here:\n```json\n' + answer([one()]) + '\n```', CTX).proposals.length, 1)
})

test('malformed: no JSON object at all is an error, not an empty list', () => {
  assert.deepEqual(parseProposals('I think Agent 1 should test more.', CTX), { error: 'The Learn run did not answer in the agreed format, so nothing was proposed.' })
  assert.deepEqual(parseProposals('{"proposals": "many"}', CTX), { error: 'The Learn run did not answer in the agreed format, so nothing was proposed.' })
})

test('nothing worth changing is a valid answer, with its reason', () => {
  const r = parseProposals(JSON.stringify({ proposals: [], nothing: 'Every flow passed QA first time.' }), CTX)
  assert.deepEqual(r, { proposals: [], dropped: [], nothing: 'Every flow passed QA first time.' })
  assert.equal(parseProposals(JSON.stringify({ proposals: [] }), CTX).nothing, 'The run found nothing worth changing.')
})

test('more than 3: the first 3 are kept and the rest dropped, each with why', () => {
  const r = parseProposals(answer([1, 2, 3, 4, 5].map(i => one({ rule: `Rule ${i}.` }))), CTX)
  assert.equal(PROPOSALS_MAX, 3)
  assert.deepEqual(r.proposals.map(p => p.rule), ['Rule 1.', 'Rule 2.', 'Rule 3.'])
  assert.equal(r.dropped.length, 2)
  assert.match(r.dropped[0].why, /more than 3/)
})

test('no evidence from the pack: a proposal naming no flow, or only flows the pack does not have, is dropped', () => {
  const r = parseProposals(answer([one({ flows: [] }), one({ flows: ['made-up'] }), one({ flows: ['made-up', 'dark-mode'], rule: 'Kept.' })]), CTX)
  assert.deepEqual(r.proposals.map(p => p.rule), ['Kept.'])
  assert.deepEqual(r.proposals[0].flows, ['dark-mode']) // only the real one stays
  assert.equal(r.dropped.length, 2)
  assert.ok(r.dropped.every(d => /names no flow from the evidence/.test(d.why)))
})

test('the target must be an agent of the graph or settings; the case of a label is forgiven', () => {
  const r = parseProposals(answer([one({ target: 'agent 1', rule: 'A.' }), one({ target: 'Agent 9', rule: 'B.' })]), CTX)
  assert.deepEqual(r.proposals.map(p => p.target), ['Agent 1'])
  assert.match(r.dropped[0].why, /Agent 9 is not an agent/)
})

test('rule text: 1 to 300 characters; add needs a rule the agent lacks; change and remove need a rule it has', () => {
  const r = parseProposals(answer([
    one({ rule: 'x'.repeat(301) }),
    one({ rule: 'Write the failing test first.' }),
    one({ action: 'change', old: 'Something it never had.', rule: 'New.' }),
    one({ action: 'remove', old: 'Write the failing test first.', rule: '' }),
    one({ action: 'teleport' }),
  ]), CTX)
  assert.deepEqual(r.proposals.map(p => [p.action, p.old]), [['remove', 'Write the failing test first.']])
  assert.equal(r.proposals.length, 1)
  assert.equal(r.dropped.length, 4) // every one that fails a check, each with why
})

test('an idea the user rejected before is dropped, even reworded in case and spaces', () => {
  const r = parseProposals(answer([one({ target: 'QA', rule: 'ask  before every PUSH.' })]), CTX)
  assert.equal(r.proposals.length, 0)
  assert.match(r.dropped[0].why, /rejected before/)
})

test('agent-written text is cut, never trusted to be short', () => {
  const r = parseProposals(answer([one({ evidence: 'e'.repeat(5000), effect: 'f'.repeat(5000), check: 'c'.repeat(5000) })]), CTX)
  assert.ok(r.proposals[0].evidence.length <= 600)
  assert.ok(r.proposals[0].effect.length <= 300)
  assert.ok(r.proposals[0].check.length <= 300)
})
