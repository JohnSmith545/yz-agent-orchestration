// Tests for Archive and Delete on the Flows page: public/flow-trash.js (the calls, the toasts, the one link
// under the board to the flow archive), the ⋯ menu of an opened flow (flow-head.js), each card's own Archive
// and Delete and the board leaving archived flows out (flow-board.js), and the palette action. Browser
// scripts, run in a vm with stub windows and a stub fetch. The archive page itself is test/archive-page.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const plain = v => JSON.parse(JSON.stringify(v))
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

/** flow-trash.js in a vm: `answers` maps a url to { status, body } (or a function of the posted body to one); every fetch is recorded. */
function loadTrash(answers = {}) {
  const fetches = []
  const loads = []
  const toasts = []
  const alerts = []
  const fetch = async (url, init) => {
    fetches.push([url, init?.method || 'GET', init?.body ? JSON.parse(init.body) : undefined])
    const given = answers[url] || { status: 200, body: { ok: true } }
    const a = typeof given === 'function' ? given(init?.body ? JSON.parse(init.body) : {}) : given
    return { ok: a.status < 400, status: a.status, json: async () => structuredClone(a.body) }
  }
  const window = {
    Shell: { ago: iso => (iso === 'now-iso' ? 'now' : iso ? '3d' : '') },
    FlowsView: { load: () => loads.push(1) },
    Notifier: { toast: (html, opts) => toasts.push([html, opts]) },
    alert: m => alerts.push(m),
  }
  vm.runInNewContext(read('flow-trash.js'), { window, fetch })
  return { T: window.FlowTrash, fetches, loads, toasts, alerts }
}

// ═══ the toasts ═══

test('Delete toasts that the flow waits in the flow archive, with Undo that restores; Archive toasts the same with Undo; no 24 hours anywhere', async () => {
  const { T, toasts, loads } = loadTrash()
  assert.deepEqual(plain(await T.remove('dark-mode', false)), { ok: true })
  await T.archive('dark-mode', true)
  await T.archive('dark-mode', false)
  assert.deepEqual(plain(toasts), [
    ['Deleted. It waits in the flow archive until you delete it for good.', { kind: 'info', action: { label: 'Undo', kind: 'restore', flowId: 'dark-mode' }, keep: false }],
    ['Archived. It is in the flow archive.', { kind: 'info', action: { label: 'Undo', kind: 'unarchive', flowId: 'dark-mode' }, keep: false }],
  ])
  assert.equal(loads.length, 3, 'each call reloads the board')
  assert.doesNotMatch(read('flow-trash.js'), /24 hours|Trash ·|leftText/)
})

test('a refused call is said in plain words and reports false or null', async () => {
  const { T, alerts } = loadTrash({ '/api/flows/x/archive': { status: 404, body: { error: 'No flow x.' } }, '/api/flows/x/delete': { status: 404, body: { error: 'No flow x.' } } })
  assert.equal(await T.archive('x', true), false)
  assert.equal(await T.remove('x', true), null)
  assert.deepEqual(alerts, ['No flow x.', 'No flow x.'])
})

test('remove hands back the server question for an open flow, without a toast', async () => {
  const { T, toasts } = loadTrash({ '/api/flows/dark-mode/delete': { status: 409, body: { needsConfirm: true, message: 'Agent 3 may still be working on this. Delete it anyway?' } } })
  assert.deepEqual(plain(await T.remove('dark-mode', false)), { needsConfirm: true, message: 'Agent 3 may still be working on this. Delete it anyway?' })
  assert.equal(toasts.length, 0)
})

// ═══ the links under the board ═══

test('under the board: ONE link, Flow archive · N, archived and deleted together; nothing when both are empty', () => {
  const { T } = loadTrash()
  assert.equal(T.linksHtml({ archived: 0, deleted: 0 }), '')
  assert.equal(T.linksHtml(undefined), '')
  assert.equal(T.linksHtml({ archived: 3, deleted: 2 }), '<p class="small faint fl-lists"><a class="link" href="#/archive" data-archive-link>Flow archive · 5</a></p>')
  assert.match(T.linksHtml({ deleted: 1 }), />Flow archive · 1</)
})

