// Home's first zone (spec F2): Since you were away. One compact card, headed
// `Since 23:10`, listing at most eight one-fact lines the server built from
// data it already has (GET /api/since, since.mjs): flow changes, answers
// delivered, levels reached, ticket state changes, commits per agent. Nothing
// here is written by a model. Hidden when nothing happened.
//
// The baseline is localStorage `home.since`, and ONLY `Mark read` moves it
// (to now). A brand-new browser has none: the first load sets it to now, so
// the card never lists the whole history. Hiding, leaving or reloading the
// page changes nothing, so the card stays until it is marked read; the
// eight-line cap and the priority order keep it bounded meanwhile.
// (An earlier rule stored a last-seen time on every hide; a reload is a hide, so
// the card vanished on every reload. Ruled a spec defect, 2026-11-13.)
//
// app.js mounts it on the Home route and unmounts it on leave, as it does the
// flows strip. Every line's text is escaped here: a flow title is whatever an
// agent wrote. Storage that throws (a locked-down browser) leaves the card hidden.
;(() => {
  const KEY = 'home.since'
  const HELP =
    '<p>What happened since you last marked this read: flows that changed status, answers delivered to agents, tickets that reached a new level or changed on their source, and commits per agent.</p>' +
    '<p>Built from what the dashboard already records; no model writes it. <b>Mark read</b> clears it until something new happens.</p>'
  const store = {
    get() {
      try {
        return window.localStorage.getItem(KEY)
      } catch {
        return null
      }
    },
    set(v) {
      try {
        window.localStorage.setItem(KEY, v)
      } catch {}
    },
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const ORDER = ['flows', 'deliveries', 'levels', 'tickets', 'commits']
  const pad = n => String(n).padStart(2, '0')
  const dayKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  /** Pure: the card head for the baseline (home.since), in local time: `Since 23:10`, `Since yesterday 23:10`, or `Since 9 Nov 23:10`. */
  function head(iso, now = new Date()) {
    const t = new Date(iso)
    if (Number.isNaN(t.getTime())) return 'Since'
    const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    if (dayKey(t) === dayKey(now)) return `Since ${hm}`
    if (dayKey(t) === dayKey(yesterday)) return `Since yesterday ${hm}`
    return `Since ${t.getDate()} ${MONTHS[t.getMonth()]} ${hm}`
  }

  /** Pure: the card's HTML for a digest, '' when it has no lines. */
  function html(digest, since, now = new Date()) {
    const lines = ORDER.flatMap(k => (Array.isArray(digest?.[k]) ? digest[k] : []))
    if (!lines.length) return ''
    const row = l => {
      const data = l.ticket ? ` data-ticket="${esc(l.ticket)}"` : l.flow ? ` data-flow="${esc(l.flow)}"` : ''
      return `<li><a class="since-line" href="${esc(l.href || '#/')}"${data}><span class="since-text">${esc(l.text)}</span><span class="since-at faint">${esc(window.Shell?.ago(l.at) ?? '')}</span></a></li>`
    }
    return `<section class="card since"><div class="card-head"><h3>${esc(head(since, now))}</h3>
        <span class="since-acts"><button type="button" class="help" aria-label="About Since you were away">?</button><a href="#/" class="link" data-read>Mark read</a></span></div>
        <ul class="since-list">${lines.map(row).join('')}</ul></section>`
  }

  // The baseline. None yet (a brand-new browser): start it now, so the first card is not the whole history.
  // Not a past time (hand-edited, or a clock that ran ahead): also now, or the
  // server answers an empty digest forever and Mark read is never offered.
  let since = store.get()
  const t = since ? Date.parse(since) : NaN
  if (Number.isNaN(t) || t > Date.now()) {
    since = new Date().toISOString()
    store.set(since)
  }
  let box = null
  let gen = 0

  function hide() {
    if (!box) return
    box.innerHTML = ''
    box.hidden = true
  }
  async function load() {
    if (!box) return
    const g = ++gen
    try {
      const r = await fetch(`/api/since?t=${encodeURIComponent(since)}`)
      if (!r.ok) throw new Error(String(r.status))
      const d = await r.json()
      if (g !== gen || !box) return
      const out = html(d, since)
      if (!out) return hide()
      box.innerHTML = out
      box.hidden = false
      window.Help?.attach(box.querySelector('.help'), HELP)
    } catch {
      if (g === gen) hide() // a failed digest is no card, never an error on Home
    }
  }

  /** A line or Mark read: through the shell helpers, so a flow or ticket opens where it lives. */
  function open(a, w = window) {
    if (a.dataset.ticket && w.FactoryView?.gotoTicket) return w.FactoryView.gotoTicket(a.dataset.ticket)
    if (a.dataset.flow && w.FlowsView?.gotoFlow) return w.FlowsView.gotoFlow(a.dataset.flow)
    window.Shell?.go(a.getAttribute('href'))
  }
  function onClick(e) {
    if (e.target.closest('[data-read]')) {
      e.preventDefault()
      return markRead()
    }
    const a = e.target.closest('a.since-line')
    if (!a) return
    e.preventDefault()
    open(a)
  }

  function markRead() {
    since = new Date().toISOString()
    store.set(since)
    gen++ // a digest still in flight lands nowhere
    hide()
  }

  window.Since = {
    head,
    html,
    /** Home's first zone. Idempotent; asks for the digest each time Home shows. */
    mount(el) {
      if (!el) return
      if (box !== el) {
        if (box) box.removeEventListener('click', onClick)
        box = el
        box.addEventListener('click', onClick)
      }
      load()
    },
    /** Leave Home: drop the card; with `el`, only if that box still holds it. */
    unmount(el) {
      if (!box || (el && box !== el)) return
      box.removeEventListener('click', onClick)
      gen++
      hide()
      box = null
    },
    markRead,
    _open: open, // tests
  }

  if (!window.document) return
  // Back on the tab: the same baseline, with whatever happened meanwhile. Nothing is stored here.
  window.document.addEventListener('visibilitychange', () => {
    if (window.document.visibilityState === 'visible' && box) load()
  })
})()
