// Tests for the quality pages, the PURE halves run in a vm with a bare window: the Lessons page (public/quality-lessons-
// page.js, #/lessons): lessons by area, most hit first, with their sources and Retire or Restore; the candidates with
// Accept, Edit and Reject (and the same-as wording); the failures waiting with Extract lessons and what a run costs;
// the quality panel of a flow (public/quality-flow.js): the risk chip and its reasons, the line when a gate it asks
// for is not on the pipeline, the self-check ticks, the second opinion and its button by mode; the card chip and the
// diagram tooltip line. The wiring (rail, shell, index.html, package.json) is read from the files.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

function load(file, name) {
  const window = { Shell: { ago: iso => (iso ? '3d' : '') } }
  vm.runInNewContext(read(file), { window })
  return window[name]
}

const DATA = {
  lessons: [
    { id: 'L2', text: 'Check the page at phone width.', area: 'ui', count: 4, status: 'active', by: 'model', sources: [{ flow: 'dark', at: '2026-11-20T09:00:00Z', gate: 'qa' }], at: '2026-11-20T09:00:00Z' },
    { id: 'L1', text: 'Write the failing test first.', area: 'tests', count: 7, status: 'active', by: 'you', sources: [], at: '2026-11-19T09:00:00Z' },
    { id: 'L3', text: 'Look at the <dark> theme.', area: 'ui', count: 9, status: 'retired', by: 'model', sources: [{ flow: 'dark', at: '2026-11-21T09:00:00Z', gate: 'security' }], at: '2026-11-21T09:00:00Z' },
  ],
  candidates: [
    { id: 'c1', kind: 'new', text: 'Test the empty password first.', area: 'tests', source: { flow: 'login', at: '2026-11-25T09:00:00Z', gate: 'qa' }, title: 'Add the login page' },
    { id: 'c2', kind: 'same', lesson: 'L1', text: 'Write the failing test first.', area: 'tests', source: { flow: 'login', at: '2026-11-25T09:00:00Z', gate: 'qa' }, title: 'Add the login page' },
  ],
  failures: [{ key: 'login:qa:1', flow: 'login', title: 'Add the login page', gate: 'qa', at: '2026-11-25T09:00:00Z', summary: 'No test for the empty password.', auto: false, retry: false }],
  areas: ['tests', 'ui', 'routes', 'general'],
  settings: { autoLessons: true, critic: 'manual' },
  busy: false,
  limits: { text: 160, brief: 7 },
}

test('Lessons: grouped by area in the area order, most hit first, each with its count, sources and Retire or Restore', () => {
  const Q = load('quality-lessons-page.js', 'QualityLessons')
  const h = Q.html(DATA)
  const t = text(h)
  assert.ok(t.indexOf('tests') < t.indexOf('Check the page at phone width'), 'tests before ui')
  assert.ok(h.indexOf('Look at the &lt;dark&gt; theme.') > h.indexOf('Check the page at phone width.'), 'a retired lesson after the active ones of its area')
  assert.match(t, /Seen 7 times/)
  assert.match(h, /data-ql-flow="dark"/, 'a source links to its flow')
  assert.match(h, /data-ql-retire="L2"/)
  assert.match(h, /data-ql-restore="L3"/)
  assert.doesNotMatch(h, /<dark>/, 'escaped')
  assert.match(t, /Added by you/)
})

test('Candidates: a new one has Accept, Edit and Reject; a same-as says which lesson it counts again', () => {
  const Q = load('quality-lessons-page.js', 'QualityLessons')
  const h = Q.html(DATA)
  assert.match(h, /data-ql-accept="c1"/)
  assert.match(h, /data-ql-edit="c1"/)
  assert.match(h, /data-ql-reject="c1"/)
  assert.match(text(h), /Counts again as L1: Write the failing test first\./)
  assert.doesNotMatch(h, /data-ql-edit="c2"/, 'nothing to edit on a same-as')
  assert.match(text(h), /Waiting for you · 2/)
  assert.match(text(h), /From Add the login page \(QA\)/)
})

