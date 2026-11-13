// Tests for public/motion.js (spec 8): Motion.countUp lands on the exact
// value, enterList runs once per list, and all of it stands down under
// prefers-reduced-motion. A vm with a stub element, a manual animation-frame
// queue and a settable clock.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'public', 'motion.js'), 'utf8')

function el(text = '') {
  const classes = new Set()
  return {
    textContent: text,
    style: { props: {}, setProperty(k, v) { this.props[k] = v } },
    listeners: {},
    children: [],
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
    querySelectorAll() { return this.children },
  }
}

function load({ reduce = false } = {}) {
  let clock = 0
  let frames = []
  const window = {
    matchMedia: q => ({ matches: reduce && q.includes('reduce') }),
    requestAnimationFrame: fn => frames.push(fn),
    cancelAnimationFrame: () => {},
    performance: { now: () => clock },
  }
  vm.runInNewContext(SRC, { window, WeakSet, WeakMap })
  /** Runs queued frames with the clock at `t` ms until none are left. */
  const runTo = t => {
    clock = t
    for (let guard = 0; frames.length && guard < 100; guard++) {
      const now = frames
      frames = []
      now.forEach(fn => fn(clock))
    }
  }
  const step = t => {
    clock = t
    const now = frames
    frames = []
    now.forEach(fn => fn(clock))
  }
  return { Motion: window.Motion, runTo, step, pending: () => frames.length }
}

test('countUp passes through the numbers between and ends on the exact value', () => {
  const { Motion, step, runTo } = load()
  const n = el('10')
  Motion.countUp(n, 40)
  step(150)
  const mid = Number(n.textContent)
  assert.ok(mid > 10 && mid < 40, `halfway shows a number between, got ${n.textContent}`)
  runTo(1000)
  assert.equal(n.textContent, '40')
})

test('countUp writes the value straight away when there is no number to start from, or nothing changed', () => {
  const { Motion, pending } = load()
  const blank = el('–')
  Motion.countUp(blank, 7)
  assert.equal(blank.textContent, '7')
  const same = el('7')
  Motion.countUp(same, 7)
  assert.equal(same.textContent, '7')
  assert.equal(pending(), 0, 'no frame was asked for')
})

test('a second countUp on the same element ends on the newer value', () => {
  const { Motion, step, runTo } = load()
  const n = el('0')
  Motion.countUp(n, 100)
  step(100)
  Motion.countUp(n, 5)
  runTo(2000)
  assert.equal(n.textContent, '5')
})

test('under reduced motion countUp only writes the final value', () => {
  const { Motion, pending } = load({ reduce: true })
  const n = el('3')
  Motion.countUp(n, 12)
  assert.equal(n.textContent, '12')
  assert.equal(pending(), 0)
})

test('enterList staggers the items 30 ms apart on the first render only', () => {
  const { Motion } = load()
  const list = el()
  list.children = [el(), el(), el()]
  Motion.enterList(list)
  assert.deepEqual(list.children.map(c => c.style.props['--i']), ['0', '1', '2'])
  assert.ok(list.children.every(c => c.classList.contains('enter')))
  const again = [el(), el()]
  list.children = again
  Motion.enterList(list)
  assert.ok(again.every(c => !c.classList.contains('enter')), 'a poll re-render never animates')
})

test('enterList waits for a list that has items before it counts as rendered', () => {
  const { Motion } = load()
  const list = el()
  Motion.enterList(list)
  list.children = [el()]
  Motion.enterList(list)
  assert.ok(list.children[0].classList.contains('enter'))
})

test('under reduced motion enterList and spotlight do nothing', () => {
  const { Motion } = load({ reduce: true })
  const list = el()
  list.children = [el()]
  Motion.enterList(list)
  assert.ok(!list.children[0].classList.contains('enter'))
  const root = el()
  Motion.spotlight(root)
  assert.deepEqual(root.listeners, {})
})

test('spotlight puts the pointer position on the card under it as --mx and --my', () => {
  const { Motion } = load()
  const root = el()
  Motion.spotlight(root)
  const card = el()
  card.getBoundingClientRect = () => ({ left: 100, top: 50 })
  card.matches = () => false
  const target = { closest: () => card }
  root.listeners.pointermove[0]({ target, clientX: 130, clientY: 70 })
  assert.equal(card.style.props['--mx'], '30px')
  assert.equal(card.style.props['--my'], '20px')
  assert.ok(card.classList.contains('spot'))
})
