// The Explain tab of an opened flow, the drawing half (flow-explain.js builds the
// slides): ONE slide at a time, full width, like a presentation.
//
//   [● What and why  ● Before and after  ● Path through the agents …]      ‹ 2/5 ›
//   ┌ the slide ──────────────────────────────────────────────────────────────┐
//
// The index row jumps to a slide; ‹ › and ArrowLeft / ArrowRight (while the stage
// or anything in it has the focus) step through them. The place is kept in memory
// per flow, by kind, so a poll that adds a slide (a QA result arriving) keeps the
// one on show. It reuses what Output draws: the Story lines (flow-story.js), the
// before and after pair and its slider (flow-compare.js), the diagrams
// (diagram.js, each redrawn for its box's real width), and the QA words
// (flow-qa-line.js). The path is the flow's own route and progress, as /api/flows
// sends them (flow-route.js), so it needs no request of its own. Text is escaped,
// Markdown goes through FlowDrawer.md (the one safe renderer), nothing here posts
// but Retry (flow-qa-line.js).
//
//   html(flow, slides, index, opts?)   the markup; opts.compare is 'screens' (default) or 'compare'
//   moveTo(at, by, n)                  PURE: the slide `by` places from `at`, kept within n
//   fill(root, flow)                   draw in place (flows.js renderOpened), only when it changed
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const X = () => window.FlowExplain
  const DRAW_W = 960 // the width a chart is drawn for before fill() measures its box
  const short = sha => String(sha || '').slice(0, 7)

  const moveTo = (at, by, n) => Math.max(0, Math.min(Number(at) + Number(by), n - 1))

  // ═══ the slides ═══

  function what(s, flow) {
    const story = window.FlowStory.html({ m: { story: { lines: s.lines, derived: false, asks: [] } }, keyed: () => '', flow })
    return `<p class="xp-lead">${esc(s.heading)}</p>` + (s.why ? `<div class="xp-why">${window.FlowDrawer.md(s.why)}</div>` : '') + story
  }

  function change(s, c, mode) {
    const C = window.FlowCompare
    const show = s.compare && mode === 'compare' ? 'compare' : 'screens'
    const seg = s.compare ? `<div class="ob-seg xp-seg" role="group" aria-label="Show">` +
      `<button type="button" data-xp-cmp="screens" aria-pressed="${show === 'screens'}">Side by side</button>` +
      `<button type="button" data-xp-cmp="compare" aria-pressed="${show === 'compare'}">Slider</button></div>` : ''
    const pics = s.pairs ? (show === 'compare' ? C.compare(c) : C.screens(c, () => '') || '') : ''
    return seg + (pics ? `<div class="xp-pics">${pics}</div>` : '') + C.strip(c.m)
  }

  function path(s, c) {
    if (!s.chart) return `<p class="small faint xp-note">${esc(s.note)}</p>`
    return c.chart('path', s.chart, 'Path through the agents', 'xp-path') + (s.where ? `<p class="small xp-note">${esc(s.where)}</p>` : '')
  }

  function qa(s, flow) {
    const pushed = s.pushedAt ? `pushed ${window.Shell.ago(s.pushedAt)}` : s.pushError ? `<span class="warn" title="${esc(s.pushError)}">push refused</span>` : s.state.key === 'passed' ? 'not pushed yet' : ''
    const facts = [s.attempt ? `attempt ${esc(s.attempt)}` : '', s.commit ? `<code>${esc(short(s.commit))}</code>` : '', s.branch ? `<code>${esc(s.branch)}</code>` : '', pushed].filter(Boolean)
    return `<p class="xp-qa-state">${window.FlowQa.markOf(s.state)}${facts.length ? ` <span class="faint">· ${facts.join(' · ')}</span>` : ''}</p>` +
      (s.summary ? `<div class="xp-why">${window.FlowDrawer.md(s.summary)}</div>` : '') +
      window.FlowQa.reworkLineOf(s.rework, flow.id) +
      `<p class="xp-acts"><button type="button" class="link" data-xp-qa="${esc(flow.id)}">${s.steps ? 'How to test' : 'Open in QA'}</button></p>`
  }

  // ═══ the markup ═══

  function render(flow, slides, index, opts = {}) {
    const i = moveTo(index, 0, slides.length)
    const s = slides[i]
    const charts = new Map()
    const c = {
      flow,
      m: window.FlowOutput.model(flow),
      chart: (key, graph, title, cls = '') => {
        charts.set(key, { graph, title, cls })
        return `<div class="dg-host${cls ? ' xp-chart' : ''}" data-dg="${esc(key)}">${window.Diagram.svg(graph, { dir: 'auto', maxWidth: DRAW_W, title, cls })}</div>`
      },
    }
    const body = s.kind === 'what' ? what(s, flow)
      : s.kind === 'change' ? change(s, c, opts.compare)
      : s.kind === 'how' ? window.FlowCompare.how(c)
      : s.kind === 'path' ? path(s, c)
      : qa(s, flow)
    const dots = slides.map((x, k) => `<button type="button" data-xp-go="${k}"${k === i ? ' aria-current="step"' : ''}><i class="xp-dot" aria-hidden="true"></i>${esc(x.title)}</button>`).join('')
    const n = slides.length
    const step = `<div class="xp-step" role="group" aria-label="Step through the slides">` +
      `<button type="button" data-xp-step="-1" aria-label="Previous slide"${i === 0 ? ' disabled' : ''}>‹</button><span class="xp-count">${i + 1}/${n}</span>` +
      `<button type="button" data-xp-step="1" aria-label="Next slide"${i === n - 1 ? ' disabled' : ''}>›</button></div>`
    const html = `<div class="xp" data-xp tabindex="0" role="group" aria-roledescription="slides" aria-label="Explain">` +
      `<div class="xp-bar"><nav class="xp-index" aria-label="Slides">${dots}</nav>${step}</div>` +
      `<section class="xp-slide xp-${s.kind}" aria-label="${esc(s.title)}"><h3 class="xp-h">${esc(s.title)}</h3>${body}</section></div>`
    return { html, charts, index: i }
  }
  const html = (flow, slides, index, opts) => render(flow, slides, index, opts).html

  const slidesFor = flow => X().slidesOf(flow)

  // ═══ fill: in place ═══

  const places = new Map() // flow id -> { kind, i } on show
  const modes = new Map() // flow id -> 'screens' | 'compare' (the Before and after slide)
  const drawn = new WeakMap() // root -> { html, charts }
  const shown = new WeakMap() // root -> the flow last drawn
  const bound = new WeakSet()

  function fill(root, flow) {
    if (!root || !flow) return
    bind(root)
    shown.set(root, flow)
    const slides = slidesFor(flow)
    const place = places.get(flow.id)
    const at = place ? Math.max(0, slides.findIndex(s => s.kind === place.kind)) : 0
    const index = place && slides[at]?.kind !== place.kind ? moveTo(place.i, 0, slides.length) : at
    const r = render(flow, slides, index, { compare: modes.get(flow.id) })
    places.set(flow.id, { kind: slides[r.index].kind, i: r.index })
    const prev = drawn.get(root)
    if (prev?.html === r.html) return redraw(root)
    const doc = root.ownerDocument
    const had = root.contains(doc.activeElement) ? doc.activeElement : null
    const again = had?.dataset?.xpStep ? `[data-xp-step="${had.dataset.xpStep}"]:not([disabled])` : had?.dataset?.xpGo ? `[data-xp-go="${r.index}"]` : '[data-xp]'
    root.innerHTML = r.html
    drawn.set(root, r)
    redraw(root)
    if (had) (root.querySelector(again) || root.querySelector('[data-xp]'))?.focus({ preventScroll: true })
  }

  /** Each chart drawn for the width of its own box; a box whose width has not changed keeps its SVG. */
  function redraw(root) {
    const charts = drawn.get(root)?.charts
    for (const host of root.querySelectorAll('[data-dg]')) {
      const c = charts?.get(host.dataset.dg)
      const w = host.clientWidth
      if (!c || !w) continue
      const at = `${w}|${JSON.stringify(c.graph)}`
      if (host._drawnAt === at) continue
      host._drawnAt = at
      host.innerHTML = window.Diagram.svg(c.graph, { dir: 'auto', maxWidth: w, title: c.title, cls: c.cls })
    }
  }

  function go(root, to) {
    const flow = shown.get(root)
    if (!flow) return
    const slides = slidesFor(flow)
    const i = moveTo(to, 0, slides.length)
    places.set(flow.id, { kind: slides[i].kind, i })
    fill(root, flow)
  }

  function bind(root) {
    if (bound.has(root)) return
    bound.add(root)
    window.Lightbox.bind(root)
    // the slider and the pair stepper on Before and after (flow-compare.js); its keys come first
    window.FlowCompare.bind(root, () => shown.get(root), flow => fill(root, flow))
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => redraw(root)).observe(root)
    const here = () => places.get(shown.get(root)?.id)?.i || 0
    root.addEventListener('click', e => {
      const step = e.target.closest('[data-xp-step]')
      if (step) return go(root, here() + Number(step.dataset.xpStep))
      const dot = e.target.closest('[data-xp-go]')
      if (dot) return go(root, Number(dot.dataset.xpGo))
      const cmp = e.target.closest('[data-xp-cmp]')
      const flow = shown.get(root)
      if (cmp && flow) { modes.set(flow.id, cmp.dataset.xpCmp); return fill(root, flow) }
      const q = e.target.closest('[data-xp-qa]')
      if (q) window.QaPage?.gotoFlow(q.dataset.xpQa)
    })
    root.addEventListener('keydown', e => {
      if (e.defaultPrevented || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
      if (!e.target.closest?.('[data-xp]') || e.target.closest('input, textarea, select, [role="slider"]')) return
      e.preventDefault()
      go(root, here() + (e.key === 'ArrowRight' ? 1 : -1))
    })
  }

  window.FlowExplainView = { html, moveTo, fill }
})()