test('Edit: the candidate becomes a form with its text and area, Save and accept, and Cancel', () => {
  const Q = load('quality-lessons-page.js', 'QualityLessons')
  const h = Q.html(DATA, { edit: 'c1' })
  assert.match(h, /<form class="ql-edit" data-ql-form="c1"/)
  assert.match(h, /maxlength="160"/)
  assert.match(h, /value="Test the empty password first\."/)
  assert.match(h, /<option value="tests" selected>/)
  assert.match(text(h), /Save and accept/)
  assert.match(h, /data-ql-cancel/)
})

test('Failures: each with Extract lessons and what one run costs; while one runs every button waits', () => {
  const Q = load('quality-lessons-page.js', 'QualityLessons')
  const h = Q.html(DATA)
  assert.match(h, /data-ql-extract="login:qa:1"/)
  assert.match(text(h), /No test for the empty password\./)
  assert.match(text(h), /costs about/)
  assert.match(text(h), /New failures are read on their own/)
  const busy = Q.html({ ...DATA, busy: true }, { running: 'login:qa:1' })
  assert.match(busy, /data-ql-extract="login:qa:1"[^>]*disabled/)
  assert.match(text(busy), /Reading…/)
  const off = Q.html({ ...DATA, settings: { autoLessons: false, critic: 'off' } })
  assert.match(text(off), /Automatic runs are off/)
})

test('Add a lesson: a text box of at most 160 characters and the area list; an empty library says how lessons arrive', () => {
  const Q = load('quality-lessons-page.js', 'QualityLessons')
  const h = Q.html(DATA)
  assert.match(h, /<form class="ql-add" data-ql-add/)
  assert.match(h, /<select name="area"[^>]*>/)
  const empty = Q.html({ ...DATA, lessons: [], candidates: [], failures: [] })
  assert.match(text(empty), /No lessons yet/)
})

test('An area filter from the address shows that area only', () => {
  const Q = load('quality-lessons-page.js', 'QualityLessons')
  const h = Q.html(DATA, { area: 'tests' })
  assert.doesNotMatch(h, /Check the page at phone width/)
  assert.match(h, /Write the failing test first/)
  assert.match(text(h), /Showing the tests lessons only\. Show every area/)
  assert.ok(h.includes('href="#/lessons"'), 'the way back to every area')
  assert.doesNotMatch(Q.html(DATA), /Showing the/)
})

const PANEL = {
  risk: { level: 'high', reasons: ['It touches sign-in or sessions.'], needs: ['security', 'deep-qa'] },
  missing: ['Security'], missingLine: 'This task asks for a Security review, but there is no Security agent on the pipeline (config.json pipeline).',
  selfcheck: { at: '2026-11-25T10:00:00Z', by: 'Agent 1', items: [{ lesson: 'tests-first', text: 'I wrote the failing test first.', ok: true, note: '' }, { lesson: 'docs', text: 'I updated the docs.', ok: false, note: 'no docs <yet>' }] },
  critic: { at: '2026-11-25T09:00:00Z', verdict: 'concerns', points: ['There is no test plan.'], cost: 0.012, plan: 'login/plan-1.md' },
  criticCurrent: true, criticMode: 'manual', hasPlan: true, lessons: [],
}

test('the flow panel: the risk chip and reasons, the missing gate line, the self-check ticks, the second opinion', () => {
  const Q = load('quality-flow.js', 'QualityFlow')
  const h = Q.panelHtml(PANEL)
  const t = text(h)
  assert.match(t, /High risk/)
  assert.match(t, /It touches sign-in or sessions\. It asks for a Security review and a deeper QA pass\./)
  assert.match(t, /there is no Security agent on the pipeline/)
  assert.match(t, /Self-check by Agent 1: 1 ok, 1 no/)
  assert.match(h, /no docs &lt;yet&gt;/)
  assert.match(t, /Second opinion on the plan: concerns/)
  assert.match(t, /There is no test plan\./)
  assert.match(t, /\$0\.01/)
  assert.match(h, /data-qf-critic/, 'manual: the button')
  assert.match(t, /never blocks/)
})

