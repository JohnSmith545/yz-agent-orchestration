// Tests for public/pipeline-layout.js: the Agents page diagram laid out from /api/pipeline's graph alone
// (layers by the longest path over the non-rework edges, branch fans, skip edges through a corridor into the
// Outcome, rework edges as return arrows), for any number of producers, left to right when it fits and top to
// bottom when it does not. The graphs come from the real pipeline.mjs pipelineGraph; the browser file runs in a vm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { pipelineGraph } from '../pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const window = {}
for (const f of ['pipeline-labels.js', 'pipeline-layout.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), { window })
const L = window.PipelineLayout
const plain = v => JSON.parse(JSON.stringify(v))

/** The graph for `n` producers (Agent 1..n) under the coordinator Master. */
const graphWith = n => pipelineGraph({ coordinator: 'Master', codingAgents: { Master: 'Master' }, pipeline: { producers: Array.from({ length: n }, (_, i) => `Agent ${i + 1}`) } })
const G3 = graphWith(3)
const byId = lay => new Map(lay.nodes.map(n => [n.id, n]))

// ═══ layers ═══

test('the default graph layers as Request | Master | the producers | QA and Human task | Push | Outcome', () => {
  assert.deepEqual(plain(L.ranks(G3)), { request: 0, master: 1, 'agent-1': 2, 'agent-2': 2, 'agent-3': 2, qa: 3, human: 3, push: 4, outcome: 5 })
})

test('with no producers QA follows the coordinator straight away', () => {
  assert.deepEqual(plain(L.ranks(graphWith(0))), { request: 0, master: 1, qa: 2, human: 2, push: 3, outcome: 4 })
})

test('one and five producers each share one layer, between the coordinator and QA', () => {
  for (const n of [1, 5]) {
    const r = L.ranks(graphWith(n))
    for (let i = 1; i <= n; i++) assert.equal(r[`agent-${i}`], 2, `agent-${i} of ${n}`)
    assert.equal(r.qa, 3)
    assert.equal(r.outcome, 5)
  }
})

test('rework edges never push a layer: they are the only way back', () => {
  const r = L.ranks({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', kind: 'main' }, { from: 'b', to: 'a', kind: 'rework' }] })
  assert.deepEqual(plain(r), { a: 0, b: 1 })
})

test('an empty or broken graph lays out without throwing', () => {
  assert.equal(L.layout({ nodes: [], edges: [] }, { width: 800 }).nodes.length, 0)
  const lay = L.layout({ nodes: [{ id: 'x', label: 'X' }], edges: [{ from: 'x', to: 'nowhere' }] }, { width: 800 })
  assert.equal(lay.nodes.length, 1)
  assert.equal(lay.edges.length, 0)
})

// ═══ left to right ═══

test('wide: left to right, one column per layer, the producers stacked in config order', () => {
  const lay = L.layout(G3, { width: 1160 })
  assert.equal(lay.dir, 'LR')
  const at = byId(lay)
  const xs = ['request', 'master', 'agent-1', 'qa', 'push', 'outcome'].map(id => at.get(id).x)
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b))
  assert.equal(new Set(xs).size, 6)
  assert.equal(at.get('agent-1').x, at.get('agent-3').x)
  assert.ok(at.get('agent-1').y < at.get('agent-2').y && at.get('agent-2').y < at.get('agent-3').y)
})

test('it never needs more than the width it is given, left to right or top to bottom', () => {
  for (const n of [0, 1, 3, 5]) {
    for (const width of [1400, 1160, 900, 640, 480]) {
      const lay = L.layout(graphWith(n), { width })
      if (n === 5 && width < 600) continue // five side by side on a phone: the box scrolls inside itself
      assert.ok(lay.width <= width, `${n} producers at ${width}: ${lay.width} (${lay.dir})`)
    }
  }
})

test('a phone (a 358 px box, QA 2026-11-24: it drew 404 px and scrolled inside) fits three producers with no inner scroll', () => {
  for (const n of [0, 1, 2, 3]) {
    const lay = L.layout(graphWith(n), { width: 358, rows: 2 })
    assert.ok(lay.width <= 358, `${n} producers: ${lay.width}`)
  }
})

test('on a phone a step with the row to itself is wider than the producers sharing theirs, so its name is not cut', () => {
  const at = byId(L.layout(G3, { width: 358, rows: 2 }))
  assert.ok(at.get('master').w >= 140 && at.get('outcome').w >= 140, `${at.get('master').w}`)
  assert.ok(at.get('agent-1').w < at.get('master').w)
  assert.equal(at.get('master').x + at.get('master').w / 2, at.get('agent-2').x + at.get('agent-2').w / 2, 'centred on one line')
})

test('narrow: top to bottom, one row per layer, the producers side by side', () => {
  const lay = L.layout(G3, { width: 480 })
  assert.equal(lay.dir, 'TB')
  const at = byId(lay)
  const ys = ['request', 'master', 'agent-1', 'qa', 'push', 'outcome'].map(id => at.get(id).y)
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b))
  assert.equal(at.get('agent-1').y, at.get('agent-3').y)
  assert.ok(at.get('agent-1').x < at.get('agent-2').x)
})

