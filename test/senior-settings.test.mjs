// Tests for Senior as an agent of the dashboard: its model is fixed like the planner's and Security's (Opus 5.5 at
// high effort, agent-settings.mjs FIXED_ROLES), the agent window says so (agent-window-view.js), `flow senior-start`
// and `flow rules` print its fixed line with its rules (tools/rules-cli.mjs), and a saved style names it in plain
// words (style-words.mjs). FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-settings-test-'))
const HERE = path.dirname(fileURLToPath(import.meta.url))
const F = await import('../flows.mjs')
const S = await import('../agent-settings.mjs')
const W = await import('../style-words.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
const { applyHandTick } = await import('../hand-steps.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))

const CONFIG = {
  repo: 'C:/watched/repo', coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', Senior: 'Senior' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2, senior: 'Senior' },
}
const run = (by, ...argv) => runFlow(argv, { by, cwd: os.tmpdir(), config: CONFIG })

test('Senior always runs on Opus at high effort: a model change is refused, and its print says the model is fixed', () => {
  assert.ok(S.FIXED_ROLES.includes('senior'))
  assert.match(S.checkModel({ model: 'claude-sonnet-5-5' }, 'senior').error, /always runs on Opus at high effort/)
  assert.match(S.settingsBlock({ agents: {} }, 'Senior', 'senior'), /^Settings for Senior\. Your model is fixed by the dashboard, not chosen by the user:\nYou always run on Opus 5\.5/)
})

test('flow rules and senior-start print the fixed line; a refused senior-start prints nothing more', () => {
  assert.match(run('Senior', 'rules').out, /^Settings for Senior\. Your model is fixed/)
  assert.equal(run('Agent 1', 'new', 'keys', 'Rotate the deploy keys', '--type', 'ask').code, 0)
  assert.equal(run('Agent 1', 'hand-step', 'keys', 'Rotate the key', '--expect', 'A new key is listed').code, 0)
  assert.equal(run('Senior', 'senior-start', 'keys').out.includes('Settings'), false, 'not ticked yet: refused, nothing more')
  const flow = F.readFlow('keys')
  applyHandTick(flow, 'h1', true)
  F.writeFlow(flow)
  const r = run('Senior', 'senior-start', 'keys')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^keys: Senior is reviewing it\.\nSettings for Senior\. Your model is fixed/)
})

test('the agent window shows Senior with the fixed model and says why', () => {
  const ctx = vm.createContext({ window: {} })
  for (const f of ['shell.js', 'app.js', 'pipeline-tickets.js', 'pipeline-details.js', 'agent-window-view.js']) vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
  const html = ctx.window.AgentWindowView.modelHtml({ label: 'Senior', role: 'senior', entry: {} })
  assert.match(html, /<b>Opus 5\.5, high effort<\/b>/)
  assert.match(html, /The Senior agent always runs on Opus at high effort/)
  assert.doesNotMatch(html, /<select/)
})

test('a saved style names Senior in plain words', () => {
  const style = { parts: { agents: { ...CONFIG, chatName: 'Independent' }, rules: { agents: {} }, settings: { agents: {} } } }
  const v = W.styleView(style)
  const senior = v.agents.find(a => a.label === 'Senior')
  assert.equal(senior.roleWords, 'reviews work done by hand, such as CI and cloud settings')
  assert.equal(senior.fixed, true)
  assert.equal(senior.modelWords, 'Opus 5.5, high effort (fixed)')
  assert.match(W.routeWords(v.graph), /Senior reviews work done by hand before it reaches the Output/)
  assert.match(W.summaryOf(style), /Senior reviews by-hand work/)
})
