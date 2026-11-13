// Tests for the chat drawer (spec 5 and 7): public/factory-chat.js mounted in
// the shell's drawer, its prefill (the explainer's "Ask Independent about
// this"), and public/shell.js remembering the drawer under shell.drawerOpen.
// Both files are browser scripts, so they run here in a vm context with a
// small stub DOM: every element is a plain object, and querySelector or
// getElementById hands back the same stub for the same selector, so what the
// script writes can be read back.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const source = name => fs.readFileSync(path.join(HERE, '..', 'public', name), 'utf8')

/** A stub element: records attributes, listeners, focus and child lookups. */
function el(name = '') {
  const kids = new Map()
  const classes = new Set()
  return {
    name, hidden: false, value: '', textContent: '', className: '', disabled: false, title: '', innerHTML: '',
    dataset: {}, style: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0, attrs: {}, listeners: {}, focused: 0,
    classList: { toggle: (c, on) => (on ?? !classes.has(c) ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c) },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return this.attrs[k] ?? null },
    removeAttribute(k) { delete this.attrs[k] },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
    dispatchEvent(e) { for (const fn of this.listeners[e.type] || []) fn(e) },
    focus() { this.focused++ },
    querySelector(sel) { if (!kids.has(sel)) kids.set(sel, el(sel)); return kids.get(sel) },
    querySelectorAll: () => [],
    appendChild: c => c,
    contains: () => false,
    closest: () => null,
  }
}

/** A document whose getElementById returns one stub per id. */
function stubDocument() {
  const doc = el('document')
  const byId = new Map()
  doc.getElementById = id => { if (!byId.has(id)) byId.set(id, el(`#${id}`)); return byId.get(id) }
  doc.createElement = tag => el(tag)
  doc.body = el('body')
  doc.documentElement = el('html')
  return doc
}

class FakeEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail } }
/** Opens straight away, so a mount resolves without a server. */
class FakeEventSource { constructor() { FakeEventSource.last = this } addEventListener(type, fn) { if (type === 'open') fn() } close() {} }
const stream = e => FakeEventSource.last.onmessage({ data: JSON.stringify(e) })

// ═══ the chat: prefill ═══

function loadChat({ drawerOpen = true, busy = false } = {}) {
  const document = stubDocument()
  const calls = []
  const fetch = async (url, init) => { calls.push(url); return { ok: true, json: async () => ({ busy, name: 'Independent', model: 'claude-opus-5-5', log: [] }) } }
  const opened = []
  const window = { Shell: { drawer: { get isOpen() { return drawerOpen }, open: () => opened.push(1) } } }
  const ctx = { window, document, fetch, EventSource: FakeEventSource, CustomEvent: FakeEvent, setTimeout, scrollX: 0, scrollY: 0, confirm: () => true, alert: () => {} }
  vm.runInNewContext(source('factory-chat.js'), ctx)
  return { chat: window.FactoryChat, window, document, calls, opened }
}

test('prefill puts the text in the input, focuses it, and sends nothing', async () => {
  const { chat, calls } = loadChat()
  const body = el('body'), head = el('head')
  await chat.mount(body, head)
  calls.length = 0
  chat.prefill('x')
  const input = body.querySelector('#fcInput')
  assert.equal(input.value, 'x')
  assert.equal(input.focused, 1)
  assert.deepEqual(calls, [])
})

test('prefill opens the drawer when it is closed', async () => {
  const { chat, calls, opened } = loadChat({ drawerOpen: false })
  await chat.mount(el('body'), el('head'))
  calls.length = 0
  chat.prefill('what is a worktree')
  assert.equal(opened.length, 1)
  assert.deepEqual(calls, [])
})

test('mount writes the one head into the head it is given: Ask, the name and the model', async () => {
  const { chat } = loadChat()
  const head = el('head')
  await chat.mount(el('body'), head)
  assert.match(head.innerHTML, /Ask/)
  assert.match(head.innerHTML, /id="fcNew"/)
  assert.equal(head.querySelector('#fcName').textContent, 'Independent')
  assert.equal(head.querySelector('#fcModel').textContent, 'Opus 5.5')
})

test('the first status after mounting is announced as chat:status, and then each change of busy', async () => {
  const idle = loadChat()
  const quiet = []
  idle.document.addEventListener('chat:status', e => quiet.push(e.detail.busy))
  await idle.chat.mount(el('body'), el('head'))
  assert.deepEqual(quiet, [false], 'the first status takes over the dot, even when idle')
  const working = loadChat({ busy: true })
  const seen = []
  working.document.addEventListener('chat:status', e => seen.push(e.detail.busy))
  await working.chat.mount(el('body'), el('head'))
  stream({ role: 'status', busy: false })
  stream({ role: 'status', busy: false, model: 'claude-opus-5-5' })
  assert.deepEqual(seen, [true, false], 'a status without a change of busy is not announced')
})

