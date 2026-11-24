// Tests for the Explain tab of an opened flow (public/flow-explain.js: the slides
// and the path chart, pure; public/flow-explain-view.js: their markup) and for the
// QA state in the opened flow's head (public/flow-qa-line.js). Browser scripts in
// a vm with a stub window; FACTORY_DATA_DIR points at a fresh temp folder BEFORE
// flows.mjs is imported (derive builds the story lines the slides read).

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-explain-test-'))
const { derive, DATA_DIR } = await import('../flows.mjs')
const { pipelineGraph, stageOf } = await import('../pipeline.mjs')
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const SCRIPTS = ['shell.js', 'terms.js', 'flow-chart.js', 'diagram-fit.js', 'diagram-route.js', 'diagram.js', 'flow-picture.js', 'flow-drawer.js',
  'lightbox.js', 'flow-tabs.js', 'flow-story.js', 'flow-compare.js', 'flow-visual.js', 'flow-steps.js', 'flow-send.js', 'flow-output.js',
  'flow-head.js', 'flow-qa-line.js', 'flow-explain.js', 'flow-explain-view.js']
const memory = new Map()
const ctx = { window: {}, localStorage: { getItem: k => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, String(v)) }, URL }
for (const f of SCRIPTS) vm.runInNewContext(read(f), ctx)
const { window } = ctx
const X = window.FlowExplain
const XV = window.FlowExplainView
const Q = window.FlowQa
const plain = v => JSON.parse(JSON.stringify(v))
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const DARK = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
const NOVIS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const fx = (base, edit = () => {}) => {
  const f = structuredClone(base)
  edit(f)
  f.derived = derive(f)
  return f
}
const CONFIG = { coordinatorLabel: 'Coordinator', codingAgents: { a: 'Agent 1', b: 'Agent 2', c: 'Agent 3' }, pipeline: { qa: 'QA' } }
const GRAPH = pipelineGraph(CONFIG)
const ticketOf = f => ({ id: f.id, stage: stageOf(f, GRAPH), qa: f.qa || null })
const commit = f => { f.nodes[0].evidence = [...(f.nodes[0].evidence || []), { kind: 'commit', ref: 'abc1234', label: 'c' }] }
const QA = (over = {}) => ({ status: 'passed', attempt: 1, by: 'QA', at: '2026-11-24T11:00:00Z', commit: 'cd34ef5a1b2c', branch: 'feature/dark-mode', summary: 'All checks pass.', report: 'dark-mode/qa-1-report.md', shots: [], steps: [{ do: 'Open it', expect: 'It opens' }], pushedAt: '2026-11-24T11:05:00Z', rework: null, attempts: [], ...over })

// ═══ the path chart ═══

test('pathGraph: only the visited nodes, in the order first visited, joined in order; a repeated hop drawn once', () => {
  const g = plain(X.pathGraph({ node: 'push', status: 'waiting', path: ['request', 'coordinator', 'agent-3', 'qa', 'agent-3', 'qa', 'push'], reworks: 1 }, GRAPH))
  assert.deepEqual(g.nodes.map(n => n.id), ['request', 'coordinator', 'agent-3', 'qa', 'push'])
  assert.deepEqual(g.nodes.map(n => n.label), ['Request', 'Coordinator', 'Agent 3', 'QA', 'Push'])
  assert.deepEqual(g.edges.map(e => `${e.from}>${e.to}`), ['request>coordinator', 'coordinator>agent-3', 'agent-3>qa', 'qa>agent-3', 'qa>push'])
})

test('pathGraph: the rework is a return arrow labelled from the pipeline (failed, ×N when it went back more than once)', () => {
  const once = plain(X.pathGraph({ node: 'agent-3', status: 'rework', path: ['request', 'coordinator', 'agent-3', 'qa', 'agent-3'], reworks: 1 }, GRAPH))
  const back = once.edges.find(e => e.from === 'qa' && e.to === 'agent-3')
  assert.equal(back.label, 'failed')
  assert.equal(back.cls, 'xp-rework')
  const twice = plain(X.pathGraph({ node: 'qa', status: 'testing', path: ['request', 'coordinator', 'agent-3', 'qa', 'agent-3', 'qa', 'agent-3', 'qa'], reworks: 2 }, GRAPH))
  assert.equal(twice.edges.find(e => e.from === 'qa' && e.to === 'agent-3').label, 'failed ×2')
  const passed = plain(X.pathGraph({ node: 'outcome', status: 'passed', path: ['request', 'coordinator', 'agent-3', 'qa', 'push', 'outcome'], reworks: 0 }, GRAPH))
  assert.equal(passed.edges.find(e => e.from === 'qa' && e.to === 'push').label, 'passed')
})

