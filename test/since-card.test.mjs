// Tests for Home's Since you were away card (public/since.js, spec F2) in a
// vm: a stub window, document, localStorage and fetch. The card's baseline is
// home.since, which ONLY Mark read moves (and a first load starts at now);
// it hides itself when nothing happened, and a reload keeps it until marked read.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'public', 'since.js'), 'utf8')
const SHELL = fs.readFileSync(path.join(HERE, '..', 'public', 'shell.js'), 'utf8')

const KEY = 'home.since'
const SINCE = new Date(Date.now() - 9 * 3600_000).toISOString() // a past time, whatever the clock says
const EMPTY = { since: null, commits: [], levels: [], flows: [], deliveries: [], tickets: [] }
const line = (text, more = {}) => ({ text, href: '#/tickets', at: new Date(Date.now() - 2 * 3600_000).toISOString(), ...more })

/**
 * since.js loaded once (a page load) over `stored` (a Map standing in for
 * localStorage: pass the same Map again to load the page a second time), with
 * /api/since answering `digest`.
 */
function load({ stored = new Map([[KEY, SINCE]]), digest = EMPTY, storageThrows = false } = {}) {
  const localStorage = {
    getItem: k => { if (storageThrows) throw new Error('blocked'); return stored.has(k) ? stored.get(k) : null },
    setItem: (k, v) => { if (storageThrows) throw new Error('blocked'); stored.set(k, String(v)) },
  }
  const docListeners = {}
  const winListeners = {}
  const document = { visibilityState: 'visible', addEventListener: (t, fn) => ((docListeners[t] ||= []).push(fn)) }
  const shellWindow = {}
  vm.runInNewContext(SHELL, { window: shellWindow })
  const window = {
    document,
    localStorage,
    addEventListener: (t, fn) => ((winListeners[t] ||= []).push(fn)),
    Shell: { ago: shellWindow.Shell.ago, go: h => gone.push(h) },
    Help: { attach: (el, html) => helped.push(html) },
  }
  const gone = []
  const helped = []
  const fetched = []
  const fetch = async url => (fetched.push(url), { ok: true, json: async () => digest })
  vm.runInNewContext(SRC, { window, fetch, document })
  return { Since: window.Since, stored, fetched, gone, helped, docListeners, winListeners, document }
}

function box() {
  const listeners = {}
  return {
    innerHTML: 'old',
    hidden: false,
    listeners,
    addEventListener: (t, fn) => ((listeners[t] ||= []).push(fn)),
    removeEventListener: (t, fn) => (listeners[t] = (listeners[t] || []).filter(f => f !== fn)),
    querySelector: () => ({ stub: true }),
  }
}
const settle = () => new Promise(r => setTimeout(r, 0))
const asked = t => '/api/since?t=' + encodeURIComponent(t)
const markRead = el => el.listeners.click[0]({ preventDefault() {}, target: { closest: sel => (sel === '[data-read]' ? {} : null) } })

test('the card is hidden when nothing happened', async () => {
  const t = load()
  const el = box()
  t.Since.mount(el)
  await settle()
  assert.deepEqual(t.fetched, [asked(SINCE)])
  assert.equal(el.hidden, true)
  assert.equal(el.innerHTML, '')
})

test('a brand-new browser starts home.since at now, so the first card is not the whole history', async () => {
  const stored = new Map()
  const before = Date.now()
  const t = load({ stored })
  const at = Date.parse(stored.get(KEY))
  assert.ok(at >= before && at <= Date.now(), 'now, in storage')
  const el = box()
  t.Since.mount(el)
  await settle()
  assert.deepEqual(t.fetched, [asked(stored.get(KEY))])
  assert.equal(el.hidden, true)
})

test('a broken or future home.since is reset to now on load, so the card can recover', async () => {
  for (const bad of ['not a date', '', new Date(Date.now() + 86400_000).toISOString()]) {
    const stored = new Map([[KEY, bad]])
    const before = Date.now()
    const t = load({ stored })
    const at = Date.parse(stored.get(KEY))
    assert.ok(at >= before && at <= Date.now(), `${bad}: reset to now`)
    const el = box()
    t.Since.mount(el)
    await settle()
    assert.deepEqual(t.fetched, [asked(stored.get(KEY))], bad)
  }
})

