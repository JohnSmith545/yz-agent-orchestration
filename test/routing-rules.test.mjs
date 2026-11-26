// Tests for routing-rules.mjs: the routing rules (defaults in code, the user's in config.json), which rule fits a
// task, the suggestion and its one line, the fixed roles never suggested down, and whether a suggestion was followed.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { DEFAULT_RULES, RULE_LIMITS, routingSettings, checkRules, matchRule, suggest, suggestionLine, followedOf } = await import('../routing-rules.mjs')

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const silent = () => {}

test('the defaults are valid rules and start with high risk', () => {
  assert.deepEqual(checkRules(DEFAULT_RULES), { rules: DEFAULT_RULES, problems: [] })
  assert.equal(DEFAULT_RULES[0].when.risk, 'high')
  assert.ok(DEFAULT_RULES.some(r => r.when.type === 'wording' && r.model === SONNET && r.effort === 'medium'))
})

test('settings: left out keeps the defaults with no warning; intakeModel off by default', () => {
  const warn = []
  const s = routingSettings(undefined, w => warn.push(w))
  assert.deepEqual(s.rules, DEFAULT_RULES)
  assert.equal(s.custom, false)
  assert.equal(s.intakeModel, null)
  assert.deepEqual(warn, [])
})

test('settings: good rules from config.json are used as given', () => {
  const rules = [{ when: { type: 'docs' }, agent: 'Agent 2', model: SONNET, effort: 'low', why: 'docs are easy' }]
  const s = routingSettings({ rules, intakeModel: 'claude-haiku-5-5' }, silent)
  assert.deepEqual(s.rules, rules)
  assert.equal(s.custom, true)
  assert.equal(s.intakeModel, 'claude-haiku-5-5')
})

test('settings: any bad rule keeps the defaults with ONE warning naming the first problem', () => {
  const warn = []
  const bad = [{ when: { type: 'docs' }, model: SONNET, why: 'fine' }, { when: { type: 'poetry' }, model: SONNET, why: 'x' }, { when: {}, why: '' }]
  const s = routingSettings({ rules: bad }, w => warn.push(w))
  assert.deepEqual(s.rules, DEFAULT_RULES)
  assert.equal(warn.length, 1)
  assert.match(warn[0], /routing\.rules/)
  assert.match(warn[0], /Rule 2/)
  assert.match(warn[0], /defaults/)
  assert.equal(s.warning, warn[0])
  for (const rules of ['nope', {}, [null], [{ when: 'x', why: 'y', model: SONNET }]]) {
    const w = []
    assert.deepEqual(routingSettings({ rules }, x => w.push(x)).rules, DEFAULT_RULES)
    assert.equal(w.length, 1)
  }
})

test('settings: a bad intakeModel is off with a warning', () => {
  const warn = []
  assert.equal(routingSettings({ intakeModel: 'gpt-9' }, w => warn.push(w)).intakeModel, null)
  assert.equal(warn.length, 1)
  assert.equal(routingSettings({ intakeModel: false }, silent).intakeModel, null)
})

test('checkRules: each problem in one plain line; limits on count and length', () => {
  const { problems } = checkRules([
    { when: { type: 'docs', colour: 'red' }, model: SONNET, why: 'x' },
    { when: { size: 'huge' }, model: SONNET, why: 'x' },
    { when: { risk: 'mild' }, model: SONNET, why: 'x' },
    { when: {}, model: 'gpt', why: 'x' },
    { when: {}, effort: 'max', why: 'x' },
    { when: {}, why: 'nothing to suggest' },
    { when: {}, model: SONNET, why: '' },
    { when: {}, model: SONNET, why: 'x'.repeat(RULE_LIMITS.why + 1) },
    { when: {}, agent: 'Bad "name"', why: 'x' },
  ])
  assert.equal(problems.length, 9)
  for (const p of problems) assert.match(p, /^Rule \d+: /)
  assert.match(checkRules(Array.from({ length: RULE_LIMITS.rules + 1 }, () => ({ when: {}, model: SONNET, why: 'x' }))).problems[0], /at most/)
  assert.deepEqual(checkRules([{ when: { type: ['wording', 'style'] }, model: SONNET, why: 'x' }]).problems, [], 'a list of types is allowed')
})

