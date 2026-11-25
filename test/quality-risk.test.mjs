// Tests for the risk label (quality-risk.mjs): pure rules, no model. Each default rule fires on its words, its
// ticket labels or its paths; the highest level wins and every reason is listed; config.json quality.riskRules
// replaces the defaults, and a bad entry keeps the defaults with ONE warning; riskRoute puts Security or Senior on
// the planned route when the label asks for them and that agent is on the pipeline, and names them when it is not.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_RISK_RULES, LEVELS, riskOf, riskRoute, riskRules, riskText } from '../quality-risk.mjs'
import { pipelineGraph } from '../pipeline.mjs'

const flow = (title, extra = {}) => ({ id: 'f', title, agent: 'Agent 1', status: 'open', nodes: [], ...extra })

test('a plain task is low risk, with no reasons and nothing it needs', () => {
  assert.deepEqual(riskOf(flow('Make the card titles wrap')), { level: 'low', reasons: [], needs: [] })
})

test('every default rule fires on its words', () => {
  const cases = [
    ['Fix the sign-in page timeout', 'sign-in'],
    ['Keep the user session after a reload', 'sign-in'],
    ['Add Stripe payments to premium', 'payments'],
    ['Move the API key into the secrets store', 'secrets'],
    ['Change the GitHub Actions workflow for deploys', 'infra'],
    ['Add a migration for the clubs table schema', 'database'],
    ['Purge deleted accounts after 30 days', 'deleting'],
    ['Make the public profile page show the badge', 'public'],
  ]
  for (const [title, id] of cases) {
    const r = riskOf(flow(title))
    const rule = DEFAULT_RISK_RULES.find(x => x.id === id)
    assert.ok(rule, `a default rule ${id}`)
    assert.ok(r.reasons.includes(rule.why), `${title} -> ${id}: ${JSON.stringify(r)}`)
    assert.equal(r.level, rule.level, title)
  }
})

test('a word only counts whole: auth in author does not fire, nor a bare session (a Claude Code session here)', () => {
  assert.equal(riskOf(flow('Show the author of each post')).level, 'low')
  assert.equal(riskOf(flow('Open the Standup Creator session from the page')).level, 'low')
  assert.equal(riskOf(flow('Paint the dropdown')).level, 'low', 'drop alone is not a deletion')
})

test('the request text, node titles and the plan are read, not only the title', () => {
  assert.equal(riskOf(flow('Tidy up', { why: 'the login page loses the session' })).level, 'high')
  assert.equal(riskOf(flow('Tidy up', { nodes: [{ id: 'n1', type: 'step', title: 'Write the SQL migration', status: 'todo' }] })).level, 'high')
  assert.equal(riskOf(flow('Tidy up'), { planText: '1. Change the terraform module' }).level, 'high')
})

test('ticket labels count: a label naming payments fires the payments rule', () => {
  const r = riskOf(flow('Tidy up'), { labels: ['Billing & Payments'] })
  assert.equal(r.level, 'high')
  assert.ok(r.reasons.some(x => /payment/i.test(x)))
})

test('files the change touched count, once there is a change', () => {
  assert.equal(riskOf(flow('Tidy up'), { files: ['db/091_clubs.sql'] }).level, 'high')
  assert.equal(riskOf(flow('Tidy up'), { files: ['infra/terraform/main.tf'] }).level, 'high')
  assert.equal(riskOf(flow('Tidy up'), { files: ['.github/workflows/ci.yml'] }).level, 'high')
  assert.equal(riskOf(flow('Tidy up'), { files: ['apps/api/src/auth/session.ts'] }).level, 'high')
  assert.equal(riskOf(flow('Tidy up'), { files: ['public/flows.js', 'README.md'] }).level, 'low')
})

test('the highest level wins, and every reason and need is listed once', () => {
  const r = riskOf(flow('Purge old sessions and drop the login table'))
  assert.equal(r.level, 'high')
  assert.ok(r.reasons.length >= 2)
  assert.equal(new Set(r.reasons).size, r.reasons.length)
  assert.equal(new Set(r.needs).size, r.needs.length)
  assert.ok(r.needs.includes('security'))
  assert.ok(r.needs.includes('deep-qa'))
  assert.deepEqual(LEVELS, ['low', 'medium', 'high'])
})

