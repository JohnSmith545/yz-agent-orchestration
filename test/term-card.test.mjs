// Tests for the marked-word hover card (public/term-card.js) over the shared
// glossary store (public/glossary-store.js) and the one popover explain.js
// owns. Browser scripts, so they run in a vm with a stub DOM, fake timers, a
// fake clock and a stubbed fetch: no network, no model turn.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')

/** A stub element: attributes, listeners, a parent link for contains(). */
function el(tag = 'div', props = {}) {
  const e = {
    tagName: tag.toUpperCase(), hidden: false, innerHTML: '', textContent: '', className: '', style: {}, dataset: {}, attrs: {}, listeners: {}, children: [], parent: null,
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return this.attrs[k] ?? null },
    removeAttribute(k) { delete this.attrs[k] },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
    appendChild(c) { this.children.push(c); c.parent = this; return c },
    contains(x) { for (let n = x; n; n = n.parent) if (n === this) return true; return false },
    closest() { return null },
    querySelector() { return null },
    querySelectorAll() { return [] },
    focus() {},
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 160, bottom: 120, width: 60, height: 20 }),
    get offsetWidth() { return 320 },
    get offsetHeight() { return 120 },
    ...props,
  }
  return e
}

/** A chip as Terms.html draws it; `flow` is the id of the flow it sits in, `text` its paragraph. */
function chip(term, raw = term, { flow = '', text = '' } = {}) {
  const block = el('p', { textContent: text || raw })
  const flowEl = flow ? el('section', { dataset: { flow } }) : null
  const d = el('dfn', { textContent: raw, dataset: { term, raw } })
  d.closest = sel => (sel.includes('dfn[data-term]') ? d : sel.includes('#rail') ? null : sel.includes('[data-flow]') ? flowEl : sel.includes('p') ? block : null)
  return d
}

/** Fake timers: setTimeout queued by due time, run by advance(ms). */
function clock() {
  let now = Date.parse('2026-11-13T10:00:00Z')
  let id = 0
  const timers = new Map()
  return {
    Date: { now: () => now, parse: Date.parse },
    setTimeout: (fn, ms = 0) => (timers.set(++id, { fn, at: now + ms }), id),
    clearTimeout: t => timers.delete(t),
    async advance(ms) {
      const until = now + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0])
        now = next[1].at
        next[1].fn()
        await flush()
      }
      now = until
      await flush()
    },
  }
}
/** Every pending promise job, however long the chain: a real macrotask turn (the vm only has fake timers). */
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)) }

const ENTRIES = [
  { key: 'idempotency', term: 'idempotency', short: 'Doing it twice has the same effect as once.', more: 'So a retry is safe.', source: 'built-in', at: null, seenIn: [] },
  { key: 'token', term: 'token', short: 'A short secret string.', more: null, source: 'learned', at: '2026-11-12T10:00:00Z', seenIn: ['dark-mode'] },
]

/**
 * Loads terms, the store, explain and the card. `routes` answers fetch by path: a function (body, url) or
 * a { status, body } object. GET /api/glossary serves `glossary` (mutable by the tests).
 */
