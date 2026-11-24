// Tests for the one agent card renderer in public/agent-cards.js (spec 5):
// Home draws it compact, the Agents page details pane draws it full. Both files are browser
// scripts; app.js attaches window.UI and window.App before any DOM code and
// skips the DOM when there is no document, so both run here in one vm context
// with a bare window. AgentCards.card is pure: an agent in, HTML out.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = vm.createContext({ window: {} })
for (const f of ['shell.js', 'app.js', 'agent-cards.js']) vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
const { card } = ctx.window.AgentCards

const agent = (extra = {}) => ({
  sessionId: 's-1',
  name: 'Agent 1',
  label: 'Agent 1',
  coding: true,
  state: 'active',
  lastTool: { tool: 'Bash', summary: 'npm test', t: new Date().toISOString() },
  recentWorktrees: ['wt-a'],
  recentTickets: ['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4', 'ABC-5', 'ABC-6'],
  subagents: [{ id: 'sub-1', description: 'Review Task 1', state: 'active', updatedAt: new Date().toISOString() }],
  talkingWith: { with: 'Coordinator', direction: 'to', t: new Date().toISOString(), via: 'message' },
  ...extra,
})
const worktrees = [{ name: 'wt-a', branch: 'feat/a', dirty: 2 }]
/** How many class attributes name `cls` as a whole class (chip, not chip-x). */
const count = (html, cls) => (html.match(new RegExp(String.raw`class="(?:[^"]*\s)?${cls}(?=["\s])`, 'g')) || []).length

// ═══ compact (Home) ═══

test('a compact card for an agent with 6 tickets has exactly 4 chips and a +2', () => {
  const html = card(agent(), { compact: true, worktrees })
  assert.equal(count(html, 'chip'), 4)
  assert.match(html, />\+2</)
})

test('a compact card shows the name, the state and one last-action line, nothing more', () => {
  const html = card(agent(), { compact: true, worktrees })
  assert.match(html, /Agent 1/)
  assert.match(html, /class="dot active"/)
  assert.equal(count(html, 'ac-now'), 1)
  assert.equal(count(html, 'ac-talk'), 0)
  assert.equal(count(html, 'ac-subs'), 0)
  assert.equal(count(html, 'branch'), 0)
  assert.equal(count(html, 'ac-report'), 0)
})

test('a compact card with 4 or fewer tickets has no +N', () => {
  const html = card(agent({ recentTickets: ['ABC-1', 'ABC-2'] }), { compact: true, worktrees })
  assert.equal(count(html, 'chip'), 2)
  assert.doesNotMatch(html, />\+\d/)
})

test('a compact card with no last tool and no tickets is just the head', () => {
  const html = card(agent({ lastTool: null, recentTickets: [] }), { compact: true, worktrees })
  assert.equal(count(html, 'ac-now'), 0)
  assert.equal(count(html, 'ac-foot'), 0)
})

// ═══ full (the Agents page details pane) ═══

test('a full card has every ticket, the branch, the talk line, the subagents and a Progress report button', () => {
  const html = card(agent(), { worktrees })
  assert.equal(count(html, 'chip'), 6)
  assert.doesNotMatch(html, />\+\d/)
  assert.match(html, /feat\/a/)
  assert.equal(count(html, 'ac-talk'), 1)
  assert.equal(count(html, 'ac-subs'), 1)
  assert.match(html, /Review Task 1/)
  assert.match(html, /data-report="s-1"[^>]*>Progress report</)
})

test('the card escapes what it prints', () => {
  const html = card(agent({ label: '<b>x</b>', recentTickets: ['<i>'] }), { worktrees })
  assert.doesNotMatch(html, /<b>x<\/b>|<i>/)
})

// ═══ the Independent card (Home and the Agents page), from /api/pulse chat ═══

test('the Independent card shows the name, a dot with the state word, and the last message time', () => {
  const { chatCard } = ctx.window.AgentCards
  const at = new Date(Date.now() - 5 * 60_000).toISOString()
  const html = chatCard({ name: 'Independent', state: 'waiting', lastAt: at })
  assert.match(html, /class="ac-name">Independent</)
  assert.match(html, /data-term="waiting"/)
  assert.match(html, /class="dot waiting"/)
  assert.match(html, /Last message 5m/)
  assert.match(html, /data-chat/)
  assert.match(chatCard({ name: 'Independent', state: 'working' }), /data-term="working"/)
  assert.match(chatCard({ name: 'Independent', state: 'idle' }), /No messages yet/)
  assert.match(chatCard({ name: 'Independent', state: 'weird' }), /data-term="idle"/, 'an unknown state reads idle')
})