test('pathGraph: the current node is marked with its state; the ends are pills', () => {
  const g = plain(X.pathGraph({ node: 'qa', status: 'testing', path: ['request', 'coordinator', 'agent-3', 'qa'], reworks: 0 }, GRAPH))
  const now = g.nodes.find(n => n.id === 'qa')
  assert.equal(now.cls, 'xp-now')
  assert.equal(now.sub, 'now: testing')
  assert.equal(g.nodes.filter(n => n.cls === 'xp-now').length, 1)
  assert.equal(g.nodes.find(n => n.id === 'request').kind, 'actor')
  assert.equal(g.nodes.find(n => n.id === 'agent-3').kind, 'box')
})

test('pathGraph: no path (a dropped flow) or no graph is null', () => {
  assert.equal(X.pathGraph({ node: null, status: 'dropped', path: [], reworks: 0 }, GRAPH), null)
  assert.equal(X.pathGraph(null, GRAPH), null)
  assert.equal(X.pathGraph({ node: 'qa', status: 'testing', path: ['request', 'qa'] }, null), null)
})

// ═══ the slides ═══

test('slidesOf: a flow with a before and after, a diagram and a QA result has all five, in order', () => {
  const f = fx(DARK, x => { commit(x); x.qa = QA() })
  const s = plain(X.slidesOf(f, ticketOf(f), GRAPH))
  assert.deepEqual(s.map(x => x.kind), ['what', 'change', 'how', 'path', 'qa'])
  assert.deepEqual(s.map(x => x.title), ['What and why', 'Before and after', 'How it works', 'Path through the agents', 'QA result'])
})

test('slidesOf: a flow with nothing but its story has What and why and the path, never fewer', () => {
  const f = fx(NOVIS)
  assert.deepEqual(plain(X.slidesOf(f, ticketOf(f), GRAPH)).map(x => x.kind), ['what', 'path'])
  assert.deepEqual(plain(X.slidesOf(f, null, null)).map(x => x.kind), ['what', 'path'], 'still two while the pipeline loads')
})

test('slidesOf: What and why carries the title, the why and the story lines', () => {
  const f = fx(DARK)
  const [what] = plain(X.slidesOf(f, ticketOf(f), GRAPH))
  assert.equal(what.heading, DARK.title)
  assert.equal(what.why, DARK.why)
  assert.ok(what.lines.length >= 2)
  assert.deepEqual(Object.keys(what.lines[0]).sort(), ['did', 'who', 'why'])
})

test('slidesOf: Before and after needs a before and after pair, else the Before / Now lines, else it is left out', () => {
  const pair = plain(X.slidesOf(fx(DARK), null, null)).find(x => x.kind === 'change')
  assert.equal(pair.pairs, 1)
  assert.equal(pair.compare, true, 'both pictures: the slider is offered')
  assert.ok(pair.text, 'the lines too')
  const words = plain(X.slidesOf(fx(DARK, x => { x.output.result = x.output.result.filter(r => r.when !== 'before') }), null, null)).find(x => x.kind === 'change')
  assert.equal(words.pairs, 0)
  assert.equal(words.text.before, DARK.output.change.before)
  const none = plain(X.slidesOf(fx(DARK, x => { x.output.result = x.output.result.filter(r => r.when !== 'before'); delete x.output.change }), null, null))
  assert.ok(!none.some(x => x.kind === 'change'))
})

test('slidesOf: How it works only with the agent diagram', () => {
  assert.ok(plain(X.slidesOf(fx(DARK), null, null)).some(x => x.kind === 'how'))
  assert.ok(!plain(X.slidesOf(fx(DARK, x => { delete x.output.diagram }), null, null)).some(x => x.kind === 'how'))
})