test('riskRules: left out are the defaults; a good list replaces them', () => {
  const warns = []
  assert.equal(riskRules(undefined, m => warns.push(m)), DEFAULT_RISK_RULES)
  const mine = riskRules([{ match: { words: ['clubs'] }, level: 'medium', needs: ['senior'], why: 'It touches clubs.' }], m => warns.push(m))
  assert.equal(mine.length, 1)
  assert.deepEqual(warns, [])
  const r = riskOf(flow('Rename the clubs tab'), { rules: mine })
  assert.deepEqual(r, { level: 'medium', reasons: ['It touches clubs.'], needs: ['senior'] })
  assert.equal(riskOf(flow('Fix the login'), { rules: mine }).level, 'low', 'the defaults are replaced, not added to')
})

test('riskRules: any bad entry keeps the defaults, with one warning', () => {
  const bad = [
    'not a list',
    [{ match: {}, level: 'high', needs: [], why: 'empty match' }],
    [{ match: { words: ['x'] }, level: 'severe', needs: [], why: 'bad level' }],
    [{ match: { words: ['x'] }, level: 'high', needs: ['lawyer'], why: 'bad need' }],
    [{ match: { words: ['x'] }, level: 'high', needs: [] }],
    [{ match: { words: [''] }, level: 'high', needs: [], why: 'empty word' }],
    [{ match: { words: ['x'] }, level: 'low', needs: [], why: 'fine' }, null],
  ]
  for (const raw of bad) {
    const warns = []
    assert.equal(riskRules(raw, m => warns.push(m)), DEFAULT_RISK_RULES, JSON.stringify(raw))
    assert.equal(warns.length, 1, JSON.stringify(raw))
    assert.match(warns[0], /quality\.riskRules/)
  }
})

const CONFIG = {
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 3 },
}
const withGates = { ...CONFIG, pipeline: { ...CONFIG.pipeline, security: 'Security', senior: 'Senior' } }

test('riskRoute: Security goes before Push on a build route that lacks it, when Security is on the pipeline', () => {
  const graph = pipelineGraph(withGates)
  const r = riskRoute({ type: 'build', steps: ['request', 'master', 'agent-1', 'qa', 'push', 'outcome'] }, { level: 'high', reasons: ['x'], needs: ['security'] }, graph)
  assert.deepEqual(r.steps, ['request', 'master', 'agent-1', 'qa', 'security', 'push', 'outcome'])
  assert.deepEqual(r.missing, [])
  assert.equal(r.changed, true)
})

test('riskRoute: Senior goes before the Output on an ask route, after Human task', () => {
  const graph = pipelineGraph(withGates)
  const r = riskRoute({ type: 'ask', steps: ['request', 'master', 'outcome'] }, { level: 'high', reasons: ['x'], needs: ['senior'] }, graph)
  assert.deepEqual(r.steps, ['request', 'master', 'human', 'senior', 'outcome'])
})

test('riskRoute: a route that has them already is unchanged; a gate not configured is named as missing', () => {
  const graph = pipelineGraph(withGates)
  const steps = ['request', 'master', 'agent-1', 'qa', 'security', 'push', 'outcome']
  assert.deepEqual(riskRoute({ type: 'build', steps }, { level: 'high', reasons: [], needs: ['security', 'deep-qa'] }, graph), { steps, missing: [], unmet: [], changed: false })
  const bare = riskRoute({ type: 'build', steps: ['request', 'master', 'qa', 'push', 'outcome'] }, { level: 'high', reasons: [], needs: ['security', 'senior'] }, pipelineGraph(CONFIG))
  assert.deepEqual(bare.missing, ['security', 'senior'])
  assert.equal(bare.changed, false)
})

test('riskRoute: a gate on the pipeline that this kind of route never passes is unmet, not missing', () => {
  const graph = pipelineGraph(withGates)
  const build = riskRoute({ type: 'build', steps: ['request', 'master', 'qa', 'security', 'push', 'outcome'] }, { level: 'high', reasons: [], needs: ['security', 'senior'] }, graph)
  assert.deepEqual([build.missing, build.unmet, build.changed], [[], ['senior'], false], 'Senior reviews work done by hand, never a code change')
  const ask = riskRoute({ type: 'ask', steps: ['request', 'master', 'human', 'senior', 'outcome'] }, { level: 'high', reasons: [], needs: ['security', 'senior'] }, graph)
  assert.deepEqual([ask.missing, ask.unmet], [[], ['security']], 'Security reviews code changes only')
})

test('riskText: one plain line for an agent or QA', () => {
  assert.equal(riskText({ level: 'low', reasons: [], needs: [] }), 'Risk: low.')
  assert.equal(riskText({ level: 'high', reasons: ['It touches sign-in or sessions.'], needs: ['security', 'deep-qa'] }),
    'Risk: high. It touches sign-in or sessions. It asks for a Security review and a deeper QA pass.')
})
