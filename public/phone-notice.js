// Phone access, visible on every desktop page (review point 3: turning it on from a terminal is no boundary against
// a local agent that can write config.json, so nothing about it may happen quietly).
//
// - While phone access is on, the rail ends with a small **Phone on** badge that links to the Phone card on Settings.
// - Every phone sign-in, lockout, escalation, damaged sign-in file, PIN change and change of remote.enabled or
//   remote.bind (phone-auth.mjs events, noted by the server's watcher) raises a toast. The ones that may mean someone
//   else is at work (a lockout, an escalation, a damaged file, a config change, a PIN changed outside phone-pin) stay
//   until dismissed. The same events are lines in the Log and on the Phone card, so a missed toast is never lost.
// - Which events this browser has already shown is a per-viewer convenience in localStorage (wrapped: a private
//   window simply shows the last hour again); the record that matters is the server's.
//
//   fresh(events, seenAt)   the events to raise now, oldest first
//   textOf(e) / urgent(e)   the sentence, and whether it stays until dismissed
//   badgeHtml(on)           the rail badge, or '' when phone access is off
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const KINDS = ['login', 'lockout', 'escalate', 'damaged', 'pin', 'config']
  const POLL_MS = 20_000
  const SEEN_KEY = 'phone.noticeSeen'

  const fresh = (events, seenAt) => (Array.isArray(events) ? events : [])
    .filter(e => KINDS.includes(e?.kind) && String(e.at) > String(seenAt || ''))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))

  function textOf(e) {
    const from = e.address ? ` from ${e.address}` : ''
    switch (e.kind) {
      case 'login': return `A phone signed in${from}.`
      case 'lockout': return `Phone sign-in was locked for 15 minutes after 5 wrong PINs${e.address ? ` (the last from ${e.address})` : ''}.`
      case 'escalate': return '3 lockouts within 24 hours: phone access was turned off. Turn it on again at the PC only if that was you.'
      case 'damaged': return 'The phone sign-in file was damaged: a copy was kept and sign-in is locked for 15 minutes.'
      default: return String(e.text || '')
    }
  }

  const urgent = e => (e.kind === 'pin' ? e.outside === true : e.kind !== 'login')

  const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>'
  const badgeHtml = on => (on
    ? `<a class="rail-item rail-phone" href="#/settings" data-phone-badge title="Phone access is on: open its card in Settings"><span class="rail-icon">${ICON}<i class="rail-phone-dot" aria-hidden="true"></i></span><span class="rail-label">Phone on</span></a>`
    : '')

  window.PhoneNotice = { fresh, textOf, urgent, badgeHtml }

  // ═══ live (the desktop page only: the tests load this with a bare window) ═══
  const doc = window.document
  if (!doc?.getElementById) return

  const seenGet = () => { try { return window.localStorage.getItem(SEEN_KEY) } catch { return null } }
  const seenSet = at => { try { window.localStorage.setItem(SEEN_KEY, at) } catch { /* private window: shown again next load */ } }

  function badge(on) {
    const nav = doc.querySelector('#rail .rail-nav')
    const had = doc.querySelector('[data-phone-badge]')
    if (on && !had && nav) nav.insertAdjacentHTML('beforeend', badgeHtml(true)) // a new rail entry goes at the END
    if (!on && had) had.remove()
  }

  async function poll() {
    let j
    try {
      const r = await window.fetch('/api/phone', { cache: 'no-store' })
      if (!r.ok) return
      j = await r.json()
    } catch {
      return
    }
    badge(!!j?.remote?.enabled)
    const seen = seenGet() || new Date(Date.now() - 3600_000).toISOString()
    const list = fresh(j?.events, seen)
    for (const e of list) window.Notifier?.toast(esc(textOf(e)), { kind: urgent(e) ? 'decision' : 'info', sticky: urgent(e) })
    if (list.length) seenSet(list.at(-1).at)
  }

  const start = () => {
    poll()
    window.setInterval(() => { if (doc.visibilityState !== 'hidden') poll() }, POLL_MS)
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start)
  else start()
})()
