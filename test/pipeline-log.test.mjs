// Tests for the Log in the Agents page pull-out panel: public/pipeline-log.js (the pure half: filters, the query,
// the chips and the list HTML) in a vm with a bare window, the panel's third mode, the scorecard's See these in
// the log links, and the wiring greps (script order, npm run check, no class shared with the palette).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const ctx = vm.createContext({ window: {} })
for (const f of ['shell.js', 'app.js', 'score-view.js', 'pipeline-log.js', 'pipeline-panel.js']) vm.runInContext(read(f), ctx)
const L = ctx.window.PipelineLog
const plain = v => JSON.parse(JSON.stringify(v))

const NOW = Date.now()
const ago = ms => new Date(NOW - ms).toISOString()
const EVENTS = [
  { at: ago(2 * 3600_000), kind: 'failed', flow: { id: 'f1', title: 'Fix <login>' }, agent: 'QA', text: 'QA failed this and sent it back to Agent 1.', cell: 'caught' },
  { at: ago(3 * 3600_000), kind: 'handed', flow: { id: 'f1', title: 'Fix <login>' }, agent: 'Agent 1', text: 'Agent 1 handed this to QA.', cell: null },
  { at: ago(4 * 3600_000), kind: 'rule', flow: null, agent: 'Master', text: 'Master changed a rule.', cell: null },
]
const DATA = { events: EVENTS, total: 3, window: { days: 30 } }

test('the filters: All, Delivered, Caught, Missed, Slipped through, Rules; anything else is All', () => {
  assert.deepEqual(plain(L.FILTERS.map(f => [f.key, f.label])), [['all', 'All'], ['delivered', 'Delivered'], ['caught', 'Caught'], ['missed', 'Missed'], ['slipped', 'Slipped through'], ['rule', 'Rules']])
  assert.equal(L.filterOf('caught'), 'caught')
  for (const v of [null, '', 'x', 'started']) assert.equal(L.filterOf(v), 'all', String(v))
})

test('the query follows the window and the filter: a cell, or kind=rule for Rules', () => {
  assert.equal(L.queryOf('30', 'all'), '/api/log?days=30')
  assert.equal(L.queryOf('7', 'caught'), '/api/log?days=7&cell=caught')
  assert.equal(L.queryOf('all', 'rule'), '/api/log?days=all&kind=rule')
  assert.equal(L.queryOf(null, 'junk'), '/api/log?days=30')
})

test('the chips: one pressed, the rest not, in a labelled group', () => {
  const html = L.chipsHtml('missed')
  assert.match(html, /role="group" aria-label="Show in the log"/)
  assert.match(html, /<button type="button" data-log-chip="missed" aria-pressed="true">Missed<\/button>/)
  assert.match(html, /<button type="button" data-log-chip="all" aria-pressed="false">All<\/button>/)
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1)
})

test('a row: the short time, the sentence, the flow title escaped, and the quiet tag when it counted', () => {
  const html = L.listHtml({ data: DATA }, { selected: null, win: '30' })
  assert.match(html, /<button type="button" class="lg-row" data-ticket="f1" aria-pressed="false">/)
  assert.match(html, /<time class="lg-time" datetime="[^"]+" title="[^"]+">2h<\/time>/)
  assert.match(html, /<span class="lg-text">QA failed this and sent it back to Agent 1\.<\/span>/)
  assert.match(html, /<span class="lg-flow">Fix &lt;login&gt;<\/span>/)
  assert.match(html, /<span class="lg-tag">Counted: right, caught<\/span>/)
  assert.equal((html.match(/lg-tag/g) || []).length, 1, 'only the event that counted carries a tag')
  assert.doesNotMatch(html, /<login>/)
})

test('a row of the selected flow is pressed; an event with no flow is not a button', () => {
  const html = L.listHtml({ data: DATA }, { selected: 'f1', win: '30' })
  assert.equal((html.match(/data-ticket="f1" aria-pressed="true"/g) || []).length, 2)
  assert.match(html, /<div class="lg-row lg-plain"><span class="lg-top"><time/)
})