async function load({ routes = {}, glossary = ENTRIES, flows = [] } = {}) {
  const t = clock()
  const document = el('document')
  document.body = el('body')
  document.documentElement = el('html')
  document.createElement = tag => el(tag)
  document.getElementById = () => null
  document.querySelectorAll = () => []
  const calls = []
  const state = { glossary: structuredClone(glossary) }
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url, body })
    if (url === '/api/glossary') return { ok: true, status: 200, json: async () => ({ terms: state.glossary }) }
    const r = routes[url]
    const out = typeof r === 'function' ? await r(body, url) : r || { status: 404, body: { error: 'no route' } }
    return { ok: (out.status || 200) < 400, status: out.status || 200, json: async () => out.body }
  }
  const prefills = []
  const drawer = []
  const window = {
    innerWidth: 1280, innerHeight: 800,
    FactoryChat: { name: 'Independent', prefill: s => (prefills.push(s), true) },
    Shell: { drawer: { open: () => drawer.push(1) } },
    FlowsView: { data: { flows } },
    getSelection: () => null,
  }
  const ctx = { window, document, fetch, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, Date: t.Date, JSON, Promise, console }
  for (const f of ['terms.js', 'glossary-store.js', 'explain.js', 'term-card.js']) vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), ctx)
  await flush()
  const pop = document.body.children.find(c => c.className === 'xp-pop')
  /** Every document listener for `type`, as the browser would call them. */
  const fire = (type, target, extra = {}) => {
    const e = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...extra }
    for (const fn of document.listeners[type] || []) fn(e)
    for (const fn of window.listeners?.[type] || []) fn(e)
    return e
  }
  /** A click on a card button: `tc` is its data-tc. */
  const press = tc => {
    const b = el('button', { dataset: { tc } })
    b.closest = sel => (sel.includes('[data-tc]') ? b : null)
    pop.appendChild(b)
    fire('click', b)
    for (const fn of pop.listeners.click || []) fn({ target: b, preventDefault() {}, stopPropagation() {} })
  }
  return { ...t, window, document, pop, calls, state, fire, press, prefills, drawer, G: window.Glossary, outside: el('main') }
}
const posts = (calls, url) => calls.filter(c => c.url === url)

// ═══ hover, focus, pin ═══

test('hovering a chip for 250 ms opens its card: the term, the explanation, More, the source tag and the two actions', async () => {
  const p = await load()
  const d = chip('idempotency')
  p.fire('mouseover', d)
  await p.advance(249)
  assert.equal(p.pop.hidden, true, 'not before the dwell')
  await p.advance(1)
  assert.equal(p.pop.hidden, false)
  const h = p.pop.innerHTML
  assert.match(h, /class="xp-term">idempotency</)
  assert.match(h, /Doing it twice has the same effect as once\./)
  assert.match(h, /<details class="xp-more"><summary>More<\/summary><p>So a retry is safe\.<\/p><\/details>/)
  assert.match(h, /class="tc-src">built-in</)
  assert.match(h, /data-tc="ask"[^>]*>Ask the agent</)
  assert.match(h, /data-tc="edit"[^>]*>Edit</)
})

test('moving away closes it after 200 ms; the pointer inside the card keeps it open', async () => {
  const p = await load()
  const d = chip('idempotency')
  p.fire('mouseover', d)
  await p.advance(250)
  p.fire('mouseover', p.outside)
  await p.advance(199)
  assert.equal(p.pop.hidden, false)
  await p.advance(1)
  assert.equal(p.pop.hidden, true, 'left: closed')

  p.fire('mouseover', d)
  await p.advance(250)
  p.fire('mouseover', p.outside)
  await p.advance(100)
  const inside = p.pop.appendChild(el('p'))
  p.fire('mouseover', inside)
  await p.advance(1000)
  assert.equal(p.pop.hidden, false, 'the pointer reached the card in time')
})

test('a hover that leaves before the dwell never opens', async () => {
  const p = await load()
  p.fire('mouseover', chip('idempotency'))
  await p.advance(100)
  p.fire('mouseover', p.outside)
  await p.advance(1000)
  assert.equal(p.pop.hidden, true)
})

test('keyboard focus opens the card at once; a click pins it until Escape, and Escape closes one thing', async () => {
  const p = await load()
  const d = chip('token')
  p.fire('focusin', d)
  await p.advance(0)
  assert.equal(p.pop.hidden, false)
  assert.match(p.pop.innerHTML, /class="tc-src">learned</)
  p.fire('mouseover', p.outside)
  await p.advance(1000)
  // focus held: the pointer elsewhere does not close a card opened from the keyboard until focus leaves
  p.fire('click', d)
  await p.advance(0)
  p.fire('mouseover', p.outside)
  await p.advance(1000)
  assert.equal(p.pop.hidden, false, 'pinned: hovering away leaves it')
  const esc = p.fire('keydown', p.outside, { key: 'Escape' })
  assert.equal(p.pop.hidden, true)
  assert.equal(esc.defaultPrevented, true, 'the shell does not also close the drawer')
})