test('send while the drawer is closed opens it, then posts the message', async () => {
  const { chat, calls, opened } = loadChat({ drawerOpen: false })
  await chat.mount(el('body'), el('head'))
  calls.length = 0
  assert.equal(await chat.send('hello'), true)
  assert.equal(opened.length, 1)
  assert.deepEqual(calls, ['/api/chat/send'])
})

// ═══ the head: light or forked, and the New chat menu ═══

/** The chat with a server that answers /api/chat with `status`, and /api/chat/new with what `onNew` returns. */
function loadChatWith(status, onNew = () => ({ ...status })) {
  const document = stubDocument()
  const posts = []
  const fetch = async (url, init) => {
    if (init?.method === 'POST') posts.push([url, init.body ? JSON.parse(init.body) : undefined])
    const body = url === '/api/chat/new' ? onNew(init?.body ? JSON.parse(init.body) : {}) : { name: 'Independent', model: 'claude-opus-5-5', log: [], ...status }
    return { ok: true, json: async () => body }
  }
  const window = { Shell: { drawer: { isOpen: true, open() {} } } }
  const ctx = { window, document, fetch, EventSource: FakeEventSource, CustomEvent: FakeEvent, setTimeout, scrollX: 0, scrollY: 0, confirm: () => true, alert: () => {} }
  vm.runInNewContext(source('factory-chat.js'), ctx)
  return { chat: window.FactoryChat, document, posts }
}
const click = async b => { for (const fn of b.listeners.click || []) await fn({ preventDefault() {} }) }

test('the head says light for a fresh brief chat and forked for a forked one', async () => {
  const light = loadChatWith({ mode: 'brief', nextFork: false })
  const head = el('head')
  await light.chat.mount(el('body'), head)
  assert.equal(head.querySelector('#fcModel').textContent, 'Opus 5.5 · light')
  stream({ role: 'status', mode: 'fork', nextFork: false })
  assert.equal(head.querySelector('#fcModel').textContent, 'Opus 5.5 · forked')
  stream({ role: 'status', mode: 'brief', nextFork: true })
  assert.equal(head.querySelector('#fcModel').textContent, 'Opus 5.5 · forked next')
})

test('New chat is a menu of two: a light new chat, and Start from my session', async () => {
  const { chat } = loadChatWith({ mode: 'brief', nextFork: false })
  const head = el('head')
  await chat.mount(el('body'), head)
  assert.match(head.innerHTML, /id="fcNew"/)
  assert.match(head.innerHTML, />New chat</)
  assert.match(head.innerHTML, />Start from my session \(costs more\)</)
})

test('the second item posts fork true and the head then reads forked next; the first posts a plain new chat', async () => {
  const { chat, posts } = loadChatWith({ mode: 'brief', nextFork: false }, b => ({ name: 'Independent', model: 'claude-opus-5-5', mode: 'brief', nextFork: b.fork === true }))
  const head = el('head')
  await chat.mount(el('body'), head)
  await click(head.querySelector('#fcNewFork'))
  assert.deepEqual(posts, [['/api/chat/new', { fork: true }]])
  assert.equal(head.querySelector('#fcModel').textContent, 'Opus 5.5 · forked next')
  posts.length = 0
  await click(head.querySelector('#fcNewLight'))
  assert.deepEqual(posts, [['/api/chat/new', { fork: false }]])
  assert.equal(head.querySelector('#fcModel').textContent, 'Opus 5.5 · light')
})

// ═══ the shell: the remembered drawer ═══

function loadShell(localStorage) {
  const document = stubDocument()
  const listeners = {}
  const mounts = []
  const window = {
    document,
    location: { hash: '#/' },
    addEventListener: (t, fn) => ((listeners[t] ||= []).push(fn)),
    FactoryChat: { mount: (body, head) => mounts.push([body, head]), name: 'Independent' },
  }
  Object.defineProperty(window, 'localStorage', { get: localStorage })
  vm.runInNewContext(source('shell.js'), { window, setTimeout, clearTimeout })
  for (const fn of document.listeners.DOMContentLoaded || []) fn()
  return { shell: window.Shell, document, mounts }
}

test('a storage that throws leaves the drawer closed, and nothing mounts', () => {
  const { shell, document, mounts } = loadShell(() => { throw new Error('blocked') })
  assert.equal(shell.drawer.isOpen, false)
  assert.equal(document.getElementById('drawer').hidden, true)
  assert.equal(mounts.length, 0)
})

test('a remembered open drawer opens on load and mounts the chat once', () => {
  const saved = new Map([['shell.drawerOpen', '1']])
  const { shell, mounts } = loadShell(() => ({ getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) }))
  assert.equal(shell.drawer.isOpen, true)
  shell.drawer.close()
  assert.equal(saved.has('shell.drawerOpen'), false)
  shell.drawer.open()
  assert.equal(saved.get('shell.drawerOpen'), '1')
  assert.equal(mounts.length, 1)
})

