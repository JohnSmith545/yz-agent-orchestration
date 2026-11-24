// Regression test from QA (2026-11-24): a step clicked in a flow's head opens the Agents page with that node
// shown and that flow selected (AgentsPage.showNode). Whatever it lights, the flow's row in the side panel shows
// as selected, so a click on that row visibly clears the path and a click on another row selects that one.
// QA saw the first row click draw nothing and the second draw the path. The cause: open() drew at once with the
// pipeline the page had read on an EARLIER visit, and a flow missing from that stale list had its selection
// dropped before the fresh list arrived, so nothing was lit and no row was pressed.
//
// agents-page.js runs in a vm with stub collaborators that record what it asks them to draw; the route pieces
// (flow-route.js, pipeline-tickets.js) are the real ones, over a real graph and real progress.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-select-test-'))
const { DEFAULT_PIPELINE, pipelineGraph, stageOf } = await import('../pipeline.mjs')
const { withRoute } = await import('../flow-route.mjs')
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')

const graph = pipelineGraph({ coordinator: 'Master', coordinatorLabel: 'Master', codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1' }, pipeline: { ...DEFAULT_PIPELINE } })
const at = '2026-11-24T10:00:00Z'
function ticket(id, agent) {
  const f = { id, title: `Flow ${id}`, agent, status: 'open', createdAt: at, updatedAt: at, nodes: [] }
  return { id, title: f.title, agent, tickets: [], status: 'open', stage: stageOf(f, graph), ...withRoute(f, graph), qa: null, codeProducing: false, hasOutput: false, archived: false, updatedAt: at }
}
const OLD = { graph, tickets: [ticket('f2', 'Agent 1')], builtAt: at } // what an earlier visit read: no f1 yet
const NEW = { graph, tickets: [ticket('f1', 'Master'), ticket('f2', 'Agent 1')], builtAt: at }

/** The page in a vm: what it last asked the diagram and the panel to show, and a shell that opens it on #/agents. */
function harness() {
  const drawn = { path: undefined, node: undefined, selected: undefined }
  let served = OLD
  let onSelect = null
  const el = () => ({ addEventListener() {}, querySelector: () => el(), getBoundingClientRect: () => ({ top: 0 }), scrollIntoView() {}, set innerHTML(v) {} })
  const window = {
    UI: { data: () => ({ agents: [], worktrees: [] }), esc: s => String(s) },
    Shell: { ago: () => '', setStatus() {}, setTitle() {} },
    AgentCards: { renderChat() {} },
    PipelineDetails: { html: () => '', empty: () => '' },
    PipelineView: { create: () => ({ update() {}, setPath: h => (drawn.path = h), setNode: id => (drawn.node = id) }) },
    PipelinePanel: { create: (_, o) => ((onSelect = o.onSelect), { update: (_p, sel) => (drawn.selected = sel), isOpen: () => true }) },
  }
  let hash = ''
  const location = {
    get hash() { return hash },
    set hash(v) { // the shell: a new hash closes the page it leaves and opens the one it names
      hash = v
      if (v === '#/agents') window.AgentsPage.open()
    },
  }
  const fetch = async url => ({ ok: true, status: 200, json: async () => (url === '/api/pipeline' ? structuredClone(served) : {}), text: async () => '' })
  const ctx = { window, document: { getElementById: () => el(), addEventListener() {} }, location, fetch, setTimeout }
  for (const f of ['flow-route.js', 'pipeline-tickets.js', 'agents-page.js']) vm.runInNewContext(read(f), ctx)
  return {
    page: window.AgentsPage, drawn, location,
    serve: p => (served = p),
    select: id => onSelect(id),
  }
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)) }

test('showNode after an earlier visit: the flow stays selected while the fresh pipeline loads, so its path is lit and its row pressed', async () => {
  const h = harness()
  h.location.hash = '#/agents' // an earlier visit reads the pipeline as it was then
  await settle()
  h.page.close()
  h.location.hash = '#/flows'
  h.serve(NEW) // the flow was started since
  h.page.showNode('master', 'f1')
  await settle()
  assert.equal(h.drawn.selected, 'f1', 'its row in the panel shows as selected')
  assert.equal(h.drawn.node, 'master', 'the node clicked in the head is the one shown')
  assert.ok(h.drawn.path?.nodes?.includes('master'), 'its route is lit')
})

test('a click on the selected row visibly clears the path; a click on another row selects that one', async () => {
  const h = harness()
  h.serve(NEW)
  h.page.showNode('master', 'f1')
  await settle()
  assert.equal(h.drawn.selected, 'f1')
  assert.ok(h.drawn.path)
  h.select('f1')
  assert.equal(h.drawn.selected, null)
  assert.equal(h.drawn.path, null, 'the same row again clears the path')
  h.page.showNode('master', 'f1')
  h.select('f2')
  assert.equal(h.drawn.selected, 'f2')
  assert.ok(h.drawn.path?.nodes?.includes('agent-1'), 'another row lights that flow instead')
})

test('a selection that is really gone is still dropped once the fresh pipeline has been read', async () => {
  const h = harness()
  h.serve(OLD)
  h.page.showNode('master', 'f1')
  await settle()
  assert.equal(h.drawn.selected, null)
  assert.equal(h.drawn.path, null)
})
