// Tests for tools/rules-cli.mjs: the rules the user set on the Agents page reach the agents. `flow rules` prints an
// agent's specification and rules; `flow new` prints its --by agent's after the usual line, and `flow qa-start`
// the QA label's, so every agent reads them at the start of every request. Nothing extra when there are none.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports; the config is our own.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-cli-test-'))
const F = await import('../flows.mjs')
const { RULES_FILE, writeRules } = await import('../agent-rules.mjs')
const { runFlow, USAGE } = await import('../tools/flow-cli.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))

const CONFIG = {
  repo: 'C:/watched/repo', coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', tester: 'QA' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev', 'stage', 'main', 'master'], maxReworks: 2 },
  pr: { remote: 'origin', bases: ['dev'], protect: ['main'] },
}
const AT = '2026-11-24T10:00:00.000Z'
const run = (by, ...argv) => runFlow(argv, { by, cwd: os.tmpdir(), config: CONFIG })
const AGENT_1 = [
  'Rules for Agent 1, set by the user on the dashboard. Follow them:',
  'Specification: Builds the web pages.',
  '1. Never touch the mobile app.',
  '2. Run the tests before you say done.',
].join('\n')

beforeEach(() => {
  fs.rmSync(RULES_FILE, { force: true })
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
})
const setRules = () => writeRules({ agents: {
  'Agent 1': { spec: 'Builds the web pages.', updatedAt: AT, rules: [
    { id: 'a', text: 'Never touch the mobile app.', addedAt: AT }, { id: 'b', text: 'Run the tests before you say done.', addedAt: AT },
  ] },
  QA: { spec: '', updatedAt: AT, rules: [{ id: 'q', text: 'Test on a phone width too.', addedAt: AT }] },
} })

test('flow rules prints that agent specification and rules', () => {
  setRules()
  assert.deepEqual(run('Agent 1', 'rules'), { out: AGENT_1, code: 0 })
})

test('flow rules with none set says so in one line', () => {
  assert.deepEqual(run('Agent 1', 'rules'), { out: 'No rules set for Agent 1.', code: 0 })
  setRules()
  assert.deepEqual(run('Master', 'rules'), { out: 'No rules set for Master.', code: 0 })
})

test('flow rules for a label no longer in the graph shows nothing, though the file keeps them', () => {
  writeRules({ agents: { Gone: { spec: 'Old.', rules: [], updatedAt: AT } } })
  assert.deepEqual(run('Gone', 'rules'), { out: 'No rules set for Gone.', code: 0 })
})

test('flow rules needs a name, like the other commands', () => {
  const r = run('', 'rules')
  assert.equal(r.code, 1)
  assert.match(r.out, /--by/)
})

test('flow new prints the --by agent rules after its usual line', () => {
  setRules()
  assert.deepEqual(run('Agent 1', 'new', 'fix-login', 'Fix the login', '--type', 'build'), { out: `Flow fix-login created\n${AGENT_1}`, code: 0 })
})

test('flow new prints nothing extra when that agent has no rules', () => {
  setRules()
  assert.deepEqual(run('Master', 'new', 'plan-it', 'Plan it', '--type', 'ask'), { out: 'Flow plan-it created', code: 0 })
})

test('a refused flow new prints no rules', () => {
  setRules()
  const r = run('Agent 1', 'new', 'no-type', 'No type')
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.out, /Rules for/)
})

test('flow qa-start prints the QA rules after its usual line; a refused one prints none', () => {
  setRules()
  run('Agent 1', 'new', 'to-test', 'To test', '--type', 'build')
  const r = run('QA', 'qa-start', 'to-test')
  assert.equal(r.code, 0)
  assert.equal(r.out, 'to-test: QA attempt 1 testing\nRules for QA, set by the user on the dashboard. Follow them:\n1. Test on a phone width too.')
  const refused = run('Agent 1', 'qa-start', 'to-test')
  assert.equal(refused.code, 1)
  assert.doesNotMatch(refused.out, /Rules for/)
})

test('the usage text names flow rules', () => {
  assert.match(USAGE, /\n {2}rules \[--by/)
})

test('from a shell, FACTORY_BY is honoured like the other commands', () => {
  setRules()
  const cli = path.join(HERE, '..', 'tools', 'factory.mjs')
  const r = spawnSync(process.execPath, [cli, 'flow', 'rules'], { encoding: 'utf8', env: { ...process.env, FACTORY_BY: 'Agent 1' } })
  // the real config may not name Agent 1 as an agent: either it prints the rules or says there are none, never fails
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^(Rules for Agent 1|No rules set for Agent 1\.)/)
})