test('every edge of the graph is drawn once, with its kind and an arrow head', () => {
  const lay = L.layout(G3, { width: 1160 })
  assert.equal(lay.edges.length, G3.edges.length)
  for (const [i, e] of lay.edges.entries()) {
    assert.equal(e.from, G3.edges[i].from)
    assert.equal(e.kind, G3.edges[i].kind)
    assert.match(e.d, /^M/)
    assert.match(e.head, /^M.*Z$/)
  }
})

test('chip rows make every box taller by the same amount', () => {
  const a = byId(L.layout(G3, { width: 1160, rows: 0 })).get('qa')
  const b = byId(L.layout(G3, { width: 1160, rows: 3 })).get('qa')
  assert.ok(b.h > a.h)
  assert.equal(new Set(L.layout(G3, { width: 1160, rows: 3 }).nodes.map(n => n.h)).size, 1)
})

// ═══ edges ═══

/** Every point of a path of M, L, C and Q commands, sampled along each curve. */
function samples(d) {
  const t = d.match(/[MLCQ]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g)
  const out = []
  let p = [0, 0]
  for (let i = 0; i < t.length;) {
    const c = t[i++]
    const num = () => +t[i++]
    if (c === 'M' || c === 'L') { p = [num(), num()]; out.push(p) } else if (c === 'Q') {
      const a = [num(), num()]
      const b = [num(), num()]
      for (let s = 1; s <= 8; s++) { const u = s / 8; out.push([(1 - u) ** 2 * p[0] + 2 * (1 - u) * u * a[0] + u * u * b[0], (1 - u) ** 2 * p[1] + 2 * (1 - u) * u * a[1] + u * u * b[1]]) }
      p = b
    } else if (c === 'C') {
      const a = [num(), num()]
      const b = [num(), num()]
      const e = [num(), num()]
      for (let s = 1; s <= 24; s++) {
        const u = s / 24
        const k = [(1 - u) ** 3, 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u * u, u ** 3]
        out.push([k[0] * p[0] + k[1] * a[0] + k[2] * b[0] + k[3] * e[0], k[0] * p[1] + k[1] * a[1] + k[2] * b[1] + k[3] * e[1]])
      }
      p = e
    }
  }
  // straight runs: add points in between, so a line across a box is caught
  const dense = []
  for (let i = 0; i < out.length; i++) {
    if (i) for (let s = 1; s < 10; s++) dense.push([out[i - 1][0] + ((out[i][0] - out[i - 1][0]) * s) / 10, out[i - 1][1] + ((out[i][1] - out[i - 1][1]) * s) / 10])
    dense.push(out[i])
  }
  return dense
}
const inside = (p, b, inset = 1) => p[0] > b.x + inset && p[0] < b.x + b.w - inset && p[1] > b.y + inset && p[1] < b.y + b.h - inset

