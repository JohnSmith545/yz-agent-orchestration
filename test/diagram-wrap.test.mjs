// Tests for the proper-UI pass on public/diagram.js and public/flow-picture.js:
// labels wrap at word boundaries and never end mid-word, diamonds are sized to
// their question, arrow labels of up to 24 characters are never cut and never
// sit on a box, and a chart too wide for one row wraps into a second row with
// short connectors at the row ends instead of a loop back across the picture.
// layout is pure, so every position and path is checked without a DOM.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-wrap-test-'))
const { derive, DATA_DIR } = await import('../flows.mjs')
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

const window = {}
for (const f of ['terms.js', 'flow-chart.js', 'diagram-fit.js', 'diagram-route.js', 'diagram.js', 'flow-picture.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', f), 'utf8'), { window })
const D = window.Diagram
const P = window.FlowPicture
const NOVIS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const nv = () => { const f = structuredClone(NOVIS); f.derived = derive(f); return f }
/** The agent diagram of the dark-mode fixture: five shapes, two arrows into one box, a branch. */
const DARK = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8')).output.diagram

/** Every node's label lines as drawn: [{ label, lines }]. */
function drawnLabels(svg) {
  return [...svg.matchAll(/<g class="dg-node[^"]*"[^>]*><title>([^<]*)<\/title>[\s\S]*?<text class="dg-label"[^>]*>([\s\S]*?)<\/text><\/g>/g)].map(m => ({
    title: m[1].replace(/ \([^)]*\)$/, ''),
    lines: [...m[2].matchAll(/<tspan x[^>]*>([^<]*)<\/tspan>/g)].map(t => t[1]),
  }))
}
const unesc = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")

/** True when each drawn line is made of whole words of the label (a trailing … allowed after a whole word). */
function wholeWords(label, lines) {
  const words = new Set(unesc(label).split(/\s+/).map(w => w.replace(/…$/, '')))
  return lines.every(l => unesc(l).replace(/…$/, '').split(/\s+/).filter(Boolean).every(w => words.has(w)))
}

/** The straight pieces of a path of M, H, V and Q commands (a Q counts as the line to its end point). */
function segments(d) {
  const t = d.match(/[MHVQ]|-?\d+(?:\.\d+)?/g)
  const out = []
  let x = 0, y = 0
  for (let i = 0; i < t.length;) {
    const c = t[i++]
    if (c === 'M') { x = +t[i++]; y = +t[i++]; continue }
    const from = { x, y }
    if (c === 'H') x = +t[i++]
    else if (c === 'V') y = +t[i++]
    else if (c === 'Q') { i += 2; x = +t[i++]; y = +t[i++] }
    out.push([from, { x, y }])
  }
  return out
}
/** Does the segment pass through the inside of the box (touching its edge is fine)? */
const crosses = ([a, b], n) => {
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y)
  return x2 > n.x + 0.5 && x1 < n.x + n.w - 0.5 && y2 > n.y + 0.5 && y1 < n.y + n.h - 0.5
}

test('no label ends mid-word: the summary chart of the fixture, and long labels in boxes and diamonds', () => {
  const graphs = [
    P.graph(nv()),
    { nodes: [{ id: 'a', label: 'Move the nightly report job to the new scheduler and keep the old one running' }, { id: 'q', kind: 'decision', label: 'Run both schedulers side by side for a week before switching?' }], edges: [{ from: 'a', to: 'q' }] },
  ]
  for (const g of graphs) {
    for (const width of [1300, 1000, 700]) {
      for (const { title, lines } of drawnLabels(D.svg(g, { dir: 'auto', maxWidth: width }))) {
        // a box at least 170 px wide may take a third line before it cuts (U8)
        assert.ok(lines.length >= 1 && lines.length <= 3, `${title}: ${lines.length} lines`)
        assert.ok(wholeWords(title, lines), `${title} drawn as ${JSON.stringify(lines)}`)
      }
    }
  }
})

