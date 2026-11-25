// Tests for public/completed-view.js, the pure half: the waiting line (Agents page and Home), the pile-up reminder
// (Ask drawer, Tickets page), the Output box head, the amber mark, the Completed buttons with their inline confirm,
// the flow's Sign-off block and the archive label. Loaded in a vm with a bare window, like the other browser files.
// The sentences must match completed.mjs word for word (the CLI and the pages say the same thing).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { reminderLine, waitingLine } from '../completed.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const ctx = vm.createContext({ window: {} })
vm.runInContext(read('completed-view.js'), ctx)
const V = ctx.window.CompletedView
const plain = v => JSON.parse(JSON.stringify(v))

const sum = (n, { overdue = 0, max = 7, warnAfterDays = 2 } = {}) => ({
  waiting: Array.from({ length: n }, (_, i) => ({ id: `f${i + 1}`, title: `Flow <${i + 1}>`, agent: 'Agent 1', finishedAt: '2026-11-20T10:00:00.000Z', overdue: i < overdue })),
  counts: { waiting: n, overdue }, max, warnAfterDays, piled: n >= max,
})

test('the sentences are completed.mjs word for word, singular and plural', () => {
  for (const n of [1, 2, 3, 7, 12]) {
    assert.equal(V.waitingLine(n), waitingLine(n))
    assert.equal(V.reminderLine(n), reminderLine(n))
  }
})

// ═══ the waiting line (Agents page, Home) ═══

test('the waiting line: nothing at 0; a quiet line with a link to the Output list; a notice once one is overdue', () => {
  assert.equal(V.lineHtml(sum(0)), '')
  assert.equal(V.lineHtml(null), '')
  const quiet = V.lineHtml(sum(3))
  assert.match(quiet, /^<p class="cv-line" role="status">/)
  assert.match(quiet, /3 outputs wait for your sign-off/)
  assert.match(quiet, /<a class="link" href="#\/agents\?outputs" data-cv-show>Show them<\/a>/)
  assert.doesNotMatch(quiet, /overdue/)
  const notice = V.lineHtml(sum(3, { overdue: 2 }))
  assert.match(notice, /^<p class="cv-line is-notice" role="status">/)
  assert.match(notice, /2 waiting more than 2 days/)
  assert.match(V.lineHtml(sum(1, { overdue: 1, warnAfterDays: 1 })), /1 waiting more than 1 day</)
})

// ═══ the pile-up reminder ═══

test('the reminder shows at the limit (7) and not below it (6), with Mark all completed right there', () => {
  assert.equal(V.reminderHtml(sum(6)), '')
  const html = V.reminderHtml(sum(7))
  assert.match(html, /<div class="cv-remind" role="note">/)
  assert.match(html, /7 outputs wait for your sign-off\. Mark them completed before a new request\./)
  assert.match(html, /data-cv-ask[^>]*>Mark all completed<\/button>/)
  assert.match(html, /data-cv-ids="f1 f2 f3 f4 f5 f6 f7"/)
  assert.match(V.reminderHtml(sum(2, { max: 2 })), /2 outputs wait/)
  assert.match(V.reminderHtml(sum(1, { max: 1 })), /Mark it completed before a new request/)
  assert.doesNotMatch(V.reminderHtml(sum(1, { max: 1 })), /Mark all/, 'one waiting: no Mark all')
})

// ═══ the inline confirm ═══

