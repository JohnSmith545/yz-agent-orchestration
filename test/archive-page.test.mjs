// Tests for the flow archive page (public/archive-page.js, #/archive): its two groups, the search, the in-row
// Delete for good question that names the flow, and how it is reached (the rail, the shell, index.html) and how
// an archived or deleted flow opens read-only (flows.js, archive.css). The page is a browser script: its pure
// html() runs in a vm with a bare window; the wiring is read from the files.

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

function load() {
  const window = { Shell: { ago: iso => (iso ? '3d' : '') } }
  vm.runInNewContext(read('archive-page.js'), { window })
  return window.ArchivePage
}

const DATA = {
  archived: [
    { id: 'dark-mode', title: 'Add a dark mode toggle', agent: 'Agent 3', status: 'open', tickets: ['FLA-12'], archivedAt: '2026-11-20T09:00:00Z' },
    { id: 'csp', title: 'Enforce the <CSP>', agent: 'Agent 1', status: 'done', tickets: [], archivedAt: '2026-11-19T09:00:00Z' },
  ],
  deleted: [
    { id: 'login-fix', title: 'Ship the login fix', agent: 'Agent 2', status: 'done', tickets: ['FLA-7'], deletedAt: '2026-11-21T09:00:00Z' },
    { id: 'broken', title: 'broken', agent: '', status: '', tickets: [], deletedAt: '2026-11-18T09:00:00Z', broken: true },
  ],
}

test('two groups, Archived then Deleted, each with its count and one plain line; a row is its title (opens it), agent, status, tickets and when', () => {
  const P = load()
  const h = P.html(DATA)
  assert.ok(h.indexOf('Archived') < h.indexOf('Deleted'))
  assert.match(h, /<h3 id="ar-h-archived">Archived <span class="faint">· 2<\/span><\/h3>/)
  assert.match(h, /<h3 id="ar-h-deleted">Deleted <span class="faint">· 2<\/span><\/h3>/)
  assert.match(h, /<button type="button" class="link ar-title" data-ar-open="dark-mode" aria-label="Open Add a dark mode toggle, read only">Add a dark mode toggle<\/button>/)
  assert.match(text(h), /Add a dark mode toggle Agent 3 · open · FLA-12 · archived 3d Restore Delete/)
  assert.match(text(h), /Ship the login fix Agent 2 · done · FLA-7 · deleted 3d Restore Delete for good/)
  assert.match(h, /Enforce the &lt;CSP&gt;/, 'escaped')
})

test('an archived row offers Restore and Delete; a deleted row Restore and Delete for good; a broken copy only Delete for good, never Open', () => {
  const h = load().html(DATA)
  assert.match(h, /data-ar-unarchive="dark-mode"[^>]*>Restore</)
  assert.match(h, /data-ar-delete="dark-mode"[^>]*>Delete</)
  assert.match(h, /data-ar-restore="login-fix"[^>]*>Restore</)
  assert.match(h, /data-ar-purge="login-fix"[^>]*>Delete for good</)
  assert.doesNotMatch(h, /data-ar-open="broken"|data-ar-restore="broken"/)
  assert.match(h, /data-ar-purge="broken"/)
  assert.match(h, /this copy cannot be read/)
})

test('Delete for good asks in the row first, naming the flow, with Delete for good and Cancel; no window.confirm anywhere', () => {
  const P = load()
  const h = P.html(DATA, { confirm: 'login-fix' })
  assert.match(text(h), /Delete Ship the login fix for good\? Its screenshots go too, and this cannot be undone\. Delete for good Cancel/)
  assert.match(h, /<button type="button" class="ar-danger" data-ar-purge-yes="login-fix">Delete for good<\/button><button type="button" data-ar-cancel>Cancel<\/button>/)
  assert.doesNotMatch(h, /data-ar-purge="login-fix"/, 'the question replaces the button')
  assert.doesNotMatch(read('archive-page.js'), /confirm\(/)
})

test('Delete on an archived flow its agent may be working on shows the server question in the row', () => {
  const h = load().html(DATA, { asking: { id: 'dark-mode', message: 'Agent 3 may still be working on this. Delete it anyway?' } })
  assert.match(text(h), /Agent 3 may still be working on this\. Delete it anyway\? Delete Cancel/)
  assert.match(h, /data-ar-delete="dark-mode" data-confirmed>Delete</)
})

test('the search filters by title, flow id or ticket id, ignoring case; a group with no match says so; counts read N of M', () => {
  const P = load()
  assert.equal(P.matches(DATA.archived[0], 'DARK'), true)
  assert.equal(P.matches(DATA.archived[0], 'fla-12'), true)
  assert.equal(P.matches(DATA.archived[0], 'dark-mode'), true)
  assert.equal(P.matches(DATA.archived[0], 'login'), false)
  assert.equal(P.matches(DATA.archived[0], '  '), true)
  const h = P.html(DATA, { q: 'fla-7' })
  assert.match(h, /Archived <span class="faint">· 0 of 2<\/span>/)
  assert.match(h, /No archived flow matches\./)
  assert.match(h, /Deleted <span class="faint">· 1 of 2<\/span>/)
  assert.match(h, /Ship the login fix/)
  assert.doesNotMatch(h, /Add a dark mode toggle/)
})

test('empty groups are one calm line each; a deleted group that could not be read says why', () => {
  const P = load()
  const h = P.html({ archived: [], deleted: [] })
  assert.match(h, /<p class="ar-empty">Nothing archived\.<\/p>/)
  assert.match(h, /<p class="ar-empty">Nothing deleted\.<\/p>/)
  assert.match(P.html({ archived: [], deleted: [], deletedError: 'The deleted flows could not be read: EACCES' }), /<p class="small warn">The deleted flows could not be read: EACCES<\/p>/)
  assert.doesNotThrow(() => P.html(null))
})

test('reached like the other pages: a rail link, #/archive with an optional ?q=, its own section, script and stylesheet', () => {
  const shell = read('shell.js')
  assert.match(shell, /link\('archive', '#\/archive', 'Flow archive'\)/)
  assert.match(shell, /archive: 'archiveView'/)
  assert.match(shell, /archive: 'ArchivePage'/)
  const window = {}
  vm.runInNewContext(shell, { window })
  assert.deepEqual(JSON.parse(JSON.stringify(window.Shell.resolve('#/archive?q=dark%20mode'))), { view: 'archive', params: { query: { q: 'dark mode' } }, redirect: null })
  const html = read('index.html')
  assert.match(html, /<section id="archiveView" aria-label="Flow archive" hidden><\/section>/)
  assert.match(html, /<script src="archive-page.js"><\/script>/)
  assert.match(html, /<link rel="stylesheet" href="archive.css">/)
})

test('an archived or deleted flow opens read-only: a banner with Restore, the controls that change it hidden and refused', () => {
  const flows = read('flows.js')
  assert.match(flows, /const readonly = f => !!\(f\?\.archivedAt \|\| f\?\.deletedAt\)/)
  assert.match(flows, /It is in the flow archive, and nothing can be changed here\./)
  assert.match(flows, /if \(!f \|\| readonly\(f\)\) return/, 'no status, tick or verify change')
  assert.match(flows, /if \(readonly\(f\) && e\.target\.closest\('\[data-drop\], \[data-archive\], \[data-delete\], \[data-answer\]/)
  const css = read('archive.css')
  for (const sel of ['.fl-more', '[data-answer]', '[data-verify]', '[data-node-status]', '[data-sb-request]', '[data-send-open]']) assert.ok(css.includes(sel), sel)
  assert.match(css, /\.fl-open\.is-readonly :is\(/)
})
