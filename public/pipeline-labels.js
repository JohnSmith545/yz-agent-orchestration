// The Agents page diagram's labels, put in the clear (pipeline-layout.js lays out the boxes and the arrows, then
// hands its labels here). Split out of pipeline-layout.js along this seam: placing a label touches nothing else.
//
//   PipelineLabels.clear(labels, paths, boxes, width, height, lr)   moves each label, in place, to a free spot
//   PipelineLabels.pathPoints(d) / textBox(l, x, y, pad)             the geometry it works with
//
// ═══ LABELS IN THE CLEAR ═══ No arrow, arrowhead or dashed line may touch or run under a label's text, and it may
// not sit on a box, an agent's pill or another label (QA 2026-11-25: Security's return arrow and the skip lines ran
// into the producers' `failed`). QA's returns keep a label beside each producer while those spots are free; when the
// gap is too full they share ONE label beside QA, where they leave it. The text is measured as pipeline.css draws it
// (11 px, LABEL_CHAR a character): MUST CHANGE IN LOCKSTEP with test/diagram-geometry.mjs, which checks it.
// Pure: no DOM, so the layout tests run it in a vm (load it before pipeline-layout.js).
;(() => {
  const LABEL_CHAR = 6.3 // an 11 px label's width per character
  const LABEL_UP = 9 // above its baseline
  const LABEL_DOWN = 3 // below it
  const LABEL_PAD = 3 // the clear room kept round its text
  const CELL = 2 // the grid the drawn lines are noted on
  const r1 = v => Math.round(v * 10) / 10

  /** Points every 2 px or so along a path this file wrote (M, L, Q, C and Z only). */
  function pathPoints(d) {
    const out = []
    const tok = String(d).match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) || []
    let cur = [0, 0]
    let start = cur
    let i = 0
    const num = () => Number(tok[i++])
    const run = (f, len) => {
      const n = Math.max(2, Math.ceil(len / 2))
      for (let k = 0; k <= n; k++) out.push(f(k / n))
    }
    const len = (...ps) => ps.slice(1).reduce((s, p, k) => s + Math.hypot(p[0] - ps[k][0], p[1] - ps[k][1]), 0)
    while (i < tok.length) {
      const cmd = tok[i++]
      const a = cur
      if (cmd === 'M') {
        cur = start = [num(), num()]
        out.push(cur)
      } else if (cmd === 'L' || cmd === 'Z') {
        const p = cmd === 'Z' ? start : [num(), num()]
        run(t => [a[0] + (p[0] - a[0]) * t, a[1] + (p[1] - a[1]) * t], len(a, p))
        cur = p
      } else if (cmd === 'Q') {
        const c = [num(), num()]
        const p = [num(), num()]
        run(t => [0, 1].map(k => (1 - t) ** 2 * a[k] + 2 * (1 - t) * t * c[k] + t ** 2 * p[k]), len(a, c, p))
        cur = p
      } else if (cmd === 'C') {
        const c1 = [num(), num()]
        const c2 = [num(), num()]
        const p = [num(), num()]
        run(t => [0, 1].map(k => (1 - t) ** 3 * a[k] + 3 * (1 - t) ** 2 * t * c1[k] + 3 * (1 - t) * t ** 2 * c2[k] + t ** 3 * p[k]), len(a, c1, c2, p))
        cur = p
      }
    }
    return out
  }

  /** [x1, y1, x2, y2] of a label's text at (x, y), grown by `pad`; a rotate(-90) label stands up from its point. */
  function textBox(l, x, y, pad = LABEL_PAD) {
    const w = l.text.length * LABEL_CHAR
    const from = l.anchor === 'middle' ? -w / 2 : l.anchor === 'end' ? -w : 0
    if (l.rotate === -90) return [x - LABEL_UP - pad, y - from - w - pad, x + LABEL_DOWN + pad, y - from + pad]
    return [x + from - pad, y - LABEL_UP - pad, x + from + w + pad, y + LABEL_DOWN + pad]
  }
  const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

  /**
   * Put every label where nothing touches it, BY ITS OWN ARROW. Free is: no drawn line or arrowhead touches its text,
   * and it sits on no box, no agent's pill (agent-window.css: the bottom edge centred left to right, the top right
   * corner top to bottom) and no label placed before it, inside the canvas. By its own arrow is: no other arrow is
   * nearer to its text than its own (QA 2026-11-25 B-8: `reviewed` sat over the chat lane, `done by hand` far above
   * its arrow, QA's `failed` under the Human task box). A label already free and by its own arrow stays where it was.
   *   - QA's return labels (`src`) stay beside each producer while each one is free there or a step or two away;
   *     when one is not (the gap is full of lines: Security's bus, the skips), QA's returns share ONE label instead,
   *     beside QA where they leave it, or wherever nearest that is by one of them.
   *   - Every other label, and that shared one, moves to the nearest spot that is free and by its own arrow, in rings
   *     of 3 px up to 90 px out; failing that, the nearest free spot up to 60 px out (as before); failing both it stays.
   * `edges` are the layout's drawn edges, { i, d, head }: a label's `edges` name its own by `i`.
   */
  function clearLabels(labels, edges, boxes, width, height, lr) {
    const lines = new Set()
    const HASH = 16 // the grid the points are kept on for the nearest-arrow search
    const points = new Map() // `${hx},${hy}` -> [[x, y, edge i]]
    for (const e of edges) {
      for (const d of [e.d, e.head]) {
        for (const [x, y] of pathPoints(d)) {
          lines.add(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`)
          const key = `${Math.floor(x / HASH)},${Math.floor(y / HASH)}`
          ;(points.get(key) || points.set(key, []).get(key)).push([x, y, e.i])
        }
      }
    }
    const taken = boxes.map(b => [b.x, b.y, b.x + b.w, b.y + b.h])
    for (const b of boxes.filter(x => x.agent)) {
      const mid = b.x + b.w / 2
      taken.push(lr ? [mid - 40, b.y + b.h - 10, mid + 40, b.y + b.h + 11] : [b.x + b.w - 16, b.y - 11, b.x + b.w + 8, b.y + 11])
    }
    const byId = new Map(boxes.map(b => [b.id, b]))
    const free = (l, x, y) => {
      const r = textBox(l, x, y)
      if (r[0] < 0 || r[1] < 0 || r[2] > width || r[3] > height) return false
      if (taken.some(t => overlaps(r, t))) return false
      for (let cx = Math.floor(r[0] / CELL); cx <= Math.floor(r[2] / CELL); cx++) {
        for (let cy = Math.floor(r[1] / CELL); cy <= Math.floor(r[3] / CELL); cy++) if (lines.has(`${cx},${cy}`)) return false
      }
      return true
    }
    const REACH = 64 // how far round its text a label looks for arrows
    /** Its own arrow is nearer to its text than any other (within REACH; its own must be there). */
    const byOwn = (l, x, y) => {
      const r = textBox(l, x, y, 0)
      let own = Infinity
      let other = Infinity
      for (let hx = Math.floor((r[0] - REACH) / HASH); hx <= Math.floor((r[2] + REACH) / HASH); hx++) {
        for (let hy = Math.floor((r[1] - REACH) / HASH); hy <= Math.floor((r[3] + REACH) / HASH); hy++) {
          for (const [px, py, i] of points.get(`${hx},${hy}`) || []) {
            const d = Math.hypot(Math.max(r[0] - px, 0, px - r[2]), Math.max(r[1] - py, 0, py - r[3]))
            if (l.edges.includes(i)) own = Math.min(own, d)
            else other = Math.min(other, d)
          }
        }
      }
      return own <= REACH && own < other
    }
    /** The nearest spot within `rings` rings that is free (and by its own arrow when `own`), or null. */
    const near = (l, rings, own = false) => {
      const ok = (x, y) => free(l, x, y) && (!own || byOwn(l, x, y))
      if (ok(l.x, l.y)) return [l.x, l.y]
      for (let ring = 1; ring <= rings; ring++) {
        const r = ring * 3
        const spot = [[0, -r], [0, r], [r, 0], [-r, 0], [r, -r], [-r, -r], [r, r], [-r, r], [2 * r, 0], [-2 * r, 0]].map(([dx, dy]) => [l.x + dx, l.y + dy]).find(([x, y]) => ok(x, y))
        if (spot) return spot
      }
      return null
    }
    /** By its own arrow if it can be, else merely free, as before. */
    const best = (l, rings = 20) => near(l, 30, true) || near(l, rings)
    const settle = (l, spot) => {
      if (spot) [l.x, l.y] = spot.map(r1)
      taken.push(textBox(l, l.x, l.y, 0))
    }
    // QA's returns first: beside each producer when every one of them is free there, else one label by QA
    const groups = new Map()
    for (const l of labels) if (l.src) (groups.get(l.src) || groups.set(l.src, []).get(l.src)).push(l)
    for (const [src, list] of groups) {
      const spots = list.map(l => near(l, 3, true))
      const clash = (a, b) => overlaps(textBox(a.l, ...a.s), textBox(b.l, ...b.s))
      const placed = list.map((l, i) => ({ l, s: spots[i] }))
      if (spots.every(Boolean) && !placed.some((a, i) => placed.slice(i + 1).some(b => clash(a, b)))) {
        placed.forEach(({ l, s }) => settle(l, s))
        continue
      }
      const box = byId.get(src)
      const one = list[0]
      one.edges = list.flatMap(l => l.edges)
      // beside QA where its returns leave it: the first of these spots that is free and by a return (top to bottom,
      // the box left of QA may be the Human task box, so its right side and the gap under it are tried too)
      const sides = lr
        ? [{ x: box.x + 2, y: box.y - 5, anchor: 'start' }, { x: box.x + 2, y: box.y + box.h + 13, anchor: 'start' }]
        : [{ x: box.x - 6, y: box.y + 14, anchor: 'end' }, { x: box.x + box.w + 6, y: box.y + 28, anchor: 'start' }, { x: box.x + 2, y: box.y - 5, anchor: 'start' },
          { x: box.x + box.w - 2, y: box.y - 5, anchor: 'end' }, { x: box.x + 2, y: box.y + box.h + 13, anchor: 'start' }]
      // each spot as it is, or a step or two away from it; then by a return anywhere near the producers' own spots
      const tried = sides.map(s => ({ s, at: near({ ...one, ...s }, 3, true) }))
      let pick = tried.find(t => t.at)
      if (!pick) {
        for (const l of list) {
          const at = near({ ...one, x: l.x, y: l.y, anchor: l.anchor }, 30, true)
          if (at) {
            pick = { s: { x: l.x, y: l.y, anchor: l.anchor }, at }
            break
          }
        }
      }
      if (!pick) {
        const s = sides.find(x => near({ ...one, ...x }, 3)) || sides[0]
        pick = { s, at: near({ ...one, ...s }, 3) }
      }
      Object.assign(one, { x: r1(pick.s.x), y: r1(pick.s.y), anchor: pick.s.anchor })
      for (const l of list.slice(1)) labels.splice(labels.indexOf(l), 1)
      settle(one, pick.at || near(one, 20))
    }
    for (const l of labels) {
      if (l.src) {
        delete l.src
        continue
      }
      settle(l, best(l))
    }
  }

  window.PipelineLabels = { clear: clearLabels, pathPoints, textBox }
})()
