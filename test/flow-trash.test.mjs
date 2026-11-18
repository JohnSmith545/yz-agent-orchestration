// Tests for Archive and the Trash on the page: public/flow-trash.js (the Trash and Archived lists in
// place of the board, the links under it, the time left), the ⋯ menu of an opened flow (flow-head.js),
// the board and the strip leaving archived flows out (flow-board.js), and the palette actions. Browser
// scripts, run in a vm with stub windows, a stub fetch and a tiny stub DOM.

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
const MIN = 60_000
const HOUR = 60 * MIN

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

/** A board element: innerHTML, and a focusable heading. */
function stubBoard() {
  const head = { focused: false, focus() { this.focused = true } }
  return { innerHTML: '', head, querySelector: sel => (sel.includes('data-list-head') ? head : { focus() {} }) }
}
/** A click target carrying `attrs` (`data-purge`: 'dark'): closest() finds it for a selector naming one of them. */
function target(attrs = {}) {
  const dataset = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]))
  const el = { dataset, hasAttribute: a => a in attrs, closest: sel => (Object.keys(attrs).some(a => sel.includes(`[${a}]`)) ? el : null) }
  return el
}
const settle = () => new Promise(r => setTimeout(r, 0))

const ITEMS = [
  { id: 'dark-mode', title: 'Add a dark mode toggle', agent: 'Agent 3', status: 'open', deletedAt: '2026-11-14T09:00:00.000Z', expiresAt: '2026-11-15T09:00:00.000Z', leftMs: 23 * HOUR + 5 * MIN },
  { id: 'acme-report', title: 'Nightly <b>report</b>', agent: 'Agent 1', status: 'done', deletedAt: '2026-11-13T09:40:00.000Z', expiresAt: '2026-11-14T09:40:00.000Z', leftMs: 40 * MIN },
]

// ═══ the time left ═══

test('leftText at the boundaries: hours rounded down, minutes below an hour, then under a minute, then expiring now', () => {
  const { T } = loadTrash()
  assert.equal(T.leftText(24 * HOUR), '24 h left')
  assert.equal(T.leftText(90 * MIN), '1 h left')
  assert.equal(T.leftText(HOUR), '1 h left')
  assert.equal(T.leftText(HOUR - 1000), '59 min left')
  assert.equal(T.leftText(MIN), '1 min left')
  assert.equal(T.leftText(59_000), 'under a minute left')
  assert.equal(T.leftText(1), 'under a minute left')
  assert.equal(T.leftText(0), 'expiring now')
  assert.equal(T.leftText(-5), 'expiring now')
})

// ═══ the Trash list ═══

test('the Trash list: ← Flows, the heading, one muted sentence, then a row per flow with its time left, Restore and Delete forever', () => {
  const { T } = loadTrash()
  const h = T.trashHtml(ITEMS)
  assert.match(h, /<button type="button" class="link" data-close>← Flows<\/button>/)
  assert.match(h, /<h2 class="fl-title" tabindex="-1" data-list-head>Trash<\/h2>/)
  assert.match(text(h), /Deleted flows stay here for 24 hours, then they are gone for good\./)
  const rows = [...h.matchAll(/<li class="fl-row"[\s\S]*?<\/li>/g)].map(m => text(m[0]))
  assert.deepEqual(rows, [
    'Add a dark mode toggle Agent 3 · 23 h left Restore Delete forever',
    'Nightly &lt;b&gt;report&lt;/b&gt; Agent 1 · 40 min left Restore Delete forever',
  ])
  assert.doesNotMatch(h, /<b>report/, 'escaped')
  assert.match(h, /data-restore="dark-mode" aria-label="Restore Add a dark mode toggle">Restore</)
  assert.match(h, /data-purge="dark-mode" aria-label="Delete Add a dark mode toggle forever">Delete forever</)
})

test('the empty Trash is one line, and a broken entry offers only Delete forever', () => {
  const { T } = loadTrash()
  assert.match(T.trashHtml([]), /<p class="small faint fl-list-empty">Trash is empty\.<\/p>/)
  const h = T.trashHtml([{ id: 'broken', title: 'broken', agent: '', status: '', leftMs: HOUR * 2, broken: true }])
  assert.doesNotMatch(h, /data-restore/)
  assert.match(h, /data-purge="broken"/)
})