test('slidesOf: the path slide has the chart and where the flow is now; without the pipeline it says why there is none', () => {
  const f = fx(DARK, x => { commit(x); x.status = 'done' })
  const p = plain(X.slidesOf(f, ticketOf(f), GRAPH)).find(x => x.kind === 'path')
  assert.deepEqual(p.chart.nodes.map(n => n.id), ['request', 'coordinator', 'agent-3', 'qa'])
  assert.equal(p.node, 'QA')
  assert.equal(p.status, 'waiting')
  assert.match(plain(X.slidesOf(f, null, null)).find(x => x.kind === 'path').note, /Loading the pipeline/)
  assert.match(plain(X.slidesOf(f, null, GRAPH)).find(x => x.kind === 'path').note, /not on the pipeline/i)
  const dropped = fx(NOVIS, x => { x.status = 'dropped' })
  assert.match(plain(X.slidesOf(dropped, ticketOf(dropped), GRAPH)).find(x => x.kind === 'path').note, /dropped/i)
})

test('slidesOf: the QA slide carries the state, the summary, the commit and the rework', () => {
  const f = fx(DARK, x => { commit(x); x.qa = QA({ status: 'failed', pushedAt: null, rework: { to: 'Agent 3', queuedAt: 'x', sentAt: null, error: 'Agent 3 is not running' } }) })
  const q = plain(X.slidesOf(f, ticketOf(f), GRAPH)).find(x => x.kind === 'qa')
  assert.equal(q.state.key, 'failed')
  assert.equal(q.summary, 'All checks pass.')
  assert.equal(q.commit, 'cd34ef5a1b2c')
  assert.equal(q.rework.state, 'failed')
  assert.ok(!plain(X.slidesOf(fx(DARK), null, GRAPH)).some(x => x.kind === 'qa'), 'no QA record, no QA slide')
})

// ═══ the markup ═══

