// The chart the Output view draws when a flow has neither a screenshot nor an
// agent diagram (flow-output.js, drawn by diagram.js). It is a SUMMARY, never
// one box per step: the owner asked for visuals that are high level and easy
// to follow, and Process already has the full chart.
//
//   graph(flow)     PURE: { nodes, edges, line } for Diagram.svg, plus the one line of counts under it
//   clip(s, max)    s in at most max characters, cut after a whole word and never on a small word:
//                   MUST CHANGE IN LOCKSTEP with flow-story.mjs clip (a parity test pins them)
//
// ═══ HOW A FLOW IS SUMMED UP ═══ Walk the nodes in list order (an `after`
// only ever names an earlier node, so this is the flow's own order):
//   - an ask is a diamond: its question cut near 34 characters; an answer goes
//     on the arrow out of it (Yes, No, the first words of a text answer) or
//     under it when nothing follows. An open one has no label: its warn colour
//     says it waits on you;
//   - each RUN of steps and checks between two asks is at most two boxes: the
//     done part, solid, its first title with `+N more` under it; and the rest,
//     dashed, `N left`, in the warn colour with `1 blocked` under it when any
//     is blocked. No proof marks: Status and Process carry the proof;
//   - skipped steps and notes are left out, and so are the branches inside a
//     run (deliberately: Process has them);
//   - fewer than 4 shapes says nothing about the journey (a long flow with no
//     decisions would be two boxes): the longest done run of 4 or more steps
//     is split into up to 4 stages, each a solid box (stages);
//   - more than MAX shapes: the middle ones merge into one box,
//     `N steps and M decisions`, from the middle outward, until it fits.
// Each shape's goto is the first flow node it holds, so a click opens that
// node's row on Status (flows.js).
;(() => {
  const MAX = 7
  const STAGE_FEW = 4 // a summary of fewer shapes than this shows the stages of its longest done run
  const STAGE_MIN = 4 // a done run this long or longer can be split
  const STAGES = 4 // into at most this many stages
  const LABEL = 34 // a shape label, about six words
  const ANSWER = 18 // a text answer on an arrow, about three words
  const WORK = ['step', 'check']
  const LEFT = ['todo', 'doing', 'blocked'] // skipped is a decision not to, so it is not left

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

  // MUST CHANGE IN LOCKSTEP with flow-story.mjs SMALL and clip
  const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with'])
  function clip(text, max) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (s.length <= max) return s
    const out = []
    let len = 0
    for (const w of s.split(' ')) {
      const next = len + (out.length ? 1 : 0) + w.length
      if (next + 1 > max) break
      out.push(w)
      len = next
    }
    const bare = w => w.toLowerCase().replace(/[.,;:!?]+$/, '')
    while (out.length > 1 && SMALL.has(bare(out[out.length - 1]))) out.pop()
    if (!out.length) return `${s.slice(0, max - 1)}…`
    return `${out.join(' ').replace(/[.,;:!?]+$/, '')}…`
  }

  /** A node title as a chart shows it: marked words without their brackets (an SVG label is not a chip). */
  const plain = s => (window.Terms ? window.Terms.plain(s) : String(s ?? ''))
  const answerOf = n => n.answer == null ? '' : n.answer === 'yes' ? 'Yes' : n.answer === 'no' ? 'No' : clip(plain(n.answer), ANSWER)

  /** The shapes before any merge: one per ask, one or two per run of work. Each holds its flow nodes. */
  function shapes(flow) {
    const out = []
    let run = null
    const close = () => {
      if (!run) return
      const done = run.filter(n => n.status === 'done')
      const left = run.filter(n => LEFT.includes(n.status))
      if (done.length) out.push(doneBox(done))
      if (left.length) {
        const blocked = left.filter(n => n.status === 'blocked').length
        out.push({ kind: 'box', label: `${left.length} left`, sub: blocked ? `${blocked} blocked` : '', cls: `dg-left${blocked ? ' dg-blocked' : ''}`, held: left })
      }
      run = null
    }
    for (const n of flow.nodes || []) {
      if (n.type === 'ask') {
        close()
        out.push({ kind: 'decision', label: clip(plain(n.title), LABEL), cls: `dg-ask${n.answer == null ? ' dg-open' : ''}`, answer: answerOf(n), held: [n] })
      } else if (WORK.includes(n.type) && n.status !== 'skipped') (run ||= []).push(n)
    }
    close()
    return stages(out)
  }

  /** A solid box for a run of done steps: its first title, `+N more` under it. */
  const doneBox = done => ({ kind: 'box', label: clip(plain(done[0].title), LABEL), sub: done.length > 1 ? `+${done.length - 1} more` : '', cls: 'dg-done', held: done })

  /**
   * The journey: a summary of under STAGE_FEW shapes says nothing (a long flow with no decisions is two boxes),
   * so the longest done run of STAGE_MIN or more steps is split into up to STAGES consecutive stages, as even
   * as they can be (13 steps: 4, 3, 3, 3), each a solid box of its own; never past MAX shapes in all.
   */
  function stages(list) {
    if (list.length >= STAGE_FEW) return list
    const runs = list.filter(s => s.cls === 'dg-done' && s.held.length >= STAGE_MIN)
    if (!runs.length) return list
    const run = runs.reduce((a, b) => (b.held.length > a.held.length ? b : a))
    const k = Math.min(STAGES, run.held.length, MAX - (list.length - 1))
    const parts = []
    for (let i = 0, start = 0; i < k; i++) {
      const size = Math.floor(run.held.length / k) + (i < run.held.length % k ? 1 : 0)
      parts.push(doneBox(run.held.slice(start, start + size)))
      start += size
    }
    const at = list.indexOf(run)
    return [...list.slice(0, at), ...parts, ...list.slice(at + 1)]
  }

  /** Over MAX: the middle shapes become one box of N steps and M decisions. */
  function merge(list) {
    if (list.length <= MAX) return list
    const take = list.length - MAX + 1
    const start = Math.floor((list.length - take) / 2)
    const inner = list.slice(start, start + take)
    const held = inner.flatMap(s => s.held)
    const asks = held.filter(n => n.type === 'ask').length
    const steps = held.length - asks
    const label = steps && asks ? `${plural(steps, 'step')} and ${plural(asks, 'decision')}` : steps ? plural(steps, 'step') : plural(asks, 'decision')
    const open = held.some(n => LEFT.includes(n.status) || (n.type === 'ask' && n.answer == null))
    return [...list.slice(0, start), { kind: 'box', label, cls: `dg-merged ${open ? 'dg-left' : 'dg-done'}`, held }, ...list.slice(start + take)]
  }

  /** `13 done · 4 left · 2 decisions`, the parts that are not zero. */
  function line(flow) {
    const nodes = flow.nodes || []
    const work = nodes.filter(n => WORK.includes(n.type))
    const parts = [
      [work.filter(n => n.status === 'done').length, 'done'],
      [work.filter(n => LEFT.includes(n.status)).length, 'left'],
    ].filter(([n]) => n).map(([n, w]) => `${n} ${w}`)
    const asks = nodes.filter(n => n.type === 'ask').length
    if (asks) parts.push(plural(asks, 'decision'))
    return parts.join(' · ')
  }

  function graph(flow) {
    const list = merge(shapes(flow))
    if (!list.length) return { nodes: [{ id: 's1', label: 'No steps yet', kind: 'box', cls: 'dg-left' }], edges: [], line: '' }
    const nodes = list.map((s, i) => {
      const last = i === list.length - 1
      const sub = s.sub || (last && s.kind === 'decision' ? s.answer : '')
      const n = { id: `s${i + 1}`, label: s.label, kind: s.kind, cls: s.cls, goto: s.held[0].id }
      if (sub) n.sub = sub
      return n
    })
    const edges = list.slice(1).map((s, i) => ({ from: `s${i + 1}`, to: `s${i + 2}`, label: list[i].answer || '' }))
    return { nodes, edges, line: line(flow) }
  }

  window.FlowPicture = { graph, clip }
})()
