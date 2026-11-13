// Tests for the rail's spend chip (public/spend.js, spec F4) in a vm: a stub
// window, a tiny fake DOM and a fetch that answers /api/spend. The chip is
// hidden at zero, reads `$12.40 today` with a total, rounds to cents in the
// page, escapes every string in its panel, and polls every 60 s.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'public', 'spend.js'), 'utf8')
const SHELL = fs.readFileSync(path.join(HERE, '..', 'public', 'shell.js'), 'utf8')

/** A fake element: enough of the DOM for mount (createElement, appendChild, attributes, listeners). */
function element(tag = 'div') {
  const attrs = {}
  const listeners = {}
  return {
    tagName: tag.toUpperCase(),
    children: [],
    className: '',
    textContent: '',
    hidden: false,
    title: '',
    listeners,
    appendChild(c) {
      this.children.push(c)
      return c
    },
    setAttribute: (k, v) => (attrs[k] = String(v)),
    getAttribute: k => (k in attrs ? attrs[k] : null),
    addEventListener: (t, fn) => ((listeners[t] ||= []).push(fn)),
  }
}

const ZERO = { today: 0, byKind: { chat: 0, relay: 0, explain: 0, refresh: 0 }, recent: [] }

/** spend.js loaded once, with /api/spend answering `data` (a value or a function of the call count). */
function load(data = ZERO) {
  const helped = []
  const closed = []
  const fetched = []
  const intervals = []
  const docListeners = {}
  const document = {
    visibilityState: 'visible',
    createElement: element,
    addEventListener: (t, fn) => ((docListeners[t] ||= []).push(fn)),
  }
  const shellWindow = {}
  vm.runInNewContext(SHELL, { window: shellWindow })
  const window = {
    document,
    Shell: { ago: shellWindow.Shell.ago },
    Help: { attach: (el, html) => (helped.push(html), el), close: () => closed.push(true) },
    setInterval: (fn, ms) => (intervals.push({ fn, ms }), intervals.length),
  }
  const fetch = async url => {
    fetched.push(url)
    const body = typeof data === 'function' ? data(fetched.length) : data
    return { ok: true, json: async () => body }
  }
  vm.runInNewContext(SRC, { window, fetch, document })
  return { Spend: window.Spend, helped, closed, fetched, intervals, docListeners }
}
const settle = () => new Promise(r => setTimeout(r, 0))
/** The chip button and its two text spans inside the slot. */
const parts = slot => {
  const btn = slot.children[0]
  return { btn, amt: btn.children[0], label: btn.children[1] }
}

test('the chip stays hidden when nothing was spent today', async () => {
  const t = load(ZERO)
  const slot = element()
  t.Spend.mount(slot)
  await settle()
  assert.deepEqual(t.fetched, ['/api/spend'])
  assert.equal(slot.hidden, true)
})

test('with a total the chip shows, reading $12.40 today rounded to cents', async () => {
  const t = load({ ...ZERO, today: 12.3987, byKind: { ...ZERO.byKind, chat: 12.3987 } })
  const slot = element()
  t.Spend.mount(slot)
  await settle()
  const { btn, amt, label } = parts(slot)
  assert.equal(slot.hidden, false)
  assert.equal(btn.tagName, 'BUTTON')
  assert.equal(label.textContent, '$12.40 today')
  assert.equal(amt.textContent, '$12') // the 56 px rail shows the short form
  assert.match(btn.title, /\$12\.40 today/)
})

test('under half a cent shows as <$0.01, never as $0.00 or hidden', async () => {
  const t = load({ ...ZERO, today: 0.0012, byKind: { ...ZERO.byKind, explain: 0.0012 }, recent: [{ at: new Date().toISOString(), kind: 'explain', usd: 0.0012 }] })
  const slot = element()
  t.Spend.mount(slot)
  await settle()
  assert.equal(slot.hidden, false)
  assert.equal(parts(slot).label.textContent, '<$0.01 today')
})

test('the panel lists every kind and the recent lines with how long ago, escaped', async () => {
  const at = new Date(Date.now() - 3 * 60_000).toISOString()
  const t = load({
    today: 0.95,
    byKind: { chat: 0.94, relay: 0, explain: 0.01, refresh: 0 },
    recent: [{ at, kind: 'explain', usd: 0.01 }, { at, kind: '<img src=x onerror=alert(1)>', usd: 0.5 }],
  })
  const slot = element()
  t.Spend.mount(slot)
  await settle()
  const html = t.helped.at(-1)
  assert.match(html, /\$0\.95 today/)
  for (const label of ['Chat', 'Answer relay', 'Explain', 'Ticket refresh']) assert.ok(html.includes(label), label)
  assert.match(html, /\$0\.94/)
  assert.match(html, />3m</)
  assert.ok(!html.includes('<img'), 'an odd kind is escaped')
  assert.ok(html.includes('&lt;img'))
})

test('the chip polls /api/spend every 60 s, and hides again when the day rolls over to zero', async () => {
  const t = load(n => (n === 1 ? { ...ZERO, today: 1.5 } : ZERO))
  const slot = element()
  t.Spend.mount(slot)
  await settle()
  assert.equal(slot.hidden, false)
  assert.equal(t.intervals.length, 1)
  assert.equal(t.intervals[0].ms, 60_000)
  t.intervals[0].fn()
  await settle()
  assert.equal(t.fetched.length, 2)
  assert.equal(slot.hidden, true)
})

test('mounting twice adds one chip and one timer', async () => {
  const t = load(ZERO)
  const slot = element()
  t.Spend.mount(slot)
  t.Spend.mount(slot)
  await settle()
  assert.equal(slot.children.length, 1)
  assert.equal(t.intervals.length, 1)
})

test('a failed fetch leaves the chip as it was and never throws', async () => {
  const t = load(ZERO)
  const slot = element()
  slot.hidden = true
  const window = { document: { createElement: element, addEventListener() {} }, Help: { attach: el => el }, Shell: { ago: () => '' }, setInterval: () => 1 }
  vm.runInNewContext(SRC, { window, fetch: async () => { throw new Error('offline') }, document: window.document })
  window.Spend.mount(slot)
  await settle()
  assert.equal(slot.hidden, true)
  assert.ok(t.Spend)
})

test('refresh fetches at once (an explain or a chat turn just finished)', async () => {
  const t = load(ZERO)
  t.Spend.mount(element())
  await settle()
  await t.Spend.refresh()
  assert.equal(t.fetched.length, 2)
})
