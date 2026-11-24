// Tests for public/pipeline-tickets.js: the tickets of /api/pipeline grouped onto the diagram's nodes (chips
// with a +N), their colour by meaning only, the side panel's Tickets list (needs attention first) and Outputs
// list (finished work with output or a QA pass), and where Explain and How to test go. Browser file in a vm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { pipelineGraph } from '../pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const window = {}
const ctx = { window, location: { hash: '#/agents' } }
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'pipeline-tickets.js'), 'utf8'), ctx)
const T = window.PipelineTickets
const plain = v => JSON.parse(JSON.stringify(v))
const G = pipelineGraph({ coordinator: 'Master', codingAgents: { Master: 'Master' }, pipeline: { producers: ['Agent 1', 'Agent 2'] } })
const labels = T.labelsOf(G)

let n = 0
const tk = (node, status, extra = {}) => ({
  id: extra.id || `t${++n}`,
  title: extra.title || `Ticket ${n}`,
  agent: 'Agent 1',
  status: extra.flow || (node === 'outcome' ? 'done' : 'open'),
  stage: { node, status, path: ['request', 'master', node].filter(Boolean), reworks: 0 },
  qa: extra.qa ?? null,
  codeProducing: extra.codeProducing ?? true,
  hasOutput: extra.hasOutput ?? false,
  archived: extra.archived ?? false,
  updatedAt: extra.updatedAt || `2026-11-2${n % 10}T10:00:00Z`,
})

// ═══ colour and words ═══

test('a chip is green only for passed, red only for a failure, neutral for everything else', () => {
  assert.equal(T.tone(tk('outcome', 'passed')), 'ok')
  assert.equal(T.tone(tk('qa', 'failed')), 'bad')
  assert.equal(T.tone(tk('agent-1', 'rework')), 'bad')
  assert.equal(T.tone(tk('push', 'failed')), 'bad')
  assert.equal(T.tone(tk('qa', 'x', { qa: { status: 'qa-failed' } })), 'bad')
  for (const s of ['working', 'blocked', 'waiting', 'pending', 'testing', 'done']) assert.equal(T.tone(tk('qa', s)), '', s)
})

test('each stage status reads as a plain word', () => {
  assert.equal(T.word(tk('agent-1', 'working')), 'Working')
  assert.equal(T.word(tk('agent-1', 'rework')), 'Sent back')
  assert.equal(T.word(tk('qa', 'pending')), 'Queued')
  assert.equal(T.word(tk('push', 'failed')), 'Failed')
  assert.equal(T.word({ stage: null }), 'Dropped')
})

// ═══ chips on the nodes ═══

test('tickets group onto their stage node; dropped and archived ones stay off the diagram', () => {
  const list = [tk('agent-1', 'working'), tk('agent-1', 'working'), tk('qa', 'testing'), tk(null, 'dropped'), tk('qa', 'testing', { archived: true })]
  const g = T.byNode(list)
  assert.deepEqual(Object.keys(g).sort(), ['agent-1', 'qa'])
  assert.equal(g['agent-1'].length, 2)
  assert.equal(g.qa.length, 1)
})

test('a node shows at most four chips, the rest as +N', () => {
  const six = Array.from({ length: 6 }, () => tk('qa', 'testing'))
  const c = T.chips(six)
  assert.equal(c.shown.length, 4)
  assert.equal(c.more, 2)
  assert.equal(T.chips(six.slice(0, 3)).more, 0)
})

test('the chip rows the boxes need are the most chips any node shows', () => {
  assert.equal(T.chipRows({}), 0)
  assert.equal(T.chipRows({ a: [1, 2], b: [1] }), 2)
  assert.equal(T.chipRows({ a: [1, 2, 3, 4, 5, 6, 7] }), 4)
})

test('a chip carries the ticket id, its colour class and the status as text in its tooltip', () => {
  const html = T.chipHtml(tk('qa', 'failed', { id: 'dark-mode', title: 'Dark <mode>' }), labels)
  assert.match(html, /data-ticket="dark-mode"/)
  assert.match(html, /class="pl-chip t-bad"/)
  assert.match(html, /title="Dark &lt;mode&gt; · QA · Failed"/)
  assert.match(html, />Dark &lt;mode&gt;</)
})