test('matchRule: the FIRST rule that fits wins; an absent key matches anything; a rule naming risk needs a known risk', () => {
  const rules = [
    { when: { risk: 'high' }, model: OPUS, why: 'risky' },
    { when: { type: 'wording', size: 'small' }, model: SONNET, why: 'small words' },
    { when: { type: ['wording', 'style'] }, model: SONNET, effort: 'high', why: 'words or looks' },
    { when: {}, model: OPUS, why: 'everything else' },
  ]
  assert.equal(matchRule(rules, { type: 'wording', size: 'small', risk: 'high' }).index, 0)
  assert.equal(matchRule(rules, { type: 'wording', size: 'small' }).index, 1, 'no risk known: the risk rule does not fit')
  assert.equal(matchRule(rules, { type: 'wording', size: 'large' }).index, 2)
  assert.equal(matchRule(rules, { type: 'style', size: 'small' }).index, 2)
  assert.equal(matchRule(rules, { type: null, size: 'small' }).index, 3, 'an unsure type only fits a rule naming no type')
  assert.equal(matchRule([], { type: 'wording' }), null)
})

test('suggest: the rule fills the suggestion; nothing fits is null', () => {
  const s = suggest({ type: 'wording', size: 'small' }, DEFAULT_RULES, { agent: 'Agent 2', role: 'producer' })
  assert.equal(s.model, SONNET)
  assert.equal(s.effort, 'medium')
  assert.equal(s.agent, null, 'the default rules name no agent')
  assert.equal(typeof s.rule, 'number')
  assert.equal(suggest({ type: 'investigation', size: 'medium' }, [{ when: { type: 'docs' }, model: SONNET, why: 'x' }], {}), null)
})

test('the fixed roles are never suggested down: Planner, Security and Senior stay on Opus at high effort', () => {
  const rules = [{ when: {}, model: 'claude-haiku-5-5', effort: 'low', why: 'cheap' }]
  for (const role of ['planner', 'security', 'senior']) {
    const s = suggest({ type: 'docs', size: 'small' }, rules, { agent: 'X', role })
    assert.equal(s.model, OPUS)
    assert.equal(s.effort, 'high')
    assert.equal(s.fixed, true)
  }
  const named = suggest({ type: 'docs' }, [{ when: {}, agent: 'Security', model: SONNET, effort: 'low', why: 'x' }], { roleOf: label => (label === 'Security' ? 'security' : 'producer') })
  assert.equal(named.model, OPUS, 'a rule naming a fixed-role agent is lifted to Opus high too')
  assert.equal(named.effort, 'high')
})

test('suggestionLine: the agent, the model name, the effort and the why', () => {
  assert.equal(suggestionLine({ agent: 'Agent 2', model: SONNET, effort: 'medium', why: 'small wording fixes rarely fail QA' }),
    'Suggested: Agent 2, Sonnet 5.5, medium effort, because small wording fixes rarely fail QA')
  assert.equal(suggestionLine({ agent: null, model: null, effort: 'low', why: 'docs are easy' }), 'Suggested: low effort, because docs are easy')
  assert.equal(suggestionLine({ agent: 'Planner', model: OPUS, effort: 'high', why: 'x', fixed: true }), 'Suggested: Planner, Opus 5.5, high effort, because this role always runs on Opus at high effort')
  assert.equal(suggestionLine(null), 'No routing rule fits this task: use your usual choice.')
})

test('followedOf: every part the suggestion named must match what was used; unknown is null', () => {
  const s = { agent: 'Agent 2', model: SONNET, effort: 'medium' }
  assert.equal(followedOf(s, { agent: 'Agent 2', model: SONNET, effort: 'medium' }), true)
  assert.equal(followedOf(s, { agent: 'Agent 1', model: SONNET, effort: 'medium' }), false)
  assert.equal(followedOf(s, { agent: 'Agent 2', model: OPUS, effort: 'medium' }), false)
  assert.equal(followedOf({ agent: null, model: SONNET, effort: null }, { agent: 'Agent 9', model: SONNET, effort: 'high' }), true, 'only what it named counts')
  assert.equal(followedOf(s, { agent: 'Agent 2', model: null, effort: 'medium' }), null, 'a model not known: cannot tell')
  assert.equal(followedOf(s, { agent: 'Agent 1', model: null, effort: 'medium' }), false, 'a known mismatch is still a no')
  assert.equal(followedOf(null, { agent: 'Agent 2' }), null, 'nothing was suggested')
  assert.equal(followedOf(s, null), null)
})
