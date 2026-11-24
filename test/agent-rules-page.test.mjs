// Tests for public/agent-rules.js: the Settings editor of an agent's details pane on the Agents page. The pane is
// redrawn on every status load (about every 15 seconds) and when the pipeline reloads; an editor in use must
// survive that with no lost typing, no lost focus or cursor and no flicker, so paint() keeps the live editor
// element where it is and swaps only what is around it. Also: loading the saved rules, Save (and a failed one that
// keeps what was typed), Add with Enter, Remove, and Escape closing the editor.
//
// Runs in a vm with a small fake DOM (attribute selectors only, which is all agent-rules.js uses). The live editor
// element counts every time it is taken out of the tree: a detach would blur it in a browser, so it must stay 0.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')

// ═══ a fake DOM ═══

const SEL = /\[([\w-]+)(?:="([^"]*)")?\]/g
function matches(el, sel) {
  if (el.nodeType !== 1) return false
  const parts = [...sel.matchAll(SEL)]
  return parts.length > 0 && parts.every(([, name, value]) => (value === undefined ? name in el.attrs : el.attrs[name] === value))
}
class Node {
  constructor(name, attrs = {}, text = '') {
    this.nodeName = name.toUpperCase()
    this.nodeType = name === '#fragment' ? 11 : name === '#comment' ? 8 : 1
    this.attrs = { ...attrs }
    this.childNodes = []
    this.parentNode = null
    this.detached = 0
    this.textContent = text
    this.value = attrs.value ?? ''
    this.listeners = {}
    this.disabled = false
  }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })) }
  getAttribute(n) { return this.attrs[n] ?? null }
  setAttribute(n, v) { this.attrs[n] = String(v) }
  removeAttribute(n) { delete this.attrs[n] }
  hasAttribute(n) { return n in this.attrs }
  append(...kids) { for (const k of kids) this.appendChild(k); return this }
  appendChild(k) { if (k.parentNode) k.parentNode.removeChild(k); k.parentNode = this; this.childNodes.push(k); return k }
  insertBefore(k, ref) {
    if (k.parentNode) k.parentNode.removeChild(k)
    k.parentNode = this
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, k)
    return k
  }
  removeChild(k) { this.childNodes.splice(this.childNodes.indexOf(k), 1); k.parentNode = null; k.detached++; return k }
  remove() { if (this.parentNode) this.parentNode.removeChild(this) }
  descendants() { return this.childNodes.flatMap(c => [c, ...c.descendants()]) }
  querySelector(sel) { return this.descendants().find(n => matches(n, sel)) || null }
  querySelectorAll(sel) { return this.descendants().filter(n => matches(n, sel)) }
  matches(sel) { return matches(this, sel) }
  closest(sel) { for (let n = this; n; n = n.parentNode) if (matches(n, sel)) return n; return null }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  set innerHTML(v) { this.childNodes = []; this.innerSet = (this.innerSet || 0) + 1; this.html = v }
  focus() { focused = this }
  setSelectionRange(a, b) { this.selection = [a, b] }
}
let focused = null
const el = (name, attrs, ...kids) => new Node(name, attrs).append(...kids)

/** A pane as agent-rules-view.js draws it, as nodes: a head with Settings, the sections, and a tickets line. */
function pane({ mode = 'edit', label = 'Agent 1', tickets = 'No tickets here right now.' } = {}) {
  const spec = el('textarea', { 'data-ar-field': 'spec' })
  const slot = el('section', { 'data-ar-slot': label, 'data-ar-mode': mode },
    spec, el('p', { 'data-ar-count': '' }), el('span', { 'data-ar-n': '' }), el('div', { 'data-ar-list': '' }),
    el('input', { 'data-ar-field': 'pending' }), el('p', { 'data-ar-error': '' }), el('button', { 'data-ar-act': 'save' }))
  const root = el('div', { class: 'pl-det', 'data-node': 'agent-1' },
    el('div', { class: 'pl-det-head' }, el('button', { 'data-ar-act': 'settings', 'data-ar-label': label })),
    new Node('#comment'), slot, new Node('#comment'), new Node('p', {}, tickets))
  return { root, slot, spec }
}

