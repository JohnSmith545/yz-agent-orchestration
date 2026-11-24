// Archive and Delete on the Flows page (trash-routes.mjs on the server). flows.js draws the board and the
// opened flow; this file makes the calls behind their Archive and Delete, and draws the one quiet link under
// the board to the flow archive (archive-page.js, #/archive), where archived and deleted flows are listed:
//
//   under the board   Flow archive · 5        (archived and deleted together; nothing at all when both are empty)
//
// Delete on a flow its agent may still be working on (open or blocked) is answered 409 with the server's
// question; the ⋯ menu (flow-head.js `asking`) and the card (flow-board.js) show it inline with Delete and
// Cancel, never a window.confirm. A deleted flow is never gone: it waits in the archive's Deleted group until
// the user chooses Delete for good there. After Delete and Archive a toast (notify.js) offers Undo; its action is
// plain data ({ kind: 'restore' | 'unarchive' }) that notify.js hands back to restore and unarchive here.
//
//   linksHtml(counts)              PURE: the line under the board, from /api/flows `counts` ({ archived, deleted })
//   without(data, id)              PURE: the page data without that flow (flows.js, right after a Delete or Archive)
//   archive(id, on) / unarchive(id) / remove(id, confirm) / restore(id)   the calls, then FlowsView.load()
;(() => {
  const enc = encodeURIComponent

  // ═══ pure ═══

  /** The quiet line under the board: one link to the flow archive with how many flows are in it, or nothing. */
  function linksHtml(counts) {
    const n = (Number(counts?.archived) || 0) + (Number(counts?.deleted) || 0)
    return n > 0 ? `<p class="small faint fl-lists"><a class="link" href="#/archive" data-archive-link>Flow archive · ${n}</a></p>` : ''
  }

  /** The page data without flow `id` (a NEW object): after a Delete the closed board never draws its card again. */
  const without = (data, id) => ({ ...data, flows: (data?.flows || []).filter(f => f.id !== id) })

  // ═══ the calls (each reloads the page's flows, which redraws the board and the count) ═══

  async function call(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }
    } catch (e) {
      return { ok: false, status: 0, j: { error: e?.message || String(e) } }
    }
  }
  const refused = r => window.alert?.(r.j?.error || `Failed (${r.status})`)
  const reload = () => {
    window.FlowsView?.load()
    window.ArchivePage?.reload()
  }
  /** A toast with Undo: the action is plain data notify.js runs (and hands back here). Not kept in the alerts history: it is your own act. */
  const undoToast = (text, kind, flowId) => window.Notifier?.toast(text, { kind: 'info', action: { label: 'Undo', kind, flowId }, keep: false })

  /** Archive (`on`) or unarchive. Archive offers Undo. True when it went through. */
  async function archive(id, on) {
    const r = await call(`/api/flows/${enc(id)}/archive`, { archived: !!on })
    if (!r.ok) return refused(r), false
    if (on) undoToast('Archived. It is in the flow archive.', 'unarchive', id)
    reload()
    return true
  }
  const unarchive = id => archive(id, false)

  /**
   * Delete: { ok: true } (moved to the flow archive, with an Undo toast), { needsConfirm, message } (its agent may
   * be working on it: ask, then call again with confirm), or null (refused, said in plain words).
   */
  async function remove(id, confirm) {
    const r = await call(`/api/flows/${enc(id)}/delete`, { confirm: !!confirm })
    if (r.status === 409 && r.j?.needsConfirm) return { needsConfirm: true, message: String(r.j.message || '') }
    if (!r.ok) return refused(r), null
    undoToast('Deleted. It waits in the flow archive until you delete it for good.', 'restore', id)
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

  window.FlowTrash = { linksHtml, without, archive, unarchive, remove, restore }
})()
