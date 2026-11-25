// Tests for Completed on the Flows page and in the flow archive: a flow card or tile that waits for the user's sign-off
// carries the amber mark in words; the opened flow's Output tab ends with the Sign-off block (Completed, next to Send);
// a completed flow opens read-only with its own line (Uncomplete is in the flow archive, never a Restore that the
// server would refuse); and the archive lists it with `Completed <date>` and Uncomplete. Browser files in a vm.

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

const window = { Shell: { ago: iso => (iso ? '3d' : '') } }
for (const f of ['completed-view.js', 'flow-route.js', 'flow-board.js', 'archive-page.js']) vm.runInNewContext(read(f), { window })
const { CompletedView: C, FlowBoard: B, ArchivePage: A } = window
const sum = ids => ({ waiting: ids.map(([id, overdue]) => ({ id, overdue })), counts: { waiting: ids.length, overdue: ids.filter(x => x[1]).length }, max: 7, warnAfterDays: 2, piled: false })
const flow = (id, more = {}) => ({ id, title: `Flow ${id}`, agent: 'Agent 1', status: 'done', nodes: [], updatedAt: '2026-11-24T10:00:00Z', derived: { progress: { done: 1, total: 1 }, waiting: [], story: [] }, ...more })

// ═══ the board ═══

test('a card and a tile that wait for sign-off say Mark it completed; others do not', () => {
  C.setData(sum([['wait', false], ['late', true]]))
  assert.match(B.small(flow('wait')), /<span class="cv-mark"><i class="cv-dot" aria-hidden="true"><\/i>Mark it completed<\/span>/)
  assert.match(B.small(flow('late')), /cv-mark is-over.*Mark it completed, waiting over 2 days/)
  assert.match(B.card(flow('wait', { status: 'open' })), /cv-mark/, 'open at the Output: a full card, marked too')
  assert.doesNotMatch(B.small(flow('other')), /cv-mark/)
  C.setData(null)
  assert.doesNotMatch(B.small(flow('wait')), /cv-mark/, 'before the summary is read: no mark')
})

// ═══ the opened flow ═══

test('the Output tab ends with the Sign-off block, after Send, and redraws when what waits changes', () => {
  const src = read('flow-output.js')
  assert.match(src, /\$\{window\.FlowSend\.html\(c\)\}\$\{window\.CompletedView\?\.flowBlock\(c\) \|\| ''\}<\/div>/)
  assert.match(src, /CompletedView\?\.waits\(flow\.id\)/, 'in the redraw signature')
  assert.match(read('flows.js'), /addEventListener\('outputs:change'/)
})

test('a completed flow opens read-only with its own line: when, and Uncomplete in the flow archive; no Restore', () => {
  const html = C.readonlyHtml({ id: 'ship-it', title: 'Ship it', completedAt: new Date(2026, 10, 24, 9).toISOString(), archivedAt: 'x' }, new Date(2026, 10, 25))
  assert.match(html, /^<p class="fl-readonly" role="note">/)
  assert.match(text(html), /This flow is completed \(24 Nov\)\. It is in the flow archive, and nothing can be changed here\./)
  assert.match(html, /<a class="link" href="#\/archive\?q=ship-it">Uncomplete it in the flow archive<\/a>/)
  assert.doesNotMatch(html, /data-ro-restore/)
  assert.equal(C.readonlyHtml({ id: 'x', archivedAt: 'y' }), '', 'an archived flow keeps its own banner')
  assert.match(read('flows.js'), /f\.completedAt && window\.CompletedView\) return window\.CompletedView\.readonlyHtml\(f\)/)
})

// ═══ the flow archive ═══

const DATA = {
  archived: [
    { id: 'signed', title: 'Ship <it>', agent: 'Agent 1', status: 'done', tickets: [], archivedAt: '2026-11-24T09:00:00Z', completedAt: new Date(2026, 10, 24, 9).toISOString() },
    { id: 'away', title: 'Put away', agent: 'Agent 2', status: 'open', tickets: [], archivedAt: '2026-11-20T09:00:00Z' },
  ],
  deleted: [],
}

test('the archive lists a completed flow with Completed and its date, and Uncomplete in place of Restore', () => {
  const html = A.html(DATA)
  const row = html.slice(html.indexOf('data-id="signed"'), html.indexOf('data-id="away"'))
  assert.match(row, /<span class="ar-done">Completed \d{1,2} [A-Z][a-z]{2}( \d{4})?<\/span>/)
  assert.match(row, /<button type="button" class="link" data-ar-uncomplete="signed" aria-label="Uncomplete Ship &lt;it&gt;: back on the boards">Uncomplete<\/button>/)
  assert.doesNotMatch(row, /data-ar-unarchive/)
  assert.doesNotMatch(row, /archived 3d/, 'one date, the completed one')
  assert.match(row, /data-ar-delete="signed"/, 'Delete still works')
  const other = html.slice(html.indexOf('data-id="away"'))
  assert.match(other, /data-ar-unarchive="away"/)
  assert.doesNotMatch(other, /ar-done|data-ar-uncomplete/)
})

test('an archived flow that still waits for sign-off says Mark it completed in the archive, with its Completed tick', () => {
  C.setData(sum([['away', false]]))
  const html = A.html(DATA)
  const row = html.slice(html.indexOf('data-id="away"'))
  assert.match(row, /Mark it completed/)
  assert.match(row, /data-cv-yes data-cv-ids="away">Completed<\/button>/)
  assert.match(row, /data-ar-unarchive="away"/, 'Restore stays')
  C.setData(null)
  assert.doesNotMatch(A.html(DATA).slice(A.html(DATA).indexOf('data-id="away"')), /cv-confirm/)
  assert.match(read('archive-page.js'), /addEventListener\('outputs:change'/)
})

test('the help says archiving is not a sign-off', () => {
  assert.match(read('flows-page.js'), /Archiving is not a sign-off/)
  assert.match(text(A.html(DATA)), /Completed ones are the outputs you signed off/)
  const guide = fs.readFileSync(path.join(HERE, '..', 'docs', 'USER_GUIDE.md'), 'utf8')
  assert.match(guide, /Archiving is not a sign-off/)
  assert.match(fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8'), /Archiving is not a sign-off/)
})

test('the archive says what Completed is, and its Uncomplete posts completed false', () => {
  assert.match(text(A.html(DATA)), /Completed ones are the outputs you signed off/)
  const src = read('archive-page.js')
  assert.match(src, /data-ar-uncomplete/)
  assert.match(src, /CompletedView\.complete\(\[id\], false\)/)
})