// ═══ the ⋯ menu of an opened flow (flow-head.js) ═══

function loadHead() {
  const window = { FlowDrawer: { md: s => `<p>${s}</p>` }, Shell: { ago: () => '2m' } }
  vm.runInNewContext(read('flow-head.js'), { window })
  return window.FlowHead
}
const PARTS = { tickets: () => '', envPill: () => '', statusPill: s => `<span>${s}</span>`, statuses: ['open', 'done'] }
const FLOW = { id: 'dark-mode', title: 'T', agent: 'Agent 3', status: 'open', why: '', updatedAt: '2026-11-14T09:00:00Z' }
const menuOf = h => /<div class="fl-more-menu">([\s\S]*?)<\/div><\/details>/.exec(h.sub)?.[1] || ''

test('the ⋯ menu: Archive, or Unarchive on an archived flow, and Delete', () => {
  const H = loadHead()
  const menu = menuOf(H.html(FLOW, PARTS))
  assert.match(menu, /<button type="button" class="link" data-archive>Archive<\/button>/)
  assert.match(menu, /<button type="button" class="link" data-delete>Delete<\/button>/)
  assert.doesNotMatch(menu, /Unarchive/)
  assert.match(menuOf(H.html({ ...FLOW, archivedAt: '2026-11-14T09:00:00Z' }, PARTS)), /<button type="button" class="link" data-archive>Unarchive<\/button>/)
  assert.doesNotMatch(H.html(FLOW, PARTS).sub, /<details class="fl-more" open>/, 'closed until asked')
})

test('Delete on an open flow: the server question inline in the open menu, with Delete and Cancel', () => {
  const H = loadHead()
  const h = H.html(FLOW, { ...PARTS, asking: 'Agent 3 may still be working on <this>. Delete it anyway?' })
  assert.match(h.sub, /<details class="fl-more" open>/)
  const menu = menuOf(h)
  assert.match(menu, /<p class="small fl-ask-delete">Agent 3 may still be working on &lt;this&gt;\. Delete it anyway\?<\/p>/)
  assert.match(menu, /<button type="button" class="link" data-delete data-confirmed>Delete<\/button><button type="button" class="link" data-delete-cancel>Cancel<\/button>/)
})

// ═══ the board and the strip (flow-board.js) ═══

test('each card and tile carries its own Archive and Delete; a Delete waiting on the server question shows it on that card with Delete and Cancel', () => {
  const window = { Shell: { ago: () => '2m' } }
  vm.runInNewContext(read('flow-board.js'), { window })
  const B = window.FlowBoard
  const f = { id: 'dark-mode', title: 'Add <a> toggle', agent: 'Agent 3', status: 'open', nodes: [], updatedAt: '2026-11-14T09:00:00Z' }
  const acts = B.acts(f)
  assert.equal(acts, '<div class="fl-card-acts"><button type="button" class="link" data-card-archive="dark-mode" aria-label="Archive Add &lt;a&gt; toggle">Archive</button>' +
    '<button type="button" class="link fl-row-bad" data-card-delete="dark-mode" aria-label="Delete Add &lt;a&gt; toggle">Delete</button></div>')
  assert.ok(B.card(f).includes(acts) && B.small(f).includes(acts))
  const asking = { id: 'dark-mode', message: 'Agent 3 may still be working on this. Delete it anyway?' }
  const q = B.card(f, { asking })
  assert.match(q, /<span class="fl-card-ask">Agent 3 may still be working on this\. Delete it anyway\?<\/span>/)
  assert.match(q, /data-card-delete="dark-mode" data-confirmed aria-label="Delete Add &lt;a&gt; toggle">Delete<\/button><button type="button" class="link" data-card-cancel/)
  assert.doesNotMatch(q, /data-card-archive/)
  assert.ok(B.card({ ...f, id: 'other' }, { asking }).includes('data-card-archive="other"'), 'only the asked card changes')
})

