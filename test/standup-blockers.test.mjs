// Tests for standup-blockers.mjs: the Human review items written as blockers the team can read, before the model
// sees them (QA A-F1, 2026-11-25: a Daily said "Master must read the Cloud Armor plan" and "steps still to be asked
// of the agent"). No agent label from the config, no dashboard word, one line per ticket, and an item that only
// says the steps are not written yet is no blocker at all. Plus the prompt rules for blockers and merged pull
// requests (QA A-F2: a loose "Merged to dev in PR #1226." read as if the ticket above it had merged).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { blockerLines, neutral } from '../standup-blockers.mjs'
import { systemPrompt } from '../standup-prompt.mjs'
import { factsText } from '../standup-text.mjs'
import { standupWindow } from '../standup-window.mjs'

const AGENTS = ['Master', 'Agent 1', 'QA', 'Senior', 'Planner', 'Independent', 'flinki-v2-a9']
const NOW = new Date(2026, 10, 25, 10, 12)

test('neutral: no agent label from the config and no dashboard word survive', () => {
  assert.equal(neutral('Master must read the plan before you apply; applying an unchecked plan could change the live dev project.', AGENTS),
    'someone must read the plan before you apply; applying an unchecked plan could change the live dev project.')
  assert.equal(neutral('Agent 1 and QA asked; the agent marked this flow blocked in Human review.', AGENTS), 'someone and someone asked; someone marked this work blocked.')
  assert.equal(neutral('2 of 5 by-hand steps done. Next: add the DNS record', AGENTS), '2 of 5 manual steps done. Next: add the DNS record')
  assert.equal(neutral('Claude Code blocked the delete until you approve it', AGENTS), 'the tooling blocked the delete until you approve it')
  assert.equal(neutral('Masterful work stays', AGENTS), 'Masterful work stays', 'only whole names')
  assert.equal(neutral('Independent agents', []), 'Independent someone', 'with no labels, the word agent still goes')
})

const item = (over = {}) => ({ kind: 'hand', title: 'Cloud Armor on dev: phase A', reason: 'x', tickets: ['FLA-833'], question: '', ...over })

test('blockerLines: one line per ticket, the items of the same ticket merged, in neutral words', () => {
  const lines = blockerLines([
    item({ reason: 'Master must read the plan before you apply.' }),
    item({ kind: 'blocked', reason: 'Blocked at: the certificate waits for its DNS record.' }),
    item({ kind: 'ask', reason: 'Part of Cloud Armor on dev', question: 'Can the prod deploy wait until Friday?', tickets: ['FLA-805'] }),
  ], AGENTS)
  assert.deepEqual(lines, [
    { tickets: ['FLA-833'], text: 'someone must read the plan before you apply; Blocked at: the certificate waits for its DNS record' },
    { tickets: ['FLA-805'], text: 'waits on an answer to: Can the prod deploy wait until Friday?' },
  ])
})

test('blockerLines: an item that only says the steps are not written yet, or are all done, is no blocker', () => {
  const lines = blockerLines([
    item({ reason: 'Steps asked for: waiting on the agent to write them.' }),
    item({ reason: 'Steps asked for, but the request was not sent: ask again.' }),
    item({ reason: 'Work only you can do (FLA-829, FLA-886), with no steps yet: ask the agent for them.' }),
    item({ reason: 'All 4 steps are done by you: mark the flow done.' }),
    item({ reason: 'Needs a production admin to grant access.', tickets: ['FLA-870'] }),
  ], AGENTS)
  assert.deepEqual(lines, [{ tickets: ['FLA-870'], text: 'Needs a production admin to grant access' }])
})

function facts(waiting) {
  return {
    mode: 'daily', window: standupWindow('daily', NOW), author: 'Yz31LL', name: 'Yz31LL', project: 'flinki-v2', base: 'origin/dev',
    commits: [], merges: [], unmerged: [], tickets: [], next: [], flows: [], waiting, agentNames: AGENTS,
    ticketListAt: null, skipped: [], builtAt: NOW.toISOString(),
  }
}

test('the facts BLOCKERS section is those lines, ticket first, and says None when nothing real waits', () => {
  const s = factsText(facts([item({ reason: 'Master must read the plan before you apply.' }), item({ reason: 'Steps asked for: waiting on the agent to write them.', tickets: ['FLA-829'] })]), NOW)
  const block = s.slice(s.indexOf('BLOCKERS'), s.indexOf('\n\n', s.indexOf('BLOCKERS')))
  assert.match(block, /\n- FLA-833: someone must read the plan before you apply$/)
  for (const word of ['Master', 'agent', 'flow', 'Human review', 'by-hand', 'FLA-829', 'Cloud Armor on dev: phase A']) assert.ok(!block.includes(word), word)
  assert.match(factsText(facts([item({ reason: 'Steps asked for: waiting on the agent to write them.' })]), NOW), /\nBLOCKERS [^\n]*\n- None\./)
})

test('the prompt: a blocker says what is waited on and from whom in the team s words, never an AI agent or the dashboard', () => {
  for (const mode of ['daily', 'week']) {
    const p = systemPrompt(mode)
    assert.match(p, /says what is waited on and from whom, in words the team uses/)
    assert.match(p, /needs a review of the plan/)
    assert.match(p, /Never name an AI agent, an agent label or the dashboard/)
    assert.match(p, /you and your in the facts mean the developer/)
    assert.match(p, /waits on a decision or approval/)
    assert.match(p, /only says steps are not written yet is not a blocker/)
    assert.match(p, /One line per ticket: merge the items of one ticket into that line/)
  }
})

test('the prompt: a merged pull request goes under its own ticket, and pushed work says so under its own', () => {
  for (const mode of ['daily', 'week']) {
    const p = systemPrompt(mode)
    assert.match(p, /A merged pull request is named in the bullets under the ticket it belongs to/)
    assert.match(p, /Work pushed but not merged says so under its own ticket/)
  }
  const w = systemPrompt('week')
  assert.match(w, /The one summary line Merged to dev in PRs lists only pull requests and goes straight under the Done line, never after a ticket/)
  assert.match(w, /Done <Done dates from the facts>:\nMerged to dev in PRs #889, #911 and #925\.\nFLA-700/)
})
