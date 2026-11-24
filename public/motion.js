// Motion (spec 8, the reactbits.dev ideas in plain CSS and a few lines here):
//   spotlight(rootEl)   a cursor-following highlight on the card border
//                       ("Spotlight Card"). One delegated pointermove on the
//                       root writes --mx/--my on the card under the pointer
//                       and gives it the `spot` class; shell.css draws the
//                       ring. No transform, no opacity, nothing moves.
//   enterList(listEl)   the items fade and rise in once, 30 ms apart
//                       ("Animated List"): ONLY the first render of a list
//                       that has items; a poll re-render never animates.
//   countUp(el, to)     a number counts from what it shows to `to` over
//                       300 ms ("Count Up") and lands on `to` exactly.
// Under prefers-reduced-motion all three stand down: spotlight and enterList
// do nothing, countUp writes the final value at once.
//
// No DOM at load, so test/motion.test.mjs runs it in a vm with a stub window.
;(() => {
  const STAGGER_MS = 30
  const STAGGER_CAP = 12 // a long list stops waiting after the twelfth item
  const COUNT_MS = 300
  // Every card that can carry the spotlight. Scroll areas are left out: their
  // mask and their scrolling content would carry the ring away.
  const SPOT = '.card, .ac-tile, .fl-card'

  const reduced = () => {
    try {
      return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
    } catch {
      return false
    }
  }

  function spotlight(rootEl) {
    if (!rootEl || reduced()) return
    rootEl.addEventListener('pointermove', e => {
      const card = e.target?.closest?.(SPOT)
      if (!card || card.matches?.('.scroll, .tablewrap')) return
      const r = card.getBoundingClientRect()
      card.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`)
      card.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`)
      card.classList.add('spot')
    })
  }

  const entered = new WeakSet()
  /** `items` picks the rows inside `listEl` (default: its children). */
  function enterList(listEl, items) {
    if (!listEl || entered.has(listEl) || reduced()) return
    const rows = [...(items ? listEl.querySelectorAll(items) : listEl.children)]
    if (!rows.length) return // nothing drawn yet: the first real render still enters
    entered.add(listEl)
    rows.forEach((row, i) => {
      row.style.setProperty('--i', String(Math.min(i, STAGGER_CAP)))
      row.classList.add('enter')
      // One-shot: a later re-render of the same node never replays it.
      row.addEventListener?.('animationend', () => row.classList.remove('enter'), { once: true })
    })
  }

  const running = new WeakMap() // el -> { frame } of its count, so a newer count wins
  function countUp(el, to) {
    if (!el) return
    const end = Number(to)
    const from = Number.parseFloat(el.textContent)
    const before = running.get(el)
    if (before) window.cancelAnimationFrame?.(before.frame)
    running.delete(el)
    if (!Number.isFinite(end) || !Number.isFinite(from) || from === end || reduced() || !window.requestAnimationFrame) {
      el.textContent = String(to)
      return
    }
    const now = () => window.performance?.now?.() ?? Date.now()
    const start = now()
    const mine = { frame: 0 }
    const tick = () => {
      if (running.get(el) !== mine) return // a newer count took over
      const t = Math.min(1, (now() - start) / COUNT_MS)
      if (t >= 1) {
        running.delete(el)
        el.textContent = String(to) // exactly the value asked for
        return
      }
      const eased = 1 - (1 - t) ** 3
      el.textContent = String(Math.round(from + (end - from) * eased))
      mine.frame = window.requestAnimationFrame(tick)
    }
    running.set(el, mine)
    mine.frame = window.requestAnimationFrame(tick)
  }

  window.Motion = { spotlight, enterList, countUp }
})()
