// The phone-width bar's More sheet. Under 720 px the rail is a 56 px bar along the bottom (shell.css), and it had
// grown to about 20 icons, too small to tap and with the spend chip clipped at 390 px. Now the bar shows only the most
// used pages (RailGroups.bar: Home, Flows, Tickets, Agents), Ask and More (rail-more.css hides the rest there), and
// More opens this sheet: every other page in its rail group (RailGroups.more), then Alerts, Spend today, Phone on,
// Settings and Theme. At 720 px and wider nothing here shows and the rail is as it was.
//
// Rules this file keeps:
// - The sheet is a modal dialog: More says aria-expanded, the focus moves to the sheet's first link, Tab and Shift+Tab
//   stay inside it, Escape (taken with preventDefault, so the Ask drawer does not close too), Close or a tap outside
//   closes it and gives the focus back to More. Following a link closes it.
// - The Spend today and Phone on slots (spend.js, phone-notice.js find them by id) MOVE into the sheet while the
//   window is narrow and back to their places in the rail when it is wide, so each keeps its one button and its
//   popover. Alerts and Theme are proxies: the sheet's row clicks the real bell (notify.js) or the real theme switch
//   (theme.js), and the bell's count is copied onto More and the Alerts row so a waiting ask is not lost from view.
// - More is marked (as a page link is) while the page shown is one of its pages.
//
//   PURE: sheetHtml(groups, current), nextFocus(count, at, back), moreLit(view)
//   LIVE: mounts itself after shell.js; RailMore.light(view) re-marks it (the shell's route listener calls it)
;(() => {
  const R = window.RailGroups
  const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`
  const ICON = {
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    bell: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
    theme: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor"/>'),
  }

  /** The sheet: its heading and Close, the pages in their groups, then the things that lived in the bar's foot. */
  const sheetHtml = (groups, current) =>
    `<div class="rm-backdrop" data-rm-close></div>` +
    `<div class="rm-sheet" role="dialog" aria-modal="true" aria-labelledby="railMoreTitle">` +
    `<div class="rm-head"><h2 class="rm-title" id="railMoreTitle">More</h2><button type="button" class="rm-x" data-rm-close aria-label="Close">${ICON.close}</button></div>` +
    `<nav class="rm-nav" aria-label="More pages">${R.navHtml(groups, current, 'rm-')}</nav>` +
    `<div class="rail-group rm-foot" role="group" aria-labelledby="rm-foot"><div class="rail-group-head"><h2 class="rail-group-label" id="rm-foot">Also here</h2></div>` +
    `<button type="button" class="rail-item" data-rm-alerts><span class="rail-icon">${ICON.bell}<span class="rm-count" hidden></span></span><span class="rail-label">Alerts</span></button>` +
    `<div class="rm-slots" id="railMoreSlots"></div>` +
    `${R.linkHtml(R.linkFor('settings'), current)}` +
    `<button type="button" class="rail-item" data-rm-theme><span class="rail-icon">${ICON.theme}</span><span class="rail-label">Theme</span></button>` +
    `</div></div>`

  /** Where Tab (or Shift+Tab with `back`) goes from focusable `at` of `count`: wrap at the ends, null inside. */
  function nextFocus(count, at, back) {
    if (!count) return null
    if (at < 0) return back ? count - 1 : 0
    if (back && at === 0) return count - 1
    if (!back && at === count - 1) return 0
    return null
  }

  /** More stands for the page shown when that page is not in the bar. */
  const moreLit = view => typeof view === 'string' && !!view && !R.bar().includes(view)

  const api = { sheetHtml, nextFocus, moreLit, light: () => {} }
  window.RailMore = api

  // ═══ the live half ═══
  const doc = window.document
  if (!doc) return
  const rail = doc.getElementById('rail')
  const btn = doc.getElementById('railMore')
  if (!rail || !btn) return
  const narrow = window.matchMedia('(max-width: 720px)')
  let lit = null

  for (const a of rail.querySelectorAll('.rail-nav a.rail-item[data-view]')) a.classList.toggle('in-bar', R.bar().includes(a.dataset.view))

  const box = doc.createElement('div')
  box.id = 'railMoreSheet'
  box.className = 'rm'
  box.hidden = true
  box.innerHTML = sheetHtml(R.more(), null)
  doc.body.appendChild(box)

  // ─── the slots that move: each remembers what it stood before in the rail ───
  const slots = ['railSpend', 'railPhone'].map(id => doc.getElementById(id)).filter(Boolean).map(el => ({ el, before: el.nextElementSibling }))
  const shelf = box.querySelector('#railMoreSlots')
  function place() {
    if (narrow.matches) {
      for (const s of slots) shelf.appendChild(s.el)
      return
    }
    close(false)
    for (const s of [...slots].reverse()) s.before?.parentNode?.insertBefore(s.el, s.before)
  }

  const focusables = () => [...box.querySelectorAll('.rm-sheet a[href], .rm-sheet button:not([disabled])')].filter(el => !el.closest('[hidden]'))

  function open() {
    if (!narrow.matches) return
    box.hidden = false
    btn.setAttribute('aria-expanded', 'true')
    light(lit)
    paintCount()
    focusables()[0]?.focus()
  }
  function close(back = true) {
    if (box.hidden) return
    box.hidden = true
    btn.setAttribute('aria-expanded', 'false')
    if (back) btn.focus()
  }

  /** Mark the shown page in the sheet, and More itself when the page is one of its own. */
  function light(view) {
    lit = view
    btn.classList.toggle('is-lit', moreLit(view))
    for (const a of box.querySelectorAll('a.rail-item[data-view]')) {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page')
      else a.removeAttribute('aria-current')
    }
  }
  api.light = light

  // ─── the bell's count, copied onto More and the sheet's Alerts row ───
  function paintCount() {
    const count = doc.querySelector('#railAlerts .nt-count')
    const n = count && !count.hidden ? count.textContent : ''
    for (const el of [btn.querySelector('.rail-icon'), box.querySelector('[data-rm-alerts] .rail-icon')]) {
      let badge = el.querySelector('.rm-count')
      if (!badge) {
        badge = doc.createElement('span')
        badge.className = 'rm-count'
        el.appendChild(badge)
      }
      badge.hidden = !n
      badge.textContent = n
    }
    const row = box.querySelector('[data-rm-alerts]')
    row.setAttribute('aria-label', n ? `Alerts: ${n} waiting` : 'Alerts')
    btn.setAttribute('aria-label', n ? `More: ${n} alerts waiting` : 'More')
  }
  const alertsSlot = doc.getElementById('railAlerts')
  if (alertsSlot && window.MutationObserver) new window.MutationObserver(paintCount).observe(alertsSlot, { subtree: true, childList: true, attributes: true, characterData: true })

  btn.addEventListener('click', () => (box.hidden ? open() : close()))
  box.addEventListener('click', e => {
    if (e.target.closest('[data-rm-close]')) return close()
    if (e.target.closest('a.rail-item')) return close(false) // the link goes on to its page
    if (e.target.closest('[data-rm-alerts]')) {
      close(false)
      // after this click has finished, so the alerts panel's own outside-click rule does not shut it at once
      return window.setTimeout(() => doc.querySelector('#railAlerts .nt-bell')?.click(), 0)
    }
    if (e.target.closest('[data-rm-theme]')) doc.getElementById('themeToggle')?.click()
  })
  box.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      return close()
    }
    if (e.key !== 'Tab') return
    const list = focusables()
    const to = nextFocus(list.length, list.indexOf(doc.activeElement), e.shiftKey)
    if (to === null) return
    e.preventDefault()
    list[to].focus()
  })

  narrow.addEventListener?.('change', place)
  place()
  window.Shell?.onRoute?.(r => light(window.Shell.railFor(r)))
})()
