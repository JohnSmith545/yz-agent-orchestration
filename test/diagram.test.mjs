// Tests for public/diagram.js, the generic node and arrow drawing behind the
// Output view's visual (an agent's diagram, or the chart drawn from the flow).
// A browser script, so it runs here in a vm with a stub window, after
// flow-chart.js whose text measuring it shares. layout is pure, so every
// position and path is checked without a DOM.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const window = {}
for (const f of ['flow-chart.js', 'diagram-fit.js', 'diagram-route.js', 'diagram.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), { window })
const D = window.Diagram
/** Arrays made inside the vm have its prototypes, so strict deepEqual needs plain copies. */
const plain = v => JSON.parse(JSON.stringify(v))

const graph = (nodes, edges = []) => ({
  nodes: nodes.map(n => (typeof n === 'string' ? { id: n, label: n.toUpperCase() } : n)),
  edges: edges.map(([from, to, label]) => ({ from, to, label })),
})
const chain = n => graph(Array.from({ length: n }, (_, i) => `n${i}`), Array.from({ length: n - 1 }, (_, i) => [`n${i}`, `n${i + 1}`]))
const at = (lay, id) => lay.nodes.find(n => n.id === id)
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
/** The first and the last point of an SVG path made of M, H and V commands. */
function ends(d) {
  const tokens = d.match(/[MHV]|-?\d+(?:\.\d+)?/g)
  let x = 0, y = 0, first = null
  for (let i = 0; i < tokens.length;) {
    const c = tokens[i++]
    if (c === 'M') { x = +tokens[i++]; y = +tokens[i++]; first = { x, y } } else if (c === 'H') x = +tokens[i++]
    else if (c === 'V') y = +tokens[i++]
  }
  return { first, last: { x, y } }
}

test('every node gets a finite position and no two boxes overlap, in both directions', () => {
  const g = graph(['a', 'b', 'c', 'd', 'e', 'f'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['d', 'e'], ['a', 'f']])
  for (const dir of ['LR', 'TB']) {
    const lay = D.layout(g, { dir, maxWidth: 900 })
    assert.equal(lay.nodes.length, 6)
    for (const n of lay.nodes) assert.ok([n.x, n.y, n.w, n.h].every(Number.isFinite), `${dir} ${n.id}`)
    for (const a of lay.nodes) for (const b of lay.nodes) if (a !== b) assert.ok(!overlap(a, b), `${dir}: ${a.id} overlaps ${b.id}`)
  }
})

test('LR puts each next layer to the right on the same row; TB puts it below', () => {
  const lr = D.layout(chain(3), { dir: 'LR', maxWidth: 2000 })
  assert.equal(lr.dir, 'LR')
  assert.ok(at(lr, 'n1').x > at(lr, 'n0').x && at(lr, 'n2').x > at(lr, 'n1').x)
  assert.equal(at(lr, 'n1').y, at(lr, 'n0').y)
  const tb = D.layout(chain(3), { dir: 'TB', maxWidth: 2000 })
  assert.equal(tb.dir, 'TB')
  assert.ok(at(tb, 'n1').y > at(tb, 'n0').y && at(tb, 'n2').y > at(tb, 'n1').y)
  assert.equal(at(tb, 'n1').x, at(tb, 'n0').x)
  assert.equal(D.layout(chain(2)).dir, 'LR', 'LR by default')
})

test('each arrow leaves its own box and ends on its target: LR side to side, TB bottom to top', () => {
  const g = graph(['a', 'b', 'c'], [['a', 'b'], ['a', 'c'], ['b', 'c']])
  for (const dir of ['LR', 'TB']) {
    const lay = D.layout(g, { dir, maxWidth: 1200 })
    assert.equal(lay.edges.length, 3)
    for (const e of lay.edges) {
      const a = at(lay, e.from)
      const b = at(lay, e.to)
      const { first, last } = ends(e.d)
      // each arrow has its own point on each side, spread around the middle (diagram-route.js)
      if (dir === 'LR') {
        assert.equal(first.x, a.x + a.w, `${e.from}>${e.to} leaves the right side`)
        assert.ok(Math.abs(first.y - (a.y + a.h / 2)) < a.h / 2, `${e.from}>${e.to} leaves within the side`)
        assert.equal(last.x, b.x, `${e.from}>${e.to} enters the left side`)
        assert.ok(Math.abs(last.y - (b.y + b.h / 2)) < b.h / 2, `${e.from}>${e.to} enters within the side`)
      } else {
        assert.equal(first.y, a.y + a.h)
        assert.ok(Math.abs(first.x - (a.x + a.w / 2)) < a.w / 2)
        assert.equal(last.y, b.y)
        assert.ok(Math.abs(last.x - (b.x + b.w / 2)) < b.w / 2)
      }
    }
  }
})

test('a cycle does not hang: its closing arrow is the one back edge, and the layers stay in order', () => {
  const lay = D.layout(graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]), { dir: 'LR', maxWidth: 2000 })
  assert.deepEqual(plain(lay.edges.filter(e => e.back).map(e => `${e.from}>${e.to}`)), ['c>a'])
  assert.ok(at(lay, 'a').layer < at(lay, 'b').layer && at(lay, 'b').layer < at(lay, 'c').layer)
  // a cycle with no way in: still laid out, one back edge
  const ring = D.layout(graph(['a', 'b'], [['a', 'b'], ['b', 'a']]))
  assert.equal(ring.edges.filter(e => e.back).length, 1)
  const svg = D.svg(graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]), { dir: 'LR' })
  assert.equal((svg.match(/class="dg-edge dg-back/g) || []).length, 1, 'drawn dashed (the dg-back class)')
})

test('40 nodes in a chain wrap into bands that fit the given width, and still never overlap', () => {
  for (const dir of ['LR', 'TB']) {
    const lay = D.layout(chain(40), { dir, maxWidth: 900 })
    assert.ok(lay.width <= 900, `${dir}: ${lay.width} wide`)
    for (const n of lay.nodes) assert.ok(n.x + n.w <= lay.minX + lay.width && n.x >= lay.minX, `${dir} ${n.id} inside`)
    for (const a of lay.nodes) for (const b of lay.nodes) if (a !== b) assert.ok(!overlap(a, b), `${dir}: ${a.id} ${b.id}`)
  }
  const lr = D.layout(chain(40), { dir: 'LR', maxWidth: 900 })
  assert.ok(new Set(lr.nodes.map(n => n.y)).size > 1, 'LR wraps into several bands')
  // a wide TB layer wraps into rows too
  const fan = graph(['root', ...Array.from({ length: 12 }, (_, i) => `k${i}`)], Array.from({ length: 12 }, (_, i) => ['root', `k${i}`]))
  const tb = D.layout(fan, { dir: 'TB', maxWidth: 600 })
  assert.ok(tb.width <= 600)
  assert.ok(new Set(tb.nodes.filter(n => n.id !== 'root').map(n => n.y)).size > 1)
})

test('auto picks LR while two columns fit the width, else TB; LR is the default', () => {
  assert.equal(D.layout(chain(4), { dir: 'auto', maxWidth: 1200 }).dir, 'LR')
  assert.equal(D.layout(chain(4), { dir: 'auto', maxWidth: 420 }).dir, 'TB')
  assert.equal(D.layout(chain(4), { dir: 'auto' }).dir, 'LR', 'no width: nothing to wrap for')
})

test('it reads like a slide: boxes at least 150 by 56 and gaps at least 56, whatever the direction', () => {
  for (const dir of ['LR', 'TB']) {
    const lay = D.layout(chain(3), { dir })
    const [a, b] = lay.nodes
    assert.ok(a.w >= 150 && a.h >= 56, `${dir} box ${a.w}x${a.h}`)
    const gap = dir === 'LR' ? b.x - (a.x + a.w) : b.y - (a.y + a.h)
    assert.ok(gap >= 56, `${dir} gap ${gap}`)
  }
})

test('an empty or broken graph lays out to nothing and never throws; unknown ends and self arrows are dropped', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(D.layout({ nodes: [], edges: [] }))).nodes, [])
  assert.doesNotThrow(() => D.layout(null))
  assert.doesNotThrow(() => D.svg(undefined))
  const lay = D.layout(graph(['a', 'b', 'a'], [['a', 'zz'], ['a', 'a'], ['a', 'b']]))
  assert.deepEqual(plain(lay.nodes.map(n => n.id)), ['a', 'b'], 'a repeated id is drawn once')
  assert.deepEqual(plain(lay.edges.map(e => `${e.from}>${e.to}`)), ['a>b'])
})