test('a click outside closes a pinned card', async () => {
  const p = await load()
  const d = chip('token')
  p.fire('click', d)
  await p.advance(0)
  assert.equal(p.pop.hidden, false)
  p.fire('mousedown', p.outside)
  assert.equal(p.pop.hidden, true)
})

// ═══ learning: never a blank card ═══

const flowWith = (terms, id = 'dark-mode') => ({ id, agent: 'Agent 3', derived: { terms } })

test('an unknown word shows Looking this up… while it is learned, then the explanation once the store refreshes', async () => {
  let release
  const p = await load({ routes: { '/api/glossary/learn': () => new Promise(r => (release = r)) } })
  const flow = flowWith([{ term: 'SQL injection', key: 'sql injection', known: false }])
  assert.equal(p.G.autoLearn(flow), true)
  const d = chip('sql injection', 'SQL injection', { flow: 'dark-mode' })
  p.fire('click', d)
  await p.advance(0)
  assert.match(p.pop.innerHTML, /Looking this up…/)
  assert.doesNotMatch(p.pop.innerHTML, /data-tc="explain"/)
  await p.advance(1500)
  assert.equal(posts(p.calls, '/api/glossary/learn').length, 1)
  p.state.glossary.push({ key: 'sql injection', term: 'SQL injection', short: 'Sneaking database commands into a form field.', more: null, source: 'learned', at: '2026-11-13T10:00:02Z', seenIn: ['dark-mode'] })
  release({ status: 200, body: { learned: [{ key: 'sql injection', term: 'SQL injection', short: 'x' }], skipped: [], cost: 0.002 } })
  await p.advance(0)
  assert.match(p.pop.innerHTML, /Sneaking database commands into a form field\./)
  assert.match(p.pop.innerHTML, /class="tc-src">learned</)
})

test('a failed learn shows Explain it and Ask the agent; Explain it asks /api/explain for that one word', async () => {
  const p = await load({
    routes: {
      '/api/glossary/learn': { status: 200, body: { error: 'turn failed' } },
      '/api/explain': { status: 200, body: { text: 'A plain answer.', cost: 0.0012, from: 'model', saved: false } },
    },
  })
  p.G.autoLearn(flowWith([{ term: 'SQL injection', key: 'sql injection', known: false }]))
  await p.advance(1500)
  const d = chip('sql injection', 'SQL injection', { flow: 'dark-mode' })
  p.fire('click', d)
  await p.advance(0)
  assert.match(p.pop.innerHTML, /data-tc="explain"[^>]*>Explain it</)
  assert.match(p.pop.innerHTML, /data-tc="ask"[^>]*>Ask the agent</)
  assert.doesNotMatch(p.pop.innerHTML, /Looking this up/)
  p.press('explain')
  await p.advance(0)
  assert.deepEqual(posts(p.calls, '/api/explain').map(c => c.body), [{ text: 'SQL injection' }])
  assert.match(p.pop.innerHTML, /A plain answer\./)
  assert.match(p.pop.innerHTML, /cost \$0\.0012/)
})

test('a busy learn reads like a failed one: the card offers Explain it', async () => {
  const p = await load({ routes: { '/api/glossary/learn': { status: 200, body: { busy: true } } } })
  p.G.autoLearn(flowWith([{ term: 'retry storm', key: 'retry storm', known: false }]))
  await p.advance(1500)
  p.fire('click', chip('retry storm', 'retry storm', { flow: 'dark-mode' }))
  await p.advance(0)
  assert.match(p.pop.innerHTML, /Explain it/)
})

// ═══ Ask the agent ═══

