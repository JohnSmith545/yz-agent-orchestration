// Tests for public/scroll-keep.js and its use on the Tickets page (QA 2026-11-25, F1): a ticket opened from Human
// review must land at the top of the screen even when the grid above the table draws after it. Run in a vm with a
// stub window, document and ResizeObserver, so a layout change above the row is simulated by moving the row.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8')
const plain = v => JSON.parse(JSON.stringify(v))

function load() {
  const window = {}
  vm.runInNewContext(read('scroll-keep.js'), { window })
  return window.ScrollKeep
}

/** A page whose row sits `rowY` px down the document; the window records each scroll and its listeners. */
function page({ rowY = 2000, reduce = false } = {}) {
  const listeners = {}
  const scrolls = []
  const win = {
    scrollY: 0,
    scrollTo(o) { scrolls.push(o); this.scrollY = o.top },
    matchMedia: () => ({ matches: reduce }),
    addEventListener: (t, fn) => (listeners[t] = fn),
    removeEventListener: t => delete listeners[t],
    setTimeout: () => 7,
    clearTimeout() {},
  }
  const row = { isConnected: true, y: rowY, getBoundingClientRect() { return { top: this.y - win.scrollY } } }
  let observer = null
  class RO { constructor(fn) { this.fn = fn; observer = this } observe() {} disconnect() { observer = null } }
  const doc = { body: {}, getElementById: id => (id === 'pageHead' ? { offsetHeight: 48 } : null) }
  return { win, doc, RO, row, scrolls, listeners, resize: () => observer?.fn(), observer: () => observer }
}

test('topFor puts the element just under the sticky header, never above the page top', () => {
  const K = load()
  assert.equal(K.topFor(1100, 0, 48), 1040)
  assert.equal(K.topFor(300, 500, 48, 0), 752)
  assert.equal(K.topFor(10, 0, 48), 0)
})

test('the row lands at the top, and is put back there when the page above it grows while it draws (the regression)', () => {
  const K = load()
  const p = page({ rowY: 1200 })
  K.to(() => p.row, { win: p.win, doc: p.doc, RO: p.RO })
  assert.deepEqual(plain(p.scrolls[0]), { top: 1140, behavior: 'smooth' })
  p.row.y += 900 // the grid above the table finished drawing: the row moved down
  p.resize()
  assert.deepEqual(plain(p.scrolls[1]), { top: 2040, behavior: 'auto' })
  assert.equal(p.row.getBoundingClientRect().top, 60, 'its top is on screen, under the 48 px header')
})

test('the target is found again each time (a redraw replaces the row), and a row no longer there is left alone', () => {
  const K = load()
  const p = page()
  let current = p.row
  K.to(() => current, { win: p.win, doc: p.doc, RO: p.RO })
  current = { isConnected: true, getBoundingClientRect: () => ({ top: 400 - p.win.scrollY }) }
  p.resize()
  assert.equal(p.scrolls.at(-1).top, 340)
  current = { isConnected: false, getBoundingClientRect: () => ({ top: 0 }) }
  p.resize()
  assert.equal(p.scrolls.length, 2)
})

test('it stops keeping the row the moment the user scrolls, clicks or presses a key; reduced motion jumps', () => {
  const K = load()
  const p = page()
  K.to(() => p.row, { win: p.win, doc: p.doc, RO: p.RO })
  for (const t of ['wheel', 'touchstart', 'keydown', 'mousedown']) assert.equal(typeof p.listeners[t], 'function', t)
  p.listeners.wheel()
  assert.equal(p.observer(), null, 'no more scrolling for the user to fight')
  assert.deepEqual(Object.keys(p.listeners), [])
  const q = page({ reduce: true })
  K.to(q.row, { win: q.win, doc: q.doc, RO: q.RO })
  assert.equal(q.scrolls[0].behavior, 'auto')
})

test('wired: the Tickets page lands a ticket with ScrollKeep, finding the row by id; loaded before factory.js; checked', () => {
  const f = read('factory.js')
  assert.match(f, /window\.ScrollKeep \? window\.ScrollKeep\.to\(row\)/)
  assert.doesNotMatch(f, /block: 'center'/)
  const html = read('index.html')
  assert.ok(html.indexOf('<script src="scroll-keep.js"></script>') < html.indexOf('<script src="factory.js"></script>'))
  assert.ok(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).checkList.includes('node --check public/scroll-keep.js'))
})
