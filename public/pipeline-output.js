// The Output box of the Agents diagram (#/agents): where finished work ends, and where it waits for the user to mark
// it completed (completed.mjs). pipeline-view.js draws its inside with this file on the live page only, the way the
// Human task box says what waits on you (pipeline-human.js):
//
//   ┌ Output               +6 ┐
//   │ ● 9 waiting              │   finished flows waiting for your sign-off (GET /api/outputs, completed-view.js)
//   │ ● 2 overdue              │   waited warnAfterDays days or more; both lines in the notice colour once outputs.max
//   │ [Ship the login fix ]    │   wait (piled up). Up to three of the flows standing here, each waiting one with the
//   │ [Turn on Cloud Armor]    │   amber dot; then +N in the head
//   └──────────────────────────┘
//
// A completed flow is never a chip here (pipeline-tickets.js byNode). With nothing waiting it reads as before: the name,
// the chips. A saved orchestration (the bank page) has no live summary: pipeline-view.js does not call this at all.
// Pure: a node and what is known in, HTML out (test/completed-pipeline.test.mjs).
//
//   inner(node, { list, labels, outputs })   the box's inside; `outputs` is the /api/outputs summary
//   rows(list, outputs)                      the chip rows it needs: its count lines, then its chips
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const MAX = 3

  /** The count lines: `N waiting`, then `N overdue` when any; none when nothing waits. */
  function lines(outputs) {
    const w = Number(outputs?.counts?.waiting) || 0
    const o = Number(outputs?.counts?.overdue) || 0
    if (!w) return []
    return [{ text: `${w} waiting`, over: false }, ...(o ? [{ text: `${o} overdue`, over: true }] : [])]
  }

  const rows = (list, outputs) => lines(outputs).length + Math.min(MAX, Array.isArray(list) ? list.length : 0)

  function inner(node, { list = [], labels = {}, outputs = null } = {}) {
    const T = window.PipelineTickets
    const shown = list.slice(0, MAX)
    const more = list.length - shown.length
    const ls = lines(outputs)
    const piled = !!outputs?.piled
    const w = Number(outputs?.counts?.waiting) || 0
    const o = Number(outputs?.counts?.overdue) || 0
    const said = w ? `${node.label}: ${w} waiting for your sign-off${o ? `, ${o} overdue` : ''}. Show details.`
      : `${node.label}, ${list.length ? `${list.length} ticket${list.length === 1 ? '' : 's'}` : 'no tickets'}. Show details.`
    return `<button type="button" class="pl-node-head" aria-label="${esc(said)}"><span class="pl-name">${esc(node.label)}</span>` +
      `${more ? `<span class="pl-more" title="${more} more here">+${more}</span>` : ''}</button>` +
      ls.map(l => `<p class="pl-out-count${piled ? ' is-notice' : l.over ? ' is-over' : ''}"><i class="cv-dot" aria-hidden="true"></i>${esc(l.text)}</p>`).join('') +
      (shown.length ? `<div class="pl-chips">${shown.map(t => T.chipHtml(t, labels)).join('')}</div>` : '')
  }

  window.PipelineOutput = { inner, rows, MAX }
})()