test('Delete forever asks first: the button reads Delete forever? and only a second click deletes', async () => {
  const { T, fetches, loads } = loadTrash({ '/api/trash': { status: 200, body: { items: ITEMS } } })
  const board = stubBoard()
  await T.fill(board, 'trash')
  assert.equal(board.head.focused, true, 'the heading takes the focus when the list opens')
  assert.match(board.innerHTML, />Delete forever<\/button>/)
  assert.equal(T.click({ target: target({ 'data-purge': 'dark-mode' }) }, board), true)
  assert.match(board.innerHTML, /data-purge="dark-mode"[^>]*data-confirm[^>]*>Delete forever\?<\/button>/)
  assert.equal((board.innerHTML.match(/Delete forever\?/g) || []).length, 1, 'only that row asks')
  assert.deepEqual(fetches.filter(f => f[1] === 'POST'), [], 'nothing deleted on the first click')
  T.click({ target: target({ 'data-purge': 'dark-mode' }) }, board)
  await settle()
  assert.deepEqual(plain(fetches.filter(f => f[1] === 'POST')), [['/api/trash/dark-mode/purge', 'POST', {}]])
  assert.equal(loads.length, 1, 'the page reloads (the counts and the list)')
})

test('a pending Delete forever? is let go by any other click', async () => {
  const { T, fetches } = loadTrash({ '/api/trash': { status: 200, body: { items: ITEMS } } })
  const board = stubBoard()
  await T.fill(board, 'trash')
  T.click({ target: target({ 'data-purge': 'dark-mode' }) }, board)
  assert.equal(T.click({ target: target({}) }, board), false)
  assert.doesNotMatch(board.innerHTML, /Delete forever\?/)
  T.click({ target: target({ 'data-purge': 'dark-mode' }) }, board)
  assert.deepEqual(fetches.filter(f => f[1] === 'POST'), [], 'that click asks again, it does not delete')
})

test('Restore posts the restore and reloads; a refusal is shown in plain words', async () => {
  const { T, fetches, loads, alerts } = loadTrash({ '/api/trash/acme-report/restore': { status: 409, body: { error: 'A flow called acme-report exists again. Delete or rename that one first.' } } })
  const board = stubBoard()
  await T.fill(board, 'trash')
  T.click({ target: target({ 'data-restore': 'dark-mode' }) }, board)
  T.click({ target: target({ 'data-restore': 'acme-report' }) }, board)
  await settle()
  assert.deepEqual(plain(fetches.filter(f => f[1] === 'POST').map(f => f[0])), ['/api/trash/dark-mode/restore', '/api/trash/acme-report/restore'])
  assert.deepEqual(alerts, ['A flow called acme-report exists again. Delete or rename that one first.'])
  assert.equal(loads.length, 2)
})

// ═══ the Archived list ═══

const ARCH = [
  { id: 'dark-mode', title: 'Add a dark mode toggle', agent: 'Agent 3', status: 'open', archivedAt: '2026-11-11T09:00:00.000Z' },
  { id: 'acme-report', title: 'Nightly report', agent: 'Agent 1', status: 'done', archivedAt: 'now-iso' },
]

test('the Archived list: the heading, then title (opens the flow), agent, status pill, archived 3d (short, like updated 2m), Unarchive and Delete', () => {
  const { T } = loadTrash()
  const h = T.archivedHtml(ARCH)
  assert.match(h, /<h2 class="fl-title" tabindex="-1" data-list-head>Archived<\/h2>/)
  assert.match(h, /<button type="button" class="link fl-row-title" data-open="dark-mode">Add a dark mode toggle<\/button>/)
  assert.match(h, /<span class="fl-status fs-open">open<\/span>/)
  const rows = [...h.matchAll(/<li class="fl-row"[\s\S]*?<\/li>/g)].map(m => text(m[0]))
  assert.deepEqual(rows, [
    'Add a dark mode toggle Agent 3 · open · archived 3d Unarchive Delete',
    'Nightly report Agent 1 · done · archived now Unarchive Delete',
  ])
  assert.match(T.archivedHtml([]), /<p class="small faint fl-list-empty">Nothing archived\.<\/p>/)
})

test('Delete on an archived flow its agent may be working on asks inline, Delete then really deletes, Cancel lets go', async () => {
  const { T, fetches, toasts } = loadTrash({
    '/api/flows?archived=1': { status: 200, body: { flows: ARCH } },
    '/api/flows/dark-mode/delete': b => (b.confirm ? { status: 200, body: { ok: true } } : { status: 409, body: { needsConfirm: true, message: 'Agent 3 may still be working on this. Delete it anyway?' } }),
  })
  const board = stubBoard()
  await T.fill(board, 'archived')
  T.click({ target: target({ 'data-arch-delete': 'dark-mode' }) }, board)
  await settle()
  assert.match(board.innerHTML, /Agent 3 may still be working on this\. Delete it anyway\?/)
  assert.match(board.innerHTML, /data-arch-delete="dark-mode" data-confirmed[^>]*>Delete<\/button>/)
  assert.match(board.innerHTML, /data-arch-cancel[^>]*>Cancel<\/button>/)
  T.click({ target: target({ 'data-arch-cancel': '' }) }, board)
  assert.doesNotMatch(board.innerHTML, /may still be working/)
  T.click({ target: target({ 'data-arch-delete': 'dark-mode', 'data-confirmed': '' }) }, board)
  await settle()
  assert.deepEqual(plain(fetches.filter(f => f[1] === 'POST').map(f => f[2])), [{ confirm: false }, { confirm: true }])
  assert.deepEqual(plain(toasts.map(t => t[0])), ['Moved to Trash. Kept for 24 hours.'], 'one toast, for the delete that happened')
})

