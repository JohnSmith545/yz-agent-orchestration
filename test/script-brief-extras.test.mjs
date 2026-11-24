// Tests for script-brief-extras.mjs: the two extra sections SCRIPT's orchestration brief carries, built from the
// agents' saved rules (agent-rules.mjs rulesText) and the pipeline scorecard (score.mjs scoreText). Everything is
// passed in, so no file is read.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pipelineGraph } from '../pipeline.mjs'
import { orchestrationBrief } from '../script-brief.mjs'
import { briefExtras } from '../script-brief-extras.mjs'

const CONFIG = { coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { a: 'Master', b: 'Agent 1' }, pipeline: { qa: 'QA' } }
const graph = pipelineGraph(CONFIG)
const NOW = Date.parse('2026-11-24T12:00:00Z')
const RULES = { agents: { 'Agent 1': { spec: 'Builds the web pages.', rules: [{ id: 'r1', text: 'Never touch the mobile app.', addedAt: '2026-11-24T10:00:00Z' }], updatedAt: '2026-11-24T10:00:00Z' } } }
const passed = { id: 'f1', title: 'One', agent: 'Agent 1', status: 'done', updatedAt: '2026-11-24T11:00:00Z', nodes: [], qa: { status: 'passed', attempt: 1, at: '2026-11-24T11:00:00Z', startedAt: '2026-11-24T10:30:00Z' } }

test('with rules saved and flows scored, both sections are there, rules first', () => {
  const extras = briefExtras({ graph, rules: RULES, flows: [passed], now: NOW })
  assert.deepEqual(extras.map(x => x.title), ['What the user told each agent', 'How the pipeline scores'])
  assert.match(extras[0].text, /Agent 1/)
  assert.match(extras[0].text, /Never touch the mobile app\./)
  assert.match(extras[1].text, /Precision 100% \(1 of 1\)/)
})

test('no rules saved: the rules section is left out, never an empty heading', () => {
  const extras = briefExtras({ graph, rules: { agents: {} }, flows: [passed], now: NOW })
  assert.deepEqual(extras.map(x => x.title), ['How the pipeline scores'])
})

test('nothing scored yet: the score section is left out', () => {
  const extras = briefExtras({ graph, rules: RULES, flows: [], now: NOW })
  assert.deepEqual(extras.map(x => x.title), ['What the user told each agent'])
  assert.deepEqual(briefExtras({ graph, rules: { agents: {} }, flows: [], now: NOW }), [])
})

test('a store or flow list that cannot be read gives no section and never throws', () => {
  assert.deepEqual(briefExtras({ graph, rules: null, flows: null, now: NOW }), [])
})

test('the brief carries the extras as its last sections', () => {
  const text = orchestrationBrief({ config: CONFIG, graph, extras: briefExtras({ graph, rules: RULES, flows: [passed], now: NOW }) })
  assert.match(text, /### What the user told each agent\n[\s\S]*Never touch the mobile app\.[\s\S]*### How the pipeline scores\n/)
})