test('the Independent card escapes the name it is given', () => {
  const html = ctx.window.AgentCards.chatCard({ name: '<img src=x onerror=alert(1)>', state: 'idle' })
  assert.ok(!html.includes('<img'), html)
  assert.match(html, /&lt;img/)
})

test('a pulse draws the Independent card into each slot, and a click on it opens the Ask drawer', () => {
  const listeners = {}
  const slot = { hidden: true, innerHTML: '', on: {}, addEventListener(t, fn) { this.on[t] = fn } }
  const document = { addEventListener: (t, fn) => ((listeners[t] ||= []).push(fn)), querySelectorAll: sel => (sel === '.ac-chat-slot' ? [slot] : []) }
  const opened = []
  const window = {}
  const c = vm.createContext({ window, document })
  for (const f of ['shell.js', 'app.js', 'agent-cards.js']) vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), c)
  window.Shell.drawer = { open: () => opened.push(1) }
  for (const fn of listeners.pulse || []) fn({ detail: { chat: { name: 'Independent', state: 'working', lastAt: new Date().toISOString() } } })
  assert.equal(slot.hidden, false)
  assert.match(slot.innerHTML, /data-term="working"/)
  slot.on.click({ target: { closest: sel => (sel === '[data-chat]' ? {} : null) } })
  assert.equal(opened.length, 1)
})

// ═══ the coordinator is whoever the config says, under the label it gives ═══

test('Home lists first the session the server marks as the coordinator, whatever it is named', () => {
  const { groups } = ctx.window.AgentCards
  const agents = [
    { name: 'Master', label: 'Lead', coding: true, coordinator: true, updatedAt: '2026-11-12T10:00:00Z' },
    { name: 'Coordinator', label: 'Agent 1', coding: true, coordinator: false, updatedAt: '2026-11-12T10:00:00Z' },
    { name: 'other', label: 'Other', coding: false, coordinator: false, updatedAt: '2026-11-12T10:00:00Z' },
  ]
  const g = groups(agents)
  assert.equal(g.coordinator.name, 'Master')
  assert.equal(Array.from(g.workers, a => a.name).join(), 'Coordinator', 'a session merely NAMED Coordinator is an ordinary agent')
  assert.equal(groups(agents.map(a => ({ ...a, coordinator: false }))).coordinator, null)
})

test('Home draws the coordinator, the coding agents by name, then the rest newest first, ignoring any old saved drag order', () => {
  const store = { 'agentCardOrder.workers': JSON.stringify(['s-b', 's-a']), 'agentCardOrder.others': JSON.stringify(['s-old', 's-new']) }
  const window = {}
  const c = vm.createContext({ window, localStorage: { getItem: k => store[k] ?? null, setItem: () => {} } })
  for (const f of ['shell.js', 'app.js', 'agent-cards.js']) vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), c)
  const box = { innerHTML: '', addEventListener() {} }
  const a = (sessionId, label, extra) => agent({ sessionId, label, ...extra })
  const agents = [
    a('s-old', 'Old', { coding: false, transcriptAt: '2026-11-12T09:00:00Z' }),
    a('s-b', 'Bravo'),
    a('s-new', 'New', { coding: false, transcriptAt: '2026-11-12T10:00:00Z' }),
    a('s-lead', 'Lead', { coordinator: true }),
    a('s-a', 'Alpha'),
  ]
  window.AgentCards.render({ agents }, { root: box })
  assert.deepEqual([...box.innerHTML.matchAll(/data-session="([^"]+)"/g)].map(m => m[1]), ['s-lead', 's-a', 's-b', 's-new', 's-old'])
  assert.equal(count(box.innerHTML, 'ac-compact'), 5)
})

test('a coordinator that is not running shows under its configured label, Coordinator when none is known, escaped', () => {
  const { missingRoot } = ctx.window.AgentCards
  assert.match(missingRoot('Lead'), /<span class="ac-name">Lead<\/span><span class="ac-role">not running<\/span>/)
  assert.match(missingRoot(undefined), /<span class="ac-name">Coordinator<\/span>/)
  assert.ok(!missingRoot('<b>x</b>').includes('<b>'))
})

test('no page decides who coordinates by a hard-coded session name', () => {
  for (const f of ['agent-cards.js', 'agent.js', 'app.js', 'flow.js', 'orchestration.js']) {
    const src = fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
    assert.doesNotMatch(src, /name\s*[!=]==\s*'(Master|Coordinator)'/, f)
  }
  const server = fs.readFileSync(path.join(HERE, '..', 'server.mjs'), 'utf8')
  assert.doesNotMatch(server, /name\s*[!=]==\s*'(Master|Coordinator)'/)
  assert.match(server, /coordinator: s\.name === CONFIG\.coordinator/)
})
