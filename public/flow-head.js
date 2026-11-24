// The head of an opened flow (flows.js draws it into two slots, so the view tabs
// can sit on the title row between them):
//
//   head   ← Flows
//          Title of the flow                [Output | Explain | Status | Process] ?   (the tabs are flows.js's)
//   sub    The why, its first sentence, more
//          Agent 3 · ABC-1 · dev · open · ● QA failed · updated 2m               ⋯   (ONE muted meta line)
//          build  Request › Master › Agent 3 › QA › Push › Output                    (the path, flow-route.js line;
//                                                                                     a click on a step opens its detail)
//          Sent back to Agent 3 · not delivered Retry                                (only when QA failed; flow-qa-line.js)
//
// The flow's status select and Drop live in the ⋯ menu, so they stop competing
// with the content; flows.js still handles them (data-flow-status, data-drop).
// So do Archive (Unarchive on an archived flow) and Delete (data-archive,
// data-delete; the calls are flow-trash.js's). Delete on a flow its agent may
// be working on gets the server's question back: `parts.asking` puts it in the
// menu, held open, with Delete (data-confirmed) and Cancel. No window.confirm.
// A why longer than about 160 characters shows its first sentence and `more`.
// Marked words in the why are term chips (FlowDrawer.md). At most three ticket
// chips show, then `+N`, which shows them all for the life of the page.
//
// ⚠️ `updated 2m` is NOT part of the sub's markup: it goes into its own slot as
// text (`updated`), so the minute ticking over never redraws the sub, and an
// expanded `more` or an open ⋯ menu stays as it is.
//
//   html(f, parts)  { head, sub, updated }; `parts` are flows.js's pills: { tickets, envPill, statusPill, statuses },
//                   and `asking`, the server's question while a Delete waits on Delete or Cancel
//   HELP            the opened flow's ONE ?: a short paragraph per Output block, the views and the proof marks
//   firstSentence(text, max?)  PURE: the first sentence, cut after a whole word with … past `max`
//   expandTickets(flowId)      every ticket of that flow on show from now on (what `+N` does)
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const md = s => window.FlowDrawer.md(s)
  const WHY_MAX = 160
  const dfn = (term, text = term) => `<dfn data-term="${term}" tabindex="0">${text}</dfn>`
  // spec 6: what a view shows lives here, never in a row on the page
  const HELP = '<p><b>Story</b>: who did what, and why, in plain lines. <b>auto</b> means the dashboard made it from the steps.</p>' +
    '<p><b>Picture</b>: the result at a glance: the screenshots, the agent diagram, or a chart of the steps (solid is done, dashed is left, ' +
    'orange is blocked or waiting on you). Click a box of the chart to see that step. With a before and after, ' +
    '<b>Compare</b> lays one over the other: drag the handle.</p>' +
    `<p><b>How to test</b>: try each ${dfn('test step')} and tick I saw this; the ticks stay in this browser only.</p>` +
    '<p><b>Details</b>: the full summary and the commits.</p>' +
    '<p><b>Explain</b> walks through the flow one slide at a time: what and why, before and after, how it works, its path through the agents and the QA result.</p>' +
    '<p><b>Send</b>: when the agent says the work is ready, review it here and send it as a pull request; nothing is sent until you click.</p>' +
    `<p>${dfn('status', 'Status')} lists what is built, what is left and the decisions; ${dfn('process', 'Process')} is the full chart. ` +
    'The mark on a done step says how far it is proven:</p><div class="fl-legend small">' +
    `<span><b class="ok">✓</b> ${dfn('verified')}</span><span><b class="cl">●</b> ${dfn('claimed')}</span>` +
    `<span><b class="un">●</b> ${dfn('unproven')}</span><span class="dim">▢ ${dfn('pending')}</span></div>` +
    '<p>Hover a tinted word for what it means; the Glossary page keeps them all.</p>'

  function firstSentence(text, max = WHY_MAX) {
    const s = String(text ?? '').trim().split(/\n\s*\n|\n/)[0].split(/(?<=[.!?])\s+/)[0]
    if (s.length <= max) return s
    const cut = s.slice(0, max - 1)
    return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length)}…`
  }

  function why(text) {
    const w = String(text ?? '').trim()
    if (!w) return ''
    if (w.length <= WHY_MAX) return `<div class="fl-why">${md(w)}</div>`
    const more = ' <button type="button" class="link fl-why-more" data-why-more aria-expanded="false">more</button>'
    const short = md(firstSentence(w)).replace(/<\/p>\s*$/, `${more}</p>`)
    return `<div class="fl-why" data-why><div class="fl-why-short">${short}</div><div class="fl-why-full" hidden>${md(w)}</div></div>`
  }

  /** The flows whose every ticket is on show (`+N` pressed), for the life of the page. */
  const opened = new Set()
  const TICKETS_SHOWN = 3
  /** At most three ticket chips, then `+N` that shows the rest in place, so the meta line stays one line. */
  function ticketChips(f, tickets) {
    const all = Array.isArray(f.tickets) ? f.tickets : []
    if (all.length <= TICKETS_SHOWN || opened.has(f.id)) return tickets(f)
    const rest = all.length - TICKETS_SHOWN
    return tickets({ ...f, tickets: all.slice(0, TICKETS_SHOWN) }) +
      `<button type="button" class="fl-tk-more" data-tk-more="${esc(f.id)}" aria-expanded="false" title="Show all ${all.length} tickets">+${rest}</button>`
  }

  function html(f, { tickets, envPill, statusPill, statuses, asking = null }) {
    const sep = '<span class="fl-sep" aria-hidden="true">·</span>'
    const meta = [`<b>${esc(f.agent)}</b>`, ticketChips(f, tickets), envPill(f.env), statusPill(f.status), window.FlowQa?.mark(f), '<span class="fl-updated" data-updated></span>'].filter(Boolean).join(sep)
    const del = asking
      ? `<p class="small fl-ask-delete">${esc(asking)}</p><span class="fl-ask-acts"><button type="button" class="link" data-delete data-confirmed>Delete</button><button type="button" class="link" data-delete-cancel>Cancel</button></span>`
      : '<button type="button" class="link" data-delete>Delete</button>'
    const menu = `<details class="fl-more"${asking ? ' open' : ''}><summary aria-label="Flow actions" title="Flow actions">⋯</summary><div class="fl-more-menu">
        <label class="small">Flow <select data-flow-status aria-label="Flow status">${statuses.map(s => `<option ${s === f.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        ${f.status !== 'dropped' ? '<button type="button" class="link" data-drop>Drop</button>' : ''}
        <button type="button" class="link" data-archive>${f.archivedAt ? 'Unarchive' : 'Archive'}</button>${del}</div></details>`
    return {
      head: `<div class="fl-open-top"><button type="button" class="link" data-close>← Flows</button></div>
        <h2 class="fl-title">${esc(f.title)}</h2>`,
      sub: `${why(f.why)}<div class="fl-open-meta">${meta}${menu}</div>${window.FlowRoute?.line(f) || ''}${window.FlowQa?.reworkHtml(f) || ''}`,
      updated: `updated ${window.Shell.ago(f.updatedAt)}`,
    }
  }

  // The why's `more`, and the ⋯ menu closing on a press outside it or on Escape (no flows.js handler needed).
  if (window.document?.addEventListener) {
    document.addEventListener('click', e => {
      const tk = e.target.closest?.('[data-tk-more]')
      if (tk) {
        opened.add(tk.dataset.tkMore)
        return window.FlowsView?.load() // the head draws again, every ticket on show
      }
      const more = e.target.closest?.('[data-why-more]')
      if (more) {
        const box = more.closest('[data-why]')
        box.querySelector('.fl-why-short').hidden = true
        box.querySelector('.fl-why-full').hidden = false
        return
      }
      for (const d of document.querySelectorAll('details.fl-more[open]')) if (!d.contains(e.target)) d.open = false
    })
    document.addEventListener('keydown', e => {
      const d = e.key === 'Escape' && document.querySelector('details.fl-more[open]')
      if (!d) return
      e.preventDefault() // one Escape closes one thing: the shell leaves the drawer open
      d.open = false
      d.querySelector('summary')?.focus()
    })
  }

  window.FlowHead = { html, HELP, firstSentence, expandTickets: id => opened.add(id) }
})()
