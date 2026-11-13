// The ? popover (spec 5 and 6): a legend, the sentence behind a number, the
// meta behind the header chip and the how-to behind an empty state live here,
// never on the page. Help.attach(el, html) turns `el` (a
// <button class="help">?</button>) into its trigger: a click (Enter and Space
// on a button are clicks) opens ONE shared popover under it; a second click,
// Escape, a press outside, a scroll that moves it or a resize closes it. Attaching again
// only updates the text, and an open popover shows the new text at once.
//
// ⚠️ `html` goes in as HTML: callers pass markup they own, and anything an
// agent wrote must already be through esc() at the call site.
//
// Sits at z-index 45 like the explain popover and the alerts panel (above the
// chat drawer, under modals and toasts); tokens only, so dark mode follows.
;(() => {
  const doc = window.document || document
  const M = 8 // px from the button and from the window edge
  let pop = null
  let owner = null // the ? the popover belongs to while open

  function ensure() {
    if (pop) return pop
    pop = doc.createElement('div')
    pop.className = 'help-pop'
    pop.hidden = true
    pop.setAttribute('role', 'dialog')
    pop.setAttribute('aria-label', 'Help')
    doc.body.appendChild(pop)
    // Capture: one Escape closes one thing, before the shell closes the drawer.
    doc.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !owner) return
      e.preventDefault()
      e.stopPropagation()
      const back = owner
      close()
      back.focus?.()
    }, true)
    doc.addEventListener('mousedown', e => {
      if (!owner || pop.contains(e.target) || owner.contains?.(e.target)) return
      close()
    }, true)
    // Only a scroll that carries the ? away closes it (the page, or a box holding the ?):
    // a live feed or a chart scrolling itself elsewhere leaves the popover where it is.
    // A ? that is gone (a redraw dropped it, or its page or card is hidden) closes it on any scroll.
    const gone = o => o.isConnected === false || (typeof o.getClientRects === 'function' && o.getClientRects().length === 0)
    doc.addEventListener('scroll', e => {
      if (owner && !pop.contains(e.target) && (e.target?.contains?.(owner) || gone(owner))) close()
    }, { capture: true, passive: true })
    window.addEventListener?.('resize', () => owner && close())
    return pop
  }

  function place(el) {
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth || 1024
    const vh = window.innerHeight || 768
    const w = pop.offsetWidth || 300
    const h = pop.offsetHeight || 100
    // Left edge under the ?, pulled in from the right edge (the header chip sits there); above it when there is no room below.
    const x = Math.max(M, Math.min(r.left, vw - w - M))
    const y = r.bottom + M + h <= vh - M ? r.bottom + M : Math.max(M, r.top - h - M)
    pop.style.left = `${x}px`
    pop.style.top = `${y}px`
  }

  function open(el) {
    ensure()
    if (owner && owner !== el) owner.setAttribute('aria-expanded', 'false')
    owner = el
    pop.innerHTML = el._helpHtml
    pop.hidden = false
    el.setAttribute('aria-expanded', 'true')
    place(el)
  }
  function close() {
    if (!pop || !owner) return
    owner.setAttribute('aria-expanded', 'false')
    owner = null
    pop.hidden = true
  }

  function attach(el, html) {
    if (!el) return el
    el._helpHtml = String(html ?? '')
    if (!el._helpWired) wire(el)
    // A poll that redraws a card swaps its ? for a new node: the same ? (same
    // aria-label) takes the open popover over instead of leaving it orphaned.
    if (owner && owner !== el && owner.isConnected === false && owner.getAttribute('aria-label') === el.getAttribute('aria-label')) open(el)
    else if (owner === el) {
      pop.innerHTML = el._helpHtml
      place(el)
    }
    return el
  }
  function wire(el) {
    el._helpWired = true
    el.setAttribute('aria-haspopup', 'dialog')
    el.setAttribute('aria-expanded', 'false')
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', 'What this shows')
    el.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation() // the ? may sit inside a clickable card
      owner === el ? close() : open(el)
    })
    // A <button> turns Enter and Space into a click; anything else needs them here.
    el.addEventListener('keydown', e => {
      if (el.tagName === 'BUTTON' || (e.key !== 'Enter' && e.key !== ' ')) return
      e.preventDefault()
      open(el)
    })
  }

  window.Help = { attach, close }
})()
