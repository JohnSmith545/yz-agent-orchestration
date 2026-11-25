// The Phone card on the Settings page (#/settings): phone access at a glance and its two safe buttons.
//
//   On or off, and why (remote.off); the address to open on the phone; when the phone PIN was set (never the PIN:
//   the page never sees it or its hash); how many phones are signed in; a sign-in lock in force; the newest sign-ins,
//   wrong PINs, lockouts and sign-outs; Sign out everywhere; Turn phone access off (only while it is on); and the
//   setup steps with the honest limits. Turning it ON and setting the PIN are terminal commands on purpose
//   (tools/phone-cli.mjs): a page driver can never open the door.
//
// The routes are phone-desktop-routes.mjs. settings-page.js puts html() in its page and calls open(root) after it
// mounts, so a redraw of the Settings page redraws this card from the state kept here.
//
//   html(view?)     PURE: the card for { data, status, error } (the state kept here when left out)
//   open(root)      fetch /api/phone, draw, and bind the two buttons once per root
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const state = { data: null, status: '', error: '' }

  const day = at => (Number.isNaN(Date.parse(at)) ? '' : new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))
  const exact = at => (Number.isNaN(Date.parse(at)) ? '' : new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))
  const WORDS = {
    login: 'Signed in', wrong: 'Wrong PIN', lockout: 'Locked for 15 minutes after 5 wrong PINs', signout: 'Signed out', 'signout-all': 'Signed out everywhere',
  }

  function eventLine(e) {
    const what = `${WORDS[e.kind] || e.kind}${e.kind === 'signout-all' && Number.isInteger(e.count) ? ` (${e.count})` : ''}`
    const when = window.Shell?.ago?.(e.at) || ''
    return `<li><time datetime="${esc(e.at)}" title="${esc(exact(e.at))}">${esc(when)}</time> <span>${esc(what)}${e.address ? ` · ${esc(e.address)}` : ''}</span></li>`
  }

  const STEPS = [
    'Install Tailscale on this PC and on the phone, and sign in to the same account. Or put both on your home Wi-Fi.',
    'In a terminal in this folder, run <code>node tools/factory.mjs phone-setup</code> and pick the address (the Tailscale one if you have it).',
    'Run <code>node tools/factory.mjs phone-pin</code> and type a PIN of 8 to 12 digits, different from your send PIN.',
    'Restart the dashboard. On the phone, open the address it shows and sign in with the PIN.',
    'Add it to the home screen: Share, then Add to Home Screen on an iPhone; the menu, then Add to Home screen on Android.',
  ]

  function html(view = state) {
    const d = view.data
    const head = '<section class="set-card" aria-label="Phone" data-phone-card><h3 class="set-h">Phone</h3>'
    if (!d) return `${head}<p class="set-muted">${view.error ? `Could not load: ${esc(view.error)}` : 'Loading…'}</p></section>`
    const r = d.remote || {}
    const line = r.enabled
      ? `<p class="pc-line"><span class="pc-dot is-on" aria-hidden="true"></span>On. Open <code>${esc(r.url)}</code> on your phone.</p>`
      : `<p class="pc-line"><span class="pc-dot" aria-hidden="true"></span>Off. ${r.configured ? esc(r.off || '') : 'Not set up yet: follow the steps below.'}</p>`
    const facts = [
      r.hasPin && !r.newPinNeeded ? `PIN set ${esc(day(r.pinSetAt) || 'earlier')}` : r.hasPin ? 'Set a new phone PIN of 8 digits or more: run node tools/factory.mjs phone-pin.' : 'No phone PIN yet.',
      `${Number(d.signedIn) || 0} ${Number(d.signedIn) === 1 ? 'phone' : 'phones'} signed in now`,
    ]
    const lock = d.lockedFor > 0 ? `<p class="pc-warn">Phone sign-in is locked for ${Math.max(1, Math.ceil(d.lockedFor / 60_000))} more minutes after 5 wrong PINs.</p>` : ''
    const events = (d.events || []).length ? `<ul class="pc-events">${d.events.map(eventLine).join('')}</ul>` : '<p class="set-faint">No sign-ins yet.</p>'
    const buttons = '<div class="set-row"><button type="button" data-phone-signout-all>Sign out everywhere</button>' +
      (r.enabled ? '<button type="button" class="link" data-phone-off>Turn phone access off</button>' : '') + '</div>'
    return head + line + `<p class="set-muted">${facts.join(' · ')}</p>` + lock + buttons +
      (view.status ? `<p class="set-status" role="status">${esc(view.status)}</p>` : '') +
      `<div class="set-field"><span class="set-k">Recent sign-ins and lockouts</span>${events}</div>` +
      `<div class="set-field"><span class="set-k">Set it up</span><ol class="pc-steps">${STEPS.map(s => `<li>${s}</li>`).join('')}</ol></div>` +
      '<p class="set-muted">The honest limits: this is plain HTTP on your private network. Tailscale encrypts the link between your devices; ' +
      'on Wi-Fi, anyone on that network can reach the sign-in page. The PIN is the only lock, and 5 wrong tries lock sign-in for 15 minutes. ' +
      'Never forward the port on your router.</p></section>'
  }

  const bound = new WeakSet()
  let current = null

  function redraw() {
    const el = current?.querySelector('[data-phone-card]')
    if (el) el.outerHTML = html()
  }

  async function load() {
    try {
      const r = await window.fetch('/api/phone')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
      Object.assign(state, { data: j, error: '' })
    } catch (e) {
      state.error = e.message
    }
    redraw()
  }

  async function post(url, done) {
    state.status = 'Working…'
    redraw()
    try {
      const r = await window.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const j = await r.json().catch(() => ({}))
      state.status = r.ok ? done(j) : j.error || `Failed (${r.status})`
    } catch (e) {
      state.status = e.message
    }
    await load()
  }

  function open(root) {
    current = root
    state.status = ''
    if (!bound.has(root)) {
      bound.add(root)
      root.addEventListener('click', e => {
        const t = e.target
        if (!t?.closest) return
        if (t.closest('[data-phone-signout-all]')) return post('/api/phone/signout-all', j => `Signed out ${j.count} ${j.count === 1 ? 'phone' : 'phones'}.`)
        if (t.closest('[data-phone-off]')) return post('/api/phone/off', () => 'Phone access is off. Run phone-setup in a terminal to turn it on again.')
      })
    }
    redraw()
    return load()
  }

  window.PhoneCard = { html, open }
})()
