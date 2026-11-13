// The Settings page (#/settings): two calm sections.
//
//   Sending      a switch `Send to <base>`; the branches it may open pull requests into; the send PIN:
//                none yet → two fields and Set PIN; one set → the current one, the new one twice, Change
//                PIN, and `Forgot it? Reset` (the new one twice, Reset PIN). One plain status line each.
//   Your setup   read-only: the watched repo, where config.json is, the session labels, the chat, the
//                ticket prefixes, the reminders; `Change these in config.json, then restart the dashboard.`
//
// The routes are settings-routes.mjs. Setting the FIRST PIN, a RESET, turning sending ON and changing the
// branches are confirmed by the person in a system window outside the browser (native-confirm.mjs), so the
// status says it is waiting for them while the request is open. The PIN fields are read at the click, sent
// once and emptied; nothing here keeps a PIN, and the page never sees the hash (only `hasPin`).
//
//   html(view)            PURE: the markup for { setup, pr, status: { send, pin }, pinMode }
//   mount(root, view)     draw into `root` and bind its clicks; returns the live state (the tests read it)
//   open() / close()      from the shell
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const WAITING = 'Waiting for you to confirm in the window that just opened…'

  const status = s => (s ? `<p class="set-status" role="status">${esc(s)}</p>` : '')
  const pinField = (attr, label, auto = 'new-password') =>
    `<input type="password" class="set-input" ${attr} autocomplete="${auto}" placeholder="${label}" aria-label="${label}">`

  function pinBlock(v) {
    const { pr } = v
    if (!pr.hasPin) {
      return `${pinField('data-set-pin-next', 'New PIN')}${pinField('data-set-pin-again', 'The new PIN again')}` +
        '<button type="button" class="primary" data-set-pin>Set PIN</button>'
    }
    if (v.pinMode === 'reset') {
      return `${pinField('data-set-pin-next', 'New PIN')}${pinField('data-set-pin-again', 'The new PIN again')}` +
        '<button type="button" class="primary" data-set-pin>Reset PIN</button><button type="button" class="link" data-set-cancel-reset>Cancel</button>'
    }
    return `${pinField('data-set-pin-current', 'Current PIN', 'current-password')}${pinField('data-set-pin-next', 'New PIN')}${pinField('data-set-pin-again', 'The new PIN again')}` +
      '<button type="button" class="primary" data-set-pin>Change PIN</button><button type="button" class="link" data-set-forgot>Forgot it? Reset</button>'
  }

  function setupBlock(setup) {
    const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`
    const list = a => (Array.isArray(a) && a.length ? esc(a.join(', ')) : '<span class="set-faint">none</span>')
    const chat = setup.chat || {}
    return '<dl class="set-dl">' +
      row('Repo', `<code>${esc(setup.repo)}</code>`) +
      row('Settings file', `<code>${esc(setup.configPath)}</code>`) +
      row('Coordinator', esc(setup.coordinator)) +
      row('Coding agents', list(setup.codingAgents)) +
      row('Chat', `${esc(chat.name)} · ${esc(chat.model)} · ${esc(chat.mode)}`) +
      row('Ticket prefixes', setup.ticketPrefixes == null ? '<span class="set-faint">from the ticket sources</span>' : list(setup.ticketPrefixes)) +
      row('Reminders', (setup.reminders || []).length ? setup.reminders.map(r => `${esc(r.at)} ${esc(r.days)} · ${esc(r.text)}`).join('<br>') : '<span class="set-faint">none</span>') +
      '</dl><p class="set-muted">Change these in config.json, then restart the dashboard.</p>'
  }

  function html(v) {
    const { pr, setup } = v
    const label = `Send to ${pr.bases.join(', ')}`
    return '<div class="set-page">' +
      '<section class="set-card" aria-label="Sending"><h3 class="set-h">Sending</h3>' +
      `<div class="set-row"><label class="set-switch"><input type="checkbox" role="switch" data-set-enabled aria-label="${esc(label)}"${pr.wanted ? ' checked' : ''}>` +
      `<span class="set-track" aria-hidden="true"></span><span class="set-label">${esc(label)}</span></label>` +
      (pr.wanted && !pr.hasPin ? '<span class="set-faint">needs a send PIN below</span>' : '') + '</div>' +
      `<div class="set-field"><label class="set-k" for="set-bases">Branches it may open pull requests into</label>` +
      `<div class="set-inline"><input id="set-bases" data-set-bases value="${esc(v.basesDraft ?? pr.bases.join(', '))}" class="set-input" autocomplete="off" spellcheck="false">` +
      '<button type="button" class="link" data-set-save-bases>Save</button></div></div>' +
      status(v.status.send) +
      `<div class="set-field"><span class="set-k">Send PIN</span><div class="set-inline set-pin">${pinBlock(v)}</div></div>` +
      status(v.status.pin) + '</section>' +
      `<section class="set-card" aria-label="Your setup"><h3 class="set-h">Your setup</h3>${setupBlock(setup)}</section></div>`
  }

  // ═══ live ═══

  async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    return { r, j }
  }

  /** root -> its state: a second open of the page reuses the state and the listeners bound the first time */
  const live = new WeakMap()

  function mount(root, view) {
    const fresh = { ...view, status: { send: '', pin: '', ...(view.status || {}) }, pinMode: view.pinMode || null, basesDraft: undefined }
    const known = live.get(root)
    if (known) {
      Object.assign(known, fresh)
      root.innerHTML = html(known)
      return known
    }
    const s = fresh
    live.set(root, s)
    const render = () => { root.innerHTML = html(s) }
    const field = attr => root.querySelector(`[${attr}]`)
    const say = (key, text) => { s.status[key] = text; render() }

    async function save(key, body, waits) {
      say(key, waits ? WAITING : 'Saving…')
      try {
        const { r, j } = await postJson(key === 'pin' ? '/api/settings/pin' : '/api/settings/send', body)
        if (!r.ok) return say(key, j.error || `Failed (${r.status})`)
        s.pr = j.pr
        s.pinMode = null
        if (key === 'send') s.basesDraft = undefined
        say(key, 'Saved.')
      } catch (e) {
        say(key, e.message)
      }
    }

    async function pin() {
      const mode = !s.pr.hasPin ? 'set' : s.pinMode === 'reset' ? 'reset' : 'change'
      const [cur, next, again] = ['data-set-pin-current', 'data-set-pin-next', 'data-set-pin-again'].map(field)
      if (!next?.value || next.value !== again?.value) return say('pin', next?.value ? 'The two PINs differ.' : 'Type the new PIN twice.')
      if (mode === 'change' && !cur?.value) return say('pin', 'Type your current PIN.')
      const body = mode === 'set' ? { next: next.value } : mode === 'reset' ? { reset: true, next: next.value } : { current: cur.value, next: next.value }
      for (const f of [cur, next, again]) if (f) f.value = '' // read once, never kept
      await save('pin', body, mode !== 'change')
    }

    root.addEventListener('click', e => {
      const t = e.target
      if (!t?.closest) return
      if (t.closest('[data-set-pin]')) return pin()
      if (t.closest('[data-set-forgot]')) { s.pinMode = 'reset'; s.status.pin = ''; return render() }
      if (t.closest('[data-set-cancel-reset]')) { s.pinMode = null; s.status.pin = ''; return render() }
      if (t.closest('[data-set-save-bases]')) {
        const raw = field('data-set-bases')?.value || ''
        s.basesDraft = raw
        const bases = raw.split(',').map(x => x.trim()).filter(Boolean)
        return save('send', { bases }, JSON.stringify(bases) !== JSON.stringify(s.pr.bases))
      }
    })
    root.addEventListener('change', e => {
      if (!e.target?.matches?.('[data-set-enabled]')) return
      const on = !!e.target.checked
      return save('send', { enabled: on }, on && !s.pr.wanted)
    })
    render()
    return s
  }

  let mounted = null
  window.SettingsPage = {
    html,
    mount,
    async open() {
      const root = window.document.getElementById('settingsView')
      if (!root) return
      root.innerHTML = '<p class="set-faint">Loading…</p>'
      try {
        const r = await fetch('/api/settings')
        const j = await r.json()
        if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
        mounted = mount(root, { setup: j.setup, pr: j.pr })
      } catch (e) {
        root.innerHTML = `<div class="banner">Settings: ${esc(e.message)}</div>`
      }
    },
    close() { mounted = null },
  }
})()