// ═══ the side panel: Tickets ═══

test('Tickets: failed, sent back and waiting come first, then the newest', () => {
  const list = [
    tk('agent-1', 'working', { id: 'new', updatedAt: '2026-11-24T10:00:00Z' }),
    tk('qa', 'waiting', { id: 'wait', updatedAt: '2026-11-20T10:00:00Z' }),
    tk('agent-2', 'rework', { id: 'back', updatedAt: '2026-11-19T10:00:00Z' }),
    tk('qa', 'failed', { id: 'fail', updatedAt: '2026-11-18T10:00:00Z' }),
    tk('outcome', 'done', { id: 'old', updatedAt: '2026-11-17T10:00:00Z' }),
    tk('agent-1', 'working', { id: 'arch', archived: true }),
  ]
  assert.deepEqual(plain(T.ticketList(list).map(t => t.id)), ['fail', 'back', 'wait', 'new', 'old'])
  assert.ok(T.ticketList(list, { archived: true }).some(t => t.id === 'arch'), 'Show archived lists them too')
})

test('a Tickets row is the title, the stage it is at and the status word, pressed when selected', () => {
  const html = T.ticketsHtml([tk('agent-2', 'rework', { id: 'x1', title: 'Fix login' })], { labels, selected: 'x1' })
  assert.match(html, /data-ticket="x1"[^>]*aria-pressed="true"/)
  assert.match(html, />Fix login</)
  assert.match(html, />Agent 2</)
  assert.match(html, /class="pl-word t-bad">Sent back</)
  assert.match(T.ticketsHtml([], { labels }), /class="empty"/)
})

// ═══ the side panel: Outputs ═══

test('Outputs: finished tickets with output or a QA pass, newest first', () => {
  const list = [
    tk('outcome', 'passed', { id: 'pass', qa: { status: 'passed' }, updatedAt: '2026-11-20T10:00:00Z' }),
    tk('outcome', 'done', { id: 'out', hasOutput: true, codeProducing: false, updatedAt: '2026-11-22T10:00:00Z' }),
    tk('outcome', 'done', { id: 'bare', hasOutput: false, codeProducing: false }),
    tk('qa', 'testing', { id: 'busy', hasOutput: true }),
    tk('push', 'waiting', { id: 'pushing', flow: 'done', hasOutput: true, qa: { status: 'passed' }, updatedAt: '2026-11-21T10:00:00Z' }),
  ]
  assert.deepEqual(plain(T.outputList(list).map(t => t.id)), ['out', 'pushing', 'pass'])
})

test('an Outputs row has the QA result word and the Explain and How to test actions', () => {
  const html = T.outputsHtml([tk('outcome', 'passed', { id: 'p1', title: 'Ship it', qa: { status: 'passed' } }), tk('outcome', 'done', { id: 'p2', hasOutput: true, codeProducing: false })], {})
  assert.match(html, /class="pl-word t-ok">Passed</)
  assert.match(html, />No code changes</)
  assert.match(html, /data-explain="p1"[^>]*>Explain</)
  assert.match(html, /data-test="p1"[^>]*>How to test</)
})

// ═══ where the actions go ═══

test('Explain opens the explanation on Flows, falling back to the flow itself', () => {
  const calls = []
  window.FlowsView = { gotoFlow: id => calls.push(['goto', id]) }
  T.explain('a')
  window.FlowsView.explain = id => calls.push(['explain', id])
  T.explain('b')
  assert.deepEqual(calls, [['goto', 'a'], ['explain', 'b']])
})

test('How to test opens the QA page at the ticket, or the QA page when it cannot', () => {
  delete window.QaPage
  T.howToTest('a')
  assert.equal(ctx.location.hash, '#/qa')
  const calls = []
  window.QaPage = { gotoFlow: id => calls.push(id) }
  T.howToTest('b')
  assert.deepEqual(calls, ['b'])
})
