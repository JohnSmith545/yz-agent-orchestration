// Tests for tools/routing-cli.mjs: `flow new` and the planner's `flow plan-start` and `flow plan` print the routing
// suggestion and store the flow's routing record (type, size, suggestion, what was used, followed); an agent's
// rewrite can never change that record; and a routing failure never fails the command. FACTORY_DATA_DIR points at a
// fresh temp folder BEFORE the imports.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-cli-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const { writeAgentSettings } = await import('../agent-settings.mjs')
const { setRoutingProviders } = await import('../routing-providers.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-cli-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const SONNET = 'claude-sonnet-5-5'
const CONFIG = {
  repo: 'C:/watched/repo',
  coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', 'Agent 2': 'Agent 2', Planner: 'Planner' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2, planner: 'Planner' },
  routing: { rules: [{ when: { type: 'wording', size: 'small' }, agent: 'Agent 2', model: SONNET, effort: 'medium', why: 'small wording fixes rarely fail QA' }] },
}
const run = (by, ...argv) => runFlow(argv, { by, cwd: TMP, config: CONFIG })

beforeEach(() => {
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
  fs.rmSync(F.EVIDENCE_DIR, { recursive: true, force: true })
  writeAgentSettings({ agents: { 'Agent 2': { model: SONNET, effort: 'medium', files: [] }, 'Agent 1': { model: 'claude-opus-5-5', effort: 'high', files: [] } } })
  setRoutingProviders({})
})

test('flow new notes the task type and the suggestion on stderr, and says it is not an order', () => {
  const r = run('Master', 'new', 'typo', 'Fix a typo on the sign-up page', '--type', 'build')
  assert.equal(r.code, 0)
  assert.match(r.out, /^Flow typo created/)
  assert.match(r.err, /Task type: wording \(likely\), small\./)
  assert.match(r.err, /Suggested: Agent 2, Sonnet 5\.5, medium effort, because small wording fixes rarely fail QA/)
  assert.match(r.err, /not an order/)
})

test('flow new stores the record: the suggestion, and what was used is the starting agent at its settings then', () => {
  run('Master', 'new', 'typo', 'Fix a typo on the sign-up page', '--type', 'build')
  const r = F.readFlow('typo').routing
  assert.equal(r.type, 'wording')
  assert.equal(r.size, 'small')
  assert.deepEqual(r.suggested, { agent: 'Agent 2', model: SONNET, effort: 'medium', rule: 0, why: 'small wording fixes rarely fail QA' })
  assert.equal(r.used.agent, 'Master')
  assert.equal(r.followed, false, 'Master is not Agent 2')
  assert.deepEqual(F.validateFlow(F.readFlow('typo')), [])
})

test('flow new with no rule that fits prints no note, and still creates the flow', () => {
  const r = run('Master', 'new', 'big', 'Add a new export feature', '--type', 'build')
  assert.equal(r.code, 0)
  assert.equal(r.err, undefined, 'nothing fits: no note at all')
  assert.equal(F.readFlow('big').routing.suggested, null)
})

test('the risk provider is read when there is one', () => {
  setRoutingProviders({ riskOf: () => 'high' })
  run('Master', 'new', 'risky', 'Fix a typo', '--type', 'build')
  assert.equal(F.readFlow('risky').routing.risk, 'high')
})

test('a refused flow new prints no routing and writes nothing', () => {
  const r = run('Master', 'new', 'x', 'Fix a typo')
  assert.equal(r.code, 1)
  assert.doesNotMatch(`${r.out}${r.err || ''}`, /Suggested/)
})

test('the planner sees the suggestion at plan-start; the hand-out records the producer as used, with followed', () => {
  run('Master', 'new', 'typo', 'Fix a typo on the sign-up page', '--type', 'build')
  const start = run('Planner', 'plan-start', 'typo')
  assert.equal(start.code, 0)
  assert.match(start.err, /Suggested: Agent 2, Sonnet 5\.5, medium effort/)
  fs.writeFileSync(path.join(TMP, 'plan.md'), '# Plan\n- change public/signup.js\n')
  const out = run('Planner', 'plan', 'typo', '--file', 'plan.md', '--to', 'Agent 2')
  assert.equal(out.code, 0, out.out)
  assert.match(out.err, /You followed the routing suggestion/)
  const r = F.readFlow('typo').routing
  assert.deepEqual({ agent: r.used.agent, model: r.used.model, effort: r.used.effort }, { agent: 'Agent 2', model: SONNET, effort: 'medium' })
  assert.equal(r.followed, true)
  assert.equal(r.size, 'small', 'from the plan: one file')
})

test('a hand-out to another producer is recorded as not followed, and says so plainly', () => {
  run('Master', 'new', 'typo', 'Fix a typo on the sign-up page', '--type', 'build')
  fs.writeFileSync(path.join(TMP, 'plan.md'), '# Plan\n- change public/signup.js\n')
  const out = run('Planner', 'plan', 'typo', '--file', 'plan.md', '--to', 'Agent 1')
  assert.equal(out.code, 0)
  assert.match(out.err, /differs from the routing suggestion/)
  assert.equal(F.readFlow('typo').routing.followed, false)
})

test('an agent rewrite can never bring, change or drop the routing record', () => {
  run('Master', 'new', 'typo', 'Fix a typo on the sign-up page', '--type', 'build')
  const stored = F.readFlow('typo')
  const file = path.join(TMP, 'f.json')
  fs.writeFileSync(file, JSON.stringify({ ...stored, routing: { type: 'feature', followed: true } }))
  assert.equal(run('Master', 'write', file).code, 0)
  assert.deepEqual(F.readFlow('typo').routing, stored.routing)
  const { routing, ...without } = stored
  fs.writeFileSync(file, JSON.stringify(without))
  assert.equal(run('Master', 'write', file).code, 0)
  assert.deepEqual(F.readFlow('typo').routing, stored.routing)
})

test('a bad routing record on a flow file is reported by validateFlow', () => {
  run('Master', 'new', 'typo', 'Fix a typo', '--type', 'build')
  const f = F.readFlow('typo')
  assert.match(F.validateFlow({ ...f, routing: { type: 'poems' } }).join('\n'), /routing type/)
})
