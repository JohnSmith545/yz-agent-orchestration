// The Tickets grid credits a ticket to the subagent that built it (orchestration.mjs,
// from subagents.mjs ticketBuilders), not to the coordinator that started the subagent;
// the chip carries the subagent's short label and the hover keeps every other line
// (public/orchestration.js). FACTORY_DATA_DIR points at a fresh temp folder BEFORE
// the imports, so no test ever touches the real data/ folder.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-subagents-test-'))
const { DATA_DIR } = await import('../flows.mjs')
const { makeOrchestration } = await import('../orchestration.mjs')
const { useTicketPrefixes } = await import('../transcripts.mjs')
useTicketPrefixes(['ABC', 'XYZ'])
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

/** origin/dev names ABC-9001 and ABC-9002; nothing else is anywhere. */
async function git(args) {
  if (args[0] === 'log' && args[1] === 'origin/dev') return { ok: true, out: 'abc1234\t2026-11-12\tfix: ABC-9001 dark mode\x1edef5678\t2026-11-12\tfix: ABC-9002 footer\x1e', err: '' }
  return { ok: true, out: '', err: '' }
}
const getStatus = async () => ({ tickets: [{ id: 'ABC-9001', title: 'Dark mode', agents: [] }, { id: 'ABC-9002', title: 'Footer', agents: [] }, { id: 'ABC-9003', title: 'Not started', agents: [] }], agents: [] })
const SUBAGENT = { sessionId: 'sess-live', id: 'b1', description: 'Build ABC-9001 dark mode toggle', label: 'Build ABC-9001 dark…', parent: '' }
const grid = (subagentBuilds, force = true) => makeOrchestration({ git, getStatus, listWorktrees: async () => [], subagentBuilds })('', force)

test('a ticket a subagent built carries that subagent; one nobody helped with carries none', async () => {
  const data = await grid(async () => new Map([['ABC-9001', SUBAGENT]]))
  assert.deepEqual(data.tickets['ABC-9001'].subagent, SUBAGENT)
  assert.equal(data.tickets['ABC-9002'].subagent, null)
})

test('the ticket stays in the grid at its level, in the column of the session that started the subagent', async () => {
  const data = await grid(async () => new Map([['ABC-9001', SUBAGENT]]))
  const first = data.columns[0].label
  assert.ok(data.cells[first].dev.includes('ABC-9001'))
  assert.deepEqual(data.tickets['ABC-9001'].agents, [first], 'an ended or unknown session reads as the first column')
  const named = await grid(async () => new Map([['ABC-9001', { ...SUBAGENT, parent: first }]]))
  assert.deepEqual(named.tickets['ABC-9001'].agents, [first])
})

test('a subagent is credited even before its ticket reaches a level', async () => {
  const data = await grid(async () => new Map([['ABC-9003', { ...SUBAGENT, id: 'b3' }]]))
  assert.equal(data.tickets['ABC-9003'].level, null)
  assert.equal(data.tickets['ABC-9003'].subagent.id, 'b3')
})

test('with no subagent source, or one that fails, the grid builds as before', async () => {
  for (const source of [undefined, async () => { throw new Error('transcripts unreadable') }, async () => null]) {
    const data = await grid(source)
    assert.equal(data.tickets['ABC-9001'].subagent, null)
    assert.equal(data.tickets['ABC-9001'].level, 'dev')
  }
})

// ═══ the page: the chip and its hover ═══

const el = () => ({ addEventListener() {}, appendChild() {}, querySelector: () => el(), style: {} })
const document = { ...el(), body: el(), createElement: el }
const window = {}
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'orchestration.js'), 'utf8'), { window, document })
const G = window.OrchestrationGrid
const ticket = (over = {}) => ({ id: 'ABC-9001', title: 'Dark mode', state: 'Started', agents: ['Master'], mark: null, moreLocal: false, outside: false, subagent: null, ...over })
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

test('a chip of a ticket a subagent built shows the subagent short label beside the number', () => {
  const h = G.chipHtml(ticket({ subagent: SUBAGENT }), 'ABC')
  assert.match(h, /data-tid="ABC-9001"/)
  assert.equal(text(h), '9001 Build ABC-9001 dark…')
  assert.match(h, /<span class="ox-subagent">Build ABC-9001 dark…<\/span>/)
})

test('a chip of any other ticket is the number alone, as before', () => {
  const h = G.chipHtml(ticket(), 'ABC')
  assert.equal(text(h), '9001')
  assert.doesNotMatch(h, /ox-subagent/)
})

test('the hover says Built by the subagent, by its full task name, with a link to watch it, and whose subagent it is', () => {
  const h = G.builtBy(ticket({ subagent: { ...SUBAGENT, parent: 'Master' } }))
  assert.match(h, /<a class="link" href="#\/agent\/sess-live\/b1">Build ABC-9001 dark mode toggle<\/a>/)
  assert.equal(text(h), 'Build ABC-9001 dark mode toggle · subagent of Master')
  assert.equal(text(G.builtBy(ticket({ subagent: SUBAGENT }))), 'Build ABC-9001 dark mode toggle · subagent of an ended session')
})

test('without a subagent the hover names the agents, as before', () => {
  assert.equal(G.builtBy(ticket({ agents: ['Agent 1', 'Agent 2'] })), 'Agent 1, Agent 2')
  assert.equal(text(G.builtBy(ticket({ agents: [] }))), '–')
})

test('a subagent label and task name are escaped', () => {
  const evil = { ...SUBAGENT, description: '<img src=x>', label: '<b>x</b>' }
  assert.ok(!G.chipHtml(ticket({ subagent: evil }), 'ABC').includes('<b>'))
  assert.ok(!G.builtBy(ticket({ subagent: evil })).includes('<img'))
})
