// The flow archive (#/archive): every flow taken off the Flows board, in two groups, and nothing ever
// leaves either by a timer (trash-routes.mjs GET /api/archive):
//
//   [ Search by title or ticket id ]
//   Archived · 2                                    put away by you; the flow itself is unchanged
//   Add a dark mode toggle   Agent 3 · open · FLA-12 · archived 3d          Restore   Delete
//   Ship the login fix       Agent 1 · done · Completed 24 Nov              Uncomplete   Delete
//                                                   (a COMPLETED flow, completed.mjs: the user's sign-off archived it;
//                                                   Uncomplete takes both off and puts it back on the boards)
//   An ARCHIVED flow at the Output that was never completed still waits for sign-off (archiving is not one): its row
//   says Mark it completed and has the Completed tick beside Restore (completed-view.js).
//   Deleted · 1                                     deleted by you; kept whole until Delete for good
//   Ship the login fix       Agent 1 · done · deleted 2h                    Restore   Delete for good
//     Delete Ship the login fix for good? Its screenshots go too, and this cannot be undone.  [Delete for good] [Cancel]
//
// A title opens the flow READ-ONLY in the ordinary flow view (FlowsView.gotoFlow: flows.js draws a banner and
// takes every control away). Restore puts an archived flow back on the board, or a deleted one back where it was
// (archived again when it was archived). Delete for good asks first IN THE ROW, naming the flow: never a
// window.confirm. Delete on an archived flow its agent may be working on asks the server's question in the row too.
// The search filters by title, flow id or ticket id, as you type; `#/archive?q=dark` opens with it filled in.
//
//   html(data, state)     PURE: both groups, filtered; state { q, confirm, asking }
//   matches(row, q)       PURE: whether a row matches the search
//   open(query) / close() / reload()   the page (shell.js), and a reload after any change made elsewhere
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const enc = encodeURIComponent
  const HELP = '<p><b>Archived</b> flows are put away: off the Flows board, unchanged, and still counted in the pipeline score.</p>' +
    '<p><b>Deleted</b> flows are kept whole here until you choose <b>Delete for good</b>, which also removes their screenshots. ' +
    'Their agents were told to stop, and deleted flows are left out of the score.</p>' +
    '<p>Archiving is not a sign-off: an archived output you never marked completed still waits for it, and shows <b>Mark it completed</b> here.</p>' +
    '<p><b>Completed</b> flows are the outputs you signed off. Only you mark a flow completed, on its Output tab or in the Output list on the Agents page; ' +
    'it then waits here, still counted in the score. <b>Uncomplete</b> puts it back on the boards.</p>' +
    '<p>Open a flow to read it; nothing can be changed there. <b>Restore</b> puts it back.</p>'

  // ═══ pure ═══

  /** Whether `row` matches the search `q`: its title, flow id or any ticket id, ignoring case. Empty matches all. */
  function matches(row, q) {
    const t = String(q ?? '').trim().toLowerCase()
    if (!t) return true
    const hay = [row?.title, row?.id, ...(Array.isArray(row?.tickets) ? row.tickets : [])].map(v => String(v ?? '').toLowerCase())
    return hay.some(v => v.includes(t))
  }

  const short = at => window.Shell?.ago(at) || ''
  const pill = s => (s ? `<span class="fl-status fs-${esc(s)}">${esc(s)}</span>` : '')

  function row(r, kind, { confirm, asking }) {
    const id = esc(r.id)
    const title = esc(r.title)
    const done = kind === 'archived' && r.completedAt ? window.CompletedView?.archiveLabel(r) || 'Completed' : '' // the user's sign-off (completed.mjs)
    const when = kind === 'deleted' ? `deleted ${short(r.deletedAt)}` : `archived ${short(r.archivedAt)}`
    const C = window.CompletedView
    const waits = kind === 'archived' && !done && !!C?.waits(r.id) // archived, never signed off: it still waits
    const meta = [esc(r.agent), pill(r.status), ...(r.tickets || []).slice(0, 3).map(t => `<span class="id">${esc(t)}</span>`), done ? `<span class="ar-done">${esc(done)}</span>` : esc(when.trim()),
      waits ? C.markHtml(C.overdue(r.id), Number(C.data?.warnAfterDays) || 2) : ''].filter(Boolean)
    const name = r.broken
      ? `<span class="ar-title ar-broken">${id} <span class="faint">(this copy cannot be read)</span></span>`
      : `<button type="button" class="link ar-title" data-ar-open="${id}" aria-label="Open ${title}, read only">${title}</button>`
    let acts
    if (confirm === r.id) {
      acts = `<span class="ar-ask" role="group" aria-label="Delete ${title} for good"><span class="ar-ask-q">Delete <b>${title}</b> for good? Its screenshots go too, and this cannot be undone.</span>` +
        `<button type="button" class="ar-danger" data-ar-purge-yes="${id}">Delete for good</button><button type="button" data-ar-cancel>Cancel</button></span>`
    } else if (asking?.id === r.id) {
      acts = `<span class="ar-ask" role="group" aria-label="Delete ${title}"><span class="ar-ask-q">${esc(asking.message)}</span>` +
        `<button type="button" class="ar-danger" data-ar-delete="${id}" data-confirmed>Delete</button><button type="button" data-ar-cancel>Cancel</button></span>`
    } else if (kind === 'deleted') {
      acts = (r.broken ? '' : `<button type="button" class="link" data-ar-restore="${id}" aria-label="Restore ${title}">Restore</button>`) +
        `<button type="button" class="link ar-bad" data-ar-purge="${id}" aria-label="Delete ${title} for good">Delete for good</button>`
    } else if (done) {
      acts = `<button type="button" class="link" data-ar-uncomplete="${id}" aria-label="Uncomplete ${title}: back on the boards">Uncomplete</button>` +
        `<button type="button" class="link ar-bad" data-ar-delete="${id}" aria-label="Delete ${title}">Delete</button>`
    } else {
      acts = (waits ? C.tickHtml(r) : '') + `<button type="button" class="link" data-ar-unarchive="${id}" aria-label="Restore ${title} to the Flows board">Restore</button>` +
        `<button type="button" class="link ar-bad" data-ar-delete="${id}" aria-label="Delete ${title}">Delete</button>`
    }
    return `<li class="ar-row" data-id="${id}"><div class="ar-main">${name}<span class="ar-meta">${meta.join('<span aria-hidden="true">·</span>')}</span>${window.LearnRetro?.rowHtml(r) || ''}</div><div class="ar-acts">${acts}</div></li>`
  }

  function group(kind, label, line, rows, all, state, error = '') {
    const shown = rows.filter(r => matches(r, state.q))
    const empty = error ? `<p class="small warn">${esc(error)}</p>`
      : all.length && !shown.length ? `<p class="ar-empty">No ${kind} flow matches.</p>`
      : `<p class="ar-empty">${kind === 'deleted' ? 'Nothing deleted.' : 'Nothing archived.'}</p>`
    const n = state.q?.trim() && all.length ? `${shown.length} of ${all.length}` : `${all.length}`
    return `<section class="card ar-group" aria-labelledby="ar-h-${kind}"><div class="ar-head"><h3 id="ar-h-${kind}">${label} <span class="faint">· ${n}</span></h3><p class="ar-line">${line}</p></div>` +
      (shown.length ? `<ul class="ar-rows">${shown.map(r => row(r, kind, state)).join('')}</ul>` : empty) + '</section>'
  }

  /** Both groups. `data` is GET /api/archive's answer; a missing group is empty. */
  function html(data, state = {}) {
    const st = { q: '', confirm: null, asking: null, ...state }
    const archived = Array.isArray(data?.archived) ? data.archived : []
    const deleted = Array.isArray(data?.deleted) ? data.deleted : []
    return group('archived', 'Archived', 'Put away by you. The flow is unchanged and still counts in the score. Completed ones are the outputs you signed off.', archived, archived, st) +
      group('deleted', 'Deleted', 'Deleted by you. Kept whole until you delete it for good.', deleted, deleted, st, data?.deletedError || '')
  }

  window.ArchivePage = { html, matches, open() {}, close() {}, reload() {} }
  if (!window.document) return

  // ═══ the page ═══

  const view = () => document.getElementById('archiveView')
  let on = false
  let built = false
  let data = null
  let failure = ''
  let gen = 0
  const state = { q: '', confirm: null, asking: null }

  function build() {
    view().innerHTML = `<div class="ar-page"><div class="ar-search"><input type="search" id="arSearch" placeholder="Search by title or ticket id" aria-label="Search the flow archive by title or ticket id" autocomplete="off"></div><div id="arBody" aria-live="polite"></div></div>`
    built = true
    const body = view().querySelector('#arBody')
    view().querySelector('#arSearch').addEventListener('input', e => {
      state.q = e.target.value
      state.confirm = state.asking = null
      paint()
    })
    body.addEventListener('click', onClick)
    // what waits for sign-off changed (completed-view.js): an archived output's mark and tick follow
    document.addEventListener('outputs:change', () => on && paint())
  }

  function head() {
    if (!on || window.Shell.current?.view !== 'archive') return
    const a = data?.archived?.length || 0
    const d = data?.deleted?.length || 0
    window.Shell.setTitle('Flow archive', 'archive', data ? a + d : null)
    window.Shell.setStatus(failure ? `<span class="warn">Could not load the archive: ${esc(failure)}</span>` : data ? `${a} archived · ${d} deleted` : 'Loading…', HELP)
  }

  /** Draw the groups; a focus inside the list stays on the same button when it is still there, else the search takes it. */
  function paint() {
    head()
    const body = view()?.querySelector('#arBody')
    if (!body || !data) return
    const a = document.activeElement
    const keep = a && body.contains(a) ? [...a.attributes].find(x => x.name.startsWith('data-ar-')) : null
    body.innerHTML = html(data, state)
    if (keep) (body.querySelector(`[${keep.name}="${CSS.escape(keep.value)}"]`) || body.querySelector('[data-ar-purge-yes], [data-ar-delete][data-confirmed]') || view().querySelector('#arSearch'))?.focus()
  }

  async function reload() {
    if (!on) return
    const mine = ++gen
    try {
      const r = await fetch('/api/archive')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || r.status)
      if (mine !== gen) return
      data = j
      failure = ''
    } catch (e) {
      if (mine !== gen) return
      failure = e?.message || String(e)
    }
    paint()
  }

  async function call(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }
    } catch (e) {
      return { ok: false, status: 0, j: { error: e?.message || String(e) } }
    }
  }
  const toast = text => window.Notifier?.toast(esc(text), { kind: 'info', keep: false })
  const refused = r => window.alert?.(r.j?.error || `Failed (${r.status})`)
  const titleOf = id => [...(data?.archived || []), ...(data?.deleted || [])].find(r => r.id === id)?.title || id

  async function onClick(e) {
    const t = e.target
    const pick = name => t.closest(`[${name}]`)?.getAttribute(name)
    let id
    if ((id = pick('data-ar-open'))) return window.FlowsView?.gotoFlow(id)
    if (t.closest('[data-ar-cancel]')) {
      state.confirm = state.asking = null
      return paint()
    }
    if ((id = pick('data-ar-purge'))) {
      state.confirm = id
      state.asking = null
      paint()
      return view().querySelector(`[data-ar-purge-yes="${CSS.escape(id)}"]`)?.focus()
    }
    if ((id = pick('data-ar-purge-yes'))) {
      const title = titleOf(id)
      state.confirm = null
      const r = await call(`/api/trash/${enc(id)}/purge`)
      if (!r.ok) refused(r)
      else toast(`${title} is deleted for good.`)
      return reload()
    }
    if ((id = pick('data-ar-restore'))) {
      const r = await call(`/api/trash/${enc(id)}/restore`)
      if (!r.ok) refused(r)
      else toast(r.j?.archived ? `${titleOf(id)} is back under Archived.` : `${titleOf(id)} is back on the Flows board.`)
      window.FlowsView?.load()
      return reload()
    }
    if ((id = pick('data-ar-uncomplete'))) {
      const { done, error } = await window.CompletedView.complete([id], false) // POST complete { completed: false }
      if (error) window.alert?.(error)
      else if (done) toast(`${titleOf(id)} is back on the boards, waiting for your sign-off.`)
      return reload()
    }
    if ((id = pick('data-ar-unarchive'))) {
      const r = await call(`/api/flows/${enc(id)}/archive`, { archived: false })
      if (!r.ok) refused(r)
      else toast(`${titleOf(id)} is back on the Flows board.`)
      window.FlowsView?.load()
      return reload()
    }
    if ((id = pick('data-ar-delete'))) {
      const confirmed = !!t.closest('[data-confirmed]')
      const r = await call(`/api/flows/${enc(id)}/delete`, { confirm: confirmed })
      if (r.j?.needsConfirm) {
        state.asking = { id, message: String(r.j.message || '') }
        return paint()
      }
      state.asking = null
      if (!r.ok) refused(r)
      return reload()
    }
  }

  window.ArchivePage = {
    html, matches, reload,
    open(query = {}) {
      if (!built) build()
      on = true
      if (typeof query.q === 'string') {
        state.q = query.q
        view().querySelector('#arSearch').value = query.q
      }
      head()
      reload()
    },
    close() {
      on = false
      state.confirm = state.asking = null
    },
  }
})()
