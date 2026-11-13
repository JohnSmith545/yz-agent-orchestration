// Zoom and pan for the Flow view (flow.js). Owns the controls and the input:
//   − / 100% / + buttons, and Fit (the whole window fits the width)
//   Ctrl or ⌘ + scroll, or a trackpad pinch, zooms around the pointer
//   keys when no field has focus: + and − step, 0 is 100%, F fits
//   dragging the chart background pans
// flow.js owns the drawing: it is handed the new zoom (a number, or 'fit')
// and the screen point to keep still, and re-lays the chart at that scale.
;(() => {
  const MIN = 0.04 // low enough for Fit to show a busy day in one screen
  const MAX = 1.75
  const STEP = 1.2
  const PAN_START = 3 // px before a press on the background becomes a pan

  const clamp = z => Math.min(MAX, Math.max(MIN, z))
  const ICON = {
    out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
    in: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg>',
  }

  const controls = () => `
    <div class="group" role="group" aria-label="Zoom" title="Ctrl + scroll to zoom, drag the background to pan"><span class="lbl">Zoom</span>
      <div class="zoombox">
        <button type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out (−)">${ICON.out}</button>
        <button type="button" data-zoom="reset" class="zpct" title="Back to 100% (0)">100%</button>
        <button type="button" data-zoom="in" aria-label="Zoom in" title="Zoom in (+)">${ICON.in}</button>
      </div>
      <button type="button" class="link" data-zoom="fit" aria-pressed="false" title="Fit the whole window to the width (F)">Fit</button>
    </div>`

  /**
   * Wire the controls in `tools` and the input on `scroller`.
   * opts.current(): the zoom in effect now (a number)
   * opts.apply(next, anchor): next is a number or 'fit'; anchor is
   *   { x, y } in client px, or null for the middle of the view
   * opts.active(): false while the Flow view is hidden
   */
  function attach(tools, scroller, opts) {
    const center = () => {
      const r = scroller.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    const step = (dir, anchor) => opts.apply(clamp(opts.current() * (dir > 0 ? STEP : 1 / STEP)), anchor || center())

    tools.addEventListener('click', e => {
      const b = e.target.closest('button[data-zoom]')
      if (!b) return
      const z = b.dataset.zoom
      if (z === 'in') step(1)
      else if (z === 'out') step(-1)
      else if (z === 'reset') opts.apply(1, center())
      else if (z === 'fit') opts.apply('fit', null)
    })

    // Wheel events arrive faster than frames: gather them, draw once a frame.
    let pending = 1
    let at = null
    let frame = 0
    scroller.addEventListener(
      'wheel',
      e => {
        if (!e.ctrlKey && !e.metaKey) return
        e.preventDefault()
        pending *= Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022))
        at = { x: e.clientX, y: e.clientY }
        if (frame) return
        frame = requestAnimationFrame(() => {
          frame = 0
          const next = clamp(opts.current() * pending)
          pending = 1
          if (Math.abs(next - opts.current()) > 0.001) opts.apply(next, at)
        })
      },
      { passive: false }
    )

    document.addEventListener('keydown', e => {
      if (!opts.active() || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.target.closest?.('input, select, textarea, [contenteditable="true"]')) return
      if (document.querySelector('.modal')) return
      if (e.key === '+' || e.key === '=') step(1)
      else if (e.key === '-' || e.key === '_') step(-1)
      else if (e.key === '0') opts.apply(1, center())
      else if (e.key === 'f' || e.key === 'F') opts.apply('fit', null)
      else return
      e.preventDefault()
    })

    // Pan: press on the chart background (not a node, label or control) and drag.
    let pan = null
    scroller.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !e.target.closest('svg.flow') || e.target.closest('.fn')) return
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop, on: false }
    })
    scroller.addEventListener('pointermove', e => {
      if (!pan || pan.id !== e.pointerId) return
      const dx = e.clientX - pan.x
      const dy = e.clientY - pan.y
      if (!pan.on) {
        if (Math.hypot(dx, dy) < PAN_START) return
        pan.on = true
        scroller.classList.add('panning')
        try {
          scroller.setPointerCapture(e.pointerId)
        } catch {}
      }
      scroller.scrollLeft = pan.left - dx
      scroller.scrollTop = pan.top - dy
    })
    const end = e => {
      if (!pan || pan.id !== e.pointerId) return
      pan = null
      scroller.classList.remove('panning')
    }
    scroller.addEventListener('pointerup', end)
    scroller.addEventListener('pointercancel', end)
    scroller.addEventListener('lostpointercapture', end)
  }

  /** Show the zoom in effect: the percentage, and whether Fit is on. */
  function show(tools, z, fit) {
    const pct = tools.querySelector('.zpct')
    if (pct) pct.textContent = `${Math.round(z * 100)}%`
    tools.querySelector('button[data-zoom="fit"]')?.setAttribute('aria-pressed', String(fit))
    tools.querySelector('button[data-zoom="in"]')?.toggleAttribute('disabled', z >= MAX - 0.001)
    tools.querySelector('button[data-zoom="out"]')?.toggleAttribute('disabled', z <= MIN + 0.001)
  }

  window.FlowZoom = { MIN, MAX, clamp, controls, attach, show }
})()
