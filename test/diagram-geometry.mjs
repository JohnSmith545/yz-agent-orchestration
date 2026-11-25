// Geometry helpers for the Agents diagram tests (not a test file itself): the box a label's text takes, and the points
// along an SVG path the layout draws (pipeline-layout.js writes only M, L, Q, C and Z), so a test can check that no
// arrow, arrowhead or dashed line touches a label.

/** The text of an 11 px label (pipeline.css .pl-elabel): about 6.3 px a character, 9 px above the baseline, 3 below. */
const CHAR = 6.3
const ASCENT = 9
const DESCENT = 3

/** [x1, y1, x2, y2] of a layout label `{ text, x, y, anchor, rotate }`, grown by `pad` on every side. */
export function labelBox(l, pad = 2) {
  const w = String(l.text).length * CHAR
  const from = l.anchor === 'middle' ? -w / 2 : l.anchor === 'end' ? -w : 0
  if (l.rotate === -90) {
    // rotate(-90 x y): a point (x + dx, y + dy) is drawn at (x + dy, y - dx)
    return [l.x - ASCENT - pad, l.y - from - w - pad, l.x + DESCENT + pad, l.y - from + pad]
  }
  return [l.x + from - pad, l.y - ASCENT - pad, l.x + from + w + pad, l.y + DESCENT + pad]
}

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1])
function sample(f, len, out) {
  const n = Math.max(2, Math.ceil(len))
  for (let i = 0; i <= n; i++) out.push(f(i / n))
}

/** Points every pixel or so along path `d`. */
export function pathPoints(d) {
  const out = []
  const tokens = String(d).match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) || []
  let cur = null
  let start = null
  let i = 0
  const num = () => Number(tokens[i++])
  while (i < tokens.length) {
    const cmd = tokens[i++]
    if (cmd === 'M') {
      cur = [num(), num()]
      start = cur
      out.push(cur)
    } else if (cmd === 'L' || cmd === 'Z') {
      const p = cmd === 'Z' ? start : [num(), num()]
      const a = cur
      sample(t => [a[0] + (p[0] - a[0]) * t, a[1] + (p[1] - a[1]) * t], dist(a, p), out)
      cur = p
    } else if (cmd === 'Q') {
      const c = [num(), num()]
      const p = [num(), num()]
      const a = cur
      sample(t => [0, 1].map(k => (1 - t) ** 2 * a[k] + 2 * (1 - t) * t * c[k] + t ** 2 * p[k]), dist(a, c) + dist(c, p), out)
      cur = p
    } else if (cmd === 'C') {
      const c1 = [num(), num()]
      const c2 = [num(), num()]
      const p = [num(), num()]
      const a = cur
      sample(t => [0, 1].map(k => (1 - t) ** 3 * a[k] + 3 * (1 - t) ** 2 * t * c1[k] + 3 * (1 - t) * t ** 2 * c2[k] + t ** 3 * p[k]), dist(a, c1) + dist(c1, c2) + dist(c2, p), out)
      cur = p
    }
  }
  return out
}

/** Each label of layout `lay` that a drawn edge or arrowhead touches: [{ text, edges: ['from>to'] }]. */
export function touchedLabels(lay) {
  const lines = lay.edges.map(e => ({ id: `${e.from}>${e.to}`, pts: [...pathPoints(e.d), ...pathPoints(e.head)] }))
  const out = []
  for (const l of lay.labels) {
    const [x1, y1, x2, y2] = labelBox(l)
    const hits = lines.filter(e => e.pts.some(([x, y]) => x >= x1 && x <= x2 && y >= y1 && y <= y2)).map(e => e.id)
    if (hits.length) out.push({ text: l.text, x: l.x, y: l.y, edges: hits })
  }
  return out
}

/** The distance from a point to the rectangle [x1, y1, x2, y2] (0 inside it). */
const toBox = ([x, y], [x1, y1, x2, y2]) => Math.hypot(Math.max(x1 - x, 0, x - x2), Math.max(y1 - y, 0, y - y2))

/**
 * Each label of `lay` that sits nearer to another arrow than to its own (QA 2026-11-25 B-8: `reviewed` above another
 * lane, `done by hand` far above its arrow): [{ text, own, other, by }], `own` and `other` the distances in px from the
 * label's text box to its own arrows and to the nearest other one, `by` that other arrow.
 */
export function strayLabels(lay) {
  const lines = lay.edges.map(e => ({ i: e.i, id: `${e.from}>${e.to}`, pts: [...pathPoints(e.d), ...pathPoints(e.head)] }))
  const out = []
  for (const l of lay.labels) {
    const box = labelBox(l, 0)
    const dist = e => Math.min(...e.pts.map(p => toBox(p, box)))
    const own = Math.min(...lines.filter(e => l.edges.includes(e.i)).map(dist))
    const others = lines.filter(e => !l.edges.includes(e.i)).map(e => ({ id: e.id, d: dist(e) })).sort((a, b) => a.d - b.d)
    if (others.length && others[0].d < own) out.push({ text: l.text, own: Math.round(own), other: Math.round(others[0].d), by: others[0].id })
  }
  return out
}
