// Tests for standup-text.mjs (the facts as the model reads them, and the page's Read and Left out lines) and
// standup-prompt.mjs (the system prompt for each mode). Pure: facts are built by hand here.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MODE_PROMPTS, systemPrompt } from '../standup-prompt.mjs'
import { FACTS_MAX, factsText, leftLine, readLine } from '../standup-text.mjs'
import { standupWindow } from '../standup-window.mjs'

const NOW = new Date(2026, 10, 25, 10, 12)
const iso = (d, h, m = 0) => new Date(2026, 10, d, h, m).toISOString()
const LINK = id => `https://app.switchboardpm.ai/stories/${id}`

function facts(mode = 'daily', over = {}) {
  const t = (id, title, state, mine = true) => ({ id, title, state, mine, known: true, link: LINK(id), line: `${id}: ${title} — ${LINK(id)}` })
  const tickets = [t('FLA-886', 'Deleted accounts also delete uploads', 'Delivered'), t('FLA-870', 'Grant prod database access', 'Started'), t('FLA-868', 'Compress big web media', 'Started')]
  return {
    mode, window: standupWindow(mode, NOW), author: 'Yz31LL', name: 'Jo Bloggs', project: 'Flinki', base: 'origin/dev',
    commits: [
      { sha: 'abc1234567', at: iso(24, 16, 41), branch: 'fix/fla-886-uploads', subject: 'fix(api): deleting an account deletes its uploads', ids: ['FLA-886'] },
      { sha: 'def7654321', at: iso(24, 9, 2), branch: 'feat/fla-868-media', subject: 'perf(web): big images are compressed', ids: ['FLA-868'] },
    ],
    merges: [{ sha: 'm1', at: iso(24, 15, 2), number: 1174, branch: 'fix/fla-886-uploads', ids: ['FLA-886'] }],
    unmerged: [{ branch: 'feat/fla-868-media', commits: 1, pushed: true, ids: ['FLA-868'] }],
    tickets, next: [tickets[2], tickets[1]],
    flows: [{ id: 'fla-868-media', title: 'Big web images are compressed', status: 'open', agent: 'Master', tickets: ['FLA-868'], updatedAt: iso(24, 9, 47) }],
    waiting: [{ kind: 'hand', title: 'Prod database grant', reason: 'Needs a production admin to grant access.', tickets: ['FLA-870'] }],
    ticketListAt: iso(12, 19, 32), skipped: [], builtAt: NOW.toISOString(), ...over,
  }
}

// ═══ the model's input ═══

test('daily facts: what to write, the heading, whose work and how old the ticket list is', () => {
  const s = factsText(facts('daily'), NOW)
  assert.match(s, /^Write the daily stand-up\./)
  assert.match(s, /^Heading: Stand up, Tue 24 Nov$/m)
  assert.match(s, /^Whose work: Yz31LL$/m)
  assert.match(s, /^Ticket list saved: Thu 12 Nov, 13 days ago\. Its states may be out of date\.$/m)
  assert.doesNotMatch(s, /^Name:/m, 'the name and project are for the weekly header only')
})

test('weekly facts: the name, project, done dates and the dates it commits to', () => {
  const s = factsText(facts('week'), NOW)
  assert.match(s, /^Write the weekly progress\./)
  assert.match(s, /^Name: Jo Bloggs$/m)
  assert.match(s, /^Project: Flinki$/m)
  assert.match(s, /^Done dates: Nov 19–25$/m)
  assert.match(s, /^Committing dates: Nov 26–Dec 2$/m)
})