test('Ask the agent posts the word and its sentence; via the chat it prefills the Ask drawer without sending', async () => {
  const p = await load({ routes: { '/api/flows/mine/ask-term': { status: 200, body: { ok: true, via: 'chat', text: 'What does "token" mean here?' } } } })
  p.fire('click', chip('token', 'token', { flow: 'mine', text: 'First. Saved the [token] in the vault. Last.' }))
  await p.advance(0)
  p.press('ask')
  await p.advance(0)
  assert.deepEqual(posts(p.calls, '/api/flows/mine/ask-term').map(c => c.body), [{ term: 'token', sentence: 'Saved the [token] in the vault.' }])
  assert.deepEqual(p.prefills, ['What does "token" mean here?'])
})

test('Ask the agent via the relay says sent to the agent in the card, and its title names the cost', async () => {
  const p = await load({
    routes: { '/api/flows/dark-mode/ask-term': { status: 200, body: { ok: true, via: 'relay' } } },
    flows: [{ id: 'dark-mode', agent: 'Agent 3' }],
  })
  p.fire('click', chip('token', 'token', { flow: 'dark-mode' }))
  await p.advance(0)
  assert.match(p.pop.innerHTML, /data-tc="ask" title="Sends one message to Agent 3 \(about \$0\.30\)"/)
  p.press('ask')
  await p.advance(0)
  assert.match(p.pop.innerHTML, /sent to Agent 3/)
  assert.deepEqual(p.prefills, [])
})

test('outside a flow, Ask the agent prefills the Ask drawer and posts nothing', async () => {
  const p = await load()
  p.fire('click', chip('token'))
  await p.advance(0)
  p.press('ask')
  await p.advance(0)
  assert.equal(p.calls.filter(c => c.url.endsWith('/ask-term')).length, 0)
  assert.deepEqual(p.prefills, ['Explain "token" in the context of this dashboard: '])
  assert.equal(p.drawer.length, 1)
})

// ═══ Edit ═══

test('Edit saves the wording as yours: the card and every chip of that word show it afterwards', async () => {
  const p = await load({
    routes: {
      '/api/glossary/term': body => ({ status: 200, body: { ok: true, entry: { key: 'token', term: 'token', short: body.short, source: 'you', at: '2026-11-13T10:00:00Z', seenIn: [] } } }),
    },
  })
  p.fire('click', chip('token'))
  await p.advance(0)
  p.press('edit')
  assert.match(p.pop.innerHTML, /<textarea[^>]*>A short secret string\.<\/textarea>/)
  const ta = { value: 'My own words.' }
  p.pop.querySelector = sel => (sel.includes('textarea') ? ta : null)
  p.state.glossary[1] = { ...p.state.glossary[1], short: 'My own words.', source: 'you' }
  p.press('save')
  await p.advance(0)
  assert.deepEqual(posts(p.calls, '/api/glossary/term').map(c => c.body), [{ term: 'token', short: 'My own words.' }])
  assert.match(p.pop.innerHTML, /My own words\./)
  assert.match(p.pop.innerHTML, /class="tc-src">yours</)
  p.fire('keydown', p.outside, { key: 'Escape' })
  p.fire('click', chip('token', 'tokens'))
  await p.advance(0)
  assert.match(p.pop.innerHTML, /class="xp-term">tokens</)
  assert.match(p.pop.innerHTML, /My own words\./, 'another chip of the same word')
})

test('Escape in the editor cancels the edit and keeps the card', async () => {
  const p = await load()
  p.fire('click', chip('token'))
  await p.advance(0)
  p.press('edit')
  assert.match(p.pop.innerHTML, /<textarea/)
  const e = p.fire('keydown', p.outside, { key: 'Escape' })
  assert.equal(e.defaultPrevented, true)
  assert.equal(p.pop.hidden, false)
  assert.doesNotMatch(p.pop.innerHTML, /<textarea/)
})