test('Unarchive from the list posts archived false', async () => {
  const { T, fetches } = loadTrash({ '/api/flows?archived=1': { status: 200, body: { flows: ARCH } } })
  const board = stubBoard()
  await T.fill(board, 'archived')
  T.click({ target: target({ 'data-unarchive': 'acme-report' }) }, board)
  await settle()
  assert.deepEqual(plain(fetches.filter(f => f[1] === 'POST')), [['/api/flows/acme-report/archive', 'POST', { archived: false }]])
})

// ═══ the toasts ═══

test('Delete toasts Moved to Trash. Kept for 24 hours. with Undo that restores; Archive toasts Archived. with Undo', async () => {
  const { T, toasts } = loadTrash()
  assert.deepEqual(plain(await T.remove('dark-mode', false)), { ok: true })
  await T.archive('dark-mode', true)
  await T.archive('dark-mode', false)
  assert.deepEqual(plain(toasts), [
    ['Moved to Trash. Kept for 24 hours.', { kind: 'info', action: { label: 'Undo', kind: 'restore', flowId: 'dark-mode' }, keep: false }],
    ['Archived.', { kind: 'info', action: { label: 'Undo', kind: 'unarchive', flowId: 'dark-mode' }, keep: false }],
  ])
})

test('remove hands back the server question for an open flow, without a toast', async () => {
  const { T, toasts } = loadTrash({ '/api/flows/dark-mode/delete': { status: 409, body: { needsConfirm: true, message: 'Agent 3 may still be working on this. Delete it anyway?' } } })
  assert.deepEqual(plain(await T.remove('dark-mode', false)), { needsConfirm: true, message: 'Agent 3 may still be working on this. Delete it anyway?' })
  assert.equal(toasts.length, 0)
})

// ═══ the links under the board ═══

