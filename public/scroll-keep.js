// ScrollKeep: bring one element to the top of the screen, clear of the sticky page header, and KEEP it there while
// the page above it is still laying out. A page that draws in steps (the Tickets page: its table, then the grid
// above it a moment later) moves a row down after a plain scrollIntoView, and the row lands far below the window
// (QA, 2026-11-25: a ticket opened from Human review ended up 1,100 px down a 900 px window).
//
//   ScrollKeep.to(target, opts)   target: an element, or a function that finds it again (the page may redraw the
//                                 row: the fresh one is used every time). Scrolls once (smooth, unless reduced
//                                 motion), then again, instantly, whenever the page's size changes, until the user
//                                 scrolls, clicks or presses a key, or `ms` (6 s) pass. Returns stop().
//   ScrollKeep.topFor(rectTop, scrollY, headerH, gap?)   PURE: the scroll position that puts the element under the header
;(() => {
  const GAP = 12

  /** The window scroll that puts an element whose box starts at `rectTop` (viewport px) just under the header. */
  const topFor = (rectTop, scrollY, headerH, gap = GAP) => Math.max(0, Math.round(rectTop + scrollY - headerH - gap))

  /** `deps` are for the tests: { win, doc, RO } (the window, the document, the ResizeObserver class). */
  function to(target, { ms = 6000, win = window, doc = window.document, RO = window.ResizeObserver } = {}) {
    const find = typeof target === 'function' ? target : () => target
    const reduce = !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const header = () => doc.getElementById?.('pageHead')?.offsetHeight || 0
    const place = smooth => {
      const el = find()
      if (!el?.isConnected) return
      win.scrollTo({ top: topFor(el.getBoundingClientRect().top, win.scrollY || 0, header()), behavior: smooth && !reduce ? 'smooth' : 'auto' })
    }
    const ro = RO ? new RO(() => place(false)) : null
    const USER = ['wheel', 'touchstart', 'keydown', 'mousedown']
    let timer = 0
    function stop() {
      ro?.disconnect()
      for (const t of USER) win.removeEventListener(t, stop, true)
      win.clearTimeout(timer)
    }
    place(true)
    ro?.observe(doc.body)
    for (const t of USER) win.addEventListener(t, stop, true)
    timer = win.setTimeout(stop, ms)
    return stop
  }

  window.ScrollKeep = { to, topFor }
})()