test('chat:status toggles the busy dot on the Ask rail item', () => {
  const { document } = loadShell(() => null)
  const ask = document.getElementById('railAsk')
  document.dispatchEvent(new FakeEvent('chat:status', { detail: { busy: true } }))
  assert.equal(ask.classList.contains('busy'), true)
  document.dispatchEvent(new FakeEvent('chat:status', { detail: { busy: false } }))
  assert.equal(ask.classList.contains('busy'), false)
})

// ═══ one Escape closes one thing (README Keyboard) ═══

/** The shell plus the page scripts that hold a modal, all on ONE stub document, as in the browser. */
function loadPage({ hash = '#/', drawer = '1', pages = [] } = {}) {
  const document = stubDocument()
  const winListeners = {}
  const replaced = []
  const saved = new Map(drawer ? [['shell.drawerOpen', drawer]] : [])
  const window = {
    document,
    location: { hash, replace: h => replaced.push(h) },
    addEventListener: (t, fn) => ((winListeners[t] ||= []).push(fn)),
    FactoryChat: { mount: () => {}, name: 'Independent', md: s => s },
    localStorage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) },
  }
  const ctx = vm.createContext({ window, document, setTimeout, clearTimeout, fetch: () => new Promise(() => {}) })
  for (const name of ['shell.js', ...pages]) vm.runInContext(source(name), ctx)
  for (const fn of document.listeners.DOMContentLoaded || []) fn()
  /** A key pressed on the page: the document's bubble listeners, then the window's, in the order they were added. */
  const press = key => {
    const e = { key, target: document.body, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {} }
    for (const fn of document.listeners.keydown || []) fn(e)
    for (const fn of winListeners.keydown || []) fn(e)
    return e
  }
  return { shell: window.Shell, window, document, press, replaced }
}

test('Escape on an open Progress report closes the report and leaves the chat drawer open', () => {
  const { shell, window, press } = loadPage({ pages: ['orchestration.js'] })
  assert.equal(shell.drawer.isOpen, true)
  void window.OrchestrationGrid.report('s-1', 'Agent 1')
  press('Escape')
  assert.equal(shell.drawer.isOpen, true, 'the report took the Escape')
  press('Escape')
  assert.equal(shell.drawer.isOpen, false, 'the next Escape closes the drawer')
})

test('Escape with only the drawer open closes the drawer, and a closed report does not swallow it', () => {
  const { shell, press } = loadPage({ pages: ['orchestration.js'] })
  const e = press('Escape')
  assert.equal(shell.drawer.isOpen, false)
  assert.equal(e.defaultPrevented, false, 'a hidden report never claims the key')
})

test('the agent page report and the Timeline popover take their Escape too, so the shell leaves the drawer open', () => {
  // Both pages are too big for this stub DOM; the handler shape is the contract: act only while shown, then preventDefault.
  for (const name of ['agent.js', 'flow.js']) assert.match(source(name), /e\.key !== 'Escape' \|\| [^\n]+\) return\r?\n\s*e\.preventDefault\(\)/, name)
})

// ═══ prefill keeps a typed draft ═══

test('prefill with a draft in the input appends the question on a new line instead of wiping the draft', async () => {
  const { chat } = loadChat()
  const body = el('body')
  await chat.mount(body, el('head'))
  const input = body.querySelector('#fcInput')
  input.value = 'my half-typed note'
  chat.prefill('Explain "idle" in the context of this dashboard: ')
  assert.equal(input.value, 'my half-typed note\nExplain "idle" in the context of this dashboard: ')
  assert.equal(input.focused, 1)
})

test('prefill with empty text leaves the draft as it was', async () => {
  const { chat } = loadChat()
  const body = el('body')
  await chat.mount(body, el('head'))
  const input = body.querySelector('#fcInput')
  input.value = 'keep me'
  chat.prefill('')
  assert.equal(input.value, 'keep me')
})

// ═══ the old Factory link ═══

test('an old #/factory link goes to #/tickets and opens the chat drawer (the Factory page always showed the chat)', () => {
  const { shell, replaced } = loadPage({ hash: '#/factory', drawer: null })
  assert.deepEqual(replaced, ['#/tickets'])
  assert.equal(shell.drawer.isOpen, true)
})

test('an old #/flow link goes to #/timeline and leaves a closed drawer closed', () => {
  const { shell, replaced } = loadPage({ hash: '#/flow', drawer: null })
  assert.deepEqual(replaced, ['#/timeline'])
  assert.equal(shell.drawer.isOpen, false)
})

// ═══ the rail pin ═══

