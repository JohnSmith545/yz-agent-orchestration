// Frame-by-frame tests of the fog list's move (public/prlist-view.js frameAt), run in a vm with a bare window. QA
// (2026-11-26) sampled every frame of a second leave and found two titles drawn in the same row: the item that came
// in at the TAIL (the one that had been past the 5th, behind `and N more`) faded in at step 5 while the old step-5
// item still stood there, waiting to rise. With hover or focus on that row the titles overprinted plainly. The rule
// now: an item that enters waits until every kept item has finished moving, and a leaving copy is gone before
// anything rises. These tests walk the whole move in 5 ms frames, with and without a focused (fully shown) item, and
// check that no two visible items overlap vertically in any frame.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = vm.createContext({ window: { Shell: { ago: () => '' } } })
vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', 'prlist-view.js'), 'utf8'), ctx)
const V = ctx.window.PrListView

/** Rows as the page lays them out (QA measured these): the clear first with its small line, then 26 px fog rows. */
function rows(keys) {
  const out = {}
  let top = 0
  keys.forEach((k, i) => {
    const height = i === 0 ? 54 : 26
    out[k] = { top, height, fog: Math.min(i, 4) }
    top += height + (i === 0 ? 9 : 0)
  })
  return out
}
const shown = list => list.slice(0, 5)

/** Every pair of visible boxes that overlap in this frame, as text. */
function overlaps(frame) {
  const vis = frame.filter(b => b.opacity > 0)
  const out = []
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i]
      const b = vis[j]
      if (a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) out.push(`${a.key} ${a.top.toFixed(1)}-${a.bottom.toFixed(1)} over ${b.key} ${b.top.toFixed(1)}-${b.bottom.toFixed(1)}`)
    }
  }
  return out
}
/** Walk the move from 0 ms to its end in 5 ms steps; the frames that overlap, each with its time. */
function walk(prevAll, nextAll, opts = {}) {
  const prev = shown(prevAll)
  const next = shown(nextAll)
  const plan = { ...V.motionPlan(prev, next, { reduced: false }), ...(opts.plan || {}) }
  const before = rows(prev)
  const after = rows(next)
  const bad = []
  for (let t = 0; t <= plan.endMs + 10; t += 5) {
    const o = overlaps(V.frameAt(plan, before, after, t, { focus: opts.focus }))
    if (o.length) bad.push(`${t} ms: ${o.join('; ')}`)
  }
  return { plan, bad }
}
const ALL = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

test('the first leaves and the 6th comes in at the tail: no two visible titles share a row in any frame', () => {
  const { plan, bad } = walk(ALL, ALL.slice(1))
  assert.deepEqual(plain(plan.entered), ['f'])
  assert.deepEqual(bad, [])
  // a SECOND leave, as QA sampled it
  assert.deepEqual(walk(ALL.slice(1), ALL.slice(2)).bad, [])
})

test('the same with keyboard focus or the pointer on the fogged row that moves, and on the one that comes in', () => {
  for (const focus of ['e', 'f', 'b', 'd']) assert.deepEqual(walk(ALL, ALL.slice(1), { focus }).bad, [], `focus on ${focus}`)
})

test('a new one at the top pushes the 5th behind and N more: clean in every frame', () => {
  assert.deepEqual(walk(ALL, ['n', ...ALL]).bad, [])
  assert.deepEqual(walk(ALL, ['n', ...ALL], { focus: 'd' }).bad, [])
})

test('one in the middle leaves, and the last of five leaves with nothing behind it: clean in every frame', () => {
  assert.deepEqual(walk(ALL, ['a', 'b', 'd', 'e', 'f', 'g']).bad, [])
  assert.deepEqual(walk(['a', 'b', 'c'], ['a', 'b']).bad, [])
  assert.deepEqual(walk(['a', 'b', 'c'], ['b', 'c']).bad, [])
})

test('the frames catch the old fault: an item that entered at once, at the tail, overprinted the one leaving its row', () => {
  const { bad } = walk(ALL, ALL.slice(1), { plan: { enterAt: 0 } })
  assert.ok(bad.length > 0, 'entering at 0 ms overlaps')
  assert.match(bad[0], /f /)
})

test('the timing: anything entering waits for the whole rise, then fades in briefly; the plan says when it all ends', () => {
  const p = V.motionPlan(shown(ALL), shown(ALL.slice(1)), { reduced: false })
  assert.equal(p.enterAt, p.ms, 'after every kept item has arrived')
  assert.ok(p.enterMs >= 120 && p.enterMs <= 260, String(p.enterMs))
  assert.equal(p.endMs, p.enterAt + p.enterMs)
  const quiet = V.motionPlan(['a', 'b'], ['a'], { reduced: false })
  assert.equal(quiet.endMs, quiet.ms, 'nothing entering: it ends with the move')
  // a frame at 0 ms: the leaving copy is still there, at its row, and the entering one is not shown yet
  const f0 = V.frameAt(p, rows(shown(ALL)), rows(shown(ALL.slice(1))), 0, {})
  assert.ok(f0.find(b => b.key === 'a').opacity > 0)
  assert.equal(f0.find(b => b.key === 'f').opacity, 0)
  const end = V.frameAt(p, rows(shown(ALL)), rows(shown(ALL.slice(1))), p.endMs, {})
  assert.equal(end.find(b => b.key === 'f').opacity, V.FOG[4].opacity, 'in at its fog step by the end')
  assert.ok(!end.some(b => b.key === 'a' && b.opacity > 0), 'the leaving one is gone')
})

test('the DOM half uses the same timing: entering rows wait plan.enterAt, the clean-up waits plan.endMs', () => {
  const js = fs.readFileSync(path.join(HERE, '..', 'public', 'prlist.js'), 'utf8')
  assert.match(js, /plan\.enterAt/)
  assert.match(js, /plan\.enterMs/)
  assert.match(js, /plan\.endMs/)
  const css = fs.readFileSync(path.join(HERE, '..', 'public', 'prlist.css'), 'utf8')
  assert.match(css, /@keyframes prl-in \{ from \{ opacity: 0; \} \}/, 'a fade only: no slide into the row above')
})

function plain(v) {
  return JSON.parse(JSON.stringify(v))
}