test('html: ONE slide shows, full width, with the ‹ 2/5 › stepper and a labelled index of every slide', () => {
  const f = fx(DARK, x => { commit(x); x.qa = QA() })
  const slides = X.slidesOf(f, ticketOf(f), GRAPH)
  const h = XV.html(f, slides, 1)
  assert.equal((h.match(/<section class="xp-slide/g) || []).length, 1)
  assert.match(h, /<section class="xp-slide xp-change" aria-label="Before and after">/)
  assert.match(h, /<button type="button" data-xp-step="-1" aria-label="Previous slide">‹<\/button><span class="xp-count">2\/5<\/span><button type="button" data-xp-step="1" aria-label="Next slide">›<\/button>/)
  const index = h.match(/<nav class="xp-index"[\s\S]*?<\/nav>/)[0]
  assert.deepEqual([...index.matchAll(/data-xp-go="(\d)"[^>]*>(?:<i[^>]*><\/i>)?([^<]+)</g)].map(m => [m[1], m[2]]),
    [['0', 'What and why'], ['1', 'Before and after'], ['2', 'How it works'], ['3', 'Path through the agents'], ['4', 'QA result']])
  assert.equal((index.match(/aria-current="step"/g) || []).length, 1)
  assert.match(h, /data-xp tabindex="0"/, 'the stage takes the focus, so the arrow keys work')
})

test('html: the first slide has no previous, the last no next', () => {
  const f = fx(NOVIS)
  const slides = X.slidesOf(f, ticketOf(f), GRAPH)
  assert.match(XV.html(f, slides, 0), /data-xp-step="-1" aria-label="Previous slide" disabled/)
  assert.match(XV.html(f, slides, 1), /data-xp-step="1" aria-label="Next slide" disabled/)
})

test('html: What and why leads with the title and why, then the story lines; text is escaped', () => {
  const f = fx(DARK, x => { x.title = '<b>T</b>' })
  const h = XV.html(f, X.slidesOf(f, null, null), 0)
  assert.match(h, /<p class="xp-lead">&lt;b&gt;T&lt;\/b&gt;<\/p>/)
  assert.match(h, /class="st-list"/, 'the Story lines, drawn the way Output draws them')
  assert.doesNotMatch(h, /data-answer=/, 'no answer buttons on a slide')
})

test('html: Before and after reuses the side by side pair, and the slider when asked for', () => {
  const f = fx(DARK)
  const slides = X.slidesOf(f, null, null)
  const i = slides.findIndex(s => s.kind === 'change')
  const side = XV.html(f, slides, i, { compare: 'screens' })
  assert.match(side, /<div class="cmp-pair">/)
  assert.match(side, /<button type="button" data-xp-cmp="compare" aria-pressed="false">Slider<\/button>/)
  const slider = XV.html(f, slides, i, { compare: 'compare' })
  assert.match(slider, /data-cmp-slider="0"/)
  assert.match(slider, /class="cmp-strip"/, 'the Before / Now lines under the pictures')
})

test('html: How it works and the path draw charts into hosts the view redraws at their real width', () => {
  const f = fx(DARK, x => { commit(x); x.status = 'done' })
  const slides = X.slidesOf(f, ticketOf(f), GRAPH)
  const how = XV.html(f, slides, slides.findIndex(s => s.kind === 'how'))
  assert.match(how, /<div class="dg-host" data-dg="how"/)
  const p = XV.html(f, slides, slides.findIndex(s => s.kind === 'path'))
  assert.match(p, /<div class="dg-host xp-chart" data-dg="path"/)
  assert.match(p, /svg class="dg dg-[a-z]+ xp-path"/)
  assert.match(text(p), /Now at QA · waiting/)
})

test('html: the QA slide says passed in green and links to the QA page', () => {
  const f = fx(DARK, x => { commit(x); x.qa = QA() })
  const slides = X.slidesOf(f, ticketOf(f), GRAPH)
  const h = XV.html(f, slides, slides.length - 1)
  assert.match(h, /<span class="dot qa-dot qa-passed"[^>]*>QA passed<\/span>/)
  assert.match(h, /<button type="button" class="link" data-xp-qa="dark-mode">How to test<\/button>/)
  assert.match(text(h), /cd34ef5/)
})

test('moveTo: the arrow keys and the stepper stay within the slides', () => {
  assert.equal(XV.moveTo(0, -1, 4), 0)
  assert.equal(XV.moveTo(0, 1, 4), 1)
  assert.equal(XV.moveTo(3, 1, 4), 3)
  assert.equal(XV.moveTo(9, 0, 2), 1, 'a place past a shorter list is its last slide')
})

// ═══ the QA state in the head ═══

test('FlowQa.state: one word per QA state; green and red only for passed and failed', () => {
  const s = q => plain(Q.state({ status: 'done', nodes: [], qa: q }))
  assert.deepEqual(s(QA()), { key: 'passed', word: 'QA passed' })
  assert.deepEqual(s(QA({ status: 'failed' })), { key: 'failed', word: 'QA failed' })
  assert.deepEqual(s(QA({ status: 'qa-failed' })), { key: 'failed', word: 'QA failed' })
  assert.deepEqual(s(QA({ status: 'testing' })), { key: 'testing', word: 'QA testing' })
  assert.deepEqual(s(QA({ status: 'pending' })), { key: 'waiting', word: 'waiting for QA' })
  assert.equal(Q.state({ status: 'open', nodes: [] }), null, 'no QA yet and still working: nothing to say')
  assert.equal(Q.state({ status: 'done', nodes: [] }), null, 'done with no code change: QA is skipped')
  assert.deepEqual(plain(Q.state(fx(NOVIS, x => { commit(x); x.status = 'done' }))), { key: 'waiting', word: 'waiting for QA' })
})

test('FlowQa.codeProducing matches pipeline.mjs isCodeProducing', async () => {
  const { isCodeProducing } = await import('../pipeline.mjs')
  const cases = [
    { nodes: [] },
    { nodes: [{ evidence: [{ kind: 'diff', ref: 'x' }] }] },
    { nodes: [{ evidence: [{ kind: 'shot', ref: 'x' }] }] },
    { nodes: [], output: { changes: [{ kind: 'commit', ref: 'a' }] } },
    { nodes: [], output: { merge: { branch: 'b' } } },
    null,
  ]
  for (const c of cases) assert.equal(Q.codeProducing(c), isCodeProducing(c), JSON.stringify(c))
})

test('the head line carries the QA word after the status, and the rework line under it when QA failed', () => {
  const parts = { tickets: () => '', envPill: () => '', statusPill: s => `<span>${s}</span>`, statuses: ['open', 'done'] }
  const base = fx(DARK, x => { commit(x); x.qa = QA({ status: 'failed', pushedAt: null, rework: { to: 'Agent 3', queuedAt: 'q', sentAt: null, error: 'Agent 3 is not running' } }) })
  const h = window.FlowHead.html(base, parts)
  assert.match(h.sub, /<span>open<\/span><span class="fl-sep" aria-hidden="true">·<\/span><span class="dot qa-dot qa-failed" data-qa-state="failed">QA failed<\/span>/)
  assert.match(h.sub, /<p class="small qa-rework"/)
  assert.match(text(h.sub), /Sent back to Agent 3 · not delivered Retry/)
  assert.match(h.sub, /<button type="button" class="link" data-qa-retry="dark-mode">Retry<\/button>/)
  assert.doesNotMatch(window.FlowHead.html(fx(NOVIS), parts).sub, /qa-dot|qa-rework/, 'no QA, no word')
})

test('FlowQa.rework: sent, sending, not delivered, or stopped by QA', () => {
  const r = q => plain(Q.rework({ qa: q }))
  assert.equal(r(QA()), null)
  assert.equal(r(QA({ status: 'failed', rework: { to: 'Agent 3', queuedAt: 'q', sentAt: 's', error: null } })).state, 'sent')
  assert.equal(r(QA({ status: 'failed', rework: { to: 'Agent 3', queuedAt: 'q', sentAt: null, error: null } })).state, 'sending')
  assert.equal(r(QA({ status: 'failed', rework: { to: 'Agent 3', queuedAt: 'q', sentAt: null, error: 'gone' } })).state, 'failed')
  assert.equal(r(QA({ status: 'qa-failed' })).state, 'stopped')
  assert.match(text(Q.reworkHtml({ id: 'f', qa: QA({ status: 'qa-failed' }) })), /Not sent back: QA stopped here\. You decide what happens next\./)
  assert.doesNotMatch(Q.reworkHtml({ id: 'f', qa: QA({ status: 'failed', rework: { to: 'A', sentAt: 's' } }) }), /data-qa-retry/, 'nothing to retry once sent')
})

test('Retry posts to the rework route, JSON, the way the page posts everywhere', () => {
  const src = read('flow-qa-line.js')
  assert.match(src, /fetch\(`\/api\/flows\/\$\{encodeURIComponent\(flowId\)\}\/rework`, \{ method: 'POST', headers: \{ 'content-type': 'application\/json' \}/)
})

// ═══ the tab ═══

test('the tabs are Output, Explain, Status, Process; Explain is remembered like the others', () => {
  const T = window.FlowTabs
  assert.deepEqual([...T.tabs('explain').matchAll(/data-view="([a-z]+)">([A-Za-z]+)</g)].map(m => [m[1], m[2]]),
    [['output', 'Output'], ['explain', 'Explain'], ['status', 'Status'], ['process', 'Process']])
  T.view.set('explain')
  assert.equal(T.view.get(), 'explain')
  T.view.set('output')
})

test('flows.js draws the Explain panel and FlowsView.explain opens a flow on it through gotoFlow', () => {
  const src = read('flows.js')
  assert.match(src, /<div class="fl-explain" id="flPanelExplain" role="tabpanel" aria-labelledby="flTabExplain"><\/div>/)
  assert.match(src, /if \(view === 'explain'\) return window\.FlowExplainView\.fill\(\$\('\.fl-explain', board\), f\)/)
  assert.match(src, /explain: flowId => gotoFlow\(flowId, null, 'explain'\)/)
})

test('the styles keep the look: tokens for colour, the one radius, no shadow, no em dash', () => {
  for (const f of ['qa.css', 'flow-explain.css']) {
    const css = read(f)
    assert.doesNotMatch(css, /box-shadow/, f)
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, `${f}: no raw colours`)
    for (const r of css.matchAll(/border-radius:\s*([^;]+);/g)) assert.ok(['var(--radius)', '50%', '999px'].includes(r[1].trim()), `${f}: ${r[1]}`)
  }
  for (const f of ['qa.css', 'flow-explain.css', 'qa-view.js', 'qa-page.js', 'flow-explain.js', 'flow-explain-view.js', 'flow-qa-line.js']) assert.ok(!read(f).includes('—'), f)
})