test('every ticket line goes in exactly as the server built it, and each section is there', () => {
  const f = facts()
  const s = factsText(f, NOW)
  for (const t of f.tickets) assert.ok(s.includes(t.line), t.id)
  for (const head of ['TICKETS', 'MERGED PULL REQUESTS', 'NOT MERGED YET', 'BLOCKERS', 'IN PROGRESS AND YOURS', 'FLOWS TOUCHED', 'COMMITS']) assert.ok(s.includes(head), head)
  assert.match(s, /PR #1174, branch fix\/fla-886-uploads, merged Tue 24 Nov \d\d:\d\d, tickets FLA-886/)
  assert.match(s, /feat\/fla-868-media: 1 commit, pushed, tickets FLA-868/)
  assert.match(s, /Prod database grant: Needs a production admin to grant access \(tickets FLA-870\)/)
  assert.match(s, /fix\(api\): deleting an account deletes its uploads/)
})

test('empty parts say none, so the model does not pad them', () => {
  const s = factsText(facts('daily', { commits: [], merges: [], unmerged: [], flows: [], waiting: [] }), NOW)
  assert.match(s, /COMMITS[^\n]*\n- None\./)
  assert.match(s, /MERGED PULL REQUESTS[^\n]*\n- None\./)
})

test('commits are newest first, and the text is capped with a note that names the cut', () => {
  const many = Array.from({ length: 900 }, (_, i) => ({ sha: `s${String(i).padStart(9, '0')}`, at: iso(24, 23, 59 - (i % 60)), branch: 'feat/long', subject: `commit number ${i} with a long subject to fill the facts up quickly`, ids: [] }))
  const s = factsText(facts('daily', { commits: many }), NOW)
  assert.ok(s.length <= FACTS_MAX, `${s.length}`)
  assert.equal(FACTS_MAX, 30_000)
  assert.match(s, /Cut here: the facts were longer than 30,000 characters, so the oldest commits were left out\.$/)
  assert.ok(s.includes('commit number 0 '), 'the newest is kept')
  assert.ok(!s.includes('commit number 899 '), 'the oldest is cut')
  assert.ok(s.indexOf('TICKETS') < s.indexOf('COMMITS'), 'the small parts come first, so a cut only ever takes commits')
})

test('what was left out is in the facts, so the model can say it does not know', () => {
  const s = factsText(facts('daily', { skipped: [{ title: 'Flows', why: 'The flows could not be read.' }], ticketListAt: null }), NOW)
  assert.match(s, /LEFT OUT\n- Flows: The flows could not be read\./)
  assert.match(s, /^Ticket list saved: not read\.$/m)
})

// ═══ the page's quiet lines ═══

test('readLine: commits, merged pull requests, tickets and the ticket list date, in plain words', () => {
  assert.equal(readLine(facts()), 'Read: 2 commits, 1 merged pull request, 3 tickets, ticket list from 12 Nov')
  assert.equal(readLine(facts('daily', { commits: [facts().commits[0]], merges: [], tickets: [], ticketListAt: null })), 'Read: 1 commit, 0 merged pull requests, 0 tickets, no ticket list')
})

test('leftLine: each source left out, or nothing', () => {
  assert.equal(leftLine(facts()), '')
  assert.equal(leftLine(facts('daily', { skipped: [{ title: 'Flows', why: 'x' }, { title: 'Ticket list', why: 'y' }] })), 'Left out: Flows, Ticket list (they could not be read).')
})

// ═══ the system prompt ═══

test('systemPrompt: the rules for both modes, then that mode s format only', () => {
  const d = systemPrompt('daily')
  const w = systemPrompt('week')
  for (const p of [d, w]) {
    assert.match(p, /Use ONLY the facts/)
    assert.match(p, /Never invent/)
    assert.match(p, /exactly as given/)
    assert.match(p, /no file names/i)
  }
  assert.ok(d.includes(MODE_PROMPTS.daily) && !d.includes(MODE_PROMPTS.week))
  assert.ok(w.includes(MODE_PROMPTS.week) && !w.includes(MODE_PROMPTS.daily))
  assert.match(d, /Stand up, Tue 24 Nov/)
  assert.match(d, /\nBlockers\n/)
  assert.match(d, /What's next/)
  assert.match(d, /None/)
  assert.match(w, /^Name: /m)
  assert.match(w, /This week — committing to:/)
  assert.throws(() => systemPrompt('month'), /daily or week/)
})

test('systemPrompt is the same text on every call for a mode, so the prompt cache reads it', () => {
  assert.equal(systemPrompt('daily'), systemPrompt('daily'))
  assert.doesNotMatch(systemPrompt('daily'), /2026|Yz31LL/, 'no date or name in it: those go in the facts')
})

// ═══ blockers are firm (QA A-6, 2026-11-25): two runs on the same facts disagreed, one listed the DNS wait, one said None ═══

test('the facts carry the blockers under their own BLOCKERS heading, each with its ticket; none says None', () => {
  const s = factsText(facts(), NOW)
  assert.match(s, /\nBLOCKERS \(every item here waits on another person or an outside system: each one IS a blocker\)\n- Prod database grant: Needs a production admin to grant access \(tickets FLA-870\)/)
  assert.doesNotMatch(s, /candidates for Blockers/)
  assert.ok(s.indexOf('BLOCKERS') < s.indexOf('IN PROGRESS AND YOURS'), 'before the long lists, so it cannot be missed')
  assert.match(factsText(facts('week', { waiting: [] }), NOW), /\nBLOCKERS [^\n]*\n- None\./)
})

test('the prompt makes every BLOCKERS item a blocker in both modes, and None only when the facts have none', () => {
  for (const mode of ['daily', 'week']) {
    const p = systemPrompt(mode)
    assert.match(p, /Every item under BLOCKERS in the facts IS a blocker, in the daily and the weekly stand-up alike/)
    assert.match(p, /Write `None` only when BLOCKERS in the facts says None/)
    assert.doesNotMatch(p, /candidates only/)
  }
})
