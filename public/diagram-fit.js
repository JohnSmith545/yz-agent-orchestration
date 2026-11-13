// How the Output charts fit their words (diagram.js lays them out): labels
// wrapped between words, and boxes, diamonds and gaps sized to the text.
//
//   lines(text, max, most, px?)  the text in at most `most` lines of `max` px, broken between words (two
//                                lines are balanced, never a long line over a lone word); words left over
//                                end the last line with … after a whole word. Only a single word wider
//                                than `max` is cut (FlowChart.fit), having no break.
//   room(node, w)                the px a label has inside a node `w` wide (a diamond narrows to its tips)
//   sizes(nodes, edges, dir, opts?)  { bw, dw, w, h, gx, gy }: box and diamond widths, the cell and the gaps
//
// ═══ SIZES ═══ Boxes are 160 to 232 wide and diamonds 170 to 300 by 84, each the
// smallest that fits every label of its kind on two whole lines, one size per
// kind per drawing so rows stay even. Left to right, the column gap grows to
// the widest arrow label of up to 24 characters, so those are drawn whole.
// The TIGHT form (opts.cap, a narrow box such as the Ask drawer open) holds
// every node to `cap` and the gap to its minimum: long labels then end with …
// after a word (the full one is in the label's tooltip) instead of the chart
// turning top to bottom.
;(() => {
  const BOX = { min: 160, max: 232, h: 64 }
  const DIAMOND = { min: 170, max: 300, h: 84 }
  const GAP = { LR: { gx: 72, gy: 56 }, TB: { gx: 56, gy: 64 } }
  const GX_MAX = 220 // the widest a column gap grows for its labels
  const TIGHT_GX = 56 // the column gap of the tight form
  const LABEL_WHOLE = 24 // an arrow label this long or shorter is never cut (outside the tight form)
  const PX = 14 // a label
  const EDGE_PX = 12
  const WEIGHT = 600

  const FC = () => window.FlowChart // textW and fit: one way of measuring text for every chart
  const textW = (s, px = PX) => FC().textW(s, px, WEIGHT)

  /** Two lines as even as they can be: never one long line over a lone word (`Read how the nightly report` / `job…`). */
  function balanced(words, max, px) {
    let best = null
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ')
      const b = words.slice(i).join(' ')
      const w = Math.max(textW(a, px), textW(b, px))
      if (w <= max && (!best || w < best.w)) best = { w, out: [a, b] }
    }
    return best?.out
  }

  function lines(text, max, most, px = PX) {
    const words = String(text).split(/\s+/).filter(Boolean)
    if (most >= 2 && words.length > 1 && textW(words.join(' '), px) > max) {
      const even = balanced(words, max, px)
      if (even) return even
    }
    const out = []
    while (words.length && out.length < most) {
      let line = ''
      while (words.length && textW(line ? `${line} ${words[0]}` : words[0], px) <= max) line = line ? `${line} ${words.shift()}` : words.shift()
      if (!line) line = FC().fit(words.shift(), px, WEIGHT, max)
      out.push(line)
    }
    if (words.length && out.length) {
      const last = out[out.length - 1].split(' ')
      while (last.length > 1 && textW(`${last.join(' ')}…`, px) > max) last.pop()
      const end = `${last.join(' ')}…`
      out[out.length - 1] = textW(end, px) <= max ? end : FC().fit(end, px, WEIGHT, max)
    }
    return out
  }
  /** Every word drawn, none cut (a label may end with its own …, from a cut title: that is not a cut here). */
  const fitsWhole = (text, max, most, px) => lines(text, max, most, px).join(' ') === String(text).split(/\s+/).filter(Boolean).join(' ')

  // a diamond keeps 16 px off its usable middle, so a label never touches its slanted edges
  const room = (n, w) => n.kind === 'decision' ? w * 0.6 - 16 : n.kind === 'actor' ? w - 30 : w - 20

  /** The smallest width from min to max (in 8 px steps) where every node of `list` fits two whole lines; else max. */
  function widthFor(list, { min, max }) {
    for (let w = min; w < max; w += 8) if (list.every(n => fitsWhole(n.label, room(n, w), 2))) return w
    return max
  }

  function sizes(nodes, edges, dir, { cap = Infinity } = {}) {
    const tight = Number.isFinite(cap)
    const boxes = nodes.filter(n => n.kind !== 'decision')
    const diamonds = nodes.filter(n => n.kind === 'decision')
    const within = k => ({ min: Math.min(k.min, cap), max: Math.min(k.max, cap) })
    const bw = boxes.length ? widthFor(boxes, within(BOX)) : Math.min(BOX.min, cap)
    const dw = diamonds.length ? widthFor(diamonds, within(DIAMOND)) : 0
    const widest = Math.max(0, ...edges.filter(e => e.label && e.label.length <= LABEL_WHOLE).map(e => textW(e.label, EDGE_PX)))
    const gx = dir === 'TB' ? GAP.TB.gx : tight ? TIGHT_GX : Math.min(GX_MAX, Math.max(GAP.LR.gx, Math.ceil(widest) + 32))
    return { bw, dw, w: Math.max(bw, dw), h: diamonds.length ? DIAMOND.h : BOX.h, gx, gy: GAP[dir].gy }
  }

  window.DiagramFit = { lines, room, sizes, textW, BOX, DIAMOND, TIGHT_GX, PX, EDGE_PX }
})()
