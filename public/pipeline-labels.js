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
   * Put every label where nothing touches it. Free is: no drawn line or arrowhead touches its text, and it sits on no
   * box, no agent's pill (agent-window.css: the bottom edge centred left to right, the top right corner top to
   * bottom) and no label placed before it, inside the canvas. A label already free stays exactly where it was.
   *   - QA's return labels (`src`) stay beside each producer while each one is free there or a step or two away;
   *     when one is not (the gap is full of lines: Security's bus, the skips), QA's returns share ONE label instead,
   *     beside QA where they leave it: over its top left corner left to right, left of it top to bottom.
   *   - Every other label, and that shared one, moves to the nearest free spot, in rings of 3 px up to 60 px out;
   *     one with no free spot nearby stays where it was.
   */
  function clearLabels(labels, paths, boxes, width, height, lr) {
    const lines = new Set()
    for (const d of paths) for (const [x, y] of pathPoints(d)) lines.add(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`)
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
    /** The nearest free spot within `rings` rings, or null. */
    const near = (l, rings) => {
      if (free(l, l.x, l.y)) return [l.x, l.y]
      for (let ring = 1; ring <= rings; ring++) {
        const r = ring * 3
        const spot = [[0, -r], [0, r], [r, 0], [-r, 0], [r, -r], [-r, -r], [r, r], [-r, r]].map(([dx, dy]) => [l.x + dx, l.y + dy]).find(([x, y]) => free(l, x, y))
        if (spot) return spot
      }
      return null
    }
    const settle = (l, spot) => {
      if (spot) [l.x, l.y] = spot.map(r1)
      taken.push(textBox(l, l.x, l.y, 0))
    }
    // QA's returns first: beside each producer when every one of them is free there, else one label by QA
    const groups = new Map()
    for (const l of labels) if (l.src) (groups.get(l.src) || groups.set(l.src, []).get(l.src)).push(l)
    for (const [src, list] of groups) {
      const spots = list.map(l => near(l, 3))
      const clash = (a, b) => overlaps(textBox(a.l, ...a.s), textBox(b.l, ...b.s))
      const placed = list.map((l, i) => ({ l, s: spots[i] }))
      if (spots.every(Boolean) && !placed.some((a, i) => placed.slice(i + 1).some(b => clash(a, b)))) {
        placed.forEach(({ l, s }) => settle(l, s))
        continue
      }
      const box = byId.get(src)
      const one = list[0]
      one.edges = list.flatMap(l => l.edges)
      // beside QA where its returns leave it: the first of these spots that is free (top to bottom, the box left of
      // QA may be the Human task box, so its right side and the gap under it are tried too), else the nearest free
      const sides = lr
        ? [{ x: box.x + 2, y: box.y - 5, anchor: 'start' }, { x: box.x + 2, y: box.y + box.h + 13, anchor: 'start' }]
        : [{ x: box.x - 6, y: box.y + 14, anchor: 'end' }, { x: box.x + box.w + 6, y: box.y + 28, anchor: 'start' }, { x: box.x + 2, y: box.y + box.h + 13, anchor: 'start' }]
      const pick = sides.find(s => free({ ...one, ...s }, s.x, s.y)) || sides[0]
      Object.assign(one, { x: r1(pick.x), y: r1(pick.y), anchor: pick.anchor })
      for (const l of list.slice(1)) labels.splice(labels.indexOf(l), 1)
      settle(one, near(one, 20))
    }
    for (const l of labels) {
      if (l.src) {
        delete l.src
        continue
      }
      settle(l, near(l, 20))
    }
  }

  window.PipelineLabels = { clear: clearLabels, pathPoints, textBox }
})()
