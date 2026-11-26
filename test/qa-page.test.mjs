// Tests for the QA page (#/qa): public/qa-view.js draws the list of tickets that
// passed QA and one ticket opened (its report, screenshots, test steps, commit
// and branch links), public/qa-page.js mounts it, and shell.js routes to it
// (#/qa and the deep link #/qa/<flow id>). Browser scripts in a vm with a bare
// window: the markup functions never touch the DOM.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const PUBLIC = path.join(ROOT, 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')

const NOW = Date.parse('2026-11-24T12:00:00Z')
const ctx = { window: {}, localStorage: { getItem: () => null, setItem: () => {} }, URL }
for (const f of ['shell.js', 'terms.js', 'flow-drawer.js', 'flow-qa-line.js', 'qa-view.js', 'qa-page.js']) vm.runInNewContext(read(f), ctx)
const { window } = ctx
const V = window.QaView
const plain = v => JSON.parse(JSON.stringify(v))
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const qaFlow = (over = {}) => ({
  id: 'dark-mode', title: 'Dark mode toggle', agent: 'Agent 3', tickets: ['ABC-101', 'ABC-102'], status: 'done', archived: false,
  updatedAt: '2026-11-24T11:00:00Z', stage: { node: 'outcome', status: 'passed', path: ['request', 'coordinator', 'agent-3', 'qa', 'push', 'outcome'], reworks: 0 },
  qa: {
    status: 'passed', attempt: 2, by: 'QA', at: '2026-11-24T11:30:00Z', commit: 'cd34ef5a1b2c3d4e5f60718293a4b5c6d7e8f901', branch: 'feature/dark-mode',
    summary: 'All checks pass.', pushedAt: '2026-11-24T11:40:00Z', pushError: null, rework: null,
    steps: [{ do: 'Open Settings', expect: 'A Dark mode switch', shot: 'dark-mode/qa-2-step1-a.png', url: '/evidence/dark-mode/qa-2-step1-a.png' }, { do: 'Turn it on', expect: 'The page goes dark' }],
    attempts: [{ attempt: 1, status: 'failed', at: '2026-11-24T10:00:00Z', commit: 'ab12cd3', summary: 'The toggle did not stick.', report: 'dark-mode/qa-1-report.md' }],
  },
  report: { ref: 'dark-mode/qa-2-report.md', url: '/evidence/dark-mode/qa-2-report.md', text: '# QA report\n\nAll **good**.', truncated: false },
  shots: [{ ref: 'dark-mode/qa-2-home.png', url: '/evidence/dark-mode/qa-2-home.png' }],
  links: { repo: 'https://github.com/o/r', commit: 'https://github.com/o/r/commit/cd34ef5a1b2c3d4e5f60718293a4b5c6d7e8f901', branch: 'https://github.com/o/r/tree/feature/dark-mode' },
  ...over,
})

// ═══ the route ═══

test('#/qa is the QA page and #/qa/<id> opens one ticket on it, decoded', () => {
  const r = h => plain(window.Shell.resolve(h))
  assert.deepEqual(r('#/qa'), { view: 'qa', params: {}, redirect: null })
  assert.deepEqual(r('#/qa/'), { view: 'qa', params: {}, redirect: null })
  assert.deepEqual(r('#/qa/dark%20mode'), { view: 'qa', params: { id: 'dark mode' }, redirect: null })
  assert.deepEqual(r('#/qa/a%E0b'), { view: 'qa', params: { id: 'a%E0b' }, redirect: null }, 'a malformed escape keeps the raw text')
  assert.equal(window.Shell.railFor(window.Shell.resolve('#/qa/x')), 'qa', 'an opened ticket still lights QA in the rail')
})

test('the rail links to QA first in the Quality group, with its own icon, and the shell opens QaPage in #qaView', () => {
  const shell = read('shell.js')
  const rail = { window: {} }
  for (const f of ['rail-groups.js', 'shell.js']) vm.runInNewContext(read(f), rail)
  const quality = rail.window.RailGroups.groups().find(g => g.id === 'quality')
  assert.equal(quality.entries[0].view, 'qa', 'QA leads the Quality group')
  assert.equal(quality.entries[0].href, '#/qa')
  assert.match(quality.entries[0].icon, /<circle/, 'the rail icon')
  assert.match(shell, /qa: 'qaView'/)
  assert.match(shell, /qa: 'QaPage'/)
  assert.match(shell, /r\.view === 'qa'\) page\?\.open\?\.\(r\.params\.id\)/, 'the opened id goes to the page')
})