test('under the board: Archived · N and Trash · N as links, only those with something in them, else nothing', () => {
  const { T } = loadTrash()
  assert.equal(T.linksHtml({ archived: 0, trash: 0 }), '')
  assert.equal(T.linksHtml(undefined), '')
  const both = T.linksHtml({ archived: 3, trash: 2 })
  assert.match(both, /^<p class="small faint fl-lists">/)
  assert.match(both, /<button type="button" class="link" data-list="archived">Archived · 3<\/button>/)
  assert.match(both, /<button type="button" class="link" data-list="trash">Trash · 2<\/button>/)
  assert.doesNotMatch(T.linksHtml({ archived: 0, trash: 1 }), /Archived/)
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

test('archived flows are left off the board and out of Waiting on you', () => {
  const window = { Shell: { ago: () => '2m' } }
  vm.runInNewContext(read('flow-board.js'), { window })
  const B = window.FlowBoard
  const ask = { id: 'n1', type: 'ask', title: 'Ship it?', answer: null }
  const live = { id: 'live', title: 'Live', agent: 'Agent 3', status: 'open', nodes: [ask], updatedAt: '2026-11-14T09:00:00Z' }
  const away = { ...live, id: 'away', archivedAt: '2026-11-14T09:00:00Z' }
  assert.deepEqual(plain(B.shown([live, away]).map(f => f.id)), ['live'])
  assert.deepEqual(plain(B.stripRows([live, away], new Set()).map(r => r.f.id)), ['live'])
})

// ═══ the palette and the wiring ═══

test('the palette: Trash and Archived open those lists, and an archived flow is not among the flows', () => {
  const window = {}
  vm.runInNewContext(read('palette.js'), { window })
  const calls = []
  const w = { FlowsView: { data: { flows: [{ id: 'a', title: 'Kept', status: 'open' }, { id: 'b', title: 'Put away', status: 'open', archivedAt: '2026-11-14T09:00:00Z' }] }, showList: k => calls.push(k) } }
  const items = window.Palette.gather(w)
  assert.deepEqual(plain(items.filter(i => i.kind === 'flow').map(i => i.label)), ['Kept'])
  items.find(i => i.label === 'Trash' && i.kind === 'action').run()
  items.find(i => i.label === 'Archived' && i.kind === 'action').run()
  assert.deepEqual(calls, ['trash', 'archived'])
})

test('wired: flow-trash.js loads before flows.js, the toasts can Undo, the help says what Archive and the Trash do, and npm run check covers the new files', () => {
  const html = read('index.html')
  const at = s => html.indexOf(`<script src="${s}"></script>`)
  assert.ok(at('flow-trash.js') > 0 && at('flow-trash.js') < at('flows.js'))
  assert.match(read('notify.js'), /const KINDS = \[[^\]]*'restore'[^\]]*'unarchive'/)
  assert.match(read('notify.js'), /case 'restore': return window\.FlowTrash\?\.restore\(a\.flowId\)/)
  assert.match(read('flows-page.js'), /<b>Archive<\/b>/)
  assert.match(read('flows-page.js'), /<b>Trash<\/b>[^']*24 hours/)
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  for (const f of ['trash.mjs', 'trash-routes.mjs', 'public/flow-trash.js']) assert.ok(pkg.scripts.check.includes(`node --check ${f}`), f)
})

// ═══ the review's fixes: focus, the delete flash, Restored to Archived ═══

/** A board whose querySelector finds an element when its markup holds that attribute, and that tracks the focus. */
function focusBoard() {
  const doc = { activeElement: null }
  const make = sel => {
    const [, attr, value] = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel) || []
    return { sel, attr, focus() { doc.activeElement = this }, hasAttribute: a => a === attr, getAttribute: a => (a === attr ? value ?? '' : null) }
  }
  const board = {
    innerHTML: '',
    ownerDocument: doc,
    contains: el => !!el && el !== doc.outside,
    querySelector(sel) {
      const [, attr, value] = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel) || []
      if (!attr) return null
      return this.innerHTML.includes(value ? `${attr}="${value}"` : attr) ? make(sel) : null
    },
  }
  doc.outside = { sel: 'outside', focus() { doc.activeElement = this } }
  return { board, doc }
}

test('a poll redraw of the Trash keeps the focus on the same button; when that row is gone, the heading takes it', async () => {
  const answers = { '/api/trash': { status: 200, body: { items: ITEMS } } }
  const { T } = loadTrash(answers)
  const { board, doc } = focusBoard()
  await T.fill(board, 'trash')
  const held = board.querySelector('[data-restore="acme-report"]')
  held.focus()
  answers['/api/trash'] = { status: 200, body: { items: ITEMS.map(i => ({ ...i, leftMs: i.leftMs - 2 * MIN })) } }
  await T.fill(board, 'trash')
  assert.notEqual(doc.activeElement, held, 'the markup was redrawn')
  assert.equal(doc.activeElement.sel, '[data-restore="acme-report"]', 'the same button has the focus again')
  answers['/api/trash'] = { status: 200, body: { items: [ITEMS[0]] } } // acme-report restored
  await T.fill(board, 'trash')
  assert.equal(doc.activeElement.sel, '[data-list-head]')
})

test('a redraw while the focus is outside the list leaves it there', async () => {
  const answers = { '/api/trash': { status: 200, body: { items: ITEMS } } }
  const { T } = loadTrash(answers)
  const { board, doc } = focusBoard()
  await T.fill(board, 'trash')
  doc.outside.focus()
  answers['/api/trash'] = { status: 200, body: { items: [ITEMS[0]] } }
  await T.fill(board, 'trash')
  assert.equal(doc.activeElement.sel, 'outside')
})

test('the inline Delete in an Archived row takes the focus, and its Delete and Cancel name the flow', async () => {
  const { T } = loadTrash({
    '/api/flows?archived=1': { status: 200, body: { flows: ARCH } },
    '/api/flows/dark-mode/delete': { status: 409, body: { needsConfirm: true, message: 'Agent 3 may still be working on this. Delete it anyway?' } },
  })
  const { board, doc } = focusBoard()
  await T.fill(board, 'archived')
  board.querySelector('[data-arch-delete="dark-mode"]').focus()
  T.click({ target: target({ 'data-arch-delete': 'dark-mode' }) }, board)
  await settle()
  assert.match(board.innerHTML, /data-arch-delete="dark-mode" data-confirmed aria-label="Delete Add a dark mode toggle">Delete<\/button>/)
  assert.match(board.innerHTML, /data-arch-cancel aria-label="Cancel deleting Add a dark mode toggle">Cancel<\/button>/)
  assert.equal(doc.activeElement.sel, '[data-arch-delete="dark-mode"]', 'the Delete that now confirms')
})

test('without: the flow leaves the page data at once, so its card never flashes back while the reload is in flight', () => {
  const { T } = loadTrash()
  const data = { flows: [{ id: 'a' }, { id: 'b' }], invalid: [], counts: { archived: 0, trash: 0 } }
  assert.deepEqual(plain(T.without(data, 'a')), { flows: [{ id: 'b' }], invalid: [], counts: { archived: 0, trash: 0 } })
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