test('Mark all completed asks once inline: the question and its two buttons are there, hidden, never a window', () => {
  const html = V.allHtml(sum(3))
  assert.match(html, /<span class="cv-confirm">/)
  assert.match(html, /<button type="button" class="cv-btn" data-cv-ask aria-expanded="false">Mark all completed<\/button>/)
  assert.match(html, /<span class="cv-ask" role="group" aria-label="Mark all 3 completed" hidden>/)
  assert.match(html, /Mark all 3 completed\? They go to the flow archive\./)
  assert.match(html, /<button type="button" class="primary" data-cv-yes data-cv-ids="f1 f2 f3">Mark all completed<\/button>/)
  assert.match(html, /<button type="button" class="link" data-cv-no>Cancel<\/button>/)
  assert.equal(V.allHtml(sum(1)), '', 'only when more than one waits')
  assert.equal(V.allHtml(sum(0)), '')
  assert.doesNotMatch(read('completed-view.js'), /confirm\(|window\.confirm/, 'never a native dialog')
})

test('a tick on one output: Completed, asked once inline, the title escaped', () => {
  const html = V.tickHtml({ id: 'f-1', title: 'Fix <login>' })
  assert.match(html, /data-cv-ask aria-expanded="false" aria-label="Mark Fix &lt;login&gt; completed" title="Mark it completed">/)
  assert.match(html, /Mark <b>Fix &lt;login&gt;<\/b> completed\? It goes to the flow archive\./)
  assert.match(html, /data-cv-yes data-cv-ids="f-1">Completed<\/button>/)
  assert.doesNotMatch(html, /<login>/)
  assert.match(V.tickHtml({ id: 'x', title: 'T' }, { label: 'Completed' }), /class="cv-btn cv-tick"[^>]*>(<svg[^]*<\/svg>)?Completed<\/button>/)
})

// ═══ marks and heads ═══

test('the amber mark says Mark it completed in words; overdue says so too', () => {
  assert.equal(V.markHtml(), '<span class="cv-mark"><i class="cv-dot" aria-hidden="true"></i>Mark it completed</span>')
  assert.match(V.markHtml(true), /class="cv-mark is-over"/)
  assert.match(V.markHtml(true), /Mark it completed, waiting over 2 days/)
  assert.match(V.markHtml(true, 3), /waiting over 3 days/)
})

test('the Output box head: the count, the overdue count, in the notice colour once piled up; nothing at 0', () => {
  assert.equal(V.headHtml(sum(0)), '')
  assert.equal(V.headHtml(sum(3)), '<span class="cv-head">3 waiting</span>')
  assert.equal(V.headHtml(sum(3, { overdue: 1 })), '<span class="cv-head">3 waiting · 1 overdue</span>')
  assert.equal(V.headHtml(sum(8, { overdue: 2 })), '<span class="cv-head is-notice">8 waiting · 2 overdue</span>')
})

test('waits(id) and overdue(id) read the last summary', () => {
  V.setData(sum(3, { overdue: 1 }))
  assert.equal(V.waits('f2'), true)
  assert.equal(V.waits('nope'), false)
  assert.equal(V.overdue('f1'), true)
  assert.equal(V.overdue('f2'), false)
  assert.deepEqual(plain(V.data.counts), { waiting: 3, overdue: 1 })
  V.setData(null)
  assert.equal(V.waits('f2'), false)
})

// ═══ the flow's own Sign-off block ═══

test('the Sign-off block on a finished flow: Completed with its confirm; none on a flow on its way, archived or completed', () => {
  const c = { flow: { id: 'ship', title: 'Ship it', status: 'done' }, keyed: () => 'data-sb="complete"' }
  const html = V.flowBlock(c)
  assert.match(html, /<section class="ob ob-complete" aria-label="Sign-off" data-sb="complete">/)
  assert.match(html, /data-cv-ask[^>]*>(<svg[^]*<\/svg>)?Completed<\/button>/)
  assert.match(html, /Mark <b>Ship it<\/b> completed\?/)
  for (const flow of [{ id: 'a', status: 'open' }, { id: 'b', status: 'done', archivedAt: 'x' }, { id: 'c', status: 'done', completedAt: 'x' }, { id: 'd', status: 'done', deletedAt: 'x' }]) {
    assert.equal(V.flowBlock({ ...c, flow }), '', flow.id)
  }
  V.setData(sum(1))
  assert.match(V.flowBlock({ ...c, flow: { id: 'f1', title: 'At the Output', status: 'open' } }), /ob-complete/, 'open but at the Output: the server says it waits')
  V.setData(sum(1, { overdue: 1 }))
  assert.match(V.flowBlock({ ...c, flow: { id: 'f1', title: 'T', status: 'done' } }), /cv-mark is-over/)
  V.setData(null)
})

test('the archive label: Completed and the local date', () => {
  const at = new Date(2026, 10, 24, 9, 30).toISOString()
  assert.equal(V.archiveLabel({ completedAt: at }, new Date(2026, 10, 25)), 'Completed 24 Nov')
  assert.equal(V.archiveLabel({ completedAt: new Date(2025, 0, 3).toISOString() }, new Date(2026, 10, 25)), 'Completed 3 Jan 2025')
  assert.equal(V.archiveLabel({}), '')
  assert.equal(V.archiveLabel({ completedAt: 'nonsense' }), '')
})

test('wired in: the script is loaded after the pages it serves, checked by npm run check, its CSS linked', () => {
  const html = read('index.html')
  const at = s => html.indexOf(`<script src="${s}"></script>`)
  assert.ok(at('completed-view.js') > 0)
  assert.ok(html.includes('<link rel="stylesheet" href="completed.css">'))
  assert.ok(html.includes('<div id="homeOutputs" data-cv-line hidden></div>'))
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  assert.match(pkg.scripts.check, /node --check public\/completed-view\.js/)
  assert.doesNotMatch(read('completed-view.js') + read('completed.css'), /—/)
})
