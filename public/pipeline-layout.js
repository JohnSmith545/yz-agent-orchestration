// The Agents page diagram (#/agents), laid out from /api/pipeline's `graph` and nothing else: no node, edge
// or count is written here, so a config with no producers, one, or five draws just as well.
//
//   ranks(graph)                  { id: layer }: the longest path from a node nothing points at, over every
//                                 edge but `rework` (QA sending work back is the only way backwards)
//   layout(graph, { width, rows }) { dir, width, height, nodes: [{ id, x, y, w, h, layer }],
//                                 edges: [{ from, to, kind, label, d, head }], labels: [{ text, x, y, rotate,
//                                 anchor, edges }] }; `rows` is how many ticket chips the boxes must hold
//
// ═══ HOW IT IS LAID OUT ═══ Everything is worked out on two axes, MAIN (the way work flows) and CROSS
// (across it), then turned into x and y: left to right (LR, main = x) when every layer gets a column at
// least WMIN wide, else top to bottom (TB, main = y). One layer per column (row), its boxes stacked across
// and centred. Arrows:
//   - to the next layer (main and branch edges): one smooth curve through the gap between the two layers;
//   - back to the layer before (rework): a return curve beside the forward one, labelled near the producer;
//   - anything longer (skip edges, the coordinator's own changes): out into the gap beside its source,
//     along a corridor outside all the boxes (skips on one side, the rest on the other), and in through the
//     gap before its target, each on a lane of its own. Arrows sharing a label and a target (every
//     `no code changes`) carry that label once, on the outermost lane; so do return arrows sharing a label and
//     a SOURCE (Security's `failed` back to every producer, pipeline.mjs), which also share ONE corridor lane, a
//     bus that splits only in the gap before each producer, so a phone has room for them.
// Every box spreads the arrows on each side along that side, ordered by where their other end is, so no
// two arrow heads share a point. Pure: no DOM, so test/pipeline-layout.test.mjs runs it in a vm.
//
// ═══ LABELS IN THE CLEAR ═══ Last, every label is moved, if it must, to a free spot (clearLabels): no arrow,
// arrowhead or dashed line may touch or run under its text, and it may not sit on a box, an agent's pill or another
// label (QA 2026-11-25: Security's return arrow and the skip lines ran into the producers' `failed`). QA's returns
// keep a label beside each producer while those spots are free; when the gap is too full they share ONE label beside
// QA, where they leave it. Security's returns end in the same arrowhead as QA's return to that producer (one arrival
// each). Only labels move: the boxes and the arrows of a graph without Security stay exactly where they were. The
// text is measured as pipeline.css draws it (11 px, LABEL_CHAR a character): MUST CHANGE IN LOCKSTEP with
// test/diagram-geometry.mjs, which checks it.
;(() => {
  const LR = { pad: 12, wMin: 100, wMax: 200, gMin: 44, gPref: 64, gMax: 120, gc: 24 }
  const TB = { pad: 8, wMin: 72, wMax: 220, roomy: 160, gm: 56, gc: 14, busRoom: 20 }
  const HEAD_H = 36 // a box's name line
  const CHIP_H = 24 // one ticket chip
  const MIN_H = 48
  const LANE = 8 // between two arrows in a gap or a corridor
  const CORR_OFF = { LR: 18, TB: 12 } // from the boxes to the first corridor lane (tighter top to bottom: a phone)
  const LABEL_ROOM = 16 // beyond the outermost lane, for its label
  const PORT = 10 // between two arrows on one side of a box
  const ARROW = 7 // an arrow head's length
  const R = 6 // a corridor arrow's rounded corner

  const LABEL_CHAR = 6.3 // an 11 px label's width per character
  const LABEL_UP = 9 // above its baseline
  const LABEL_DOWN = 3 // below it
  const LABEL_PAD = 3 // the clear room kept round its text
  const CELL = 2 // the grid the drawn lines are noted on

  const nodeHeight = rows => Math.max(MIN_H, HEAD_H + Math.max(0, rows | 0) * CHIP_H + (rows > 0 ? 6 : 0))

  /** The nodes with unique ids, and the edges whose ends both exist (no self loops), with their index in the graph. */
  function clean(graph) {
    const nodes = []
    const ids = new Set()
    for (const n of graph?.nodes || []) {
      const id = String(n?.id ?? '')
      if (!id || ids.has(id)) continue
      ids.add(id)
      nodes.push({ ...n, id, label: String(n.label ?? id) })
    }
    const edges = []
    ;(graph?.edges || []).forEach((e, i) => {
      const from = String(e?.from ?? '')
      const to = String(e?.to ?? '')
      if (ids.has(from) && ids.has(to) && from !== to) edges.push({ i, from, to, kind: String(e.kind || 'main'), label: e.label ? String(e.label) : '' })
    })
    return { nodes, edges }
  }

  function rankMap(nodes, edges) {
    const fwd = edges.filter(e => e.kind !== 'rework')
    const indeg = new Map(nodes.map(n => [n.id, 0]))
    for (const e of fwd) indeg.set(e.to, indeg.get(e.to) + 1)
    const rank = new Map()
    const queue = nodes.filter(n => !indeg.get(n.id)).map(n => n.id)
    for (const id of queue) rank.set(id, 0)
    for (let k = 0; k < queue.length; k++) {
      const id = queue[k]
      for (const e of fwd) {
        if (e.from !== id) continue
        rank.set(e.to, Math.max(rank.get(e.to) ?? 0, rank.get(id) + 1))
        indeg.set(e.to, indeg.get(e.to) - 1)
        if (!indeg.get(e.to)) queue.push(e.to)
      }
    }
    // a cycle the graph did not mark as rework: its nodes go after everything else, in node order
    let next = Math.max(-1, ...[...rank.entries()].filter(([id]) => queue.includes(id)).map(([, r]) => r)) + 1
    for (const n of nodes) if (!queue.includes(n.id)) rank.set(n.id, next++)
    return rank
  }

  function ranks(graph) {
    const { nodes, edges } = clean(graph)
    return Object.fromEntries(rankMap(nodes, edges))
  }

  // ─── geometry helpers ──────────────────────────────────────────────────────

  const r1 = v => Math.round(v * 10) / 10
  /** A path from main/cross points: `pts` are [m, c]; `lr` says which of them is x. */
  const xy = (lr, m, c) => (lr ? [m, c] : [c, m])
  const pt = (lr, m, c) => xy(lr, m, c).map(r1).join(' ')

  /** A polyline through main/cross points with rounded corners. */
  function rounded(lr, pts) {
    let d = `M${pt(lr, ...pts[0])}`
    for (let i = 1; i < pts.length - 1; i++) {
      const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]]
      const len1 = Math.hypot(b[0] - a[0], b[1] - a[1])
      const len2 = Math.hypot(c[0] - b[0], c[1] - b[1])
      const r = Math.min(R, len1 / 2, len2 / 2)
      if (r < 0.5) {
        d += ` L${pt(lr, ...b)}`
        continue
      }
      const p = [b[0] - ((b[0] - a[0]) / len1) * r, b[1] - ((b[1] - a[1]) / len1) * r]
      const q = [b[0] + ((c[0] - b[0]) / len2) * r, b[1] + ((c[1] - b[1]) / len2) * r]
      d += ` L${pt(lr, ...p)} Q${pt(lr, ...b)} ${pt(lr, ...q)}`
    }
    return `${d} L${pt(lr, ...pts.at(-1))}`
  }

  /** A smooth curve from [m0, c0] to [m1, c1], leaving and arriving along the main axis. */
  function curve(lr, [m0, c0], [m1, c1]) {
    const k = (m1 - m0) / 2
    return `M${pt(lr, m0, c0)} C${pt(lr, m0 + k, c0)} ${pt(lr, m1 - k, c1)} ${pt(lr, m1, c1)}`
  }

  /** An arrow head with its tip at [m, c], pointing along the main axis (`way` +1 or -1). */
  function head(lr, [m, c], way) {
    const b = m - way * ARROW
    return `M${pt(lr, m, c)} L${pt(lr, b, c - 4)} L${pt(lr, b, c + 4)} Z`
  }

  // ─── layout ────────────────────────────────────────────────────────────────

  function layout(graph, { width = 1200, rows = 0 } = {}) {
    const { nodes, edges } = clean(graph)
    const rank = rankMap(nodes, edges)
    const L = nodes.length ? Math.max(...rank.values()) + 1 : 0
    const layers = Array.from({ length: L }, () => [])
    for (const n of nodes) layers[rank.get(n.id)].push(n)
    const kMax = Math.max(1, ...layers.map(l => l.length))
    const H = nodeHeight(rows)

    // what each edge is: to the next layer, back to the one before, or long (through a corridor)
    for (const e of edges) {
      const span = rank.get(e.to) - rank.get(e.from)
      e.span = span
      e.type = span === 1 ? 'adj' : span === -1 ? 'ret' : 'long'
      e.side = e.kind === 'skip' ? 'neg' : 'pos'
    }
    // a return bus: Security sends work back to every producer along one corridor lane (below)
    const hasBus = edges.some(e => e.kind === 'rework' && e.type === 'long')
    // left to right when every layer gets a column of at least WMIN, else top to bottom
    const availLR = width - 2 * LR.pad
    // a roomy gap first (its arrow labels read whole), narrowed to the minimum before the boxes go below WMIN
    const widthAt = gap => Math.min(LR.wMax, Math.floor((availLR - (L - 1) * gap) / L))
    const wLR = L > 1 ? (widthAt(LR.gPref) >= LR.wMin ? widthAt(LR.gPref) : Math.max(LR.wMin, Math.floor((availLR - (L - 1) * LR.gMin) / L))) : Math.min(LR.wMax, availLR)
    const lr = L <= 1 || availLR - L * wLR >= (L - 1) * LR.gMin
    const corrOff = CORR_OFF[lr ? 'LR' : 'TB']
    const longs = side => edges.filter(e => e.type === 'long' && e.side === side)
    // the return arrows of one source share a lane (a bus); every other long arrow has its own
    const busOf = e => (e.kind === 'rework' ? `rework|${e.from}` : `edge|${e.i}`)
    const lanesOf = side => new Set(longs(side).map(busOf)).size
    const margin = side => {
      const list = longs(side)
      return list.length ? corrOff + (lanesOf(side) - 1) * LANE + (list.some(e => e.label) ? LABEL_ROOM : 4) : 0
    }
    const mNeg = margin('neg')
    const mPos = margin('pos')
    let S
    if (lr) {
      const gm = L > 1 ? Math.min(LR.gMax, Math.floor((availLR - L * wLR) / (L - 1))) : 0
      S = { pad: LR.pad, main: wLR, cross: H, gm, gc: LR.gc, w: wLR }
    } else {
      const free = width - 2 * TB.pad - mNeg - mPos - (kMax - 1) * TB.gc
      const w = Math.max(TB.wMin, Math.min(TB.wMax, Math.floor(free / kMax)))
      // a return bus (Security's) crosses the gaps the other returns use: top to bottom they get room for its labels
      S = { pad: TB.pad, main: H, cross: w, gm: TB.gm + (hasBus ? TB.busRoom : 0), gc: TB.gc, w }
    }
    // Top to bottom, a layer with fewer boxes may give each more room (up to ROOMY, never less than the
    // widest layer's): on a phone the three producers share the width while Master and Outcome keep their names.
    const roomy = Math.max(S.cross, TB.roomy)
    const freeTB = width - 2 * TB.pad - mNeg - mPos
    const crossOf = k => (lr ? S.cross : Math.max(S.cross, Math.min(roomy, Math.floor((freeTB - (k - 1) * S.gc) / Math.max(1, k)))))
    const spanOf = k => k * crossOf(k) + Math.max(0, k - 1) * S.gc
    const crossSpan = Math.max(spanOf(kMax), ...layers.map(l => spanOf(l.length)))
    const c0 = S.pad + mNeg
    const mainOf = r => S.pad + r * (S.main + S.gm)

    // every box: main is its layer, cross its place in the layer, the layer centred
    const box = new Map()
    layers.forEach((layer, r) => {
      const cs = crossOf(layer.length)
      const start = c0 + (crossSpan - spanOf(layer.length)) / 2
      layer.forEach((n, i) => {
        const c = start + i * (cs + S.gc)
        box.set(n.id, { id: n.id, layer: r, m: mainOf(r), c, cs, mid: c + cs / 2 })
      })
    })

    // ── corridor lanes: the longest span outermost; among equals the source nearest that side outermost
    const lane = new Map() // edge -> corridor cross position
    for (const side of ['neg', 'pos']) {
      const list = longs(side).sort((a, b) => Math.abs(b.span) - Math.abs(a.span) || (side === 'neg' ? 1 : -1) * (box.get(a.from).mid - box.get(b.from).mid) || a.i - b.i)
      // one lane per bus, in the order its first arrow comes
      const buses = [...new Set(list.map(busOf))]
      list.forEach(e => {
        const depth = buses.length - 1 - buses.indexOf(busOf(e)) // 0 is the inner lane
        lane.set(e, side === 'neg' ? c0 - corrOff - depth * LANE : c0 + crossSpan + corrOff + depth * LANE)
      })
    }

    // ── the two ends of every edge: which side of which box, and where the other end is (for the order).
    // A bus arrow that has a return arrow to the same box beside it (Security's, beside QA's) ends in THAT arrow's
    // head: one `failed` arrival per producer, so no second head and no second label crowd the gap.
    const joins = new Map() // bus edge -> the return edge whose arrow head it shares
    for (const e of edges) {
      if (e.kind !== 'rework' || e.type !== 'long') continue
      const twin = edges.find(r => r.kind === 'rework' && r.type === 'ret' && r.to === e.to)
      if (twin) joins.set(e, twin)
    }
    const ends = []
    for (const e of edges) {
      const fwd = e.span > 0
      const outSide = e.type === 'ret' || (e.type === 'long' && e.span < 0) ? 'start' : 'end'
      const inSide = fwd ? 'start' : 'end'
      const otherOut = e.type === 'long' ? lane.get(e) : box.get(e.to).mid
      const otherIn = e.type === 'long' ? lane.get(e) : box.get(e.from).mid
      const order = e.type === 'ret' ? 1 : 0
      ends.push({ e, end: 'out', node: e.from, side: outSide, other: otherOut, order })
      if (!joins.has(e)) ends.push({ e, end: 'in', node: e.to, side: inSide, other: otherIn, order })
    }
    const port = new Map() // `${edge.i}:out|in` -> [m, c]
    const groups = new Map()
    for (const x of ends) {
      const key = `${x.node}|${x.side}`
      ;(groups.get(key) || groups.set(key, []).get(key)).push(x)
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.other - b.other || a.order - b.order || a.e.i - b.e.i)
      const b = box.get(list[0].node)
      const k = list.length
      const step = k > 1 ? Math.min(PORT, (b.cs - 12) / (k - 1)) : 0
      list.forEach((x, i) => {
        const m = x.side === 'end' ? b.m + S.main : b.m
        port.set(`${x.e.i}:${x.end}`, [m, b.mid + (i - (k - 1) / 2) * step])
      })
    }
    for (const [e, twin] of joins) port.set(`${e.i}:in`, port.get(`${twin.i}:in`))

    // ── gap lanes for the long edges: the gap g lies between layer g and g + 1
    const gapMid = g => mainOf(g) + S.main + S.gm / 2
    const gapUse = new Map() // gap -> [{ e, end }]
    const useGap = (g, e, end) => (gapUse.get(g) || gapUse.set(g, []).get(g)).push({ e, end })
    for (const e of edges) {
      if (e.type !== 'long') continue
      const rf = rank.get(e.from)
      const rt = rank.get(e.to)
      useGap(e.span < 0 ? rf - 1 : rf, e, 'out')
      useGap(e.span > 0 ? rt - 1 : rt, e, 'in')
    }
    const gapAt = new Map() // `${edge.i}:out|in` -> main position of its lane
    for (const [g, list] of gapUse) {
      // leaving arrows nearest their source, the arrows arriving nearest their target; inner corridor lanes
      // turn first, so an arrow never crosses another one's run along the same gap
      const depth = e => Math.abs(lane.get(e) - (e.side === 'neg' ? c0 : c0 + crossSpan))
      const outs = list.filter(u => u.end === 'out').sort((a, b) => (a.e.side === b.e.side ? (a.e.side === 'neg' ? 1 : -1) * (box.get(a.e.from).mid - box.get(b.e.from).mid) : a.e.side === 'neg' ? -1 : 1) || a.e.i - b.e.i)
      const ins = list.filter(u => u.end === 'in').sort((a, b) => depth(a.e) - depth(b.e) || a.e.i - b.e.i)
      const all = [...outs, ...ins]
      const n = all.length
      const step = n > 1 ? Math.min(LANE, (S.gm - 16) / (n - 1)) : 0
      all.forEach((u, i) => gapAt.set(`${u.e.i}:${u.end}`, gapMid(g) + (i - (n - 1) / 2) * step))
    }

    // ── the paths and the labels
    const labels = []
    const longLabel = new Map() // `${side}|${to}|${label}` -> label
    const out = edges.map(e => {
      const p0 = port.get(`${e.i}:out`)
      const p3 = port.get(`${e.i}:in`)
      const way = e.span > 0 ? 1 : -1
      const tail = [p3[0] - way * ARROW, p3[1]]
      let d
      if (e.type === 'adj' || e.type === 'ret') {
        d = curve(lr, p0, tail)
        if (e.label && e.type === 'adj') {
          const mid = [(p0[0] + p3[0]) / 2, (p0[1] + p3[1]) / 2]
          labels.push(lr ? { text: e.label, x: r1(mid[0]), y: r1(mid[1] - 6), rotate: 0, anchor: 'middle', edges: [e.i] } : { text: e.label, x: r1(mid[1] + 6), y: r1(mid[0] + 4), rotate: 0, anchor: 'start', edges: [e.i] })
        } else if (e.label) {
          // a return arrow: its label beside the producer it goes back to, on the far side from the forward arrow
          // (`src`, QA, lets clearLabels give all its returns ONE label beside QA when a producer spot is crossed)
          labels.push(lr ? { text: e.label, x: r1(p3[0] + 6), y: r1(p3[1] + 13), rotate: 0, anchor: 'start', edges: [e.i], src: e.from } : { text: e.label, x: r1(p3[1] + 6), y: r1(p3[0] + 16), rotate: 0, anchor: 'start', edges: [e.i], src: e.from })
        }
      } else {
        const g1 = gapAt.get(`${e.i}:out`)
        const g2 = gapAt.get(`${e.i}:in`)
        const c = lane.get(e)
        d = rounded(lr, [p0, [g1, p0[1]], [g1, c], [g2, c], [g2, tail[1]], tail])
        if (e.label) {
          const key = e.kind === 'rework' ? `${e.side}|from ${e.from}|${e.label}` : `${e.side}|${e.to}|${e.label}`
          const at = (g1 + g2) / 2
          const off = e.side === 'neg' ? -5 : 13
          const spot = lr ? { x: r1(at), y: r1(c + off), rotate: 0 } : { x: r1(c + (e.side === 'neg' ? -4 : 13)), y: r1(at), rotate: -90 }
          const has = longLabel.get(key)
          const outer = !has || Math.abs(c - c0) > Math.abs(has.c - c0)
          if (!has) {
            const l = { text: e.label, ...spot, anchor: 'middle', edges: [e.i], c }
            longLabel.set(key, l)
            labels.push(l)
          } else {
            has.edges.push(e.i)
            if (outer) Object.assign(has, spot, { c })
          }
        }
      }
      return { i: e.i, from: e.from, to: e.to, kind: e.kind, label: e.label, d, head: head(lr, p3, way) }
    })
    for (const l of labels) delete l.c

    const mainLen = 2 * S.pad + L * S.main + Math.max(0, L - 1) * S.gm
    const crossLen = 2 * S.pad + mNeg + crossSpan + mPos
    const placed = [...box.values()].map(b => {
      const [x, y] = xy(lr, b.m, b.c)
      return { id: b.id, x: r1(x), y: r1(y), w: lr ? S.main : b.cs, h: lr ? b.cs : S.main, layer: b.layer }
    })
    const [W, Ht] = lr ? [mainLen, crossLen] : [crossLen, mainLen]
    const kinds = new Map(nodes.map(n => [n.id, n.kind]))
    clearLabels(labels, out.flatMap(e => [e.d, e.head]), placed.map(b => ({ ...b, agent: kinds.get(b.id) === 'agent' })), Math.ceil(W), Math.ceil(Ht), lr)
    return { dir: lr ? 'LR' : 'TB', width: Math.ceil(W), height: Math.ceil(Ht), nodes: placed, edges: out, labels }
  }

  // ─── labels in the clear ───────────────────────────────────────────────────

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
      Object.assign(one, lr ? { x: r1(box.x + 2), y: r1(box.y - 5), anchor: 'start' } : { x: r1(box.x - 6), y: r1(box.y + 14), anchor: 'end' })
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

  // A flow's lit route is flow-route.js highlight, over its own progress.
  window.PipelineLayout = { ranks, layout, nodeHeight }
})()
