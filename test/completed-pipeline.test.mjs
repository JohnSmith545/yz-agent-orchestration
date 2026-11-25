// Tests for Completed on the Agents page: a completed flow leaves the diagram (its chips on every box) and both panel
// lists, even with Show archived; a flow that waits for sign-off carries the amber mark (on its chip, in its tooltip,
// and in words on its Output row with a Completed tick); the Output box (public/pipeline-output.js) says how many wait
// and how many are overdue, in the notice colour once piled up, like the Human task box says what waits on you; and
// the wiring greps. Browser files in a vm with a bare window.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const ctx = vm.createContext({ window: {} })
for (const f of ['completed-view.js', 'pipeline-tickets.js', 'pipeline-details.js', 'pipeline-human.js', 'pipeline-output.js', 'pipeline-view.js']) vm.runInContext(read(f), ctx)
const { PipelineTickets: T, PipelineOutput: O, PipelineView: V, CompletedView: C } = ctx.window
const plain = v => JSON.parse(JSON.stringify(v))
const count = (html, re) => (html.match(re) || []).length
const OUTPUT = { id: 'outcome', kind: 'end', label: 'Output', role: 'outcome' }

let n = 0
const tk = (node, extra = {}) => ({
  id: extra.id || `t${++n}`, title: extra.title || `Ticket ${n}`, agent: 'Agent 1', status: node === 'outcome' ? 'done' : 'open',
  stage: { node, status: node === 'outcome' ? 'done' : 'working', path: [] }, qa: null, codeProducing: false, hasOutput: true,
  archived: false, completed: false, waiting: node === 'outcome', updatedAt: `2026-11-2${n % 10}T10:00:00Z`, ...extra,
})
const signed = extra => tk('outcome', { completed: true, archived: true, waiting: false, ...extra })
const sum = (k, { overdue = 0, max = 7 } = {}) => ({ waiting: Array.from({ length: k }, (_, i) => ({ id: `w${i}`, overdue: i < overdue })), counts: { waiting: k, overdue }, max, warnAfterDays: 2, piled: k >= max })

// ═══ purged ═══

test('a completed flow is no chip on any box, and in neither panel list, even with Show archived', () => {
  const list = [tk('outcome', { id: 'live' }), signed({ id: 'gone' }), tk('agent-1', { id: 'busy' }), tk('agent-1', { id: 'gone-2', completed: true, archived: true })]
  const groups = T.byNode(list)
  assert.deepEqual(plain(Object.values(groups).flat().map(t => t.id)).sort(), ['busy', 'live'])
  for (const archived of [false, true]) {
    assert.deepEqual(plain(T.ticketList(list, { archived }).map(t => t.id)).sort(), ['busy', 'live'], `tickets, archived ${archived}`)
    assert.deepEqual(plain(T.outputList(list, { archived }).map(t => t.id)), ['live'], `outputs, archived ${archived}`)
  }
})

test('Outputs lists every finished flow that waits for sign-off, with output or not; the rest as before', () => {
  const bare = tk('outcome', { id: 'bare', hasOutput: false })
  const old = tk('outcome', { id: 'old', hasOutput: false, waiting: false })
  assert.deepEqual(plain(T.outputList([bare, old]).map(t => t.id)), ['bare'])
})

// ═══ the amber mark ═══

test('a chip that waits for sign-off has the amber dot and says Mark it completed in its tooltip; others do not', () => {
  const html = T.chipHtml(tk('outcome', { id: 'w', title: 'Ship <it>' }), {})
  assert.match(html, /^<button type="button" class="pl-chip is-waiting" data-ticket="w" title="[^"]*Mark it completed"><i class="cv-dot" aria-hidden="true"><\/i>Ship &lt;it&gt;<\/button>$/)
  const busy = T.chipHtml(tk('agent-1', { id: 'b' }), {})
  assert.doesNotMatch(busy, /cv-dot|Mark it completed/)
})

test('an Output row that waits: the mark in words and a Completed tick that asks once; none on one that does not wait', () => {
  C.setData(sum(1, { overdue: 1 }))
  const html = T.outputsHtml([tk('outcome', { id: 'w0', title: 'Ship it' })], {})
  assert.match(html, /<span class="cv-mark is-over">.*Mark it completed, waiting over 2 days<\/span>/)
  assert.match(html, /<div class="pl-out-acts">.*data-explain="w0".*<span class="cv-confirm">.*aria-label="Mark Ship it completed".*data-cv-yes data-cv-ids="w0">Completed<\/button>/)
  const archived = T.outputsHtml([tk('outcome', { id: 'a', archived: true, waiting: false })], {})
  assert.doesNotMatch(archived, /cv-mark|cv-confirm/)
  C.setData(null)
})