test('a narrow box (the Ask drawer open, an 800 px window) still reads left to right, two shapes a row, in whole words', () => {
  const g = P.graph(nv())
  const lay = D.layout(g, { dir: 'auto', maxWidth: 580 })
  assert.equal(lay.dir, 'LR')
  assert.ok(lay.width <= 580, `${lay.width} wide`)
  assert.equal(new Set(lay.nodes.map(n => n.y + n.h / 2)).size, 3, '6 shapes, 2 a row')
  for (const { title, lines } of drawnLabels(D.svg(g, { dir: 'auto', maxWidth: 580 }))) assert.ok(wholeWords(title, lines), `${title}: ${JSON.stringify(lines)}`)
  assert.equal(D.layout(g, { dir: 'auto', maxWidth: 420 }).dir, 'TB', 'too narrow even for that: top to bottom')
})

test('marked words in a chart show the plain word, never the brackets, and are not chips', () => {
  const svg = D.svg({ nodes: [{ id: 'a', label: 'Give it its own [service account]' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', label: 'uses [token]' }] }, { maxWidth: 1200 })
  assert.doesNotMatch(svg, /\[|<dfn/)
  assert.match(svg, /service account/)
  assert.match(svg, />uses token</)
})

test('a diamond is sized to its question: at least 170 by 84, and a six-word question fits two whole lines', () => {
  const q = 'Run both schedulers side by side…'
  const lay = D.layout({ nodes: [{ id: 'q', kind: 'decision', label: q }], edges: [] }, { maxWidth: 1200 })
  assert.ok(lay.nodes[0].w >= 170 && lay.nodes[0].h >= 84, `${lay.nodes[0].w}x${lay.nodes[0].h}`)
  const [{ lines }] = drawnLabels(D.svg({ nodes: [{ id: 'q', kind: 'decision', label: 'Turn off the old scheduler now?' }], edges: [] }, { maxWidth: 1200 }))
  assert.equal(lines.length, 2)
  assert.equal(lines.join(' '), 'Turn off the old scheduler now?', 'all of it, no ellipsis')
})

test('an arrow label of up to 24 characters is drawn whole, and no arrow label sits on a box', () => {
  const g = {
    nodes: [{ id: 'u', label: 'User', kind: 'actor' }, { id: 's', label: 'Settings page' }, { id: 't', label: 'Theme tokens' }, { id: 'b', label: 'Browser storage', kind: 'store' }],
    edges: [{ from: 'u', to: 's', label: 'clicks the moon' }, { from: 's', to: 't', label: 'switches every colour' }, { from: 's', to: 'b', label: 'saves the choice for later' }],
  }
  for (const width of [1300, 900]) {
    const svg = D.svg(g, { dir: 'LR', maxWidth: width })
    assert.match(svg, />clicks the moon</)
    assert.match(svg, />switches every colour</, '21 characters: whole')
    const lay = D.layout(g, { dir: 'LR', maxWidth: width })
    for (const e of lay.edges) {
      const half = e.lw / 2
      const box = { x: e.lx - Math.min(half, 60), y: e.ly - 9, w: Math.min(e.lw, 120), h: 18 }
      for (const n of lay.nodes) assert.ok(!(box.x < n.x + n.w && n.x < box.x + box.w && box.y < n.y + n.h && n.y < box.y + box.h), `${e.from}>${e.to} label on ${n.id}`)
    }
  }
})

test('a 7-shape chart too wide for one row wraps into two rows joined by ONE continuous line; no arrow crosses a box', () => {
  const labels = ['Read how the job runs', 'Run both side by side?', 'Turn on the new schedule', '3 left', 'Turn off the old one?', '2 left', 'Retire the server']
  const g = {
    nodes: labels.map((label, i) => ({ id: `s${i + 1}`, label, kind: label.endsWith('?') ? 'decision' : 'box' })),
    edges: labels.slice(1).map((_, i) => ({ from: `s${i + 1}`, to: `s${i + 2}`, label: i === 3 ? 'Yes' : '' })),
  }
  const lay = D.layout(g, { dir: 'auto', maxWidth: 1100 })
  assert.equal(lay.dir, 'LR', 'it reads left to right like a sentence')
  const rows = [...new Set(lay.nodes.map(n => n.y + n.h / 2))].sort((a, b) => a - b)
  assert.equal(rows.length, 2, 'two rows')
  assert.ok(lay.width <= 1100)
  const at = id => lay.nodes.find(n => n.id === id)
  for (const e of lay.edges) {
    assert.equal(Number(e.to.slice(1)), Number(e.from.slice(1)) + 1, 'each arrow joins neighbours')
    assert.equal((e.d.match(/M/g) || []).length, 1, `${e.from}>${e.to} is one line, not two stubs`)
    for (const seg of segments(e.d)) for (const n of lay.nodes) assert.ok(!crosses(seg, n), `${e.from}>${e.to} crosses ${n.id}`)
  }
  const wrap = lay.edges.find(e => at(e.to).y > at(e.from).y + 10)
  assert.ok(wrap, 'one arrow goes into the next row')
  const firstRowBottom = Math.max(...lay.nodes.filter(n => n.y + n.h / 2 === rows[0]).map(n => n.y + n.h))
  const secondRowTop = Math.min(...lay.nodes.filter(n => n.y + n.h / 2 === rows[1]).map(n => n.y))
  const ys = segments(wrap.d).filter(([a, b]) => a.y === b.y && Math.abs(a.x - b.x) > 100).map(([a]) => a.y)
  assert.equal(ys.length, 1, 'one long horizontal run: the line return')
  assert.ok(ys[0] > firstRowBottom && ys[0] < secondRowTop, 'it runs in the gap between the rows')
  assert.equal(wrap.label, 'Yes')
  assert.equal(wrap.ly, ys[0], 'its label sits on that line')
})

test('arrows into the same box enter it at their own points, at least 14 px apart', () => {
  const g = { nodes: ['a', 'b', 'c'].map(id => ({ id, label: id.toUpperCase() })), edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }] }
  for (const dir of ['LR', 'TB']) {
    const lay = D.layout(g, { dir, maxWidth: 1400 })
    const ends = lay.edges.map(e => (dir === 'LR' ? e.y2 : e.x2))
    assert.ok(Math.abs(ends[0] - ends[1]) >= 14, `${dir}: ${ends}`)
  }
})

test('the agent diagram stays left to right on one row while its tight form fits (760 px): long arrow labels end with … and keep the whole label in a tooltip', () => {
  const lay = D.layout(DARK, { dir: 'auto', maxWidth: 760 })
  assert.equal(lay.dir, 'LR')
  assert.ok(new Set(lay.nodes.map(n => n.y + n.h / 2)).size <= 2, 'one band: the layers side by side')
  assert.ok(lay.width <= 760, `${lay.width}`)
  const svg = D.svg(DARK, { dir: 'auto', maxWidth: 760 })
  for (const m of svg.matchAll(/<g class="dg-elabel">(<title>([^<]*)<\/title>)?<rect[^>]*\/><text[^>]*>([^<]*)<\/text>/g)) {
    if (m[3].endsWith('…')) assert.ok(m[2] && m[2].startsWith(m[3].slice(0, -1)), `${m[3]} keeps ${m[2]}`)
  }
})

test('line returns are only for a simple chain: a branching graph too narrow for one row is drawn top to bottom', () => {
  const lay = D.layout(DARK, { dir: 'auto', maxWidth: 520 })
  assert.equal(lay.dir, 'TB')
  for (const e of lay.edges) assert.doesNotMatch(e.d, /Q/, `${e.from}>${e.to} is no line return`)
  const chainLay = D.layout(P.graph(nv()), { dir: 'auto', maxWidth: 1100 })
  assert.equal(chainLay.dir, 'LR', 'the summary chart is a chain: it wraps with line returns')
  assert.ok(chainLay.edges.some(e => /Q/.test(e.d)))
})

/** Two axis-aligned pieces lying on one line and overlapping by more than a pixel. */
function shared([a1, a2], [b1, b2]) {
  if (a1.y === a2.y && b1.y === b2.y && Math.abs(a1.y - b1.y) < 0.5) {
    return Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x)) - Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x)) > 1
  }
  if (a1.x === a2.x && b1.x === b2.x && Math.abs(a1.x - b1.x) < 0.5) {
    return Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y)) - Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y)) > 1
  }
  return false
}