test('the card lists every line, escaped, with a Mark read link and a ?', async () => {
  const digest = { ...EMPTY, since: SINCE, flows: [line('<i>Add</i> a dark mode toggle is done', { href: '#/flows', flow: 'dark' })], commits: [line('Agent 1 committed 3 times on ABC-102', { ticket: 'ABC-102' })] }
  const t = load({ digest })
  const el = box()
  t.Since.mount(el)
  await settle()
  assert.equal(el.hidden, false)
  assert.match(el.innerHTML, /<h3>Since [^<]*<\/h3>/)
  assert.match(el.innerHTML, /&lt;i&gt;Add&lt;\/i&gt; a dark mode toggle is done/)
  assert.doesNotMatch(el.innerHTML, /<i>Add/)
  assert.match(el.innerHTML, /Agent 1 committed 3 times on ABC-102/)
  assert.ok(el.innerHTML.indexOf('toggle is done') < el.innerHTML.indexOf('committed'), 'flows before commits')
  assert.match(el.innerHTML, /data-flow="dark"/)
  assert.match(el.innerHTML, /data-ticket="ABC-102"/)
  assert.match(el.innerHTML, />2h</, 'the time comes from Shell.ago')
  assert.match(el.innerHTML, /data-read[^>]*>Mark read</)
  assert.equal(t.helped.length, 1, 'the ? explains the card')
})

test('a reload with the same storage shows the same card: hiding or leaving the page stores nothing', async () => {
  const digest = { ...EMPTY, flows: [line('Fix the login is blocked')] }
  const stored = new Map([[KEY, SINCE]])
  const first = load({ stored, digest })
  const a = box()
  first.Since.mount(a)
  await settle()
  // Leave the page the way a reload does: hidden, then pagehide (nothing listens for it).
  first.document.visibilityState = 'hidden'
  for (const fn of first.docListeners.visibilitychange || []) fn()
  for (const fn of first.winListeners.pagehide || []) fn()
  assert.equal(stored.get(KEY), SINCE, 'unchanged')

  const second = load({ stored, digest })
  const b = box()
  second.Since.mount(b)
  await settle()
  assert.deepEqual(second.fetched, [asked(SINCE)])
  assert.equal(b.hidden, false)
  assert.equal(b.innerHTML, a.innerHTML, 'the same card')
})

test('Mark read writes home.since and hides the card, and a reload keeps it hidden', async () => {
  const stored = new Map([[KEY, SINCE]])
  const t = load({ stored, digest: { ...EMPTY, flows: [line('Fix the login is blocked')] } })
  const el = box()
  t.Since.mount(el)
  await settle()
  assert.equal(el.hidden, false)
  const before = Date.now()
  markRead(el)
  const at = Date.parse(stored.get(KEY))
  assert.ok(at >= before && at <= Date.now(), 'now, in storage')
  assert.equal(el.hidden, true)
  assert.equal(el.innerHTML, '')

  // The reload asks from the new baseline; nothing has happened since, so it stays hidden.
  const again = load({ stored, digest: EMPTY })
  const b = box()
  again.Since.mount(b)
  await settle()
  assert.deepEqual(again.fetched, [asked(stored.get(KEY))])
  assert.equal(b.hidden, true)
})

test('coming back to the tab asks again from the same baseline', async () => {
  const t = load()
  const el = box()
  t.Since.mount(el)
  await settle()
  t.document.visibilityState = 'visible'
  for (const fn of t.docListeners.visibilitychange) fn()
  await settle()
  assert.deepEqual(t.fetched, [asked(SINCE), asked(SINCE)])
})

test('a line click opens its ticket, flow or page through the shell helpers', async () => {
  const t = load()
  const el = box()
  t.Since.mount(el)
  const opened = []
  t.Since._open({ dataset: { ticket: 'ABC-1' }, getAttribute: () => '#/tickets' }, { FactoryView: { gotoTicket: id => opened.push(['ticket', id]) } })
  t.Since._open({ dataset: { flow: 'dark' }, getAttribute: () => '#/flows' }, { FlowsView: { gotoFlow: id => opened.push(['flow', id]) } })
  t.Since._open({ dataset: {}, getAttribute: () => '#/flows' }, {})
  assert.deepEqual(opened, [['ticket', 'ABC-1'], ['flow', 'dark']])
  assert.deepEqual(t.gone, ['#/flows'])
})

test('storage that throws leaves the card hidden and never breaks the page', async () => {
  const t = load({ storageThrows: true })
  const el = box()
  t.Since.mount(el)
  await settle()
  assert.equal(el.hidden, true)
  assert.doesNotThrow(() => t.Since.markRead())
})

test('the head reads the local time, yesterday, or the date', () => {
  const { Since } = load()
  const now = new Date(2026, 10, 13, 8, 0)
  assert.equal(Since.head(new Date(2026, 10, 13, 6, 5).toISOString(), now), 'Since 06:05')
  assert.equal(Since.head(new Date(2026, 10, 12, 23, 10).toISOString(), now), 'Since yesterday 23:10')
  assert.equal(Since.head(new Date(2026, 10, 9, 23, 10).toISOString(), now), 'Since 9 Nov 23:10')
})