test('the Output list head: how many wait, overdue, and Mark all completed when more than one; nothing at 0', () => {
  assert.equal(T.outputsHeadHtml(sum(0)), '')
  const one = T.outputsHeadHtml(sum(1))
  assert.match(one, /<div class="cv-box-head"><span class="cv-head">1 waiting<\/span><\/div>/)
  const many = T.outputsHeadHtml(sum(8, { overdue: 2 }))
  assert.match(many, /cv-head is-notice">8 waiting · 2 overdue</)
  assert.match(many, />Mark all completed<\/button>/)
})

// ═══ the Output box on the diagram ═══

test('the Output box: its count lines (waiting, then overdue), up to three chips and +N; notice colour once piled', () => {
  const list = [1, 2, 3, 4, 5].map(i => tk('outcome', { id: `o${i}` }))
  const html = O.inner(OUTPUT, { list, labels: {}, outputs: sum(5, { overdue: 1 }) })
  assert.match(html, /<span class="pl-name">Output<\/span>/)
  assert.match(html, /<p class="pl-out-count"><i class="cv-dot" aria-hidden="true"><\/i>5 waiting<\/p><p class="pl-out-count is-over"><i class="cv-dot" aria-hidden="true"><\/i>1 overdue<\/p>/)
  assert.equal(count(html, /class="pl-chip[ "]/g), 3)
  assert.match(html, />\+2</)
  assert.match(html, /aria-label="Output: 5 waiting for your sign-off, 1 overdue\. Show details\."/)
  const piled = O.inner(OUTPUT, { list, outputs: sum(8) })
  assert.match(piled, /class="pl-out-count is-notice"/)
  const none = O.inner(OUTPUT, { list: [], outputs: sum(0) })
  assert.doesNotMatch(none, /pl-out-count|pl-chips/)
  assert.equal(O.rows([], sum(0)), 0)
  assert.equal(O.rows(list, sum(5, { overdue: 1 })), 5, 'two count lines and three chips')
  assert.equal(O.rows(list.slice(0, 1), sum(1)), 2)
})

test('pipeline-view draws the Output box with pipeline-output.js only on the live page (outputs given); a saved one as before', () => {
  const list = [tk('outcome', { id: 'o1' })]
  assert.match(V.nodeInner(OUTPUT, { list, outputs: sum(1) }), /pl-out-count/)
  assert.doesNotMatch(V.nodeInner(OUTPUT, { list }), /pl-out-count/, 'the bank page: no live count behind it')
})

// ═══ wiring ═══

test('wired in: the Agents page line over the diagram, the panel head and its Show them event, the redraw on a change', () => {
  const page = read('agents-page.js')
  assert.match(page, /<div class="pl-outputs" id="plOutputs" data-cv-line hidden><\/div>\s*<div class="pl-wrap" id="plDiagram">/)
  assert.match(page, /addEventListener\('outputs:change'/)
  const panel = read('pipeline-panel.js')
  assert.match(panel, /addEventListener\('pipeline-outputs'/)
  assert.match(panel, /outputsHeadHtml/)
  const view = read('pipeline-view.js')
  assert.match(view, /addEventListener\('outputs:change'/)
  const html = read('index.html')
  const at = s => html.indexOf(`<script src="${s}"></script>`)
  assert.ok(at('pipeline-output.js') > 0 && at('pipeline-output.js') < at('pipeline-view.js'))
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  assert.match(pkg.scripts.check, /node --check public\/pipeline-output\.js/)
  assert.match(read('pipeline-details.js'), /mark it completed/i, 'the Output step says what Completed does')
})

test('a sign-off while the pipeline is being read asks for one more read, so the completed rows never linger', () => {
  const page = read('agents-page.js')
  assert.match(page, /if \(loading\) return void \(again \|\|= fresh\)/)
  assert.match(page, /if \(again\) \{\s*again = false\s*loadPipeline\(\)/)
  assert.match(page, /addEventListener\('outputs:change', \(\) => showing && loadPipeline\(true\)\)/)
})