function harness({ fetch } = {}) {
  const calls = []
  const window = {}
  const ctx = vm.createContext({ window, document: { createElement: () => { throw new Error('tests pass parse') } }, fetch: fetch || (async () => ({ ok: true, json: async () => ({}) })) })
  vm.runInContext(read('agent-rules-view.js'), ctx)
  vm.runInContext(read('agent-rules.js'), ctx)
  const box = new Node('div', { id: 'plDetails' })
  let redraws = 0
  window.AgentRules.bind(box, () => redraws++)
  return { R: window.AgentRules, V: window.AgentRulesView, box, calls, redraws: () => redraws }
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)) }
const node = { id: 'agent-1', kind: 'agent', label: 'Agent 1', role: 'producer' }
const AT = '2026-11-24T10:00:00.000Z'
const SAVED = { agents: { 'Agent 1': { spec: 'Builds pages.', rules: [{ id: 'a', text: 'Be kind.', addedAt: AT }], updatedAt: AT } }, limits: { spec: 2000, rule: 300, rules: 30 } }
/** The pane HTML the page would paint: something around the sections, and the sections for `opts`. */
const paneHtml = (V, opts, around = 'No tickets here right now.') => `<div class="pl-det" data-node="agent-1"><div class="pl-det-head"></div>${V.slotHtml(node, 'Writes the code.', opts)}<p>${around}</p></div>`

// ═══ paint: the editor survives a redraw ═══

test('a redraw while the editor is in use keeps the editor element in place, with what was typed and the focus, and swaps only what is around it', () => {
  const { R, V, box } = harness()
  const { root, slot, spec } = pane()
  box.append(root)
  spec.value = 'half typed'
  spec.focus()
  spec.setSelectionRange(4, 4)
  box._html = 'what was painted before'
  const draft = V.draftOf(null)
  const fresh = pane({ tickets: 'A new ticket arrived.' })
  const painted = R.paint(box, paneHtml(V, { draft }, 'A new ticket arrived.'), () => { const f = new Node('#fragment'); f.append(fresh.root); return f })
  assert.equal(painted, true)
  assert.equal(box.innerSet, undefined, 'the pane was not replaced whole')
  assert.equal(root.childNodes.includes(slot), true, 'the live editor is still there')
  assert.equal(slot.parentNode, root)
  assert.equal(slot.detached, 0, 'never taken out of the tree, so it never loses focus')
  assert.equal(spec.value, 'half typed')
  assert.equal(focused, spec)
  assert.deepEqual(spec.selection, [4, 4])
  assert.equal(root.childNodes.at(-1).textContent, 'A new ticket arrived.', 'what is around it is the new one')
  assert.equal(root.childNodes.indexOf(slot), 2, 'in the same place, between the head and the tickets')
})

test('a redraw where only the editor part differs (the draft moved on) touches nothing at all', () => {
  const { R, V, box } = harness()
  const { root, slot } = pane()
  box.append(root)
  const first = paneHtml(V, { draft: V.draftOf(null) })
  box._html = 'old'
  R.paint(box, first, () => { const f = new Node('#fragment'); f.append(pane().root); return f })
  const children = [...root.childNodes]
  let parsed = 0
  const again = R.paint(box, paneHtml(V, { draft: { ...V.draftOf(null), spec: 'more typing' } }), () => (parsed++, new Node('#fragment')))
  assert.equal(again, false)
  assert.equal(parsed, 0)
  assert.deepEqual(root.childNodes, children)
  assert.equal(slot.detached, 0)
})

test('the same HTML twice is no paint at all', () => {
  const { R, V, box } = harness()
  const html = paneHtml(V, { entry: null })
  assert.equal(R.paint(box, html), true)
  assert.equal(box.innerSet, 1)
  assert.equal(R.paint(box, html), false)
  assert.equal(box.innerSet, 1)
})