test('a pin click with storage that throws still toggles rail-pinned', () => {
  const { document } = loadShell(() => { throw new Error('blocked') })
  const pin = document.getElementById('railPin')
  const root = document.documentElement
  assert.equal(root.classList.contains('rail-pinned'), false)
  pin.dispatchEvent({ type: 'click' })
  assert.equal(root.classList.contains('rail-pinned'), true)
  assert.equal(pin.getAttribute('aria-pressed'), 'true')
  pin.dispatchEvent({ type: 'click' })
  assert.equal(root.classList.contains('rail-pinned'), false)
})

// ═══ Independent's state: working, waiting on you, or idle (the rail, the drawer head) ═══

test('Shell.chatState: a running turn is working, the pulse state waiting is waiting, anything else idle', () => {
  const { shell } = loadShell(() => null)
  assert.equal(shell.chatState({ busy: true, state: 'waiting' }), 'working')
  assert.equal(shell.chatState({ busy: false, state: 'waiting' }), 'waiting')
  assert.equal(shell.chatState({ busy: false, state: 'working' }), 'idle', 'a pulse that lags a finished turn does not keep it working')
  assert.equal(shell.chatState({}), 'idle')
})

test('the Ask rail item shows working, waiting (its own class) and idle, with a title in words', () => {
  const { document } = loadShell(() => null)
  const ask = document.getElementById('railAsk')
  document.dispatchEvent(new FakeEvent('pulse', { detail: { chat: { name: 'Independent', state: 'waiting', busy: false } } }))
  assert.equal(ask.classList.contains('waiting'), true)
  assert.equal(ask.classList.contains('busy'), false)
  assert.match(ask.title, /^Independent is waiting on you/)
  document.dispatchEvent(new FakeEvent('chat:status', { detail: { busy: true } }))
  assert.equal(ask.classList.contains('busy'), true)
  assert.equal(ask.classList.contains('waiting'), false)
  assert.match(ask.title, /^Independent is working/)
  document.dispatchEvent(new FakeEvent('chat:status', { detail: { busy: false } }))
  document.dispatchEvent(new FakeEvent('pulse', { detail: { chat: { name: 'Independent', state: 'idle' } } }))
  assert.equal(ask.classList.contains('busy') || ask.classList.contains('waiting'), false)
  assert.match(ask.title, /^Independent is idle/)
})

test('the drawer head shows the same one word with a dot, from the stream and the pulse', async () => {
  const { chat, document } = loadChat()
  const head = el('head')
  await chat.mount(el('body'), head)
  assert.match(head.innerHTML, /id="fcState"/)
  assert.match(head.querySelector('#fcState').innerHTML, /data-term="idle"[^>]*>Idle</)
  document.dispatchEvent(new FakeEvent('pulse', { detail: { chat: { state: 'waiting' } } }))
  assert.equal(head.querySelector('#fcDot').className, 'fc-dot waiting')
  assert.match(head.querySelector('#fcState').innerHTML, /data-term="waiting"[^>]*>Waiting</)
  stream({ role: 'status', busy: true })
  assert.equal(head.querySelector('#fcDot').className, 'fc-dot busy')
  assert.match(head.querySelector('#fcState').innerHTML, /data-term="working"[^>]*>Working</)
})

// ═══ a turn that wrote a flow: an Open flow button under the reply ═══

test('a done line with flows renders an escaped Open flow button per flow, and a click opens that flow', async () => {
  const { chat, window } = loadChat()
  const gone = []
  window.FlowsView = { gotoFlow: id => gone.push(id) }
  const body = el('body')
  await chat.mount(body, el('head'))
  stream({ role: 'done', seconds: 3, cost: 0.1, flows: [{ id: 'login-check', title: 'Check the <img src=x onerror=alert(1)> login' }, { id: 'dark', title: '' }] })
  const html = body.querySelector('#fcLog').innerHTML
  assert.match(html, /<button type="button" class="link fc-flow" data-flow="login-check">Open flow: Check the &lt;img src=x onerror=alert\(1\)&gt; login<\/button>/)
  assert.match(html, /data-flow="dark">Open flow: dark</, 'a flow with no title shows its id')
  assert.ok(!html.includes('<img'), html)
  assert.deepEqual(gone, [], 'nothing navigates by itself')
  const log = body.querySelector('#fcLog')
  for (const fn of log.listeners.click || []) fn({ target: { closest: sel => (sel === '[data-flow]' ? { dataset: { flow: 'login-check' } } : null) } })
  assert.deepEqual(gone, ['login-check'])
})

test('a done line without flows has no Open flow button', async () => {
  const { chat } = loadChat()
  const body = el('body')
  await chat.mount(body, el('head'))
  stream({ role: 'done', seconds: 2, cost: 0.05 })
  assert.doesNotMatch(body.querySelector('#fcLog').innerHTML, /fc-flow/)
})