test('a card escapes the term and the explanation', async () => {
  const p = await load({ glossary: [{ key: 'x y', term: 'x y', short: '<img src=x onerror=alert(1)>', more: '<script>1</script>', source: 'learned', at: null, seenIn: [] }] })
  p.fire('click', chip('x y', '<b>x y</b>'))
  await p.advance(0)
  assert.doesNotMatch(p.pop.innerHTML, /<img|<script|<b>/)
  assert.match(p.pop.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

// ═══ automatic learning: once, debounced, never in parallel ═══

test('auto-learn: once per flow, after 1.5 s of quiet, never two at a time, not again within 10 minutes', async () => {
  const held = []
  const p = await load({ routes: { '/api/glossary/learn': () => new Promise(r => held.push(r)) } })
  const a = flowWith([{ term: 'alpha word', key: 'alpha word', known: false }], 'flow-a')
  const b = flowWith([{ term: 'beta word', key: 'beta word', known: false }], 'flow-b')
  assert.equal(p.G.autoLearn(a), true)
  p.G.autoLearn(a)
  p.G.autoLearn(b)
  await p.advance(1499)
  assert.equal(posts(p.calls, '/api/glossary/learn').length, 0, 'debounced')
  await p.advance(1)
  assert.deepEqual(posts(p.calls, '/api/glossary/learn').map(c => c.body), [{ flowId: 'flow-a' }], 'one at a time')
  await p.advance(5000)
  assert.equal(posts(p.calls, '/api/glossary/learn').length, 1, 'b waits for a')
  held.shift()({ status: 200, body: { learned: [], skipped: [], cost: 0 } })
  await p.advance(0)
  assert.deepEqual(posts(p.calls, '/api/glossary/learn').map(c => c.body.flowId), ['flow-a', 'flow-b'])
  held.shift()({ status: 200, body: { learned: [], skipped: [], cost: 0 } })
  await p.advance(0)
  assert.equal(p.G.autoLearn(a), false, 'tried 0 minutes ago')
  await p.advance(9 * 60_000)
  assert.equal(p.G.autoLearn(a), false, 'tried 9 minutes ago')
  await p.advance(61_000)
  assert.equal(p.G.autoLearn(a), true, 'ten minutes on')
})

test('auto-learn does nothing when every marked word is known, or the store already has it', async () => {
  const p = await load()
  assert.equal(p.G.autoLearn(flowWith([{ term: 'x one', key: 'x one', known: true }])), false)
  assert.equal(p.G.autoLearn(flowWith([{ term: 'token', key: 'token', known: false }])), false, 'learned since the poll')
  assert.equal(p.G.autoLearn(flowWith([])), false)
  assert.equal(p.G.autoLearn({ id: 'x' }), false)
  await p.advance(5000)
  assert.equal(posts(p.calls, '/api/glossary/learn').length, 0)
})

test('the store: get by any spelling, all, onChange after a refresh, and save and remove refresh it', async () => {
  const p = await load({ routes: { '/api/glossary/remove': { status: 200, body: { ok: true, key: 'token', fallback: null } } } })
  assert.equal(p.G.get('Tokens').short, 'A short secret string.')
  assert.equal(p.G.get('nothing'), null)
  assert.equal(p.G.all().length, 2)
  let changes = 0
  p.G.onChange(() => changes++)
  p.state.glossary = p.state.glossary.filter(e => e.key !== 'token')
  const r = await p.G.remove('token')
  assert.equal(r.ok, true)
  assert.equal(p.G.get('token'), null)
  assert.ok(changes >= 1)
})

// ═══ the loop closes: a word an agent defined shows without a reload ═══

test('a word the server now knows but the store does not (the agent answered with term) refreshes the store once, debounced', async () => {
  const p = await load()
  const gets = () => p.calls.filter(c => c.url === '/api/glossary').length
  const before = gets()
  const flow = flowWith([{ term: 'retry storm', key: 'retry storm', known: true }])
  assert.equal(p.G.autoLearn(flow), false, 'nothing to learn')
  p.G.autoLearn(flow)
  await p.advance(999)
  assert.equal(gets(), before, 'debounced')
  await p.advance(1)
  assert.equal(gets(), before + 1, 'one refresh for both polls')
  assert.equal(posts(p.calls, '/api/glossary/learn').length, 0)
})
