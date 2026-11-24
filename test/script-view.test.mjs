// Tests for public/script-view.js: the DOM side of the SCRIPT output. It draws the
// parts from script-render.js with textContent only, and patches only what changed, so
// a paragraph, a list item or a prompt row already on screen keeps its element (and
// does not replay its entry animation) as each delta arrives. The blinking caret
// (sc-live) sits on the last thing being written. A tiny fake DOM in a vm: innerHTML
// throws, so any attempt to write model text as HTML fails the test.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = { window: {} }
for (const f of ['script-text.js', 'script-render.js', 'script-view.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), ctx)
const R = ctx.window.ScriptRender
const V = ctx.window.ScriptView

// ═══ a fake DOM, just enough ═══

class FakeNode {
  constructor(doc, tag, text) {
    this.ownerDocument = doc
    this.nodeType = tag ? 1 : 3
    this.tagName = tag ? tag.toUpperCase() : undefined
    this.childNodes = []
    this.parentNode = null
    this.attrs = {}
    this._text = text ?? ''
    const cls = new Set()
    this.classList = {
      add: (...c) => c.forEach(x => cls.add(x)),
      remove: (...c) => c.forEach(x => cls.delete(x)),
      toggle: (c, on) => ((on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c), cls.has(c)),
      contains: c => cls.has(c),
    }
    this._cls = cls
  }
  get className() { return [...this._cls].join(' ') }
  set className(v) { this._cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => this._cls.add(c)) }
  get children() { return this.childNodes.filter(n => n.nodeType === 1) }
  get firstChild() { return this.childNodes[0] ?? null }
  get textContent() { return this.nodeType === 3 ? this._text : this.childNodes.map(c => c.textContent).join('') }
  set textContent(v) {
    if (this.nodeType === 3) return void (this._text = String(v))
    this.childNodes.forEach(c => (c.parentNode = null))
    this.childNodes = v === '' || v == null ? [] : [this._adopt(new FakeNode(this.ownerDocument, null, String(v)))]
  }
  set innerHTML(_v) { throw new Error('innerHTML is not allowed for model text') }
  _adopt(n) { n.parentNode?._detach(n); n.parentNode = this; return n }
  _detach(n) { this.childNodes = this.childNodes.filter(c => c !== n); n.parentNode = null }
  append(...ns) { for (const n of ns) this.childNodes.push(this._adopt(typeof n === 'string' ? new FakeNode(this.ownerDocument, null, n) : n)) }
  appendChild(n) { this.append(n); return n }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n)
    this._adopt(n)
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, n)
    return n
  }
  prepend(n) { this.insertBefore(n, this.firstChild) }
  replaceChildren(...ns) { this.childNodes.forEach(c => (c.parentNode = null)); this.childNodes = []; this.append(...ns) }
  replaceWith(n) {
    const p = this.parentNode
    const at = p.childNodes.indexOf(this)
    p._adopt(n)
    p.childNodes[at] = n
    this.parentNode = null
  }
  remove() { this.parentNode?._detach(this) }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  removeAttribute(k) { delete this.attrs[k] }
  getAttribute(k) { return this.attrs[k] ?? null }
  querySelectorAll(sel) {
    const want = sel.replace(/^\./, '')
    const out = []
    const walk = n => n.children.forEach(c => { if (c.classList.contains(want)) out.push(c); walk(c) })
    walk(this)
    return out
  }
}
function fakeDoc() {
  const doc = { createElement: t => new FakeNode(doc, t), createTextNode: t => new FakeNode(doc, null, t) }
  return doc
}
const make = () => {
  const root = new FakeNode(fakeDoc(), 'div')
  return { root, view: V.create(root) }
}
const draw = (view, text, live = false) => view.render(R.parts(text, { live }), { live })

const QUESTIONS = 'First:\n\n1. **Who** reads it?\n2. Use `this`?'
const PROMPT = 'Here:\n\n```\nSituation: a\nCharacter: b\n```\nAssumed: x.'

// ═══ drawing ═══

test('paragraphs, lists, bold and code become real elements, with the text as text', () => {
  const { root, view } = make()
  draw(view, QUESTIONS)
  const [p, ol] = root.children
  assert.equal(p.tagName, 'P')
  assert.ok(p.classList.contains('sc-para'))
  assert.equal(p.textContent, 'First:')
  assert.equal(ol.tagName, 'OL')
  const [li1, li2] = ol.children
  assert.equal(li1.children[0].tagName, 'STRONG')
  assert.equal(li1.textContent, 'Who reads it?')
  assert.equal(li2.children[0].tagName, 'CODE')
  assert.equal(li2.textContent, 'Use this?')
})

test('a numbered list that starts past 1 keeps its number', () => {
  const { root, view } = make()
  draw(view, '3. c\n4. d')
  assert.equal(root.children[0].getAttribute('start'), '3')
})

