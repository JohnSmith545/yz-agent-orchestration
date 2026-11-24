// Tests for style-words.mjs: a saved orchestration style in plain words. The one-line summary, the route with every
// agent in it (the Planner and Security too), each agent's role, model and effort, and the list of exactly what
// differs from the style in use now (the Use confirmation). Pure: snapshots in, words out.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'style-words-test-'))
const W = await import('../style-words.mjs')

const agents = (extra = {}) => ({
  coordinator: 'Master', coordinatorLabel: 'Master', chatName: 'Independent',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', 'Agent 3': 'Agent 3' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev', 'stage', 'main', 'master'], maxReworks: 3, ...extra },
})
const style = ({ pipeline = {}, rules = {}, settings = {} } = {}) => ({
  parts: { agents: agents(pipeline), rules: { agents: rules }, settings: { agents: settings } },
})
const FULL = style({
  pipeline: { planner: 'Planner', security: 'Security' },
  rules: { 'Agent 1': { spec: 'Web.', rules: ['One.', 'Two.'] }, QA: { spec: '', rules: ['Three.'] } },
  settings: { 'Agent 2': { model: 'claude-haiku-5-5', effort: 'low' } },
})

test('the summary keeps its old shape without a planner or Security', () => {
  assert.equal(W.summaryOf(style({ rules: { 'Agent 1': { spec: '', rules: ['a', 'b'] } } })), 'Master hands to 3 agents, QA tests, 2 rules')
})

test('the summary names the Planner and Security when the style has them', () => {
  assert.equal(W.summaryOf(FULL), 'Master hands to 3 agents through Planner, QA tests, Security checks, 3 rules')
})

test('the route in words has every agent in it, in order', () => {
  assert.equal(W.routeWords(W.styleView(FULL).graph),
    'Master hands each request to Planner, who plans it and hands it to Agent 1, Agent 2 and Agent 3; QA tests every code change, then Security checks it for security problems before it is pushed; Independent answers questions in Ask.')
  assert.equal(W.routeWords(W.styleView(style()).graph),
    'Master hands each request to Agent 1, Agent 2 and Agent 3; QA tests every code change and pushes it; Independent answers questions in Ask.')
})

test('each agent in the view: plain role words, specification, rules, model and effort; the planner and Security fixed', () => {
  const v = W.styleView(FULL)
  const by = l => v.agents.find(a => a.label === l)
  assert.deepEqual(v.agents.map(a => a.label), ['Master', 'Planner', 'Agent 1', 'Agent 2', 'Agent 3', 'Independent', 'QA', 'Security'])
  assert.equal(by('Planner').roleWords, 'plans the work and hands it out')
  assert.equal(by('Security').roleWords, 'checks for security problems before the push')
  assert.equal(by('QA').roleWords, 'tests every code change')
  assert.equal(by('Planner').modelWords, 'Opus 5.5, high effort (fixed)')
  assert.equal(by('Security').modelWords, 'Opus 5.5, high effort (fixed)')
  assert.equal(by('Agent 2').modelWords, 'Haiku 5.5, low effort')
  assert.equal(by('Agent 1').modelWords, 'Model and effort not chosen')
  assert.deepEqual(by('Agent 1').rules, ['One.', 'Two.'])
  assert.equal(by('Agent 1').spec, 'Web.')
  assert.equal(v.summary, W.summaryOf(FULL))
  assert.equal(v.route, W.routeWords(v.graph))
  assert.equal(W.styleView(style()).agents.find(a => a.label === 'QA').roleWords, 'tests every code change, then pushes it')
})

test('model words for half-chosen settings', () => {
  assert.equal(W.modelWords({ model: 'claude-opus-5-5' }, 'producer'), 'Opus 5.5, effort not chosen')
  assert.equal(W.modelWords({ effort: 'medium' }, 'producer'), 'Model not chosen, medium effort')
  assert.equal(W.modelWords(null, 'qa'), 'Model and effort not chosen')
})

test('what differs: agents added and removed, rules by count per agent, specifications, models', () => {
  const now = style({
    rules: { 'Agent 1': { spec: 'Web.', rules: ['One.'] }, 'Agent 3': { spec: 'Mobile.', rules: ['Old.'] } },
    settings: { 'Agent 2': { model: 'claude-opus-5-5', effort: 'high' } },
  })
  const next = style({
    pipeline: { planner: 'Planner' },
    rules: { 'Agent 1': { spec: 'Web pages.', rules: ['One.', 'Two.', 'Three.'] }, 'Agent 3': { spec: 'Mobile.', rules: [] } },
    settings: { 'Agent 2': { model: 'claude-haiku-5-5', effort: 'low' } },
  })
  next.parts.agents.codingAgents = { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', 'Agent 3': 'Agent 3', 'Agent 4': 'Agent 4' }
  delete next.parts.agents.codingAgents['Agent 3']
  next.parts.agents.codingAgents['Agent 3'] = 'Agent 3'
  assert.deepEqual(W.styleChanges(now, next), [
    'Planner is added: plans the work and hands it out.',
    'Agent 4 is added: writes code.',
    'Agent 1: 2 rules added, and its specification changes.',
    'Agent 3: 1 rule removed.',
    'Agent 2 runs on Haiku 5.5 at low effort instead of Opus 5.5 at high effort.',
  ])
})

test('what differs: an agent removed, the rework limit and the protected branches', () => {
  const now = style({ pipeline: { security: 'Security' } })
  const next = style({ pipeline: { maxReworks: 1, protectedBranches: ['dev', 'main'] } })
  assert.deepEqual(W.styleChanges(now, next), [
    'Security is removed.',
    'A failed test goes back to its producer at most 1 time instead of 3.',
    'QA never pushes to dev and main (now: dev, stage, main and master).',
  ])
})

test('nothing differs: an empty list; a style saved before a part existed says nothing about that part', () => {
  assert.deepEqual(W.styleChanges(FULL, structuredClone(FULL)), [])
  const old = structuredClone(FULL)
  delete old.parts.settings
  delete old.parts.rules
  assert.deepEqual(W.styleChanges(FULL, old), [])
})
