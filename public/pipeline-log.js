// The Log in the Agents page pull-out panel (pipeline-panel.js, its third choice), the PURE half: the filters, the
// /api/log query, the chips and the list HTML. No DOM, no fetch, so test/pipeline-log.test.mjs runs it in a vm.
//
//   PipelineLog.listHtml({ data, failure }, { selected, win, filter })   the line above the list and the rows
//   PipelineLog.chipsHtml(filter)          All | Delivered | Caught | Missed | Slipped through | Rules
//   PipelineLog.queryOf(win, filter)       '/api/log?days=30&cell=caught' (Rules is kind=rule)
//   PipelineLog.filterOf(v)                a filter key, All for anything else
//
// One row per event (score-log.mjs): the time as the pages show times (Shell.ago, the exact time on hover), the
// plain sentence, the flow's title, and a quiet tag when the event put a count in a score ("Counted: right,
// caught"). A row with a flow is a button with data-ticket, so the panel selects that ticket exactly as a Tickets
// row does; an event with no flow (a rule change) is plain text. Every value goes through UI.esc. Classes are
// lg-: the pl- prefix is shared with the command palette.
;(() => {
  const FILTERS = Object.freeze([
    Object.freeze({ key: 'all', label: 'All' }),
    Object.freeze({ key: 'delivered', label: 'Delivered' }),
    Object.freeze({ key: 'caught', label: 'Caught' }),
    Object.freeze({ key: 'missed', label: 'Missed' }),
    Object.freeze({ key: 'slipped', label: 'Slipped through' }),
    Object.freeze({ key: 'rule', label: 'Rules' }),
  ])
  const CELLS = ['delivered', 'caught', 'missed', 'slipped']
  const TAG = Object.freeze({ delivered: 'Counted: right, delivered', caught: 'Counted: right, caught', missed: 'Counted: wrong, missed', slipped: 'Counted: wrong, slipped through' })
  /** The empty line per filter: "Nothing caught in the last 7 days." */
  const NOTHING = Object.freeze({ all: 'Nothing in the log', delivered: 'Nothing delivered', caught: 'Nothing caught', missed: 'Nothing missed', slipped: 'Nothing slipped through', rule: 'No rule changes' })

  const esc = s => window.UI.esc(s)
  const filterOf = v => (FILTERS.some(f => f.key === v) ? v : 'all')
  const winOf = v => (v === '7' || v === 'all' ? v : '30')
  const spanOf = win => (win === 'all' ? 'all time' : `the last ${win} days`)

  function queryOf(win, filter) {
    const f = filterOf(filter)
    const q = `/api/log?days=${winOf(win)}`
    if (CELLS.includes(f)) return `${q}&cell=${f}`
    return f === 'rule' ? `${q}&kind=rule` : q
  }

  function chipsHtml(filter) {
    const f = filterOf(filter)
    return `<div class="lg-chips" role="group" aria-label="Show in the log">${FILTERS.map(x => `<button type="button" data-log-chip="${x.key}" aria-pressed="${x.key === f}">${x.label}</button>`).join('')}</div>`
  }

  function rowHtml(e, selected) {
    const when = window.Shell?.ago?.(e.at) || ''
    const exact = Number.isNaN(Date.parse(e.at)) ? '' : new Date(e.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    const title = e.flow ? `<span class="lg-flow">${esc(e.flow.title || e.flow.id)}</span>` : ''
    const inner = `<span class="lg-top"><time class="lg-time" datetime="${esc(e.at)}" title="${esc(exact)}">${esc(when)}</time>${title}</span>` +
      `<span class="lg-text">${esc(e.text)}</span>${TAG[e.cell] ? `<span class="lg-tag">${TAG[e.cell]}</span>` : ''}`
    if (!e.flow?.id) return `<li><div class="lg-row lg-plain">${inner}</div></li>`
    return `<li><button type="button" class="lg-row" data-ticket="${esc(e.flow.id)}" aria-pressed="${e.flow.id === selected}">${inner}</button></li>`
  }

  function listHtml(state, { selected = null, win = '30', filter = 'all' } = {}) {
    const span = spanOf(winOf(win))
    const note = state?.failure ? `<p class="lg-note">Could not load the log: ${esc(state.failure)}</p>` : ''
    const data = state?.data
    if (!data) return `${note}<p class="lg-sum">Loading the log…</p>`
    const events = Array.isArray(data.events) ? data.events : []
    const total = Number(data.total) || events.length
    if (!events.length) return `${note}<p class="lg-sum">${NOTHING[filterOf(filter)]} in ${span}.</p>`
    const sum = total > events.length ? `Showing the newest ${events.length} of ${total} in ${span}.` : `${total} ${total === 1 ? 'event' : 'events'} in ${span}.`
    return `${note}<p class="lg-sum">${sum}</p><ul class="lg-list">${events.map(e => rowHtml(e, selected)).join('')}</ul>`
  }

  window.PipelineLog = { FILTERS, TAG, filterOf, queryOf, chipsHtml, listHtml }
})()