test('svg: each kind has its own shape, arrows have heads, and edge labels sit on a background', () => {
  const g = {
    nodes: [
      { id: 'u', label: 'User', kind: 'actor' }, { id: 'p', label: 'Page', kind: 'box' },
      { id: 's', label: 'Storage', kind: 'store' }, { id: 'q', label: 'Dark?', kind: 'decision' }, { id: 'x', label: 'Odd', kind: 'cloud' },
    ],
    edges: [{ from: 'u', to: 'p', label: 'clicks' }, { from: 'p', to: 's' }, { from: 'p', to: 'q' }],
  }
  const svg = D.svg(g, { dir: 'LR', maxWidth: 1400 })
  assert.match(svg, /^<svg class="dg dg-lr" xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[^"]+" width="\d+" height="\d+" role="img"/)
  assert.match(svg, /<g class="dg-node dg-actor"[^>]*>[\s\S]*?<rect class="dg-shape"[^>]*rx="32"/, 'an actor is a pill')
  assert.match(svg, /<g class="dg-node dg-store"[^>]*>[\s\S]*?<rect class="dg-shape"[\s\S]*?<path class="dg-lid"/, 'a store has a second top line')
  assert.match(svg, /<g class="dg-node dg-decision"[^>]*>[\s\S]*?<path class="dg-shape" d="M[^"]+Z"/, 'a decision is a diamond')
  assert.match(svg, /<g class="dg-node dg-box"[^>]*>(?:(?!<\/g>)[\s\S])*Odd/, 'an unknown kind is drawn as a box')
  assert.equal((svg.match(/<path class="dg-head"/g) || []).length, 3, 'one head per arrow')
  assert.match(svg, /<g class="dg-elabel"><rect [^>]+\/><text [^>]+>clicks<\/text><\/g>/)
  assert.doesNotMatch(svg, /style=|fill="#|stroke="#/, 'colours come from classes only')
})

test('svg fits a long label to three lines (a box at least 170 px wide) with an ellipsis and keeps the full text in its title', () => {
  const long = 'Move the nightly report job to the new scheduler and keep the old one running for a week, then retire the old server and its backups'
  const svg = D.svg({ nodes: [{ id: 'a', label: long }], edges: [] })
  assert.match(svg, new RegExp(`<title>${long}</title>`))
  const spans = [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map(m => m[1])
  assert.equal(spans.length, 3)
  assert.ok(spans[2].endsWith('…'), spans[2])
  const short = D.svg({ nodes: [{ id: 'a', label: 'Short' }], edges: [] })
  assert.equal((short.match(/<tspan/g) || []).length, 1)
})

test('svg escapes every label, id and class: a script label, an onerror arrow label, a quote in an id', () => {
  const svg = D.svg({
    nodes: [{ id: 'a', goto: 'a"><script>x</script>', label: '<script>alert(1)</script>', sub: '<b>sub</b>', cls: 'ok" onclick="x' }, { id: 'b', label: 'B' }],
    edges: [{ from: 'a', to: 'b', label: '" onerror="alert(2)' }],
  }, { title: '<img src=x onerror=alert(3)>' })
  assert.doesNotMatch(svg, /<script>/)
  assert.doesNotMatch(svg, /onerror="/)
  assert.doesNotMatch(svg, /onclick="/)
  assert.doesNotMatch(svg, /<img/)
  assert.doesNotMatch(svg, /<b>/)
  assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(svg, /data-goto="a&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/)
})

test('svg: only a node with a goto carries data-goto and is in the tab order; a sub line is drawn when given', () => {
  const svg = D.svg({ nodes: [{ id: 's1', goto: 'n4', label: 'A', sub: '1 blocked', cls: 'dg-done proof-verified' }, { id: 'b', label: 'B' }], edges: [] })
  assert.match(svg, /<g class="dg-node dg-box dg-done proof-verified" data-goto="n4" tabindex="0" role="link" aria-label="A, 1 blocked">/)
  assert.match(svg, /<g class="dg-node dg-box">/)
  assert.doesNotMatch(svg, /dg-mark/, 'no proof dots: the Output charts carry none')
  assert.match(svg, /<tspan class="dg-sub"[^>]*>1 blocked<\/tspan>/)
  assert.equal((svg.match(/data-goto=/g) || []).length, 1)
})

test('diagram.css: big type and thick arrows, dashed back edges and work left, warn when blocked, tokens only', () => {
  const css = fs.readFileSync(path.join(HERE, '..', 'public', 'diagram.css'), 'utf8')
  assert.match(css, /\.dg-label \{[^}]*font-size: 14px; font-weight: 600/)
  assert.match(css, /\.dg-edge \{[^}]*stroke-width: 1\.5/)
  assert.match(css, /\.dg-back \{[^}]*stroke-dasharray/)
  assert.match(css, /\.dg-left \.dg-shape \{[^}]*stroke-dasharray/)
  assert.match(css, /\.dg-blocked \.dg-shape \{[^}]*stroke: var\(--warn\)/)
  assert.match(css, /svg\.dg \{[^}]*margin: 0 auto/, 'centred in its block')
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b|rgb\(|animation|transition/i, 'colours are tokens, and nothing moves')
  const html = fs.readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf8')
  assert.ok(html.indexOf('href="diagram.css"') > html.indexOf('href="flows.css"'), 'after flows.css, so its storyboard rules win')
})

test('an arrow label never hangs outside the drawing, even into the first column of a wrapped band', () => {
  const g = graph(['a', 'b', 'c', 'd', 'e'], [['a', 'b', 'first'], ['b', 'c', 'second'], ['c', 'd', 'third one'], ['d', 'e', 'fourth']])
  for (const dir of ['LR', 'TB']) {
    const lay = D.layout(g, { dir, maxWidth: 600 })
    for (const e of lay.edges) {
      assert.ok(e.lx - e.lw / 2 >= lay.minX && e.lx + e.lw / 2 <= lay.minX + lay.width, `${dir} ${e.from}>${e.to}`)
    }
  }
})
