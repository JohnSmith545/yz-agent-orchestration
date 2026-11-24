// Tests for how the Agents page (public/agents-page.js) opens an agent's settings window (agent-window.js): a click on
// an agent box opens the window and puts the agent in the address; a click on a step keeps the pane; an address that
// names an agent opens its window once the graph is read; closing the window takes that part off the address; and
// Escape is left to the window while it is open. agents-page.js runs in a vm with stub collaborators.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const AT = '2026-11-24T10:00:00Z'
const graph = {
  nodes: [
    { id: 'request', kind: 'start', label: 'Request', role: 'request' },
    { id: 'master', kind: 'agent', label: 'Master', role: 'coordinator' },
    { id: 'agent-1', kind: 'agent', label: 'Agent 1', role: 'producer' },
    { id: 'push', kind: 'step', label: 'Push', role: 'push' },
  ],
  edges: [],
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)) }

function harness(hash = '#/agents') {
  const calls = { open: [], close: 0, replaced: [] }
  let attached = null
  let isOpen = false
  let onNode = null
  let detailsHtml = ''
  let keydown = null
  const el = () => ({ addEventListener() {}, querySelector: () => el(), getBoundingClientRect: () => ({ top: 0 }), scrollIntoView() {}, set innerHTML(v) {} })
  const window = {
    UI: { data: () => ({ agents: [], worktrees: [] }), esc: s => String(s) },
    Shell: { ago: () => '', setStatus() {}, setTitle() {} },
    AgentCards: { renderChat() {} },
    PipelineDetails: { html: n => `node ${n.id}`, empty: () => 'empty' },
    PipelineView: { create: (_b, o) => ((onNode = o.onNode), { update() {}, setPath() {}, setNode() {} }) },
    PipelinePanel: { create: () => ({ update() {}, isOpen: () => true }) },
    PipelineTickets: { byNode: () => ({}), labelsOf: () => ({}), outputList: () => [], stepsToFetch: () => [] },
    FlowRoute: { highlight: () => null },
    AgentRules: { load() {}, paneOpts: () => ({}), paint: (_b, html) => ((detailsHtml = html), true), escape: () => false },
    AgentWindow: {
      attach: o => (attached = o),
      open: (id, from) => { calls.open.push(id); isOpen = true },
      close: () => { calls.close++; isOpen = false },
      refresh() {},
      isOpen: () => isOpen,
      current: () => (isOpen ? graph.nodes.find(n => n.id === calls.open.at(-1))?.label : null),
    },
  }
  const location = { hash }
  const history = { replaceState: (_s, _t, h) => { calls.replaced.push(h); location.hash = h } }
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ graph, tickets: [], builtAt: AT }) })
  const document = { getElementById: () => el(), addEventListener: (t, fn) => t === 'keydown' && (keydown = fn) }
  vm.runInNewContext(read('agents-page.js'), { window, document, location, history, fetch, setTimeout, CSS: { escape: s => s }, URLSearchParams })
  return { page: window.AgentsPage, calls, location, attached: () => attached, click: id => onNode(id), details: () => detailsHtml, close: () => { isOpen = false; attached.onClose() }, key: e => keydown(e) }
}

test('a click on an agent box opens its window and names it in the address; a click on a step keeps the pane', async () => {
  const h = harness()
  h.page.open()
  await settle()
  h.click('agent-1')
  assert.deepEqual(h.calls.open, ['agent-1'])
  assert.equal(h.location.hash, '#/agents?agent=Agent%201')
  assert.notEqual(h.details(), 'node agent-1', 'the pane does not take the agent')
  h.click('push')
  assert.equal(h.details(), 'node push')
  assert.equal(h.calls.open.length, 1)
})

test('an address that names an agent opens its window once the graph is read; an unknown one opens nothing', async () => {
  const h = harness('#/agents?agent=Master')
  h.page.open()
  await settle()
  assert.deepEqual(h.calls.open, ['master'])
  const none = harness('#/agents?agent=Nobody')
  none.page.open()
  await settle()
  assert.deepEqual(none.calls.open, [])
})

test('closing the window takes the agent off the address', async () => {
  const h = harness()
  h.page.open()
  await settle()
  h.click('master')
  h.close()
  assert.equal(h.location.hash, '#/agents')
})

test('Escape is the window own while it is open: the page clears nothing', async () => {
  const h = harness()
  h.page.open()
  await settle()
  h.click('push')
  h.click('agent-1')
  let prevented = false
  h.key({ key: 'Escape', target: {}, defaultPrevented: false, preventDefault: () => (prevented = true) })
  assert.equal(prevented, false)
  assert.equal(h.details(), 'node push', 'the step stays shown under the window')
})