/** Is the point inside the shape itself (a diamond is a diamond, not its box), more than a pixel in? */
function inside(n, kind, x, y) {
  if (kind === 'decision') return Math.abs(x - (n.x + n.w / 2)) / (n.w / 2) + Math.abs(y - (n.y + n.h / 2)) / (n.h / 2) < 0.97
  return x > n.x + 1 && x < n.x + n.w - 1 && y > n.y + 1 && y < n.y + n.h - 1
}
/** Does a straight piece pass through the inside of a shape (sampled every 2 px)? */
const throughShape = ([a, b], n, kind) => {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  for (let t = 0; t <= len; t += 2) {
    const k = len ? t / len : 0
    if (inside(n, kind, a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k)) return true
  }
  return false
}

test('the dark-mode diagram at 1200, 760 and 520 px: no two arrows share a piece of line, and no arrow crosses a box', () => {
  const kind = id => DARK.nodes.find(n => n.id === id).kind
  for (const width of [1200, 760, 520]) {
    const lay = D.layout(DARK, { dir: 'auto', maxWidth: width })
    const pieces = lay.edges.map(e => ({ e, segs: segments(e.d) }))
    for (const { e, segs } of pieces) {
      for (const seg of segs) for (const n of lay.nodes) assert.ok(!throughShape(seg, n, kind(n.id)), `${width}: ${e.from}>${e.to} crosses ${n.id}`)
    }
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        for (const s of pieces[i].segs) for (const t of pieces[j].segs) {
          assert.ok(!shared(s, t), `${width}: ${pieces[i].e.from}>${pieces[i].e.to} and ${pieces[j].e.from}>${pieces[j].e.to} share a line`)
        }
      }
    }
  }
})

