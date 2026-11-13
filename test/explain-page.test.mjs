// Tests for public/explain.js, the one explanation popover and the Explain
// bubble (spec 7). The word card on hover is term-card.js (test/term-card.test.mjs).
// Browser scripts, so they run here in a vm context with a small stub DOM and a
// stubbed fetch: GET /api/glossary serves the shipped glossary.json the way the
// server does (keyed by terms.mjs normalise), and /api/explain answers however
// the test says.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { normalise } from '../terms.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const GLOSSARY = fs.readFileSync(path.join(PUBLIC, 'glossary.json'), 'utf8')

/** A stub element: records attributes, listeners and children. */
function el(tag = 'div') {
  return {
    tagName: tag.toUpperCase(), hidden: false, innerHTML: '', textContent: '', className: '', style: {}, dataset: {}, attrs: {}, listeners: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return this.attrs[k] ?? null },
    removeAttribute(k) { delete this.attrs[k] },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
    appendChild(c) { this.children.push(c); return c },
    contains: () => false,
    closest: () => null,
    querySelector: () => null,
    focus() {},
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 160, bottom: 120, width: 60, height: 20 }),
    get offsetWidth() { return 320 },
    get offsetHeight() { return 120 },
  }
}

/** Loads explain.js; `api` answers POST /api/explain (a response-ish object, or a function that may throw). */
function load(api = { ok: true, status: 200, body: { text: 'An answer.', cost: 0.0042 } }, glossaryText = GLOSSARY) {
  const document = el('document')
  document.body = el('body')
  document.documentElement = el('html')
  document.createElement = tag => el(tag)
  document.getElementById = () => null
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    if (url === '/api/glossary') {
      const g = JSON.parse(glossaryText)
      return { ok: true, json: async () => ({ terms: Object.entries(g).map(([term, e]) => ({ key: normalise(term), term, short: e.short, more: e.more ?? null, source: 'built-in' })) }) }
    }
    const r = typeof api === 'function' ? await api() : api
    return { ok: r.ok, status: r.status, json: async () => r.body }
  }
  const prefills = []
  const opened = []
  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    FactoryChat: { prefill: t => (prefills.push(t), true) },
    Shell: { drawer: { open: () => opened.push(1), isOpen: false } },
    getSelection: () => null,
  }
  const ctx = { window, document, fetch, setTimeout, clearTimeout, JSON }
  for (const f of ['terms.js', 'glossary-store.js', 'explain.js']) vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), ctx)
  const pop = document.body.children.find(c => c.className === 'xp-pop')
  return { Explain: window.Explain, pop, calls, prefills, opened, window, document }
}
const posts = calls => calls.filter(c => c.url === '/api/explain')

test('a selection that is a glossary term shows its entry and runs no turn', async () => {
  const { Explain, pop, calls } = load()
  const r = await Explain.explainText('  Fast-Forward ')
  assert.equal(r.term, 'fast-forward')
  assert.equal(r.short, JSON.parse(GLOSSARY)['fast-forward'].short)
  assert.deepEqual(posts(calls), [])
  assert.equal(pop.hidden, false)
  assert.ok(pop.innerHTML.includes('Ask Independent about this'))
})

test('trailing punctuation and doubled spaces still find the term', async () => {
  const { Explain, calls } = load()
  assert.equal((await Explain.explainText('merge   base.')).term, 'merge base')
  assert.deepEqual(posts(calls), [])
})

test('an unknown phrase asks /api/explain and shows the answer with its cost', async () => {
  const { Explain, pop, calls } = load()
  const r = await Explain.explainText('rebased onto the release train')
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { text: 'An answer.', cost: 0.0042, from: 'model', saved: false })
  const [p] = posts(calls)
  assert.equal(p.init.method, 'POST')
  assert.deepEqual(JSON.parse(p.init.body), { text: 'rebased onto the release train' })
  assert.ok(pop.innerHTML.includes('An answer.'))
  assert.ok(pop.innerHTML.includes('cost $0.0042'))
})

test('an answer with no cost shows the ~$0.01 note', async () => {
  const { Explain, pop } = load({ ok: true, status: 200, body: { text: 'Plain.', cost: null } })
  await Explain.explainText('something odd')
  assert.ok(pop.innerHTML.includes('cost ~$0.01'))
})

test('a failed turn shows exactly Couldn’t explain that, with the Ask link', async () => {
  for (const api of [{ ok: false, status: 502, body: { error: 'model not found' } }, () => { throw new Error('offline') }, { ok: true, status: 200, body: {} }]) {
    const { Explain, pop } = load(api)
    const r = await Explain.explainText('something odd')
    assert.ok(r.error)
    assert.ok(pop.innerHTML.includes("Couldn't explain that"))
    assert.ok(pop.innerHTML.includes('Ask Independent about this'))
    assert.ok(!pop.innerHTML.includes('model not found'), 'the server error is not shown')
  }
})

