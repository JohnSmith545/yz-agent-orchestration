// The Learn page (#/learn): retrospectives turned into rule changes, and a verdict on every rule change. The markup
// is learn-view.js; this file loads GET /api/learn, draws it, and posts the user's presses (learn-routes.mjs):
//
//   Run Learn                 POST /api/learn/run, then a poll every 3 s while it runs (it takes a few minutes; the
//                             run goes on and is kept if the user leaves the page)
//   Accept / Edit then accept POST /api/learn/runs/<id>/<n> { do: 'accept', text? }
//   Reject                    POST /api/learn/runs/<id>/<n> { do: 'reject', reason? }
//   Keep / Revert / Wait      POST /api/learn/changes/<id> { do }
//   on open                   POST /api/learn/weekly: the server starts a run only when learn.weekly is on and the last
//                             run is a week old; otherwise it does nothing
//
// `#/learn?run=<id>` opens with that earlier run unfolded. Focus stays where the user was after a press: on the next
// card's first button, or on the field that opened. Escape inside a form cancels it.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const POLL_MS = 3000
  window.LearnPage = { open: () => {}, close: () => {} }
  if (!window.document) return
  const doc = window.document
  const root = () => doc.getElementById('learnView')
  const enc = encodeURIComponent

  let state = null
  let token = 0
  let poll = null
  let ui = { status: '', busy: null, errors: {}, drafts: {}, editing: null, rejecting: null, openRun: null }

  function paint(focus) {
    const el = root()
    if (!el || !state) return
    el.innerHTML = window.LearnView.pageHtml(state, ui)
    window.Shell?.setTitle('Learn', 'learn')
    window.Shell?.setStatus(esc(window.LearnView.statusLine(state)), window.LearnView.HELP)
    if (focus) el.querySelector(focus)?.focus()
  }

  async function load(focus) {
    const mine = ++token
    try {
      const r = await fetch('/api/learn', { cache: 'no-store' })
      const j = await r.json()
      if (mine !== token) return
      if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
      state = j
      paint(focus)
    } catch (e) {
      if (mine === token && root()) root().innerHTML = `<div class="banner">Learn: ${esc(e.message)}</div>`
    }
    clearTimeout(poll)
    // while a run goes on, look again; a form being filled in is never redrawn under the user's hands
    if (state?.running) poll = setTimeout(() => (ui.editing || ui.rejecting ? null : load()), POLL_MS)
  }

  async function post(url, body = {}) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    return { r, j }
  }

  /** One press on a proposal or a change: busy while it runs, the error on the card when it fails. */
  async function act(key, url, body, after) {
    ui.busy = key
    delete ui.errors[key]
    paint()
    try {
      const { r, j } = await post(url, body)
      if (!r.ok) ui.errors[key] = j.error || `Not saved (${r.status}).`
      else {
        ui.editing = null
        ui.rejecting = null
        ui.status = after(j)
      }
    } catch (e) {
      ui.errors[key] = e.message
    }
    ui.busy = null
    await load()
  }

  function open(query = {}) {
    ui = { status: '', busy: null, errors: {}, drafts: {}, editing: null, rejecting: null, openRun: query.run || null }
    window.Shell?.setTitle('Learn', 'learn')
    load().then(() => (ui.openRun ? root()?.querySelector(`[data-ln-run-id="${CSS.escape(ui.openRun)}"]`)?.scrollIntoView({ block: 'start' }) : null))
    post('/api/learn/weekly').then(({ j }) => (j.started ? load() : null)).catch(() => {})
  }

  doc.addEventListener('click', e => {
    const el = root()
    if (!el || el.hidden || !el.contains(e.target)) return
    const t = e.target.closest('button')
    if (!t) return
    if (t.hasAttribute('data-ln-run')) {
      return act('run', '/api/learn/run', {}, () => 'Learn started. Its proposals show here when it is done.')
    }
    const accept = t.dataset.lnAccept
    if (accept) {
      const [run, n] = accept.split(':')
      return act(`p:${accept}`, `/api/learn/runs/${enc(run)}/${n}`, { do: 'accept' }, j => (j.note ? `Accepted. ${j.note}` : 'Accepted: the rule is saved, and its verdict is due in two weeks.'))
    }
    if (t.dataset.lnEdit) return Object.assign(ui, { editing: t.dataset.lnEdit, rejecting: null }), paint(`#ln-edit-${CSS.escape(t.dataset.lnEdit)}`)
    if (t.dataset.lnReject) return Object.assign(ui, { rejecting: t.dataset.lnReject, editing: null }), paint(`#ln-why-${CSS.escape(t.dataset.lnReject)}`)
    if (t.hasAttribute('data-ln-cancel')) {
      const back = ui.editing || ui.rejecting
      Object.assign(ui, { editing: null, rejecting: null })
      return paint(back ? `[data-ln-prop="${CSS.escape(back)}"] button` : null)
    }
    const decide = t.dataset.lnDecide
    if (decide) {
      const id = t.dataset.lnId
      const said = { keep: 'Kept. The verdict is saved in Rule changes.', revert: 'Reverted: the rule reads as it did before.', wait: 'The verdict is due again in two weeks.' }
      return act(`change:${id}`, `/api/learn/changes/${enc(id)}`, { do: decide }, j => `${said[decide]}${j.notes?.length ? ` ${j.notes.join(' ')}` : ''}`)
    }
  })

  doc.addEventListener('input', e => {
    const el = root()
    if (!el?.contains(e.target)) return
    const edit = e.target.closest('[data-ln-edit-form]')?.dataset.lnEditForm
    const why = e.target.closest('[data-ln-reject-form]')?.dataset.lnRejectForm
    if (edit) ui.drafts[edit] = e.target.value
    if (why) ui.drafts[`why:${why}`] = e.target.value
  })

  doc.addEventListener('submit', e => {
    const el = root()
    if (!el?.contains(e.target)) return
    e.preventDefault()
    const f = e.target
    const edit = f.dataset.lnEditForm
    const why = f.dataset.lnRejectForm
    const key = edit || why
    if (!key) return
    const [run, n] = key.split(':')
    const value = f.querySelector('textarea, input')?.value ?? ''
    if (edit) return act(`p:${key}`, `/api/learn/runs/${enc(run)}/${n}`, { do: 'accept', text: value }, () => 'Accepted with your wording: the rule is saved.')
    return act(`p:${key}`, `/api/learn/runs/${enc(run)}/${n}`, { do: 'reject', reason: value }, () => 'Rejected. The next run reads your reason.')
  })

  doc.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !(ui.editing || ui.rejecting) || !root()?.contains(e.target)) return
    e.preventDefault()
    const back = ui.editing || ui.rejecting
    Object.assign(ui, { editing: null, rejecting: null })
    paint(`[data-ln-prop="${CSS.escape(back)}"] button`)
  })

  window.LearnPage.open = open
  window.LearnPage.close = () => {
    token++
    clearTimeout(poll)
  }
})()