test('top to bottom (520 and 600 px, the half of a before and after): no arrow runs behind another arrow label', () => {
  for (const width of [520, 600]) {
    const lay = D.layout(DARK, { dir: 'auto', maxWidth: width })
    assert.equal(lay.dir, 'TB')
    for (const e of lay.edges) {
      if (!e.label) continue
      // the label pill: about 6.5 px a character at its 12 px type, 18 px high
      const half = Math.min(e.lw / 2, (e.label.length * 6.5) / 2 + 6)
      const box = { x: e.lx - half, y: e.ly - 9, w: 2 * half, h: 18 }
      for (const o of lay.edges) {
        if (o === e) continue
        for (const s of segments(o.d)) {
          assert.ok(!crosses(s, box), `${width}: ${o.from}>${o.to} runs behind the label of ${e.from}>${e.to}`)
        }
      }
    }
  }
})

test('a two-line label is balanced: never a long first line over one lone word', () => {
  for (const label of ['Read how the nightly report job…', 'Turn on the new schedule in dev']) {
    const svg = D.svg({ nodes: [{ id: 'a', label }, { id: 'b', label: 'Run both schedulers side by side…', kind: 'decision' }], edges: [{ from: 'a', to: 'b' }] }, { maxWidth: 1300 })
    const [{ lines }] = drawnLabels(svg)
    assert.equal(lines.length, 2, label)
    assert.ok(lines[1].split(' ').length >= 2, `${label}: ${JSON.stringify(lines)}`)
  }
})

test('a label that already ends with … (a cut title) still gets the narrowest box it fits', () => {
  const lay = D.layout({ nodes: [{ id: 'a', label: 'Read how the nightly report job…' }], edges: [] }, { maxWidth: 1300 })
  assert.ok(lay.nodes[0].w < 232, `${lay.nodes[0].w}`)
})

test('every arrow stays inside the drawing, a fanned line return included', () => {
  const g = {
    nodes: [{ id: 'u', label: 'User', kind: 'actor' }, { id: 'q', label: 'System prefers dark?', kind: 'decision' }, { id: 'p', label: 'Settings page' },
      { id: 's', label: 'Browser storage', kind: 'store' }, { id: 't', label: 'Theme tokens' }],
    edges: [{ from: 'u', to: 'p' }, { from: 'p', to: 's' }, { from: 'p', to: 't' }, { from: 'q', to: 't' }],
  }
  const lay = D.layout(g, { dir: 'auto', maxWidth: 520 })
  for (const e of lay.edges) {
    for (const [a, b] of segments(e.d)) {
      for (const p of [a, b]) assert.ok(p.x >= lay.minX + 1 && p.x <= lay.minX + lay.width - 1, `${e.from}>${e.to} x ${p.x}`)
    }
  }
})