test('with no editor in use, or the editor closed, or another agent shown, the pane is painted whole', () => {
  const { R, V, box } = harness()
  const read = paneHtml(V, { entry: null })
  R.paint(box, read)
  assert.equal(box.innerSet, 1)
  // an editor in the tree, but the new HTML has the read view (Cancel, Save): whole
  box.append(pane().root)
  R.paint(box, paneHtml(V, { entry: null }, 'other'))
  assert.equal(box.innerSet, 2)
  // an editor for Agent 1 in the tree, the new HTML is Agent 2's editor: whole
  box.append(pane().root)
  R.paint(box, paneHtml(V, { draft: V.draftOf(null) }).replace(/data-ar-slot="Agent 1"/, 'data-ar-slot="Agent 2"'))
  assert.equal(box.innerSet, 3)
})

// ═══ load, open, save ═══

function server(responses) {
  const sent = []
  const fetch = async (url, init = {}) => {
    sent.push({ url, init })
    const r = responses.shift()
    if (r instanceof Error) throw r
    return { ok: r.status === 200, status: r.status, json: async () => structuredClone(r.body) }
  }
  return { fetch, sent }
}

test('load reads the saved rules once; the pane is redrawn only when they changed', async () => {
  const s = server([{ status: 200, body: SAVED }, { status: 200, body: SAVED }])
  const h = harness({ fetch: s.fetch })
  await h.R.load()
  assert.equal(s.sent[0].url, '/api/agents/rules')
  assert.equal(h.redraws(), 1)
  assert.equal(h.R.paneOpts(node).entry.spec, 'Builds pages.')
  assert.equal(h.R.paneOpts(node).draft, null)
  await h.R.load()
  assert.equal(h.redraws(), 1, 'the same answer again: no redraw')
})

test('Settings opens the editor on the saved text and puts the cursor in the specification; Settings again keeps it open', async () => {
  const s = server([{ status: 200, body: SAVED }])
  const h = harness({ fetch: s.fetch })
  await h.R.load()
  const { root, spec } = pane()
  h.box.append(root)
  await h.R.act('settings', 'Agent 1')
  assert.equal(h.R.paneOpts(node).draft.spec, 'Builds pages.')
  assert.deepEqual([...h.R.paneOpts(node).draft.rules], ['Be kind.'])
  assert.equal(focused, spec)
  await h.R.act('settings', 'Agent 1')
  assert.ok(h.R.paneOpts(node).draft, 'still open: a second press never throws the typing away')
})

test('typing goes into the draft (and the count); Enter in the Add field adds the rule; Remove takes one out', async () => {
  const s = server([{ status: 200, body: SAVED }])
  const h = harness({ fetch: s.fetch })
  await h.R.load()
  const { root, slot, spec } = pane()
  h.box.append(root)
  await h.R.act('settings', 'Agent 1')
  spec.value = 'New words.'
  for (const fn of h.box.listeners.input) fn({ target: spec })
  assert.equal(h.R.paneOpts(node).draft.spec, 'New words.')
  assert.equal(slot.querySelector('[data-ar-count]').textContent, '10 of 2,000 characters')
  const add = slot.querySelector('[data-ar-field="pending"]')
  add.value = 'Run the tests.'
  for (const fn of h.box.listeners.input) fn({ target: add })
  let prevented = false
  for (const fn of h.box.listeners.keydown) fn({ key: 'Enter', target: add, preventDefault: () => (prevented = true) })
  assert.ok(prevented)
  assert.deepEqual([...h.R.paneOpts(node).draft.rules], ['Be kind.', 'Run the tests.'])
  assert.equal(add.value, '', 'the field is empty again')
  assert.equal(focused, add, 'and keeps the focus for the next rule')
  assert.match(slot.querySelector('[data-ar-list]').html, /Run the tests\./)
  assert.equal(slot.querySelector('[data-ar-n]').textContent, '· 2')
  await h.R.act('remove', 'Agent 1', 0)
  assert.deepEqual([...h.R.paneOpts(node).draft.rules], ['Run the tests.'])
})