test('model text that looks like HTML stays text: no element is made from it', () => {
  const { root, view } = make()
  draw(view, 'Hi <img src=x onerror=alert(1)> **<b>bold</b>**')
  const p = root.children[0]
  assert.equal(p.textContent, 'Hi <img src=x onerror=alert(1)> <b>bold</b>')
  assert.deepEqual(p.children.map(c => c.tagName), ['STRONG'], 'only the strong the renderer made')
})

test('the prompt card: one row per section, each with its letter, its label and its text; no fences', () => {
  const { root, view } = make()
  draw(view, PROMPT)
  const [lead, card, note] = root.children
  assert.equal(lead.textContent, 'Here:')
  assert.ok(card.classList.contains('sc-card'))
  const rows = card.querySelectorAll('.sc-row')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].children.map(c => c.textContent), ['S', 'Situation', 'a'])
  assert.equal(rows[0].getAttribute('data-section'), 'Situation')
  assert.ok(!card.textContent.includes('```'))
  assert.ok(note.classList.contains('sc-note'))
  assert.equal(note.textContent, 'Assumed: x.')
})

test('text in the block before the first label shows as plain lead text in the card', () => {
  const { root, view } = make()
  draw(view, '```\nYou are **kind**.\nTone: b\n```')
  const card = root.children[0]
  const lead = card.querySelectorAll('.sc-lead')[0]
  assert.equal(lead.textContent, 'You are **kind**.')
  assert.equal(lead.children.length, 0, 'plain: no bold inside the block')
})

// ═══ patching: what is on screen stays on screen ═══

test('as a paragraph grows, it is the same element: it does not replay its entry', () => {
  const { root, view } = make()
  draw(view, 'Hel', true)
  const p = root.children[0]
  draw(view, 'Hello there', true)
  assert.equal(root.children[0], p)
  assert.equal(p.textContent, 'Hello there')
})

test('as a list grows, earlier items keep their elements and new ones are added', () => {
  const { root, view } = make()
  draw(view, '1. one\n2. tw', true)
  const ol = root.children[0]
  const [a, b] = ol.children
  draw(view, '1. one\n2. two\n3. three', true)
  assert.equal(root.children[0], ol)
  assert.equal(ol.children[0], a)
  assert.equal(ol.children[1], b)
  assert.equal(b.textContent, 'two')
  assert.equal(ol.children.length, 3)
})

test('as the prompt streams, earlier rows keep their elements; only the growing text changes', () => {
  const { root, view } = make()
  draw(view, 'Here:\n\n```\nSituation: a\nCharacter: b', true)
  const lead = root.children[0]
  const card = root.children[1]
  const [s, c] = card.querySelectorAll('.sc-row')
  draw(view, 'Here:\n\n```\nSituation: a\nCharacter: bee\nRequest: c', true)
  assert.equal(root.children[0], lead)
  assert.equal(root.children[1], card)
  const rows = card.querySelectorAll('.sc-row')
  assert.equal(rows[0], s)
  assert.equal(rows[1], c)
  assert.equal(c.children[2].textContent, 'bee')
  assert.equal(rows.length, 3)
})

test('a part that changes kind is replaced, and parts that went away are removed', () => {
  const { root, view } = make()
  draw(view, 'a\n\nb')
  assert.equal(root.children.length, 2)
  draw(view, 'a')
  assert.equal(root.children.length, 1)
  const first = root.children[0]
  draw(view, '1. a')
  assert.notEqual(root.children[0], first)
  assert.equal(root.children[0].tagName, 'OL')
})

test('clear empties the box, so its empty-state text shows again', () => {
  const { root, view } = make()
  draw(view, PROMPT)
  view.clear()
  assert.equal(root.childNodes.length, 0)
  draw(view, 'again')
  assert.equal(root.children[0].textContent, 'again')
})

// ═══ the caret ═══

test('while live, the caret (sc-live) sits on the last thing being written, and only there', () => {
  const { root, view } = make()
  draw(view, '1. one\n2. tw', true)
  const live = () => {
    const out = []
    const walk = n => n.children.forEach(c => { if (c.classList.contains('sc-live')) out.push(c); walk(c) })
    walk(root)
    return out
  }
  assert.deepEqual(live(), [root.children[0].children[1]], 'the last list item')
  draw(view, '1. one\n2. two\n\n```\nSituation: a', true)
  const row = root.children[1].querySelectorAll('.sc-row')[0]
  assert.deepEqual(live(), [row.children[2]], 'the text of the row being written')
  draw(view, '1. one\n2. two\n\n```\nSituation: a\n```', false)
  assert.deepEqual(live(), [], 'no caret once the run is over')
})