test('archived and deleted flows are left off the board and out of Waiting on you', () => {
  const window = { Shell: { ago: () => '2m' } }
  vm.runInNewContext(read('flow-board.js'), { window })
  const B = window.FlowBoard
  const ask = { id: 'n1', type: 'ask', title: 'Ship it?', answer: null }
  const live = { id: 'live', title: 'Live', agent: 'Agent 3', status: 'open', nodes: [ask], updatedAt: '2026-11-14T09:00:00Z' }
  const away = { ...live, id: 'away', archivedAt: '2026-11-14T09:00:00Z' }
  const gone = { ...live, id: 'gone', deletedAt: '2026-11-14T09:00:00Z' }
  assert.deepEqual(plain(B.shown([live, away, gone]).map(f => f.id)), ['live'], 'a deleted flow opened read-only is never on the board')
  assert.deepEqual(plain(B.stripRows([live, away], new Set()).map(r => r.f.id)), ['live'])
})

// ═══ the palette and the wiring ═══

test('the palette: Flow archive opens #/archive, and an archived flow is not among the flows', () => {
  const window = {}
  vm.runInNewContext(read('palette.js'), { window })
  const calls = []
  const w = { Shell: { go: h => calls.push(h) }, FlowsView: { data: { flows: [{ id: 'a', title: 'Kept', status: 'open' }, { id: 'b', title: 'Put away', status: 'open', archivedAt: '2026-11-14T09:00:00Z' }] } } }
  const items = window.Palette.gather(w)
  assert.deepEqual(plain(items.filter(i => i.kind === 'flow').map(i => i.label)), ['Kept'])
  assert.equal(items.filter(i => /^(Trash|Archived)$/.test(i.label)).length, 0)
  items.find(i => i.label === 'Flow archive' && i.kind === 'action').run()
  assert.deepEqual(calls, ['#/archive'])
})

test('wired: flow-trash.js loads before flows.js, the toasts can Undo, the help says what Archive and Delete do, and npm run check covers the files', () => {
  const html = read('index.html')
  const at = s => html.indexOf(`<script src="${s}"></script>`)
  assert.ok(at('flow-trash.js') > 0 && at('flow-trash.js') < at('flows.js'))
  assert.match(read('notify.js'), /const KINDS = \[[^\]]*'restore'[^\]]*'unarchive'/)
  assert.match(read('notify.js'), /case 'restore': return window\.FlowTrash\?\.restore\(a\.flowId\)/)
  assert.match(read('flows-page.js'), /<b>Archive<\/b> and <b>Delete<\/b>/)
  assert.match(read('flows-page.js'), /Nothing leaves by a timer/)
  assert.doesNotMatch(read('flows-page.js'), /Trash|24 hours/)
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  for (const f of ['trash.mjs', 'trash-routes.mjs', 'public/flow-trash.js', 'public/archive-page.js']) assert.ok(pkg.scripts.check.includes(`node --check ${f}`), f)
})

// ═══ the delete flash, Restored to Archived ═══

test('without: the flow leaves the page data at once, so its card never flashes back while the reload is in flight', () => {
  const { T } = loadTrash()
  const data = { flows: [{ id: 'a' }, { id: 'b' }], invalid: [], counts: { archived: 0, deleted: 0 } }
  assert.deepEqual(plain(T.without(data, 'a')), { flows: [{ id: 'b' }], invalid: [], counts: { archived: 0, deleted: 0 } })
  assert.equal(data.flows.length, 2, 'the old data is not changed')
  const src = read('flows.js')
  assert.match(src, /if \(r\?\.ok\) \{ data = window\.FlowTrash\.without\(data, f\.id\); return close\(\) \}/, 'deleteOpened drops it before close()')
  assert.match(src, /\$\('\.fl-open-sub \[data-delete\]\[data-confirmed\]', board\)\?\.focus\(\)/, 'the inline question focuses its Delete')
})

test('Restore of a flow that was archived says Restored to Archived.; any other restore says nothing new', async () => {
  const { T, toasts } = loadTrash({
    '/api/trash/put-away/restore': { status: 200, body: { ok: true, archived: true } },
    '/api/trash/kept/restore': { status: 200, body: { ok: true, archived: false } },
  })
  await T.restore('kept')
  assert.equal(toasts.length, 0)
  await T.restore('put-away')
  assert.deepEqual(plain(toasts), [['Restored to Archived.', { kind: 'info', keep: false }]])
})