test('Save sends the PUT with the draft and, when it is saved, closes the editor and shows the saved text', async () => {
  const saved = { spec: 'New.', rules: [{ id: 'x', text: 'One.', addedAt: AT }], updatedAt: AT }
  const s = server([{ status: 200, body: SAVED }, { status: 200, body: { ok: true, label: 'Agent 1', agent: saved } }])
  const h = harness({ fetch: s.fetch })
  await h.R.load()
  h.box.append(pane().root)
  await h.R.act('settings', 'Agent 1')
  h.R.paneOpts(node).draft.spec = 'New.'
  h.R.paneOpts(node).draft.rules = ['One.']
  await h.R.act('save', 'Agent 1')
  const put = s.sent[1]
  assert.equal(put.url, '/api/agents/rules/Agent%201')
  assert.equal(put.init.method, 'PUT')
  assert.deepEqual(JSON.parse(put.init.body), { spec: 'New.', rules: ['One.'] })
  assert.equal(h.R.paneOpts(node).draft, null)
  assert.equal(h.R.paneOpts(node).entry.spec, 'New.')
})

test('a refused Save shows the server sentence calmly and keeps everything typed', async () => {
  const s = server([{ status: 200, body: SAVED }, { status: 400, body: { error: 'Rule 1 is too long. Keep each rule to 300 characters.' } }])
  const h = harness({ fetch: s.fetch })
  await h.R.load()
  const { root, slot } = pane()
  h.box.append(root)
  await h.R.act('settings', 'Agent 1')
  h.R.paneOpts(node).draft.spec = 'Kept text.'
  await h.R.act('save', 'Agent 1')
  const d = h.R.paneOpts(node).draft
  assert.equal(d.spec, 'Kept text.')
  assert.equal(d.saving, false)
  assert.match(slot.querySelector('[data-ar-error]').textContent, /Rule 1 is too long/)
})

test('a Save that cannot reach the dashboard keeps everything typed and says so in a calm line', async () => {
  const s = server([{ status: 200, body: SAVED }, new Error('offline')])
  const h = harness({ fetch: s.fetch })
  await h.R.load()
  const { root, slot } = pane()
  h.box.append(root)
  await h.R.act('settings', 'Agent 1')
  h.R.paneOpts(node).draft.spec = 'Still here.'
  await h.R.act('save', 'Agent 1')
  assert.equal(h.R.paneOpts(node).draft.spec, 'Still here.')
  assert.match(slot.querySelector('[data-ar-error]').textContent, /Could not save.*kept/)
})

test('a problem the page can see is said before anything is sent', async () => {
  const s = server([{ status: 200, body: SAVED }])
  const h = harness({ fetch: s.fetch })
  await h.R.load()
  const { root, slot } = pane()
  h.box.append(root)
  await h.R.act('settings', 'Agent 1')
  h.R.paneOpts(node).draft.spec = 'x'.repeat(2001)
  await h.R.act('save', 'Agent 1')
  assert.equal(s.sent.length, 1, 'no PUT')
  assert.match(slot.querySelector('[data-ar-error]').textContent, /too long/)
})

test('Escape closes an editor on show (and says it took the key); with none on show it leaves the key alone', async () => {
  const s = server([{ status: 200, body: SAVED }])
  const h = harness({ fetch: s.fetch })
  await h.R.load()
  assert.equal(h.R.escape(), false)
  h.box.append(pane().root)
  await h.R.act('settings', 'Agent 1')
  const before = h.redraws()
  assert.equal(h.R.escape(), true)
  assert.equal(h.R.paneOpts(node).draft, null)
  assert.equal(h.redraws(), before + 1)
  assert.equal(focused?.getAttribute('data-ar-act'), 'settings', 'the focus goes back to Settings')
})

// ═══ the Agents page: Escape closes the editor before it clears the node ═══

