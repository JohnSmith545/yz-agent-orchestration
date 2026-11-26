// A flow's retrospective where the user reads a flow: on its Output tab under the Story (flow-output.js calls
// block(c)) and in its flow archive row (archive-page.js calls rowHtml(row)). Three plain lines the server wrote
// (learn-retro.mjs): what went right, what went wrong, what to do differently.
//
//   block(c)      PURE: the Retrospective block of an opened flow, or '' for a flow that is not finished (or dropped)
//                 and has none; a finished flow without one gets Write the retrospective
//   rowHtml(row)  PURE: the archive row's folded Retrospective, or '' with none
//   sig(id)       what of this file's own state the Output signature must include (writing, an error)
//
// The one thing this file posts is Write the retrospective (POST /api/learn/retro/<id>, the page's own Origin):
// a retrospective is no change to the work, so it is offered on a read-only (archived, completed) flow too. While it
// runs the button says so; after, the flow and the archive reload (FlowsView.load, ArchivePage.reload).
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const two = n => String(n).padStart(2, '0')
  const when = iso => {
    const d = new Date(iso)
    return !iso || Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]}, ${two(d.getHours())}:${two(d.getMinutes())}`
  }
  const cost = v => (typeof v === 'number' && Number.isFinite(v) ? ` · $${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}` : '')
  /** flowId -> 'writing' | { error }: this browser's own presses. */
  const state = new Map()
  const finished = f => !!f && f.status !== 'dropped' && (f.status === 'done' || !!f.completedAt)

  const lines = r => `<dl class="lr-lines"><dt>Went right</dt><dd>${esc(r.right)}</dd><dt>Went wrong</dt><dd>${esc(r.wrong)}</dd><dt>Next time</dt><dd>${esc(r.next)}</dd></dl>`

  function block(c) {
    const f = c?.flow
    if (!f) return ''
    const r = f.retro
    if (!r && !finished(f)) return ''
    const s = state.get(f.id)
    const action = s === 'writing'
      ? '<span class="lr-busy" role="status">Writing… about half a minute</span>'
      : finished(f) ? `<button type="button" class="link" data-lr-write="${esc(f.id)}">${r ? 'Write it again' : 'Write the retrospective'}</button>` : ''
    const head = typeof c.head === 'function' ? c.head('Retrospective', null, '', action) : `<div class="ob-head"><h3 class="ob-h">Retrospective</h3><span class="ob-head-end">${action}</span></div>`
    const keyed = typeof c.keyed === 'function' ? c.keyed('retro', [r, s]) : ''
    const body = r
      ? `${lines(r)}<p class="lr-meta">Written ${esc(when(r.at))}${r.source === 'completed' ? ' when you marked it completed' : ''}${esc(cost(r.cost))}</p>`
      : '<p class="lr-none">No retrospective yet: three short lines on what went right, what went wrong and what to do next time.</p>'
    const err = s && typeof s === 'object' && s.error ? `<p class="lr-error" role="alert">${esc(s.error)}</p>` : ''
    return `<section class="ob ob-retro" aria-label="Retrospective" ${keyed}>${head}${body}${err}</section>`
  }

  function rowHtml(row) {
    const r = row?.retro
    if (!r) return ''
    return `<details class="lr-row"><summary>Retrospective</summary>${lines(r)}</details>`
  }

  const sig = id => {
    const s = state.get(id)
    return s === undefined ? null : s
  }

  window.LearnRetro = { block, rowHtml, sig }
  if (!window.document) return

  window.document.addEventListener('click', async e => {
    const b = e.target.closest?.('[data-lr-write]')
    if (!b) return
    const id = b.dataset.lrWrite
    if (state.get(id) === 'writing') return
    state.set(id, 'writing')
    window.FlowsView?.load?.()
    try {
      const r = await fetch(`/api/learn/retro/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `Not written (${r.status}).`)
      state.delete(id)
    } catch (err) {
      state.set(id, { error: err?.message || String(err) })
    }
    window.FlowsView?.load?.()
    window.ArchivePage?.reload?.()
  })
})()