test('text over 500 characters is not sent', async () => {
  const { Explain, calls } = load()
  assert.ok((await Explain.explainText('x'.repeat(501))).error)
  assert.deepEqual(posts(calls), [])
})

test('Ask Independent opens the drawer and prefills the question about the selection, without sending', async () => {
  const { Explain, pop, prefills, opened, calls } = load()
  await Explain.explainText('idle')
  const target = { closest: sel => (sel === '.xp-ask' ? {} : null) }
  for (const fn of pop.listeners.click) fn({ target, preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(prefills, ['Explain "idle" in the context of this dashboard: '])
  assert.equal(opened.length, 1)
  assert.deepEqual(posts(calls), [])
  assert.equal(pop.hidden, true)
})

test('a selection the server saved as a learned word refreshes the store', async () => {
  const { Explain, calls } = load({ ok: true, status: 200, body: { text: 'A plain answer.', cost: 0.001, from: 'model', saved: true } })
  await Explain.explainText('retry storm')
  await new Promise(r => setTimeout(r, 5))
  assert.equal(calls.filter(c => c.url === '/api/glossary').length, 2, 'loaded once, then refreshed')
})

test('an answer that arrives after the popover closed is dropped', async () => {
  let release
  const { Explain, pop } = load(() => new Promise(r => (release = () => r({ ok: true, status: 200, body: { text: 'Late.', cost: 0.01 } }))))
  const pending = Explain.explainText('something odd')
  await new Promise(r => setTimeout(r, 5))
  Explain.close()
  release()
  await pending
  assert.equal(pop.hidden, true)
  assert.ok(!pop.innerHTML.includes('Late.'))
})

test('an answer and a glossary entry holding markup are shown escaped, never as elements', async () => {
  const { Explain, pop } = load({ ok: true, status: 200, body: { text: '<img src=x onerror=alert(1)>', cost: 0.001 } })
  await Explain.explainText('something odd')
  assert.ok(pop.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(!pop.innerHTML.includes('<img'))

  const g = JSON.stringify({ boldword: { short: 'A <b>x</b> word.', more: '<script>alert(1)</script>' } })
  const { Explain: E2, pop: pop2 } = load(undefined, g)
  await E2.explainText('boldword')
  assert.ok(pop2.innerHTML.includes('A &lt;b&gt;x&lt;/b&gt; word.'))
  assert.ok(pop2.innerHTML.includes('&lt;script&gt;'))
  assert.ok(!pop2.innerHTML.includes('<b>') && !pop2.innerHTML.includes('<script'))
})

// ═══ what a scroll closes ═══

/** A scroll event on `target`, through the listeners explain.js put on the document. */
const scroll = (document, target) => (document.listeners.scroll || []).forEach(fn => fn({ target }))
/** A scrollable box: holds whatever `holds` says. */
const box = (...holds) => ({ contains: x => holds.includes(x) })

test('a scroll on an unrelated box (the chat log streaming, a live feed) leaves a word card open', async () => {
  const { Explain, pop, document } = load()
  const dfn = el('dfn')
  Explain.show('<p>card</p>', null, { held: dfn })
  scroll(document, box())
  assert.equal(pop.hidden, false, 'the chat log scrolled itself; the term did not move')
  scroll(document, box(dfn))
  assert.equal(pop.hidden, true, 'a box holding the term scrolled it away')
  Explain.show('<p>card</p>', null, { held: dfn })
  scroll(document, document)
  assert.equal(pop.hidden, true, 'the page scrolled')
})

test('the Explain bubble and its popover close only on a scroll that moves the selected text', async () => {
  const { pop, window, document } = load()
  const text = Object.assign(el('p'), { nodeType: 1 })
  const range = { commonAncestorContainer: text, getBoundingClientRect: () => ({ left: 10, top: 10, right: 90, bottom: 30, width: 80 }) }
  window.getSelection = () => ({ rangeCount: 1, toString: () => 'rebased onto the release train', anchorNode: text, focusNode: text, getRangeAt: () => range })
  const bubble = document.body.children.find(c => c.className === 'xp-bubble')
  for (const fn of document.listeners.mouseup) fn({ target: text })
  await new Promise(r => setTimeout(r, 5))
  assert.equal(bubble.hidden, false)
  scroll(document, box())
  assert.equal(bubble.hidden, false, 'a feed scrolling elsewhere leaves the bubble')
  for (const fn of bubble.listeners.click) fn({})
  await new Promise(r => setTimeout(r, 5))
  assert.equal(pop.hidden, false)
  scroll(document, box())
  assert.equal(pop.hidden, false, 'the answer stays while the chat streams')
  scroll(document, box(text))
  assert.equal(pop.hidden, true, 'the box holding the selection scrolled')
})

