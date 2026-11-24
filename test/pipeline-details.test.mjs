// Tests for public/pipeline-details.js: the details pane under the Agents page diagram. An agent node shows
// that agent's card from agent-cards.js (state, what it does, who it talks to, tickets, branch, Progress
// report), a push outside QA is said in a line of its own, and a step (Request, Push, Output) gets a plain
// description and the tickets standing there. Browser files in one vm with a bare window.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = vm.createContext({ window: {} })
for (const f of ['shell.js', 'app.js', 'agent-cards.js', 'pipeline-tickets.js', 'agent-rules-view.js', 'pipeline-details.js']) vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
const D = ctx.window.PipelineDetails

const agent = (extra = {}) => ({
  sessionId: 's-1', label: 'Agent 1', coding: true, state: 'idle', lastTool: null, recentWorktrees: ['wt-a'],
  recentTickets: ['ABC-1'], subagents: [], talkingWith: null, pushesOutsideQa: 0, ...extra,
})
const node = { id: 'agent-1', kind: 'agent', label: 'Agent 1', role: 'producer' }
const labels = { 'agent-1': 'Agent 1', push: 'Push' }
const ticket = { id: 'f1', title: 'Fix login', stage: { node: 'agent-1', status: 'working', path: [] }, updatedAt: '2026-11-24T10:00:00Z' }

test('an agent node shows that agent card, with its branch and the Progress report button', () => {
  const html = D.html(node, { agent: agent(), worktrees: [{ name: 'wt-a', branch: 'feat/a', dirty: 0 }], tickets: [ticket], labels })
  assert.match(html, /class="ac[ "]/)
  assert.match(html, /feat\/a/)
  assert.match(html, /data-report="s-1" data-label="Agent 1"[^>]*>Progress report</)
  assert.match(html, /href="#\/agent\/s-1"[^>]*>Watch live</)
  assert.match(html, /data-ticket="f1"/)
})

test('pushes outside QA are said plainly, and only when there are some', () => {
  assert.match(D.html(node, { agent: agent({ pushesOutsideQa: 3 }), labels }), /Pushed 3 times outside QA today/)
  assert.match(D.html(node, { agent: agent({ pushesOutsideQa: 1 }), labels }), /Pushed 1 time outside QA today/)
  assert.doesNotMatch(D.html(node, { agent: agent(), labels }), /outside QA/)
})

test('an agent that is not running says so, under the label the graph gives it', () => {
  const html = D.html(node, { agent: null, labels })
  assert.match(html, /Agent 1/)
  assert.match(html, /not running/)
  assert.doesNotMatch(html, /Progress report/)
})

test('the chat agent node says what it does and holds its own chat card (it is no session to find), never not running', () => {
  const html = D.html({ id: 'independent', kind: 'agent', label: 'Independent', role: 'chat' }, { agent: null, tickets: [], labels })
  assert.match(html, /class="pl-desc">The chat agent in the Ask drawer/)
  assert.match(html, /ac-chat-slot/)
  assert.doesNotMatch(html, /not running/)
})

test('Request, Push and Output get a short plain description and the tickets there', () => {
  for (const [id, role, kind] of [['request', 'request', 'start'], ['push', 'push', 'step'], ['outcome', 'outcome', 'end']]) {
    const html = D.html({ id, kind, label: id, role }, { tickets: [], labels })
    assert.match(html, /class="pl-desc"/, id)
    assert.match(html, /No tickets here right now/, id)
  }
  const push = D.html({ id: 'push', kind: 'step', label: 'Push', role: 'push' }, { tickets: [{ ...ticket, stage: { node: 'push', status: 'waiting' } }], labels })
  assert.match(push, /data-ticket="f1"/)
})

test('the default pane keeps the Independent chat slot and says how to use the page', () => {
  const html = D.empty()
  assert.match(html, /ac-chat-slot/)
  assert.match(html, /Click a step/)
})

test('the pane escapes what it prints', () => {
  const html = D.html({ id: 'x', kind: 'agent', label: '<b>x</b>', role: 'producer' }, { agent: null, labels })
  assert.doesNotMatch(html, /<b>x<\/b>/)
})

// ═══ the user's specification and rules (agent-rules-view.js) ═══

const AT = '2026-11-24T10:00:00.000Z'
const saved = { spec: 'Builds the web pages.', rules: [{ id: 'a', text: 'Never touch the mobile app.', addedAt: AT }], updatedAt: AT }

test('an agent node has Settings in its head, next to Watch live and Close, and shows its specification and rules', () => {
  const html = D.html(node, { agent: agent(), labels, rules: { entry: saved } })
  assert.match(html, /<div class="pl-det-head"><h2>Agent 1<\/h2><a [^>]*>Watch live<\/a><button [^>]*data-ar-act="settings"[^>]*>[\s\S]*?Settings<\/button><button [^>]*data-close>Close/)
  assert.match(html, /data-ar-slot="Agent 1" data-ar-mode="view"/)
  assert.match(html, /class="ar-spec">Builds the web pages\.</)
  assert.match(html, /<li>Never touch the mobile app\.<\/li>/)
  assert.doesNotMatch(html, /class="pl-desc">Writes the code/, 'the saved specification replaces the role line')
})

test('with nothing saved the role line stands in as the default specification', () => {
  const html = D.html(node, { agent: null, labels })
  assert.match(html, /Specification <span class="faint">· Default<\/span><\/h3><p class="pl-desc">Writes the code/)
  assert.match(html, /No rules yet\./)
})

test('with a draft the sections are the editor, and Settings says it is open', () => {
  const html = D.html(node, { agent: null, labels, rules: { entry: saved, draft: { spec: 'typed', rules: [], pending: '', error: '', saving: false } } })
  assert.match(html, /data-ar-mode="edit"/)
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /<textarea[^>]*>\ntyped<\/textarea>/)
})

test('the chat agent, the coordinator and QA get Settings too; Request, Push and Output never do', () => {
  for (const role of ['chat', 'coordinator', 'qa']) assert.match(D.html({ id: role, kind: 'agent', label: role, role }, { labels }), /data-ar-act="settings"/, role)
  for (const [id, kind] of [['request', 'start'], ['push', 'step'], ['outcome', 'end']]) {
    const html = D.html({ id, kind, label: id, role: id }, { labels })
    assert.doesNotMatch(html, /Settings|data-ar-/, id)
  }
})
