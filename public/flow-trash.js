// Archive and the Trash on the Flows page (trash-routes.mjs on the server). flows.js draws the board;
// this file draws the two lists that open IN PLACE of it, the quiet line of links under it, and makes
// the calls behind the ⋯ menu's Archive and Delete:
//
//   under the board   Archived · 3   Trash · 2        (only what has something in it; nothing at all when both are empty)
//
//   ← Flows
//   Trash                                              the heading takes the focus when the list opens
//   Deleted flows stay here for 24 hours, then they are gone for good.
//   Add a dark mode toggle   Agent 3 · 23 h left       Restore   Delete forever   (asks Delete forever? first)
//
//   ← Flows
//   Archived
//   Add a dark mode toggle   Agent 3 · open · archived 3d   Unarchive   Delete
//
// Delete on a flow its agent may still be working on (open or blocked) is answered 409 with the
// server's question; the ⋯ menu (flow-head.js `asking`) and the Archived row show it inline with
// Delete and Cancel, never a window.confirm. Delete forever asks on the same button, like the
// Glossary page's Remove: a second click deletes, any other click lets go.
// After Delete and Archive a toast (notify.js) offers Undo; its action is plain data
// ({ kind: 'restore' | 'unarchive' }) that notify.js hands back to restore and unarchive here.
//
//   leftText(ms)                   PURE: `23 h left`, `40 min left`, `under a minute left`, `expiring now`
//   linksHtml(counts)              PURE: the line under the board, from /api/flows `counts`
//   trashHtml(items, state)        PURE: the Trash list; state.confirm is the row asking Delete forever?
//   archivedHtml(flows, state)     PURE: the Archived list; state.asking is { id, message } for an inline Delete
//   fill(board, kind)              fetch and draw that list into the board (flows.js render, every poll)
//   click(e, board)                the lists' buttons; true when it took the click
//   leave()                        the list closed: forget its state, drop a fetch in flight
//   without(data, id)              PURE: the page data without that flow (flows.js, right after a Delete)
//   archive(id, on) / unarchive(id) / remove(id, confirm) / restore(id) / purge(id)   the calls, then FlowsView.load()
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const enc = encodeURIComponent
  const MIN = 60_000
  const HOUR = 60 * MIN
  const TRASH_LINE = 'Deleted flows stay here for 24 hours, then they are gone for good.'

  // ═══ pure ═══

  /** The time a Trash entry has left: whole hours rounded down, minutes below an hour, then under a minute. */
  function leftText(ms) {
    const n = Number(ms)
    if (!(n > 0)) return 'expiring now'
    if (n < MIN) return 'under a minute left'
    if (n < HOUR) return `${Math.floor(n / MIN)} min left`
    return `${Math.floor(n / HOUR)} h left`
  }

  /** The quiet line under the board: a link per list with something in it, or nothing. */
  function linksHtml(counts) {
    const links = [['archived', 'Archived'], ['trash', 'Trash']]
      .filter(([k]) => Number(counts?.[k]) > 0)
      .map(([k, label]) => `<button type="button" class="link" data-list="${k}">${label} · ${Number(counts[k])}</button>`)
    return links.length ? `<p class="small faint fl-lists">${links.join('')}</p>` : ''
  }

  /** The top of both lists: back to the board like an opened flow, and the heading the focus lands on. */
  const head = (title, line = '') => `<div class="fl-open-top"><button type="button" class="link" data-close>← Flows</button></div>` +
    `<h2 class="fl-title" tabindex="-1" data-list-head>${title}</h2>${line ? `<p class="small faint fl-list-line">${line}</p>` : ''}`
  const list = (rows, empty) => (rows.length ? `<ul class="fl-rows">${rows.join('')}</ul>` : `<p class="small faint fl-list-empty">${empty}</p>`)
  const meta = parts => `<span class="fl-row-meta">${parts.filter(Boolean).join(' · ')}</span>`

  function trashHtml(items, { confirm = null } = {}) {
    const rows = (items || []).map(i => {
      const id = esc(i.id)
      const title = esc(i.title)
      const asking = confirm === i.id
      // a broken entry cannot be restored (the server would refuse): it can only go
      const restore = i.broken ? '' : `<button type="button" class="link" data-restore="${id}" aria-label="Restore ${title}">Restore</button>`
      const purge = `<button type="button" class="link fl-row-bad" data-purge="${id}"${asking ? ' data-confirm' : ''} aria-label="Delete ${title} forever${asking ? ': click again to confirm' : ''}">Delete forever${asking ? '?' : ''}</button>`
      return `<li class="fl-row" data-id="${id}"><span class="fl-row-title">${title}</span>${meta([esc(i.agent), leftText(i.leftMs)])}<span class="fl-row-acts">${restore}${purge}</span></li>`
    })
    return `<section class="card fl-list">${head('Trash', TRASH_LINE)}${list(rows, 'Trash is empty.')}</section>`
  }

  /** `archived 3d`, `archived now`: short, from Shell.ago, the way `updated 2m` reads (the copy rules, spec 6). */
  const archivedAgo = at => `archived ${window.Shell?.ago(at) || ''}`.trim()

  function archivedHtml(flows, { asking = null } = {}) {
    const rows = (flows || []).map(f => {
      const id = esc(f.id)
      const title = esc(f.title)
      const acts = asking?.id === f.id
        ? `<span class="small warn">${esc(asking.message)}</span><button type="button" class="link fl-row-bad" data-arch-delete="${id}" data-confirmed aria-label="Delete ${title}">Delete</button><button type="button" class="link" data-arch-cancel aria-label="Cancel deleting ${title}">Cancel</button>`
        : `<button type="button" class="link" data-unarchive="${id}" aria-label="Unarchive ${title}">Unarchive</button><button type="button" class="link fl-row-bad" data-arch-delete="${id}" aria-label="Delete ${title}">Delete</button>`
      return `<li class="fl-row" data-id="${id}"><button type="button" class="link fl-row-title" data-open="${id}">${title}</button>` +
        `${meta([esc(f.agent), `<span class="fl-status fs-${esc(f.status)}">${esc(f.status)}</span>`, esc(archivedAgo(f.archivedAt))])}<span class="fl-row-acts">${acts}</span></li>`
    })
    return `<section class="card fl-list">${head('Archived')}${list(rows, 'Nothing archived.')}</section>`
  }

  // ═══ the calls (each reloads the page's flows, which redraws the list and the counts) ═══

  async function call(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }
    } catch (e) {
      return { ok: false, status: 0, j: { error: e?.message || String(e) } }
    }
  }
  const refused = r => window.alert?.(r.j?.error || `Failed (${r.status})`)
  const reload = () => window.FlowsView?.load()
  /** A toast with Undo: the action is plain data notify.js runs (and hands back here). Not kept in the alerts history: it is your own act. */
  const undoToast = (text, kind, flowId) => window.Notifier?.toast(text, { kind: 'info', action: { label: 'Undo', kind, flowId }, keep: false })

  /** Archive (`on`) or unarchive. Archive offers Undo. True when it went through. */
  async function archive(id, on) {
    const r = await call(`/api/flows/${enc(id)}/archive`, { archived: !!on })
    if (!r.ok) return refused(r), false
    if (on) undoToast('Archived.', 'unarchive', id)
    reload()
    return true
  }
  const unarchive = id => archive(id, false)

  /**
   * Delete: { ok: true } (moved to the Trash, with an Undo toast), { needsConfirm, message } (its agent may be
   * working on it: ask, then call again with confirm), or null (refused, said in plain words).
   */
  async function remove(id, confirm) {
    const r = await call(`/api/flows/${enc(id)}/delete`, { confirm: !!confirm })
    if (r.status === 409 && r.j?.needsConfirm) return { needsConfirm: true, message: String(r.j.message || '') }
    if (!r.ok) return refused(r), null
    undoToast('Moved to Trash. Kept for 24 hours.', 'restore', id)
    reload()
    return { ok: true }
  }

  /** Restore; a flow that was archived when it was deleted comes back archived, and says so (it is not on the board). */
  async function restore(id) {
    const r = await call(`/api/trash/${enc(id)}/restore`)
    if (!r.ok) refused(r)
    else if (r.j?.archived) window.Notifier?.toast('Restored to Archived.', { kind: 'info', keep: false })
    reload()
    return r.ok
  }

  async function purge(id) {
    const r = await call(`/api/trash/${enc(id)}/purge`)
    if (!r.ok) refused(r)
    reload()
    return r.ok
  }

  // ═══ the list in place of the board ═══

  /** kind: 'trash' | 'archived' | null; data: what it last fetched; drawn: the markup now in the board. */
  const state = { kind: null, data: null, drawn: null, confirm: null, asking: null, gen: 0 }

  /** The buttons a focus is kept on across a redraw, matched by this attribute and its value (the flow id). */
  const FOCUS_KEYS = ['data-restore', 'data-purge', 'data-unarchive', 'data-arch-delete', 'data-arch-cancel', 'data-open', 'data-close']
  /** Where the focus is in the list before a redraw: { sel } of that button ('' for anything else in it), or null when it is not in the list. */
  function focusKey(board) {
    const a = board.ownerDocument?.activeElement
    if (!a || !board.contains?.(a)) return null
    const k = FOCUS_KEYS.find(x => a.hasAttribute?.(x))
    return { sel: k ? `[${k}="${a.getAttribute(k)}"]` : '' }
  }

  /**
   * Draw the list from state. A focus inside it stays on the same button when the new markup still has it (a poll,
   * Delete forever?, the inline Delete), else it lands on the heading (the row went: Restore, Delete forever,
   * Unarchive). A focus outside the list is left alone.
   */
  function paint(board) {
    if (!state.kind || !state.data) return
    const html = state.kind === 'trash' ? trashHtml(state.data, state) : archivedHtml(state.data, state)
    if (html === state.drawn) return // a poll with nothing new leaves the list (and the focus) alone
    const keep = focusKey(board)
    board.innerHTML = html
    state.drawn = html
    if (keep) ((keep.sel && board.querySelector(keep.sel)) || board.querySelector('[data-list-head]'))?.focus()
  }

  /** The page data without flow `id` (a NEW object): after a Delete the closed board never draws its card again. */
  const without = (data, id) => ({ ...data, flows: (data?.flows || []).filter(f => f.id !== id) })

  async function fill(board, kind) {
    const first = state.kind !== kind
    if (first) Object.assign(state, { kind, data: null, drawn: null, confirm: null, asking: null })
    const mine = ++state.gen
    let data
    let error = ''
    try {
      const r = await fetch(kind === 'trash' ? '/api/trash' : '/api/flows?archived=1')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || r.status)
      data = kind === 'trash' ? j.items || [] : (j.flows || []).sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)))
    } catch (e) {
      error = e?.message || String(e)
    }
    if (mine !== state.gen || state.kind !== kind) return // left, or a newer fill is on its way
    if (error) {
      board.innerHTML = state.drawn = `<section class="card fl-list">${head(kind === 'trash' ? 'Trash' : 'Archived')}<p class="small warn">${esc(error)}</p></section>`
    } else {
      state.data = data
      paint(board)
    }
    if (first) board.querySelector('[data-list-head]')?.focus()
  }

  function leave() {
    Object.assign(state, { kind: null, data: null, drawn: null, confirm: null, asking: null })
    state.gen++
  }

  /** The lists' own buttons. A pending Delete forever? is let go by any other click (which may still be flows.js's). */
  function click(e, board) {
    if (!state.kind) return false
    const t = e.target
    const purgeBtn = t.closest('[data-purge]')
    if (state.confirm && (!purgeBtn || purgeBtn.dataset.purge !== state.confirm)) { state.confirm = null; paint(board) }
    if (purgeBtn) {
      const id = purgeBtn.dataset.purge
      if (state.confirm === id) {
        state.confirm = null
        void purge(id)
      } else {
        state.confirm = id // asks first: the button reads Delete forever? and a second click deletes
        paint(board)
        board.querySelector(`[data-purge="${id}"]`)?.focus()
      }
      return true
    }
    const back = t.closest('[data-restore]')
    if (back) return void restore(back.dataset.restore), true
    const un = t.closest('[data-unarchive]')
    if (un) return void unarchive(un.dataset.unarchive), true
    if (t.closest('[data-arch-cancel]')) { state.asking = null; paint(board); return true }
    const del = t.closest('[data-arch-delete]')
    if (del) {
      const id = del.dataset.archDelete
      void remove(id, del.hasAttribute('data-confirmed')).then(r => {
        state.asking = r?.needsConfirm ? { id, message: r.message } : null
        paint(board)
      })
      return true
    }
    return false
  }

  window.FlowTrash = { leftText, linksHtml, trashHtml, archivedHtml, fill, click, leave, archive, unarchive, remove, restore, purge, without }
})()
