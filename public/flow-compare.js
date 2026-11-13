// The before and after of a flow's Picture block (flow-visual.js draws the block,
// this draws what changed). The agent records it with three commands
// (tools/change-cli.mjs and tools/flow-cli.mjs):
//
//   flow result <flow> --shot <file> --before     a screenshot of how it looked before (output.result[].when)
//   flow change <flow> --before "…" --after "…"   one line each: how it was, how it is now (output.change)
//   flow diagram <flow> "…" --before              how it worked before (output.diagramBefore)
//
// What the page shows from them:
//   strip      Before / Now, the two lines, a slim block of its own right under the Story (flow-output.js)
//   Screens    a pair: the before and the after side by side, each labelled, with a
//              1/3 stepper when there are several; shots with no partner under their own label
//   Compare    the after with the before laid over it, a handle to slide between them
//              (pointer, or ArrowLeft / ArrowRight, Home, End); offered only when both
//              shots of a pair are pictures
//   How        the diagram of how it worked before beside the one of now (stacked when narrow)
//
// The stepper place and the slider position live in memory for this page only:
// a redraw keeps them, a reload starts again at the first pair, in the middle.
//
//   pairs(m), views(m), clamp, nudge, posAt    PURE (the tests run them)
//   step, pos                                  the in-memory places
//   strip(m), screens(c, hero), compare(c), how(c)   markup for flow-visual.js
//   bind(root, flowOf, redraw)                 the slider and the stepper (flow-output.js bind)
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const chips = s => (window.Terms ? window.Terms.html(s) : s)
  // MUST CHANGE IN LOCKSTEP with flow-drawer.js IMAGE: only a picture can be laid over a picture
  const IMAGE = ['png', 'jpg', 'jpeg', 'webp', 'gif']
  const isImage = ref => IMAGE.includes(String(ref).split('.').pop().toLowerCase())
  const STEP_KEY = 5 // percent an arrow key moves the handle

  // ═══ pure ═══

  /**
   * The before shots paired with the agent's result shots, in the order recorded. The result the page
   * makes up from the flow's evidence (no `flow result` yet) is never paired: it may show something else.
   */
  function pairs(m) {
    const before = m.before || []
    const after = m.source?.result === 'agent' ? m.result : []
    const n = Math.min(before.length, after.length)
    return {
      pairs: before.slice(0, n).map((b, i) => ({ before: b, after: after[i] })),
      loneBefore: before.slice(n),
      loneAfter: after.slice(n),
    }
  }
  /** The pairs Compare can lay over each other: both shots pictures. */
  const imagePairs = m => pairs(m).pairs.filter(p => isImage(p.before.ref) && isImage(p.after.ref))

  /** The views the Picture switch offers, only those that exist: 'screens', 'compare', 'how'. */
  function views(m) {
    if (m.visual !== 'shots') return []
    return ['screens', ...(imagePairs(m).length ? ['compare'] : []), ...(m.diagram ? ['how'] : [])]
  }

  const clamp = v => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50)
  /** Where a key moves the handle from `at`, or null for a key that is not the slider. */
  function nudge(at, key) {
    if (key === 'ArrowLeft') return clamp(at - STEP_KEY)
    if (key === 'ArrowRight') return clamp(at + STEP_KEY)
    if (key === 'Home') return 0
    if (key === 'End') return 100
    return null
  }
  /** A pointer at `x` over a box from `left`, `width` wide, as a percent (the middle for a box of no width). */
  const posAt = (x, left, width) => (width > 0 ? clamp(((x - left) / width) * 100) : 50)

  // ═══ the in-memory places ═══

  const places = new Map() // flow id -> the pair on show
  const step = {
    raw: id => places.get(id) || 0,
    get: (id, n) => Math.max(0, Math.min(places.get(id) || 0, n - 1)),
    move(id, delta, n) {
      const i = Math.max(0, Math.min(step.get(id, n) + delta, n - 1))
      places.set(id, i)
      return i
    },
  }
  const slid = new Map() // `<flow id>|<pair>` -> percent
  const pos = {
    get: (id, i) => (slid.has(`${id}|${i}`) ? slid.get(`${id}|${i}`) : 50),
    set: (id, i, v) => { slid.set(`${id}|${i}`, clamp(v)) },
  }

  // ═══ markup ═══

  const picture = (ref, alt) => window.FlowDrawer.evidenceBody({ kind: 'shot', ref, label: alt })
  const label = text => `<figcaption class="cmp-label">${text}</figcaption>`

  /** Before / Now, one line each (flow-output.js puts them in their own block, labelled What changed); '' with no change. */
  function strip(m) {
    if (!m.change) return ''
    return '<div class="cmp-strip">' +
      `<p class="cmp-was"><span class="cmp-k">Before</span> ${chips(esc(m.change.before))}</p>` +
      `<p class="cmp-now"><span class="cmp-k">Now</span> ${chips(esc(m.change.after))}</p></div>`
  }

  /** ‹ 1/3 › for several pairs, '' for one. */
  function stepper(i, n) {
    if (n < 2) return ''
    return `<div class="cmp-step" role="group" aria-label="Pairs" data-cmp-n="${n}">` +
      `<button type="button" data-cmp-step="-1" aria-label="Previous pair"${i === 0 ? ' disabled' : ''}>‹</button>` +
      `<span class="cmp-count">${i + 1}/${n}</span>` +
      `<button type="button" data-cmp-step="1" aria-label="Next pair"${i === n - 1 ? ' disabled' : ''}>›</button></div>`
  }

  const side = (cls, name, s) => `<figure class="cmp-side ${cls}">${label(name)}${picture(s.ref, `${name}: ${s.caption || 'the result'}`)}` +
    `${s.caption ? `<p class="cmp-cap">${esc(s.caption)}</p>` : ''}</figure>`
  const film = (head, shots) => (shots.length ? `<p class="cmp-lone-h">${head}</p><ul class="pv-film">` +
    shots.map(s => `<li title="${esc(s.caption)}">${picture(s.ref, s.caption || head)}</li>`).join('') + '</ul>' : '')

  /**
   * The Screens body when there is a before: the pair on show, the stepper, then the shots with no
   * partner. No pair (only a before shot): `hero(m)`, flow-visual.js's own one big image, leads. Null
   * when there is no before shot at all, so flow-visual.js draws its plain Screens.
   */
  function screens(c, hero) {
    const { m, flow } = c
    const p = pairs(m)
    if (!p.pairs.length && !p.loneBefore.length) return null
    const lone = film('Before, no after yet', p.loneBefore)
    if (!p.pairs.length) return `${m.result.length ? hero(m) : ''}${lone}`
    const i = step.get(flow.id, p.pairs.length)
    const { before, after } = p.pairs[i]
    return `<div class="cmp-pair">${side('cmp-before', 'Before', before)}${side('cmp-after', 'After', after)}</div>` +
      stepper(i, p.pairs.length) + film('After', p.loneAfter) + lone
  }

  /** The Compare body: the after, the before laid over it up to the handle. */
  function compare(c) {
    const { m, flow } = c
    const list = imagePairs(m)
    const i = step.get(flow.id, list.length)
    const { before, after } = list[i]
    const at = pos.get(flow.id, i)
    const url = s => esc(window.FlowDrawer.evidenceUrl(s.ref))
    const alt = (name, s) => esc(s.caption ? `${name}: ${s.caption}` : name)
    return `<div class="cmp-slider" data-cmp-slider="${i}" style="--pos: ${at}%">` +
      `<img class="cmp-img" src="${url(after)}" alt="${alt('After', after)}" draggable="false">` +
      `<div class="cmp-clip"><img class="cmp-img" src="${url(before)}" alt="${alt('Before', before)}" draggable="false"></div>` +
      '<span class="cmp-tag cmp-tag-before" aria-hidden="true">Before</span><span class="cmp-tag cmp-tag-after" aria-hidden="true">After</span>' +
      `<div class="cmp-handle" role="slider" tabindex="0" aria-label="Before and after" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${at}" aria-valuetext="${at}% before"></div>` +
      '</div>' + stepper(i, list.length)
  }

  /** How it works: with a diagram of how it worked before, the two side by side, each labelled. */
  function how(c) {
    const { m } = c
    const now = c.chart('how', m.diagram, 'How it works')
    if (!m.diagramBefore) return now
    const fig = (name, chart) => `<figure class="cmp-how-side">${label(name)}${chart}</figure>`
    return `<div class="cmp-how">${fig('Before', c.chart('howBefore', m.diagramBefore, 'How it worked before'))}${fig('Now', now)}</div>`
  }

  // ═══ the slider and the stepper ═══

  /** Binds once per root. `flowOf()` is the flow on show; `redraw(flow)` draws it again (a step moved). */
  function bind(root, flowOf, redraw) {
    const put = (slider, v) => {
      const at = Math.round(clamp(v) * 10) / 10
      slider.style.setProperty('--pos', `${at}%`)
      const handle = slider.querySelector('.cmp-handle')
      handle?.setAttribute('aria-valuenow', String(at))
      handle?.setAttribute('aria-valuetext', `${at}% before`)
      const flow = flowOf()
      if (flow) pos.set(flow.id, Number(slider.dataset.cmpSlider) || 0, at)
    }
    const follow = (slider, e) => {
      const r = slider.getBoundingClientRect()
      put(slider, posAt(e.clientX, r.left, r.width))
    }
    root.addEventListener('pointerdown', e => {
      const slider = e.target.closest?.('[data-cmp-slider]')
      if (!slider || e.button > 0) return
      e.preventDefault() // no image drag, no text selection
      slider.setPointerCapture?.(e.pointerId)
      slider.querySelector('.cmp-handle')?.focus({ preventScroll: true })
      follow(slider, e)
    })
    root.addEventListener('pointermove', e => {
      const slider = e.target.closest?.('[data-cmp-slider]')
      if (slider?.hasPointerCapture?.(e.pointerId)) follow(slider, e)
    })
    root.addEventListener('keydown', e => {
      const handle = e.target.closest?.('.cmp-handle')
      if (!handle) return
      const at = nudge(Number(handle.getAttribute('aria-valuenow')), e.key)
      if (at === null) return
      e.preventDefault()
      put(handle.closest('[data-cmp-slider]'), at)
    })
    root.addEventListener('click', e => {
      const btn = e.target.closest?.('[data-cmp-step]')
      const flow = flowOf()
      if (!btn || !flow) return
      step.move(flow.id, Number(btn.dataset.cmpStep), Number(btn.closest('[data-cmp-n]')?.dataset.cmpN) || 1)
      redraw(flow)
    })
  }

  window.FlowCompare = { pairs, views, clamp, nudge, posAt, step, pos, strip, screens, compare, how, bind }
})()