test('on the Agents page, Escape with the editor open closes the editor and keeps the node selected', async () => {
  const keys = []
  let detailsHtml = ''
  let escapes = 0
  const elStub = () => ({ addEventListener() {}, querySelector: () => elStub(), getBoundingClientRect: () => ({ top: 0 }), scrollIntoView() {}, set innerHTML(v) {} })
  let nodeShown
  const window = {
    UI: { data: () => ({ agents: [], worktrees: [] }), esc: s => String(s) },
    Shell: { ago: () => '', setStatus() {}, setTitle() {} },
    AgentCards: { renderChat() {} },
    PipelineDetails: { html: n => `node ${n.id}`, empty: () => 'empty' },
    PipelineView: { create: () => ({ update() {}, setPath() {}, setNode: id => (nodeShown = id) }) },
    PipelinePanel: { create: () => ({ update() {}, isOpen: () => true }) },
    PipelineTickets: { byNode: () => ({}), labelsOf: () => ({}), outputList: () => [], stepsToFetch: () => [] },
    FlowRoute: { highlight: () => null },
    AgentRules: { bind() {}, load() {}, paneOpts: () => ({}), paint: (_b, html) => ((detailsHtml = html), true), escape: () => (escapes++ === 0) },
  }
  const graph = { nodes: [{ id: 'agent-1', kind: 'agent', label: 'Agent 1', role: 'producer' }], edges: [] }
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ graph, tickets: [], builtAt: AT }) })
  const document = { getElementById: () => elStub(), addEventListener: (t, fn) => t === 'keydown' && keys.push(fn) }
  const ctx = { window, document, location: { hash: '#/agents' }, fetch, setTimeout }
  vm.runInNewContext(read('agents-page.js'), ctx)
  window.AgentsPage.open()
  await settle()
  window.AgentsPage.showNode('agent-1')
  assert.equal(detailsHtml, 'node agent-1')
  const press = () => { let prevented = false; for (const fn of keys) fn({ key: 'Escape', target: {}, defaultPrevented: false, preventDefault: () => (prevented = true) }); return prevented }
  assert.equal(press(), true, 'the editor took the key')
  assert.equal(nodeShown, 'agent-1', 'the node is still selected')
  assert.equal(detailsHtml, 'node agent-1')
  press() // the editor is closed now: this one clears the node
  assert.equal(nodeShown, null)
  assert.equal(detailsHtml, 'empty')
})

// ═══ Changes ═══

test('load keeps each agent changes for the pane; a Changes disclosure opened stays open through redraws', async () => {
  const body = { ...SAVED, changes: { 'Agent 1': [{ at: AT, text: 'Agent 1 got 1 new rule.' }] } }
  const s = server([{ status: 200, body }])
  const h = harness({ fetch: s.fetch })
  await h.R.load()
  assert.deepEqual(JSON.parse(JSON.stringify(h.R.paneOpts(node).changes)), [{ at: AT, text: 'Agent 1 got 1 new rule.' }])
  assert.equal(h.R.paneOpts(node).logOpen, false)
  const details = el('details', { 'data-ar-log': 'Agent 1' })
  const summary = el('summary', { 'data-ar-summary': '' })
  details.append(summary)
  h.box.append(details)
  for (const fn of h.box.listeners.click) fn({ target: summary })
  assert.equal(h.R.paneOpts(node).logOpen, true, 'opened: the next redraw draws it open')
  details.open = true
  for (const fn of h.box.listeners.click) fn({ target: summary })
  assert.equal(h.R.paneOpts(node).logOpen, false)
})

test('a successful Save shows its change at once (the PUT answer carries the changes)', async () => {
  const s = server([{ status: 200, body: SAVED }, { status: 200, body: { ok: true, label: 'Agent 1', agent: SAVED.agents['Agent 1'], changes: [{ at: AT, text: 'Agent 1 got a specification.' }] } }, { status: 200, body: SAVED }])
  const h = harness({ fetch: s.fetch })
  await h.R.load()
  h.box.append(pane().root)
  await h.R.act('settings', 'Agent 1')
  h.R.paneOpts(node).draft.spec = 'Other.'
  await h.R.act('save', 'Agent 1')
  assert.equal(h.R.paneOpts(node).changes[0].text, 'Agent 1 got a specification.')
})
