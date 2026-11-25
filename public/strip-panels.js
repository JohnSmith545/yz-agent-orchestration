// The panel redraw and the bars' one tab stop, shared by the Pipeline time and Pipeline tokens blocks on the Agents
// page (time-strip.js, token-strip.js). Pure parts first, so test/strip-panels.test.mjs runs them in a vm.
//
//   StripPanels.withOpen(html, states)   html with its Nth <details> open exactly when states[N] is true (null or a
//                                        missing entry: the html's own default)
//   StripPanels.rovingTo(cols, target)   target the ONLY bar at tabindex 0, every other -1; returns target
//   StripPanels.keyTarget(key, i, n)     where ArrowLeft, ArrowRight, Home and End go from bar i of n (null: nowhere)
//   StripPanels.swap(node, html)         draw a panel again: disclosures stay as the user left them, a focused bar
//                                        keeps the focus (by its place in the row) and the one tab stop
//   StripPanels.rove(el)                 the bars of `el` (.ptm-col) as one tab stop: the arrow keys, Home and End
//                                        move along them, and a click moves the tab stop too
//
// ⚠️ Why: a panel is drawn again whenever its HTML changes (about once a minute while a session works), and setting
// innerHTML closed an open As a list every time (QA, 2026-11-25). And the tab stop moved only on a key, so after a
// click two bars were at tabindex 0 and Tab stopped twice in one chart.
;(() => {
  const OPEN = /\sopen(?:=(?:""|"open"|''|'open'|open))?(?=[\s>])/
  const TAG = /<details\b[^>]*>/gi

  function withOpen(html, states) {
    if (!Array.isArray(states) || !states.length) return html
    let i = 0
    return String(html).replace(TAG, tag => {
      const want = states[i++]
      if (typeof want !== 'boolean') return tag
      const bare = tag.replace(OPEN, '')
      return want ? bare.replace(/>$/, ' open>') : bare
    })
  }

  function rovingTo(cols, target) {
    if (!target) return null
    for (const c of cols) c.tabIndex = c === target ? 0 : -1
    return target
  }

  function keyTarget(key, i, n) {
    const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: n - 1 }[key]
    return to === undefined || to < 0 || to >= n ? null : to
  }

  const BAR = '.ptm-col'

  function swap(node, html) {
    const states = [...node.querySelectorAll('details')].map(d => d.open)
    const focused = node.contains(document.activeElement) ? document.activeElement?.dataset?.bar : undefined
    node.innerHTML = withOpen(html, states)
    if (focused === undefined) return
    const cols = [...node.querySelectorAll(BAR)]
    rovingTo(cols, cols.find(c => c.dataset.bar === focused) || cols.at(-1))?.focus()
  }

  function rove(el) {
    el.addEventListener('keydown', e => {
      const col = e.target.closest?.(BAR)
      if (!col) return
      const cols = [...col.parentElement.querySelectorAll(BAR)]
      const to = keyTarget(e.key, cols.indexOf(col), cols.length)
      if (to === null) return
      e.preventDefault()
      rovingTo(cols, cols[to]).focus()
    })
    // a click (or any focus) on a bar moves the tab stop to it
    el.addEventListener('focusin', e => {
      const col = e.target.closest?.(BAR)
      if (col) rovingTo([...col.parentElement.querySelectorAll(BAR)], col)
    })
  }

  window.StripPanels = { withOpen, rovingTo, keyTarget, swap, rove }
})()
