// Tests that what the user saved in an agent's window (agent-settings.mjs) is PRINTED to that agent wherever its
// rules are printed (tools/rules-cli.mjs): `flow rules`, `flow new`, `flow qa-start`, `flow security-start` and
// `flow plan-start`; after the rules, the wanted model in one sentence and each switched-on file under its title.
// The planner and Security always get their fixed Opus line. FACTORY_DATA_DIR points at a fresh temp folder BEFORE
// the imports; the config is our own.

import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-settings-cli-test-'))
const F = await import('../flows.mjs')
const { RULES_FILE, writeRules } = await import('../agent-rules.mjs')
const S = await import('../agent-settings.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))

const CONFIG = {
  repo: 'C:/watched/repo', coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', tester: 'QA', Planner: 'Planner', Security: 'Security' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2, planner: 'Planner', security: 'Security' },
}
const AT = '2026-11-24T10:00:00.000Z'
const run = (by, ...argv) => runFlow(argv, { by, cwd: os.tmpdir(), config: CONFIG })
const OPUS = 'You always run on Opus 5.5 (claude-opus-5-5) at high effort, and so do the subagents you start.'

beforeEach(() => {
  fs.rmSync(RULES_FILE, { force: true })
  fs.rmSync(S.SETTINGS_FILE, { force: true })
  fs.rmSync(F.FLOWS_DIR, { recursive: true, force: true })
})
function saveSettings() {
  let store = S.applyModel({ agents: {} }, 'Agent 1', { model: 'claude-haiku-5-5', effort: 'low' }, { now: () => AT }).store
  store = S.addFile(store, 'Agent 1', { title: 'House style', text: 'Short sentences.', kind: 'note' }, { now: () => AT }).store
  S.writeAgentSettings(store)
}

test('flow rules prints the settings after the rules, and the settings alone when there are no rules', () => {
  saveSettings()
  const alone = run('Agent 1', 'rules')
  assert.equal(alone.code, 0)
  assert.equal(alone.out, [
    'Settings for Agent 1, set by the user on the dashboard:',
    'The user wants you on Haiku 5.5 (claude-haiku-5-5) at low effort: start your subagents on that model; the user switches this session in the editor.',
    '',
    'Note: House style',
    'Short sentences.',
  ].join('\n'))
  writeRules({ agents: { 'Agent 1': { spec: '', rules: [{ id: 'r1', text: 'Never touch mobile.', addedAt: AT }], updatedAt: AT } } })
  const both = run('Agent 1', 'rules').out
  assert.match(both, /^Rules for Agent 1, set by the user on the dashboard\. Follow them:\n1\. Never touch mobile\.\n\nSettings for Agent 1/)
})

test('flow new prints its agent settings after its line; nothing extra with nothing saved', () => {
  assert.equal(run('Agent 1', 'new', 'a', 'A thing', '--type', 'ask').out, 'Flow a created')
  saveSettings()
  assert.match(run('Agent 1', 'new', 'b', 'B thing', '--type', 'ask').out, /^Flow b created\nSettings for Agent 1/)
})

test('the planner and Security get their fixed Opus line from plan-start, security-start and flow rules', () => {
  assert.match(run('Security', 'rules').out, new RegExp(`^Settings for Security\\. Your model is fixed by the dashboard, not chosen by the user:\\n${OPUS.replace(/[.()]/g, '\\$&')}`))
  assert.match(run('Planner', 'rules').out, /^Settings for Planner/)
  run('Master', 'new', 'c', 'C thing', '--type', 'build')
  const start = run('Planner', 'plan-start', 'c')
  assert.equal(start.code, 0, start.out)
  assert.match(start.out, /Planner is planning it\.[^\n]*\nSettings for Planner\. Your model is fixed by the dashboard, not chosen by the user:\nYou always run on Opus 5\.5/)
  // QA passes it, then Security starts and is told its fixed model
  const flow = F.readFlow('c')
  F.writeFlow({ ...flow, nodes: [{ id: 'n1', type: 'step', title: 'x', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }], qa: { status: 'passed', attempt: 1, by: 'QA', at: AT, commit: 'abc1234' } })
  const sec = run('Security', 'security-start', 'c')
  assert.equal(sec.code, 0, sec.out)
  assert.match(sec.out, /Security is reviewing QA attempt 1 at abc1234\.\nSettings for Security/)
  assert.equal(run('Agent 1', 'security-start', 'c').out.includes('Settings'), false, 'a refusal prints nothing more')
})

test('qa-start prints QA settings too', () => {
  S.writeAgentSettings(S.applyModel({ agents: {} }, 'QA', { model: 'claude-sonnet-5-5' }, { now: () => AT }).store)
  run('Master', 'new', 'd', 'D thing', '--type', 'build')
  assert.match(run('QA', 'qa-start', 'd').out, /attempt 1 testing\nSettings for QA, set by the user on the dashboard:\nThe user wants you on Sonnet 5\.5/)
})