test('no arrow runs through a box, for 0, 1, 3 and 5 producers, both ways', () => {
  for (const n of [0, 1, 3, 5]) {
    for (const width of [1600, 1160, 560, 358]) {
      const lay = L.layout(graphWith(n), { width, rows: 2 })
      for (const e of lay.edges) {
        for (const p of samples(e.d)) {
          const hit = lay.nodes.find(b => inside(p, b))
          assert.ok(!hit, `${n} producers, ${lay.dir}: ${e.from} -> ${e.to} runs through ${hit?.id} at ${p.map(Math.round)}`)
        }
      }
    }
  }
})

test('every arrow fits inside the drawing', () => {
  for (const n of [0, 1, 3, 5]) {
    for (const width of [1160, 560, 358]) {
      const lay = L.layout(graphWith(n), { width })
      for (const e of lay.edges) for (const [x, y] of samples(e.d)) assert.ok(x >= 0 && y >= 0 && x <= lay.width && y <= lay.height, `${e.from}->${e.to} at ${x},${y} (${lay.width}x${lay.height})`)
    }
  }
})

test('rework arrows end on the producer they return to, skip arrows end on their box (Human task or the Outcome)', () => {
  const lay = L.layout(G3, { width: 1160 })
  const at = byId(lay)
  const end = e => samples(e.d).at(-1)
  for (const e of lay.edges.filter(x => x.kind === 'rework')) {
    const p = at.get(e.to)
    const [x, y] = end(e)
    assert.ok(Math.abs(x - (p.x + p.w)) <= 8 && y > p.y && y < p.y + p.h, `${e.to}: ${x},${y}`)
  }
  for (const e of lay.edges.filter(x => x.kind === 'skip')) {
    const o = at.get(e.to)
    const [x, y] = end(e)
    assert.ok(Math.abs(x - o.x) <= 8 && y > o.y && y < o.y + o.h, `${e.from}: ${x},${y}`)
  }
})

// ═══ labels ═══

const textBox = l => {
  const w = l.text.length * 6.4
  const h = 12
  const across = l.rotate ? { w: h, h: w } : { w, h }
  const x = l.rotate ? l.x - h : l.anchor === 'middle' ? l.x - w / 2 : l.anchor === 'end' ? l.x - w : l.x
  const y = l.rotate ? (l.anchor === 'middle' ? l.y - w / 2 : l.y - w) : l.y - 10
  return { x, y, ...across }
}
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

test('every label is drawn: failed for every return, own changes, passed, and no code changes once for the skips', () => {
  const lay = L.layout(G3, { width: 1160 })
  // QA's returns: one failed beside each producer, or ONE beside QA when the skip lines cross those spots
  // (QA 2026-11-25: no line may run under a label); either way every return arrow is labelled
  const failed = lay.labels.filter(l => l.text === 'failed')
  assert.deepEqual(plain(failed.flatMap(l => l.edges).sort()), plain(lay.edges.filter(e => e.kind === 'rework').map(e => e.i).sort()))
  const texts = plain(lay.labels.filter(l => l.text !== 'failed').map(l => l.text)).sort()
  assert.deepEqual(texts, ['done by hand', 'no code changes', 'own changes', 'passed'])
  const skip = lay.labels.find(l => l.text === 'no code changes')
  assert.equal(skip.edges.length, 4, 'the one skip label stands for all four skip arrows into Human task')
})

test('no label sits on a box, both ways, for 1, 3 and 5 producers', () => {
  for (const n of [1, 3, 5]) {
    for (const width of [1600, 1160, 560, 358]) {
      const lay = L.layout(graphWith(n), { width, rows: 1 })
      for (const l of lay.labels) {
        const hit = lay.nodes.find(b => overlaps(textBox(l), b))
        assert.ok(!hit, `${n} producers, ${lay.dir}: "${l.text}" on ${hit?.id}`)
      }
    }
  }
})

// A ticket's lit route is flow-route.js highlight, over its progress (flow-route-ui.test.mjs).
