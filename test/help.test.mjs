// Tests for public/help.js, the shared ? popover (spec 5 and 6): a click
// opens it with the caller's HTML and closes it again; Escape, a press
// outside and a scroll close it; attaching again updates what it says. A vm
// with a stub DOM, in the pattern of test/explain-page.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'public', 'help.js'), 'utf8')

function el(tag = 'div') {
  const node = {
    tagName: tag.toUpperCase(), hidden: false, innerHTML: '', className: '', style: {}, attrs: {}, listeners: {}, children: [], focused: 0,
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return this.attrs[k] ?? null },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
    appendChild(c) { this.children.push(c); c.parent = this; return c },
    contains(x) { return x === this || this.children.includes(x) },
    focus() { this.focused++ },
    getBoundingClientRect: () => ({ left: 200, top: 10, right: 220, bottom: 30, width: 20, height: 20 }),
    get offsetWidth() { return 300 },
    get offsetHeight() { return 100 },
    isConnected: true,
  }
  return node
}

function load() {
  const document = el('document')
  document.body = el('body')
  document.createElement = tag => el(tag)
  const window = { innerWidth: 1280, innerHeight: 800, listeners: {}, addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn) } }
  vm.runInNewContext(SRC, { window, document })
  const fire = (target, type, e = {}) => (target.listeners[type] || []).forEach(fn => fn({ preventDefault() {}, stopPropagation() {}, ...e }))
  const pop = () => document.body.children.find(c => /help-pop/.test(c.className))
  return { Help: window.Help, document, window, fire, pop }
}

test('a click on the ? opens the popover with the given HTML, anchored under it; a second click closes it', () => {
  const { Help, fire, pop } = load()
  const b = el('button')
  Help.attach(b, '<p>What the grid shows.</p>')
  assert.equal(b.getAttribute('aria-expanded'), 'false')
  fire(b, 'click', { target: b })
  assert.equal(pop().hidden, false)
  assert.equal(pop().innerHTML, '<p>What the grid shows.</p>')
  assert.equal(b.getAttribute('aria-expanded'), 'true')
  assert.equal(pop().style.top, '38px', 'under the button, 8 px down')
  fire(b, 'click', { target: b })
  assert.equal(pop().hidden, true)
  assert.equal(b.getAttribute('aria-expanded'), 'false')
})

test('Escape closes it and gives the focus back to the ?', () => {
  const { Help, document, fire, pop } = load()
  const b = el('button')
  Help.attach(b, 'x')
  fire(b, 'click', { target: b })
  fire(document, 'keydown', { key: 'Escape', target: document.body })
  assert.equal(pop().hidden, true)
  assert.equal(b.focused, 1)
})

test('a press outside closes it; a press inside the popover does not', () => {
  const { Help, document, fire, pop } = load()
  const b = el('button')
  Help.attach(b, 'x')
  fire(b, 'click', { target: b })
  fire(document, 'mousedown', { target: pop() })
  assert.equal(pop().hidden, false)
  fire(document, 'mousedown', { target: document.body })
  assert.equal(pop().hidden, true)
})

test('a scroll that moves the ? closes it; a list scrolling elsewhere (a live feed) does not', () => {
  const { Help, document, fire, pop } = load()
  const b = el('button')
  Help.attach(b, 'x')
  fire(b, 'click', { target: b })
  fire(document, 'scroll', { target: { contains: () => false } })
  assert.equal(pop().hidden, false, 'a feed that scrolls itself leaves the popover open')
  fire(document, 'scroll', { target: { contains: x => x === b } })
  assert.equal(pop().hidden, true, 'the page (or a box holding the ?) scrolled')
})

test('Enter or Space on a ? that is not a button opens it', () => {
  const { Help, fire, pop } = load()
  const s = el('span')
  Help.attach(s, 'y')
  fire(s, 'keydown', { key: 'Enter', target: s })
  assert.equal(pop().hidden, false)
  fire(s, 'keydown', { key: ' ', target: s })
  assert.equal(pop().hidden, false, 'Space while open keeps it open')
})

test('attaching again updates the text, and the open popover shows it at once', () => {
  const { Help, fire, pop } = load()
  const b = el('button')
  Help.attach(b, 'old')
  fire(b, 'click', { target: b })
  Help.attach(b, 'new')
  assert.equal(pop().innerHTML, 'new')
  assert.equal(b.listeners.click.length, 1, 'one listener, however often it is attached')
})

test('one popover for the whole page: opening a second ? moves it', () => {
  const { Help, document, fire, pop } = load()
  const a = el('button')
  const b = el('button')
  Help.attach(a, 'A')
  Help.attach(b, 'B')
  fire(a, 'click', { target: a })
  fire(b, 'click', { target: b })
  assert.equal(document.body.children.filter(c => /help-pop/.test(c.className)).length, 1)
  assert.equal(pop().innerHTML, 'B')
  assert.equal(a.getAttribute('aria-expanded'), 'false')
})

test('a redraw that swaps the ? for a new node keeps the open popover, on the new node', () => {
  const { Help, fire, pop } = load()
  const old = el('button')
  old.setAttribute('aria-label', 'What the grid shows')
  Help.attach(old, 'v1')
  fire(old, 'click', { target: old })
  old.isConnected = false
  const fresh = el('button')
  fresh.setAttribute('aria-label', 'What the grid shows')
  Help.attach(fresh, 'v2')
  assert.equal(pop().hidden, false)
  assert.equal(pop().innerHTML, 'v2')
  assert.equal(fresh.getAttribute('aria-expanded'), 'true')
  fire(fresh, 'click', { target: fresh })
  assert.equal(pop().hidden, true, 'the new ? closes it')
})

test('a scroll anywhere closes a popover whose ? is gone: detached by a redraw, or hidden with its page', () => {
  const { Help, document, fire, pop } = load()
  const b = el('button')
  b.getClientRects = () => [{}]
  Help.attach(b, 'x')
  fire(b, 'click', { target: b })
  fire(document, 'scroll', { target: { contains: () => false } })
  assert.equal(pop().hidden, false, 'a shown ? keeps it through an unrelated scroll')
  b.getClientRects = () => []
  fire(document, 'scroll', { target: { contains: () => false } })
  assert.equal(pop().hidden, true, 'the ? has no box any more (its page or card is hidden)')
  b.getClientRects = () => [{}]
  fire(b, 'click', { target: b })
  b.isConnected = false
  fire(document, 'scroll', { target: { contains: () => false } })
  assert.equal(pop().hidden, true, 'the ? left the page and nothing took the popover over')
})
