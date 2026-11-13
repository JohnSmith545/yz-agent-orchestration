// The arrows of an Output chart (diagram.js lays out the boxes first). Every
// arrow gets a path of its OWN: no two arrows ever share a piece of line, and
// no arrow runs through a box.
//
//   plan(edges, at, dir, S)    the work each arrow needs: its exit and entry points and the gaps it runs in
//   need(plan, S)              { gx, gy }: the gap sizes its lanes need (diagram.js widens the grid to them)
//   paths(plan, at, dir, S)    [{ d, x2, y2, lx, ly, lw }] in edge order
//
// ═══ OWN POINTS, OWN LANES ═══
// - Each box spreads the arrows leaving it along its exit side, and the arrows
//   entering it along its entry side, 14 px apart (a diamond's slope is followed).
// - An arrow that can go straight (the same height, nothing in between) does;
//   top to bottom, its label takes a lane in the gap like a bending arrow does.
// - An arrow to the next column (left to right) or the next row (top to bottom)
//   bends once, in the gap between them, on a lane of its own (14 px apart).
// - A longer arrow runs out into the gap beside its source, along the gap
//   before its target's row (lanes 18 px apart, so each label has its own line),
//   and down the gap beside its target, each on its own lane.
// - A line return (a chain wrapped into the next row, left to right only) is one
//   rounded line through the gap between the rows (diagram.js keeps line returns
//   for simple chains: a branching graph too wide for one row is drawn top to bottom).
;(() => {
  const STEP = 14 // between two arrows on one box side, or two vertical lanes in a gap
  const H_STEP = 18 // between two horizontal lanes: a label (18 px high) fits each
  const EDGE = 16 // room a gap keeps beside its boxes, outside its lanes
  const R = 10 // the corner of a line return

  const spread = (i, k, len) => (k <= 1 ? 0 : (i - (k - 1) / 2) * Math.min(STEP, (len - 16) / (k - 1)))
  /** Where a point `off` px from the middle meets a box side: a diamond's side slopes away from its tip. */
  const slope = (b, off, along) => (b.kind === 'decision' ? Math.abs(off) * (along === 'x' ? b.w / b.h : b.h / b.w) : 0)
  /** Does the straight piece from p to q pass through any box but a and b? */
  const blocked = (boxes, a, b, p, q) => boxes.some(n => n !== a && n !== b &&
    Math.max(p.x, q.x) > n.x + 0.5 && Math.min(p.x, q.x) < n.x + n.w - 0.5 && Math.max(p.y, q.y) > n.y + 0.5 && Math.min(p.y, q.y) < n.y + n.h - 0.5)

  function plan(edges, at, dir) {
    const lr = dir === 'LR'
    const outs = new Map()
    const ins = new Map()
    for (const e of edges) {
      ;(outs.get(e.from) || outs.set(e.from, []).get(e.from)).push(e)
      ;(ins.get(e.to) || ins.set(e.to, []).get(e.to)).push(e)
    }
    // along each side, in the order of the boxes at the other end, so arrows do not cross at the box
    const along = b => (lr ? b.y * 1e4 + b.x : b.x * 1e4 + b.y)
    for (const list of outs.values()) list.sort((p, q) => along(at.get(p.to)) - along(at.get(q.to)))
    for (const list of ins.values()) list.sort((p, q) => along(at.get(p.from)) - along(at.get(q.from)))
    const boxes = [...at.values()]
    return edges.map(e => {
      const a = at.get(e.from)
      const b = at.get(e.to)
      const o = outs.get(e.from)
      const i = ins.get(e.to)
      let oo = spread(o.indexOf(e), o.length, lr ? a.h : a.w)
      let oi = spread(i.indexOf(e), i.length, lr ? b.h : b.w)
      // in the same row (column), a side with one arrow lines up with the other end, so the arrow goes straight
      const level = lr ? a.cy === b.cy && b.cx > a.cx : a.cx === b.cx && b.cy > a.cy
      if (level && i.length === 1) oi = oo
      else if (level && o.length === 1) oo = oi
      const p = lr ? { x: a.x + a.w - slope(a, oo, 'x'), y: a.y + a.h / 2 + oo } : { x: a.x + a.w / 2 + oo, y: a.y + a.h - slope(a, oo, 'y') }
      const q = lr ? { x: b.x + slope(b, oi, 'x'), y: b.y + b.h / 2 + oi } : { x: b.x + b.w / 2 + oi, y: b.y + slope(b, oi, 'y') }
      const step = { e, a, b, p, q }
      if (lr && b.band > a.band) return { ...step, kind: 'wrap' }
      if (level && Math.abs(lr ? p.y - q.y : p.x - q.x) < 0.5 && !blocked(boxes, a, b, p, q)) {
        // top to bottom, its label sits in the gap below the source: it takes a lane there, so an
        // elbow through the same gap runs on a line of its own and never behind the label
        return { ...step, kind: 'straight', ...(!lr && b.row === a.row + 1 ? { gaps: [`h${a.row}`] } : {}) }
      }
      const next = lr ? b.band === a.band && b.col === a.col + 1 : b.row === a.row + 1
      if (next) return { ...step, kind: 'elbow', gaps: [lr ? `v${a.band}:${a.col}` : `h${a.row}`] }
      return { ...step, kind: 'long', gaps: lr ? [`v${a.band}:${a.col}`, `h${b.band}:${b.row - 1}`, `v${b.band}:${b.col - 1}`] : [`h${a.row}`, `v${b.col - 1}`, `h${b.row - 1}`] }
    })
  }

  /** Each gap's arrows, in order; the lane of an arrow in a gap is its place in that list. */
  function lanes(steps) {
    const users = new Map()
    for (const s of steps) for (const g of s.gaps || []) (users.get(g) || users.set(g, []).get(g)).push(s)
    return users
  }

  function need(steps, S) {
    let gx = S.gx
    let gy = S.gy
    for (const [g, list] of lanes(steps)) {
      if (g[0] === 'v') gx = Math.max(gx, (list.length - 1) * STEP + 2 * EDGE)
      else gy = Math.max(gy, (list.length - 1) * H_STEP + 2 * EDGE)
    }
    return { gx, gy }
  }

  function paths(steps, dir, S) {
    const lr = dir === 'LR'
    const users = lanes(steps)
    // a gap's middle, from the first box that names it (the right or bottom of a source, the left or top of a target)
    const centre = (g, s, which) => {
      const box = which === 'source' ? s.a : s.b
      if (g[0] === 'v') return which === 'source' ? box.cx + S.w + S.gx / 2 : box.cx - S.gx / 2
      return which === 'source' ? box.cy + S.h + S.gy / 2 : box.cy - S.gy / 2
    }
    const lane = (g, s, which) => {
      const list = users.get(g)
      return centre(g, s, which) + (list.indexOf(s) - (list.length - 1) / 2) * (g[0] === 'v' ? STEP : H_STEP)
    }
    return steps.map(s => {
      const { p, q } = s
      const end = { x2: q.x, y2: q.y }
      if (s.kind === 'straight') {
        return lr ? { d: `M${p.x} ${p.y} H${q.x}`, ...end, lx: (p.x + q.x) / 2, ly: p.y - 14, lw: Math.max(S.gx, q.x - p.x) - 12 }
          : { d: `M${p.x} ${p.y} V${q.y}`, ...end, lx: p.x, ly: s.gaps ? lane(s.gaps[0], s, 'source') : (p.y + q.y) / 2, lw: S.w + S.gx - 12 }
      }
      if (s.kind === 'wrap') {
        const r = s.a.cx + S.w + S.gx / 2
        const l = s.b.cx - S.gx / 2
        const y = s.b.bandTop - S.gy // the middle of the gap between the two rows
        const d = `M${p.x} ${p.y} H${r - R} Q${r} ${p.y} ${r} ${p.y + R} V${y - R} Q${r} ${y} ${r - R} ${y} ` +
          `H${l + R} Q${l} ${y} ${l} ${y + R} V${q.y - R} Q${l} ${q.y} ${l + R} ${q.y} H${q.x}`
        return { d, ...end, lx: (l + r) / 2, ly: y, lw: S.w }
      }
      if (s.kind === 'elbow') {
        const c = lane(s.gaps[0], s, 'source')
        return lr ? { d: `M${p.x} ${p.y} H${c} V${q.y} H${q.x}`, ...end, lx: centre(s.gaps[0], s, 'source'), ly: (p.y + q.y) / 2, lw: S.gx - 12 }
          : { d: `M${p.x} ${p.y} V${c} H${q.x} V${q.y}`, ...end, lx: (p.x + q.x) / 2, ly: c, lw: Math.max(S.w, Math.abs(q.x - p.x)) - 12 }
      }
      const [g1, g2, g3] = s.gaps
      const c1 = lane(g1, s, 'source')
      const c2 = lane(g2, s, 'target')
      const c3 = lane(g3, s, 'target')
      return lr ? { d: `M${p.x} ${p.y} H${c1} V${c2} H${c3} V${q.y} H${q.x}`, ...end, lx: (c1 + c3) / 2, ly: c2, lw: Math.max(S.gx, Math.abs(c3 - c1)) - 12 }
        : { d: `M${p.x} ${p.y} V${c1} H${c2} V${c3} H${q.x} V${q.y}`, ...end, lx: (c2 + q.x) / 2, ly: c3, lw: Math.max(S.w, Math.abs(q.x - c2)) - 12 }
    })
  }

  window.DiagramRoute = { plan, need, paths }
})()