test('each cell tag in plain words', () => {
  assert.deepEqual(plain(L.TAG), { delivered: 'Counted: right, delivered', caught: 'Counted: right, caught', missed: 'Counted: wrong, missed', slipped: 'Counted: wrong, slipped through' })
})

test('the line above the list: how many, over which window, and the cut at 300', () => {
  assert.match(L.listHtml({ data: DATA }, { win: '30' }), /<p class="lg-sum">3 events in the last 30 days\.<\/p>/)
  assert.match(L.listHtml({ data: { events: EVENTS.slice(0, 1), total: 1 } }, { win: 'all' }), /1 event in all time\./)
  assert.match(L.listHtml({ data: { events: EVENTS, total: 412 } }, { win: '7' }), /Showing the newest 3 of 412 in the last 7 days\./)
  assert.match(L.listHtml({ data: { events: [], total: 0 } }, { win: '7', filter: 'caught' }), /Nothing caught in the last 7 days\./)
  assert.match(L.listHtml({ data: { events: [], total: 0 } }, { win: '7', filter: 'all' }), /Nothing in the log in the last 7 days\./)
  assert.match(L.listHtml({ data: null }, { win: '7' }), /Loading the log…/)
  const failed = L.listHtml({ data: DATA, failure: 'offline <b>' }, { win: '30' })
  assert.match(failed, /Could not load the log: offline &lt;b&gt;/)
  assert.match(failed, /lg-row/, 'the last list stays')
})

test('the panel: a third mode, Log, remembered like the others', () => {
  const P = ctx.window.PipelinePanel
  assert.equal(P.modeOf('log'), 'log')
  assert.equal(P.modeOf('outputs'), 'outputs')
  assert.equal(P.modeOf('junk'), 'tickets')
  const src = read('pipeline-panel.js')
  assert.match(src, /data-mode="log">Log<\/button>/)
  assert.match(src, /addEventListener\('pipeline-log'/)
  assert.match(src, /addEventListener\('score-window'/)
  assert.match(src, /scrollTop/, 'a refresh keeps the scroll position')
  assert.match(src, /rows\(\)\[at\]\?\.focus\(/, 'a keyboard selection keeps the focus on its row (it was lost in the browser check)')
})

test('the scorecard: each of the four counts has See these in the log, naming its filter', () => {
  const V = ctx.window.ScoreView
  const html = V.howHtml({ window: { days: 30, stallDays: 7 }, counts: { delivered: 1, slipped: 0, missed: 0, caught: 0 }, lists: {}, correctness: {}, agents: [], inFlight: 0 })
  for (const f of ['delivered', 'slipped', 'missed', 'caught']) {
    assert.match(html, new RegExp(`<button type="button" class="link psc-seelog" data-log-filter="${f}">See these in the log</button>`), f)
  }
  const strip = read('score-strip.js')
  assert.match(strip, /new CustomEvent\('pipeline-log', \{ bubbles: true, detail: \{ filter/)
  assert.match(strip, /new CustomEvent\('score-window', \{ bubbles: true/)
  assert.match(strip, /windowNow/)
})

test('wired in: pipeline-log.js before pipeline-panel.js, checked by npm run check; classes not the palette ones', () => {
  const html = read('index.html')
  const at = s => html.indexOf(`<script src="${s}"></script>`)
  assert.ok(at('pipeline-log.js') > 0 && at('pipeline-log.js') < at('pipeline-panel.js'))
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  for (const f of ['score-log.mjs', 'public/pipeline-log.js']) assert.match(pkg.checkList, new RegExp(`node --check ${f.replace('.', '\\.')}`), f)
  for (const f of fs.readdirSync(PUBLIC).filter(f => f.endsWith('.css') && f !== 'score.css')) assert.doesNotMatch(read(f), /\.lg-/, f)
  assert.doesNotMatch(read('pipeline-log.js') + read('pipeline-panel.js'), /—/)
})