test('the flow panel: no self-check yet, no plan, the critic off; a low risk flow with nothing else draws nothing', () => {
  const Q = load('quality-flow.js', 'QualityFlow')
  const h = Q.panelHtml({ ...PANEL, selfcheck: null, critic: null, criticCurrent: false, criticMode: 'off' })
  assert.match(text(h), /No self-check yet/)
  assert.doesNotMatch(h, /data-qf-critic/)
  const noPlan = Q.panelHtml({ ...PANEL, hasPlan: false, critic: null })
  assert.doesNotMatch(noPlan, /data-qf-critic/)
  assert.equal(Q.panelHtml({ risk: { level: 'low', reasons: [], needs: [] }, missing: [], selfcheck: null, critic: null, hasPlan: false, criticMode: 'manual' }), '')
  const stale = Q.panelHtml({ ...PANEL, criticCurrent: false })
  assert.match(text(stale), /an earlier plan/)
  const running = Q.panelHtml(PANEL, { running: true })
  assert.match(running, /data-qf-critic[^>]*disabled/)
})

test('the card chip and the diagram tooltip: medium and high only', () => {
  const Q = load('quality-flow.js', 'QualityFlow')
  assert.match(Q.chip({ risk: PANEL.risk }), /<span class="fl-chip qf-risk is-high" title="It touches sign-in or sessions\. It asks for a Security review and a deeper QA pass\.">High risk<\/span>/)
  assert.match(Q.chip({ risk: { level: 'medium', reasons: ['It deletes data.'], needs: ['deep-qa'] } }), /Medium risk/)
  assert.equal(Q.chip({ risk: { level: 'low', reasons: [], needs: [] } }), '')
  assert.equal(Q.chip({}), '')
  assert.equal(Q.tip({ risk: PANEL.risk }), 'High risk: It touches sign-in or sessions.')
  assert.equal(Q.tip({}), '')
})

test('wiring: the rail link at the end, the route, the section, the scripts, the stylesheet, the check list', () => {
  const shell = read('shell.js')
  assert.match(shell, /VIEWS\.push\('lessons'\)/)
  assert.match(shell, /link\('lessons', '#\/lessons', 'Lessons'\)/)
  const index = read('index.html')
  assert.match(index, /<section id="lessonsView" aria-label="Lessons" hidden><\/section>/)
  assert.match(index, /<script src="quality-lessons-page\.js"><\/script>/)
  assert.match(index, /<script src="quality-flow\.js"><\/script>/)
  assert.match(index, /<link rel="stylesheet" href="quality\.css">/)
  const pkg = fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')
  assert.match(pkg, /node --check public\/quality-lessons-page\.js/)
  assert.match(pkg, /node --check public\/quality-flow\.js/)
  const window = { location: { hash: '' } }
  vm.runInNewContext(shell, { window })
  assert.deepEqual(JSON.parse(JSON.stringify(window.Shell.resolve('#/lessons?area=tests'))), { view: 'lessons', params: { query: { area: 'tests' } }, redirect: null })
  assert.equal(window.Shell.railFor(window.Shell.resolve('#/lessons')), 'lessons')
})

test('the CSS uses the theme tokens only, and moves nothing for reduced motion', () => {
  const css = read('quality.css')
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,6}\b/i, 'no raw colours: light and dark both follow the tokens')
  assert.doesNotMatch(css, /animation|transition/)
})

// QA 2026-11-26: a lesson the user typed showed Seen 1 time although no failure produced it.
test('a typed lesson no failure has taught yet says Added by you and no Seen count; one seen since says how often', () => {
  const Q = load('quality-lessons-page.js', 'QualityLessons')
  const typed = { id: 'L9', text: 'Stop the preview server.', area: 'general', count: 0, status: 'active', by: 'you', sources: [] }
  const t0 = text(Q.html({ ...DATA, lessons: [typed] }))
  assert.match(t0, /Added by you/)
  assert.doesNotMatch(t0, /Seen \d/)
  const t1 = text(Q.html({ ...DATA, lessons: [{ ...typed, count: 2 }] }))
  assert.match(t1, /Seen 2 times/)
  assert.match(t1, /Added by you/)
})