test('index.html holds the section, the scripts after flows-page.js and the stylesheets after flow-compare.css', () => {
  const index = read('index.html')
  assert.match(index, /<section id="settingsView" aria-label="Settings" hidden><\/section>\s*<section id="qaView" aria-label="QA" hidden><\/section>/)
  const at = s => index.indexOf(`<script src="${s}"></script>`)
  for (const s of ['flow-qa-line.js', 'qa-view.js', 'qa-page.js']) assert.ok(at(s) > at('flows-page.js'), s)
  assert.ok(at('qa-view.js') < at('qa-page.js'))
  const css = s => index.indexOf(`<link rel="stylesheet" href="${s}">`)
  assert.ok(css('qa.css') > css('flow-compare.css') && css('flow-explain.css') > css('flow-compare.css'))
})

test('npm run check covers the new scripts, and the palette and glossary know the page', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  for (const f of ['flow-qa-line.js', 'qa-view.js', 'qa-page.js', 'flow-explain.js', 'flow-explain-view.js']) assert.ok(pkg.checkList.includes(`node --check public/${f}`), f)
  assert.match(read('palette.js'), /\['QA', '#\/qa'\]/)
  assert.ok(JSON.parse(read('glossary.json')).qa?.short?.length > 20)
})

// ═══ the list ═══

test('rows: only the tickets that passed, newest QA result first', () => {
  const flows = [
    qaFlow({ id: 'old', qa: { ...qaFlow().qa, at: '2026-11-20T09:00:00Z' } }),
    qaFlow({ id: 'failed', qa: { ...qaFlow().qa, status: 'failed' } }),
    qaFlow({ id: 'new', qa: { ...qaFlow().qa, at: '2026-11-24T11:59:00Z' } }),
    qaFlow({ id: 'none', qa: null }),
  ]
  assert.deepEqual(plain(V.rows(flows).map(f => f.id)), ['new', 'old'])
  assert.deepEqual(plain(V.rows(null)), [])
})

test('a row is one link to its ticket: a green Passed mark (the word too), title, tickets, agent, short sha, when pushed', () => {
  const h = V.listHtml({ flows: [qaFlow()] }, NOW)
  const row = h.match(/<a class="qa-row"[\s\S]*?<\/a>/)[0]
  assert.match(row, /href="#\/qa\/dark-mode"/)
  assert.match(row, /<span class="dot qa-dot qa-passed"[^>]*>Passed<\/span>/, 'colour is never the only signal')
  assert.equal(text(row), 'Passed Dark mode toggle ABC-101 ABC-102 · Agent 3 · cd34ef5 · pushed 20m')
})

test('a row not pushed yet says so', () => {
  const h = V.listHtml({ flows: [qaFlow({ qa: { ...qaFlow().qa, pushedAt: null } })] }, NOW)
  assert.match(text(h), /cd34ef5 · not pushed yet/)
})

test('the empty list is one plain line saying how tickets get here', () => {
  const h = V.listHtml({ flows: [] }, NOW)
  assert.match(text(h), /^Nothing has passed QA yet\. /)
  assert.match(text(h), /QA/)
  assert.doesNotMatch(h, /qa-row/)
})

test('the list escapes what agents wrote', () => {
  const h = V.listHtml({ flows: [qaFlow({ title: '<img src=x onerror=alert(1)>', agent: '<b>A</b>', tickets: ['<i>'] })] }, NOW)
  assert.ok(!h.includes('<img src=x') && !h.includes('<b>A') && !h.includes('<i>'))
})

// ═══ one ticket opened ═══

