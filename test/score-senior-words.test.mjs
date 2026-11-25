// Tests for the scorecard words once Senior is on the pipeline (QA B-3): the Missed list says who stopped a flow (QA,
// Security or Senior), and the help for Right caught, Wrong missed, Correctness and the By agent table names Senior
// where its verdicts count, only when Senior is configured (and Security only when it is). score.mjs says which agents
// are on the graph (gates) and who stopped each missed flow (stoppedBy); public/score-view.js runs in a vm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

import { DEFAULT_PIPELINE, pipelineGraph } from '../pipeline.mjs'
import { scoreOf } from '../score.mjs'

const ctx = vm.createContext({ window: {} })
for (const f of ['shell.js', 'app.js', 'score-view.js']) vm.runInContext(fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'), ctx)
const V = ctx.window.ScoreView
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

const agents = { coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', Senior: 'Senior', Security: 'Security' } }
const SENIOR = pipelineGraph({ ...agents, pipeline: { ...DEFAULT_PIPELINE, senior: 'Senior' } })
const BOTH = pipelineGraph({ ...agents, pipeline: { ...DEFAULT_PIPELINE, senior: 'Senior', security: 'Security' } })
const PLAIN = pipelineGraph({ ...agents, pipeline: { ...DEFAULT_PIPELINE } })
const NOW = Date.parse('2026-11-25T12:00:00Z')
const ago = ms => new Date(NOW - ms).toISOString()
const code = [{ id: 'n1', type: 'step', title: 'x', status: 'done', evidence: [{ kind: 'commit', ref: 'abc1234' }] }]
const flow = (id, more) => ({ id, title: `Flow ${id}`, agent: 'Agent 1', status: 'blocked', createdAt: ago(86_400_000), updatedAt: ago(3_600_000), nodes: [], ...more })
const bySenior = flow('s', { hand: { steps: [{ id: 'h1', do: 'x', expect: 'y', done: null }] }, senior: { status: 'senior-failed', by: 'Senior', at: ago(5000), summary: 'no' } })
const byQa = flow('q', { nodes: code, qa: { status: 'qa-failed', attempt: 4, by: 'QA', at: ago(4000) } })
const bySecurity = flow('c', { nodes: code, qa: { status: 'passed', attempt: 1, by: 'QA', at: ago(6000), commit: 'abc1234', security: { status: 'security-failed', by: 'Security', at: ago(3000), commit: 'abc1234' } } })

test('scoreOf says which agents are on the graph, and who stopped each missed flow', () => {
  assert.deepEqual(scoreOf([], SENIOR, { now: NOW }).gates, { security: false, senior: true })
  assert.deepEqual(scoreOf([], PLAIN, { now: NOW }).gates, { security: false, senior: false })
  const s = scoreOf([bySenior, byQa, bySecurity], BOTH, { now: NOW, days: 30 })
  const who = Object.fromEntries(s.lists.missed.map(m => [m.id, m.stoppedBy]))
  assert.deepEqual(who, { s: 'senior', q: 'qa', c: 'security' })
})

test('the Missed list says Stopped by Senior, by Security or at QA', () => {
  const s = scoreOf([bySenior, byQa, bySecurity], BOTH, { now: NOW, days: 30 })
  const h = text(V.howHtml(s))
  for (const words of ['Flow s Stopped by Senior', 'Flow q Stopped at QA', 'Flow c Stopped by Security']) assert.ok(h.includes(words), words)
})

test('the help names Senior where its verdicts count, only when it is on the pipeline', () => {
  const withSenior = text(V.howHtml(scoreOf([bySenior], SENIOR, { now: NOW, days: 30 })))
  assert.match(withSenior, /Each time QA or Senior failed the work and held it back\./)
  assert.match(withSenior, /Dropped, stopped at QA or Senior, or no update for 7 days\./)
  assert.match(withSenior, /Sent back: times QA or Senior failed its work\./)
  assert.match(withSenior, /flows passed \(by QA, or by Senior for work done by hand\) with no failure on the way/)
  const both = text(V.howHtml(scoreOf([], BOTH, { now: NOW })))
  assert.match(both, /Each time QA, Security or Senior failed the work and held it back\./)
  const plain = text(V.howHtml(scoreOf([], PLAIN, { now: NOW })))
  assert.doesNotMatch(plain, /Senior|Security/, 'neither on the pipeline: QA alone')
  assert.match(plain, /Each time QA failed the work and held it back\./)
})
