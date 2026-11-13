// A node and arrow graph drawn as a flowchart, for the Output view's Picture
// (flow-visual.js): the agent's own diagram (`flow diagram`, output.diagram)
// and the summary chart the page draws from the flow itself (flow-picture.js).
// How labels wrap and how big the shapes are is diagram-fit.js; how each arrow
// finds its own path is diagram-route.js.
//
//   layout(graph, opts)  PURE: { dir, nodes: [{ id, x, y, w, h, layer }], edges: [{ from, to, d, back,
//                        label, lx, ly, lw, x2, y2 }], minX, minY, width, height }
//   svg(graph, opts)     the markup, as a string
//
//   graph  { nodes: [{ id, label, kind?, sub?, cls?, goto? }], edges: [{ from, to, label?, cls? }] }
//          kind: box (a rounded rect, the default), actor (a pill), store (a rect with a second top
//          line), decision (a diamond). sub: a second, quieter line (`1 blocked`). goto: the flow
//          node a click opens on Status (data-goto, flows.js); a node without one is not clickable.
//   opts   { dir: 'LR' | 'TB' | 'auto', maxWidth, title, cls }
//          auto: left to right on ONE row (at full size, else in the tight form of diagram-fit.js);
//          a simple chain (the summary chart) too long for one row wraps into rows joined by line
//          returns; any other graph too wide for one row is drawn top to bottom (pick)
//
// ═══ IT SHOULD READ LIKE A SLIDE ═══ (the owner: high level, easy to follow)
// Few boxes, big type (14 px, 600), generous gaps, thick arrows with clear
// heads, read left to right like a sentence. It is never scaled down.
//   - labels are never cut mid-word (diagram-fit.js), and an arrow label always
//     sits in a gap, never on a box;
//   - every arrow has its own exit point, entry point and lanes: no two arrows
//     share a piece of line, and none runs through a box (diagram-route.js);
//   - an arrow into the next row of a wrapped chain is ONE continuous line
//     return, rounded at each turn, its label on the run back.
// Marked words ([word]) show as the plain word (Terms.plain): an SVG label is
// not a chip.
//
// ═══ HOW IT IS LAID OUT ═══ Layers go left to right (LR) or top to bottom
// (TB), each layer the longest path from a node nothing points at; within a
// layer the nodes sit in the order of the nodes that point at them. Every node
// is centred in one cell of a grid, so the gaps between columns and rows are
// always free: each arrow runs along those gaps, never through a box. An arrow
// that closes a cycle (found depth first, in node order) is a BACK edge: drawn
// dashed, and no part of the layering, so a cycle never hangs or breaks it.
//
// ⚠️ Every label, id, title and class goes through esc() (classes are also
// filtered to letters, digits and dashes). Colours come from CSS classes only
// (diagram.css, dg-*), so dark mode follows; nothing here animates.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const cls = s => String(s ?? '').replace(/[^A-Za-z0-9 _-]/g, '').trim()
  const plain = s => (window.Terms ? window.Terms.plain(s) : String(s ?? ''))
  const F = () => window.DiagramFit
  const KINDS = ['box', 'actor', 'store', 'decision']
  const PAD = 10 // around everything the drawing holds (boxes, arrows, arrow labels)
  const LH = 18 // a label's line height
  const SUB_PX = 12
  const HEAD = 9 // arrow head length

  // ─── the graph, cleaned ─────────────────────────────────────────────────────

  function clean(graph) {
    const nodes = []
    const index = new Map()
    for (const n of graph?.nodes || []) {
      const id = String(n?.id ?? '')
      if (!id || index.has(id)) continue
      index.set(id, nodes.length)
      nodes.push({ ...n, id, label: plain(n.label ?? id), kind: KINDS.includes(n.kind) ? n.kind : 'box' })
    }
    const edges = []
    for (const e of graph?.edges || []) {
      const from = String(e?.from ?? '')
      const to = String(e?.to ?? '')
      if (index.has(from) && index.has(to) && from !== to) edges.push({ from, to, label: e.label ? plain(e.label) : '', cls: e.cls })
    }
    return { nodes, edges, index }
  }

  // ─── layers ────────────────────────────────────────────────────────────────

  /** Marks the back edges and groups the nodes into layers, each layer in the order the nodes before it suggest. */
  function layers(nodes, edges, index) {
    const out = new Map(nodes.map(n => [n.id, []]))
    for (const e of edges) out.get(e.from).push(e)
    const state = new Map() // 1 on the stack, 2 done
    const visit = id => {
      state.set(id, 1)
      for (const e of out.get(id)) {
        const s = state.get(e.to)
        if (s === 1) e.back = true
        else if (!s) visit(e.to)
      }
      state.set(id, 2)
    }
    const pointedAt = new Set(edges.map(e => e.to))
    for (const n of nodes) if (!pointedAt.has(n.id) && !state.has(n.id)) visit(n.id)
    for (const n of nodes) if (!state.has(n.id)) visit(n.id) // a cycle nothing points into
    // the longest path over the forward edges, in topological order
    const fwd = edges.filter(e => !e.back)
    const indeg = new Map(nodes.map(n => [n.id, 0]))
    for (const e of fwd) indeg.set(e.to, indeg.get(e.to) + 1)
    const rank = new Map()
    const queue = nodes.filter(n => !indeg.get(n.id)).map(n => n.id)
    for (const id of queue) rank.set(id, 0)
    while (queue.length) {
      const id = queue.shift()
      for (const e of out.get(id)) {
        if (e.back) continue
        rank.set(e.to, Math.max(rank.get(e.to) ?? 0, rank.get(id) + 1))
        indeg.set(e.to, indeg.get(e.to) - 1)
        if (!indeg.get(e.to)) queue.push(e.to)
      }
    }
    const groups = []
    for (const n of nodes) (groups[rank.get(n.id)] ||= []).push(n.id)
    const slot = new Map()
    for (const g of groups) {
      const key = new Map(g.map(id => {
        const ps = fwd.filter(e => e.to === id && slot.has(e.from)).map(e => slot.get(e.from))
        return [id, ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity]
      }))
      g.sort((a, b) => key.get(a) - key.get(b) || index.get(a) - index.get(b))
      g.forEach((id, i) => slot.set(id, i))
    }
    return { rank, groups }
  }

  // ─── layout ────────────────────────────────────────────────────────────────

  const columnsIn = (maxWidth, S) => Number.isFinite(maxWidth) && maxWidth > 0 ? Math.max(1, Math.floor((maxWidth - 2 * PAD) / (S.w + S.gx))) : Infinity

  /** One path and nothing else: every box has at most one arrow in and one out, and they join up. */
  function isChain(nodes, edges) {
    const ins = new Map()
    const outs = new Map()
    for (const e of edges) {
      ins.set(e.to, (ins.get(e.to) || 0) + 1)
      outs.set(e.from, (outs.get(e.from) || 0) + 1)
    }
    return edges.length === Math.max(0, nodes.length - 1) && !edges.some(e => e.back) && nodes.every(n => (ins.get(n.id) || 0) <= 1 && (outs.get(n.id) || 0) <= 1)
  }

  /**
   * The direction and sizes ('auto'): left to right on ONE row at full size; else on one row in the tight form
   * (nodes held to their share of the width, the gap at its minimum); else, for a simple chain only, left to
   * right wrapped into rows joined by line returns; else top to bottom, where branches never need to cross back.
   */
  function pick(nodes, edges, opts, layerCount, chain) {
    const tb = () => ({ dir: 'TB', S: F().sizes(nodes, edges, 'TB'), oneRow: false })
    if (opts.dir === 'TB') return tb()
    const full = F().sizes(nodes, edges, 'LR')
    if (opts.dir !== 'auto') return { dir: 'LR', S: full, oneRow: !chain }
    if (columnsIn(opts.maxWidth, full) >= layerCount) return { dir: 'LR', S: full, oneRow: true }
    const min = nodes.some(n => n.kind === 'decision') ? F().DIAMOND.min : F().BOX.min
    const tight = cols => {
      const cap = Math.floor((opts.maxWidth - 2 * PAD) / cols) - F().TIGHT_GX
      return cap >= min ? F().sizes(nodes, edges, 'LR', { cap }) : null
    }
    const one = tight(layerCount)
    if (one && columnsIn(opts.maxWidth, one) >= layerCount) return { dir: 'LR', S: one, oneRow: true }
    if (!chain) return tb()
    if (columnsIn(opts.maxWidth, full) >= 2) return { dir: 'LR', S: full, oneRow: false }
    const two = tight(2)
    return two && columnsIn(opts.maxWidth, two) >= 2 ? { dir: 'LR', S: two, oneRow: false } : tb()
  }

  /** Every point a path of M, H, V and Q commands passes (a Q's control point included). */
  function points(d) {
    const t = d.match(/[MHVQ]|-?\d+(?:\.\d+)?/g) || []
    const out = []
    let x = 0
    let y = 0
    for (let i = 0; i < t.length;) {
      const c = t[i++]
      if (c === 'M') { x = +t[i++]; y = +t[i++] } else if (c === 'H') x = +t[i++]
      else if (c === 'V') y = +t[i++]
      else if (c === 'Q') { out.push([+t[i++], +t[i++]]); x = +t[i++]; y = +t[i++] }
      out.push([x, y])
    }
    return out
  }

  /** Every node in its cell: LR layers side by side (bands of a wrapped chain stacked), TB layers as rows. */
  function place(nodes, groups, rank, dir, S, fits) {
    const cellW = S.w + S.gx
    const cellH = S.h + S.gy
    const pos = new Map() // id -> { col, row, band }
    const bandTop = [] // the y of each band's first cell
    let rows = 0
    let bands = 0 // LR: each band after the first starts one more row gap down
    if (dir === 'LR') {
      // a band holds up to `fits` layers side by side, the bands as even as they can be (7 shapes in rows
      // of up to 6: 4 and 3, never 6 and 1); the bands stack downwards, a double row gap apart
      const per = Math.ceil(groups.length / Math.max(1, Math.ceil(groups.length / fits)))
      for (let start = 0; start < groups.length; start += per) {
        const band = groups.slice(start, start + per)
        const tall = Math.max(...band.map(g => g.length))
        bandTop.push(rows * cellH + bands * S.gy)
        band.forEach((g, c) => g.forEach((id, i) => pos.set(id, { col: c, row: rows + i + Math.floor((tall - g.length) / 2), band: bands })))
        rows += tall
        bands++
      }
    } else {
      // each layer is a row; a layer wider than the width wraps onto more rows, centred by whole cells
      const cols = Math.min(fits, Math.max(0, ...groups.map(g => g.length)))
      for (const g of groups) {
        g.forEach((id, i) => {
          const inRow = Math.min(cols, g.length - Math.floor(i / cols) * cols)
          pos.set(id, { col: (i % cols) + Math.floor((cols - inRow) / 2), row: rows + Math.floor(i / cols), band: 0 })
        })
        rows += Math.ceil(g.length / cols)
      }
    }
    const boxes = nodes.map(n => {
      const p = pos.get(n.id)
      const w = n.kind === 'decision' ? S.dw : S.bw
      const h = n.kind === 'decision' ? F().DIAMOND.h : F().BOX.h
      const cx = p.col * cellW // the cell's left and top: the node is centred in it
      const cy = p.row * cellH + p.band * S.gy
      return { id: n.id, kind: n.kind, x: cx + (S.w - w) / 2, y: cy + (S.h - h) / 2, w, h, layer: rank.get(n.id), cx, cy, col: p.col, row: p.row, band: p.band, bandTop: bandTop[p.band] ?? 0 }
    })
    return new Map(boxes.map(b => [b.id, b]))
  }

  function layout(graph, opts = {}) {
    const { nodes, edges, index } = clean(graph)
    const { rank, groups } = layers(nodes, edges, index)
    const chain = isChain(nodes, edges)
    const picked = pick(nodes, edges, opts, groups.length, chain)
    const { dir, oneRow } = picked
    let S = picked.S
    const fits = () => (oneRow ? Infinity : columnsIn(opts.maxWidth, S))
    let at = place(nodes, groups, rank, dir, S, fits())
    let steps = window.DiagramRoute.plan(edges, at, dir)
    // the lanes may need wider gaps: widen the whole grid once and place again
    const need = window.DiagramRoute.need(steps, S)
    if (need.gx > S.gx || need.gy > S.gy) {
      S = { ...S, gx: Math.max(S.gx, need.gx), gy: Math.max(S.gy, need.gy) }
      at = place(nodes, groups, rank, dir, S, fits())
      steps = window.DiagramRoute.plan(edges, at, dir)
    }
    const routes = window.DiagramRoute.paths(steps, dir, S)
    const out = edges.map((e, i) => ({ from: e.from, to: e.to, label: e.label, cls: e.cls, back: !!e.back, ...routes[i] }))
    // the drawing is what it holds, PAD around: the boxes, every point of every arrow, every arrow label's room
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
    for (const b of at.values()) { grow(b.x, b.y); grow(b.x + b.w, b.y + b.h) }
    for (const e of out) {
      for (const [x, y] of points(e.d)) grow(x, y)
      if (e.label) { grow(e.lx - e.lw / 2, e.ly - 12); grow(e.lx + e.lw / 2, e.ly + 12) }
    }
    if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 0; y1 = 0 }
    return {
      dir,
      nodes: [...at.values()].map(({ id, x, y, w, h, layer }) => ({ id, x, y, w, h, layer })),
      edges: out,
      minX: x0 - PAD,
      minY: y0 - PAD,
      width: x1 - x0 + 2 * PAD,
      height: y1 - y0 + 2 * PAD,
    }
  }

  // ─── svg ───────────────────────────────────────────────────────────────────

  function shape(n, b) {
    const { x, y, w, h } = b
    if (n.kind === 'decision') return `<path class="dg-shape" d="M${x + w / 2} ${y} L${x + w} ${y + h / 2} L${x + w / 2} ${y + h} L${x} ${y + h / 2} Z"/>`
    const rx = n.kind === 'actor' ? h / 2 : n.kind === 'store' ? 4 : 8
    const rect = `<rect class="dg-shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`
    return n.kind === 'store' ? `${rect}<path class="dg-lid" d="M${x} ${y + 7} H${x + w}"/>` : rect
  }

  function node(n, b) {
    const space = F().room(n, b.w)
    const sub = n.sub ? String(n.sub) : ''
    // a box at least 170 px wide takes a third line before it cuts (a diamond has no room for one)
    const text = F().lines(n.label, space, n.kind !== 'decision' && !sub && b.w >= 170 ? 3 : 2)
    const all = text.length + (sub ? 1 : 0)
    const cx = b.x + b.w / 2
    const lh = all > 2 ? LH - 1 : LH // three lines (two of label, one sub) still fit the box
    const top = b.y + b.h / 2 - ((all - 1) * lh) / 2 + F().PX * 0.35
    const go = n.goto != null ? ` data-goto="${esc(n.goto)}" tabindex="0" role="link" aria-label="${esc(n.label)}${sub ? `, ${esc(sub)}` : ''}"` : ''
    const extra = cls(n.cls)
    return `<g class="dg-node dg-${n.kind}${extra ? ` ${extra}` : ''}"${go}><title>${esc(n.label)}${sub ? ` (${esc(sub)})` : ''}</title>${shape(n, b)}` +
      `<text class="dg-label" text-anchor="middle">${text.map((t, i) => `<tspan x="${cx}" y="${top + i * lh}">${esc(t)}</tspan>`).join('')}` +
      (sub ? `<tspan class="dg-sub" x="${cx}" y="${top + text.length * lh}">${esc(F().lines(sub, space, 1, SUB_PX)[0] || '')}</tspan>` : '') + '</text></g>'
  }

  const head = ({ x2: x, y2: y }, dir) => dir === 'LR'
    ? `<path class="dg-head" d="M${x} ${y} L${x - HEAD} ${y - 5} L${x - HEAD} ${y + 5} Z"/>`
    : `<path class="dg-head" d="M${x} ${y} L${x - 5} ${y - HEAD} L${x + 5} ${y - HEAD} Z"/>`

  /** An arrow label on a background just big enough for it, so it reads over a line; cut only after a whole word. */
  function edgeLabel(e) {
    if (!e.label) return ''
    const px = F().EDGE_PX
    const [text] = F().lines(e.label, e.lw, 1, px)
    const w = Math.ceil(F().textW(text, px)) + 8
    const h = px + 6
    const full = text === e.label ? '' : `<title>${esc(e.label)}</title>`
    return `<g class="dg-elabel">${full}<rect x="${e.lx - w / 2}" y="${e.ly - h / 2}" width="${w}" height="${h}" rx="4"/>` +
      `<text x="${e.lx}" y="${e.ly + px * 0.35}" text-anchor="middle">${esc(text)}</text></g>`
  }

  function svg(graph, opts = {}) {
    const lay = layout(graph, opts)
    const { nodes } = clean(graph)
    const at = new Map(lay.nodes.map(b => [b.id, b]))
    const edgeCls = e => ['dg-edge', e.back ? 'dg-back' : '', cls(e.cls)].filter(Boolean).join(' ')
    const top = ['dg', `dg-${lay.dir.toLowerCase()}`, cls(opts.cls)].filter(Boolean).join(' ')
    const title = esc(opts.title || 'Diagram')
    return `<svg class="${top}" xmlns="http://www.w3.org/2000/svg" viewBox="${lay.minX} ${lay.minY} ${lay.width} ${lay.height}" ` +
      `width="${lay.width}" height="${lay.height}" role="img" aria-label="${title}"><title>${title}</title>` +
      `<g class="dg-edges">${lay.edges.map(e => `<path class="${edgeCls(e)}" d="${e.d}"/>${head(e, lay.dir)}`).join('')}</g>` +
      `<g class="dg-nodes">${nodes.map(n => node(n, at.get(n.id))).join('')}</g>` +
      `<g class="dg-labels">${lay.edges.map(edgeLabel).join('')}</g></svg>`
  }

  window.Diagram = { layout, svg }
})()