test('opened: the report through the safe Markdown renderer, screenshots as lightbox thumbnails, steps as do -> expect cards', () => {
  const h = V.detailHtml(qaFlow(), NOW)
  assert.match(h, /<a class="link" href="#\/qa">← QA<\/a>/)
  assert.match(h, /<h2 class="qa-title" tabindex="-1">Dark mode toggle<\/h2>/, 'it takes the focus when a ticket opens')
  const report = h.match(/aria-label="Report"[\s\S]*?<\/section>/)[0]
  assert.match(report, /QA report/)
  assert.doesNotMatch(report, /truncated/i)
  const shots = h.match(/aria-label="Screenshots"[\s\S]*?<\/section>/)[0]
  assert.match(shots, /<a href="\/evidence\/dark-mode\/qa-2-home\.png" target="_blank" rel="noopener"><img class="fl-shot"/)
  const steps = h.match(/aria-label="How to test"[\s\S]*?<\/section>/)[0]
  assert.equal((steps.match(/class="ts-card/g) || []).length, 2)
  assert.match(steps, /<p class="ts-do">Open Settings<\/p><p class="ts-expect"><span>Expect<\/span> A Dark mode switch<\/p>/)
  assert.match(steps, /img class="fl-shot" src="\/evidence\/dark-mode\/qa-2-step1-a\.png"/, 'the step screenshot')
  assert.match(steps, /<div class="ts-tile" aria-hidden="true"><\/div>/, 'a step without one: the quiet placeholder')
  assert.doesNotMatch(steps, /I saw this/, 'no checklist here: QA did the testing')
})

test('opened: the commit and branch link to GitHub in a new tab; Explain in Flows; the earlier attempt in one line', () => {
  const h = V.detailHtml(qaFlow(), NOW)
  assert.match(h, /<a class="link" href="https:\/\/github\.com\/o\/r\/commit\/cd34ef5a1b2c3d4e5f60718293a4b5c6d7e8f901" target="_blank" rel="noopener"><code>cd34ef5<\/code><\/a>/)
  assert.match(h, /<a class="link" href="https:\/\/github\.com\/o\/r\/tree\/feature\/dark-mode" target="_blank" rel="noopener"><code>feature\/dark-mode<\/code><\/a>/)
  assert.match(h, /<button type="button" class="link" data-qa-explain="dark-mode">Explain in Flows<\/button>/)
  assert.match(text(h), /Attempt 1 · failed · ab12cd3 · The toggle did not stick\./)
  assert.match(text(h), /Passed · attempt 2/)
})

test('opened: it links to the flow itself (Open flow), and shows the flow route from its own progress under the meta line', () => {
  window.FlowRoute = { line: f => `<nav class="rt-line" data-for="${f.id}"></nav>` }
  try {
    const h = V.detailHtml(qaFlow(), NOW)
    assert.match(h, /<button type="button" class="link" data-qa-open="dark-mode">Open flow<\/button>/)
    assert.match(h, /<\/p><nav class="rt-line" data-for="dark-mode"><\/nav>/)
    assert.match(V.missingHtml('dark-mode', { id: 'dark-mode', title: 'T', status: 'open', nodes: [] }), /data-qa-open="dark-mode">Open flow</)
  } finally {
    delete window.FlowRoute
  }
  assert.match(read('qa-page.js'), /\[data-qa-open\][\s\S]{0,200}FlowsView\?\.gotoFlow\(/, 'a click opens the flow on Flows')
})

test('opened: no GitHub link makes the short sha and the branch plain text; a link that is not https is never used', () => {
  const h = V.detailHtml(qaFlow({ links: { repo: null, commit: null, branch: 'javascript:alert(1)' } }), NOW)
  assert.match(h, /<code>cd34ef5<\/code>/)
  assert.doesNotMatch(h, /href="https:\/\/github\.com\/o\/r\/commit/)
  assert.doesNotMatch(h, /javascript:/)
  assert.match(h, /<code>feature\/dark-mode<\/code>/)
})

test('opened: a cut report says so; a missing report file says so; no shots and no steps leave their blocks out', () => {
  const cut = V.detailHtml(qaFlow({ report: { ...qaFlow().report, truncated: true } }), NOW)
  assert.match(text(cut), /The report is longer than 64 KB: only the start shows\. Open the full report/)
  const gone = V.detailHtml(qaFlow({ report: { ...qaFlow().report, text: null }, shots: [], qa: { ...qaFlow().qa, steps: [] } }), NOW)
  assert.match(text(gone), /The report file is missing\./)
  assert.doesNotMatch(gone, /aria-label="Screenshots"|aria-label="How to test"/)
})

test('opened: the report is never rendered as HTML', () => {
  const h = V.detailHtml(qaFlow({ report: { ...qaFlow().report, text: '<script>alert(1)</script> <img src=x onerror=y>' } }), NOW)
  assert.ok(!h.includes('<script>') && !h.includes('<img src=x'))
})

test('opened: a failed ticket (opened from Explain) is red and says Failed, with its rework line', () => {
  const f = qaFlow({ qa: { ...qaFlow().qa, status: 'failed', pushedAt: null, rework: { to: 'Agent 3', queuedAt: '2026-11-24T11:31:00Z', sentAt: '2026-11-24T11:31:10Z', error: null } } })
  const h = V.detailHtml(f, NOW)
  assert.match(h, /<span class="dot qa-dot qa-failed"[^>]*>QA failed<\/span>|<span class="dot qa-dot qa-failed"[^>]*>Failed<\/span>/)
  assert.match(text(h), /Sent back to Agent 3 · sent/)
})

test('QaPage exposes open, close, update and gotoFlow', () => {
  for (const k of ['open', 'close', 'update', 'gotoFlow']) assert.equal(typeof window.QaPage[k], 'function', k)
})

// ═══ a ticket QA never saw (QA report: red "QA has no record of csp-enforce", and Loading… on a direct load) ═══

const ok = body => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
/** qa-page.js in a vm with a stub DOM and a fetch that answers from `routes` (url -> body). */
function page(routes) {
  const calls = []
  const box = { className: '', innerHTML: '', addEventListener() {}, removeEventListener() {}, querySelector: () => null }
  const section = { innerHTML: '', replaceChildren() {} }
  const c = {
    window: {}, URL, calls, box, setInterval: () => 1, clearInterval() {},
    document: { getElementById: () => section, createElement: () => box },
    fetch: url => { calls.push(url); return url in routes ? ok(routes[url]) : new Promise(() => {}) },
  }
  c.window.Lightbox = { bind() {} }
  c.window.Shell = { current: { view: 'qa' }, setTitle() {}, setStatus() {}, ago: () => '3m', go() {}, whenReady() {} }
  for (const f of ['terms.js', 'flow-drawer.js', 'flow-qa-line.js', 'qa-view.js', 'qa-page.js']) vm.runInNewContext(read(f), c)
  return c
}
const settle = () => new Promise(r => setTimeout(r, 0))

test('a direct load of #/qa/<id> asks for that ticket at once, beside the passed list, not after it', () => {
  const c = page({})
  c.window.QaPage.open('csp-enforce')
  assert.ok(c.calls.includes('/api/qa?status=passed'), 'the list')
  assert.ok(c.calls.includes('/api/qa'), 'every QA record, in the same tick: no wait for the list first')
  assert.ok(c.calls.includes('/api/flows/csp-enforce'), 'the flow itself, for its title when QA has no record')
})

test('the list alone does not read every QA record', () => {
  const c = page({})
  c.window.QaPage.open(null)
  assert.deepEqual(c.calls, ['/api/qa?status=passed'])
})

test('a ticket QA has no record of is neutral, named by its title, and points to How to test in Flows', async () => {
  const c = page({
    '/api/qa?status=passed': { flows: [], builtAt: '2026-11-24T12:00:00Z' },
    '/api/qa': { flows: [] },
    '/api/flows/csp-enforce': { id: 'csp-enforce', title: 'Enforce the CSP', status: 'done', nodes: [], output: { testing: [{ id: 't1', do: 'Open it', expect: 'It opens' }] } },
  })
  c.window.QaPage.open('csp-enforce')
  await settle()
  await settle()
  const h = c.box.innerHTML
  assert.doesNotMatch(h, /class="[^"]*\bwarn\b/, 'red means failed, and this did not fail')
  assert.match(h, /<h2 class="qa-title" tabindex="-1">Enforce the CSP<\/h2>/)
  assert.match(text(h), /has not been through QA/)
  assert.match(text(h), /changed no code/)
  assert.match(h, /data-qa-output="csp-enforce"/, 'How to test lives on the Output tab in Flows')
  assert.match(h, /data-qa-explain="csp-enforce"/)
})

test('missingHtml: the reason follows the flow, the id stands in for a title it could not read, nothing is red', () => {
  const said = f => text(V.missingHtml('x-1', f))
  assert.match(said(null), /^← QA x-1 /)
  assert.match(said(null), /has not been through QA/)
  assert.match(said({ id: 'x-1', title: 'T', status: 'done', nodes: [] }), /changed no code/)
  assert.match(said({ id: 'x-1', title: 'T', status: 'done', nodes: [{ evidence: [{ kind: 'commit', ref: 'a' }] }] }), /waiting for QA/)
  assert.match(said({ id: 'x-1', title: 'T', status: 'open', nodes: [{ evidence: [{ kind: 'commit', ref: 'a' }] }] }), /still being worked on/)
  assert.match(said({ id: 'x-1', title: 'T', status: 'dropped', nodes: [] }), /dropped/)
  for (const f of [null, { id: 'x-1', title: 'T', status: 'done', nodes: [] }]) assert.doesNotMatch(V.missingHtml('x-1', f), /\bwarn\b|qa-failed/)
  assert.ok(!V.missingHtml('<b>', { title: '<i>x</i>', status: 'done', nodes: [] }).includes('<i>x'), 'escaped')
})

// ═══ QA attempt 2 ═══

test('every open of the page reads the list again, and the last list shows while it loads', async () => {
  const routes = { '/api/qa?status=passed': { flows: [qaFlow()], builtAt: '2026-11-24T12:00:00Z' } }
  const c = page(routes)
  c.window.QaPage.open(null)
  await settle()
  assert.match(c.box.innerHTML, /qa-row/)
  c.window.QaPage.close()
  delete routes['/api/qa?status=passed'] // the next read never answers
  c.window.QaPage.open(null)
  assert.equal(c.calls.filter(u => u === '/api/qa?status=passed').length, 2, 'coming back reads it again')
  assert.match(c.box.innerHTML, /qa-row/, 'the last list, not Loading…, while it does')
  c.window.QaPage.open('dark-mode')
  c.window.QaPage.open(null)
  assert.equal(c.calls.filter(u => u === '/api/qa?status=passed').length, 4, '← QA from a ticket reads it again too')
})

test('frontmatter: the --- block at the top of a report is taken off the text, its fields kept', () => {
  const md = '---\r\nticket: qa-pipeline\nresult: FAILED\ntested:\n  local: failed\n  dev: not-tested\nscreenshots: screenshots/\ncommit: d293e3c856a4e494bc584bf2382f6bad51cf107a\n---\n\n# QA report\n\nBody.'
  const { fields, body } = plain(V.frontmatter(md))
  assert.equal(body.trim(), '# QA report\n\nBody.')
  assert.deepEqual(fields, { ticket: 'qa-pipeline', result: 'FAILED', tested: { local: 'failed', dev: 'not-tested' }, screenshots: 'screenshots/', commit: 'd293e3c856a4e494bc584bf2382f6bad51cf107a' })
  assert.deepEqual(plain(V.frontmatter('# No block\n---\nx: y')), { fields: {}, body: '# No block\n---\nx: y' }, 'only a block that opens the text')
  assert.deepEqual(plain(V.frontmatter('---\nresult: x\nno end')), { fields: {}, body: '---\nresult: x\nno end' }, 'an unclosed block is left as text')
  assert.deepEqual(plain(V.frontmatter(null)), { fields: {}, body: '' })
})

test('the report shows its result, tested rungs and commit as one small neutral list, never the raw block', () => {
  const text0 = '---\nticket: dark-mode\nresult: <b>PASSED</b>\ntested:\n  local: passed\n  dev: not-tested\ncommit: cd34ef5a1b2c3d4e\n---\n\nAll **good**.'
  const h = V.detailHtml(qaFlow({ report: { ...qaFlow().report, text: text0 } }), NOW)
  const report = h.match(/aria-label="Report"[\s\S]*?<\/section>/)[0]
  assert.doesNotMatch(report, /---|ticket:/, 'the block is gone from the text')
  assert.match(report, /<dl class="qa-front">/)
  assert.match(text(report), /Result &lt;b&gt;PASSED&lt;\/b&gt; Tested local: passed · dev: not-tested Commit cd34ef5/)
  assert.doesNotMatch(report, /<b>PASSED/, 'escaped')
  assert.doesNotMatch(report, /\bwarn\b|qa-failed|qa-passed/, 'neutral: the state mark is in the meta line already')
  const none = V.detailHtml(qaFlow(), NOW)
  assert.doesNotMatch(none, /qa-front/, 'no block, no list')
})

test('no QA record: How to test in Flows only when the flow has test steps; else Explain in Flows alone', () => {
  const steps = { id: 'x-1', title: 'T', status: 'done', nodes: [], output: { testing: [{ id: 't1', do: 'a', expect: 'b' }] } }
  const withSteps = V.missingHtml('x-1', steps)
  assert.match(withSteps, /data-qa-output="x-1"/)
  assert.match(text(withSteps), /own How to test, on the Output tab/)
  for (const f of [null, { id: 'x-1', title: 'T', status: 'done', nodes: [] }, { id: 'x-1', status: 'done', nodes: [], output: { testing: [] } }]) {
    const h = V.missingHtml('x-1', f)
    assert.doesNotMatch(h, /data-qa-output|How to test/, JSON.stringify(f))
    assert.match(h, /data-qa-explain="x-1"/)
  }
})
