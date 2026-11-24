// The tickets of /api/pipeline on the Agents page (#/agents): the chips on each node of the diagram and the
// two lists of the side panel. Pure except explain and howToTest, which hand over to another page.
//
//   byNode(tickets)             { nodeId: [tickets] }: where each ticket stands now, the current step of its
//                               `progress` (flow-route.js at; stage.node when a ticket has none), dropped and
//                               archived off
//   chips(list) / chipRows(g)   at most MAX chips per node and a +N; the chip rows the tallest node needs
//   chipHtml(t, labels)         one chip: the title cut by CSS, its status in the tooltip
//   ticketList / ticketsHtml    Tickets: needs attention first (failed, sent back, blocked, waiting), then newest;
//                               each row says the flow's type and its current step (`build · QA`)
//   outputList / outputsHtml    Outputs: finished tickets with output or a QA pass, newest first
//   testTarget(t, steps)        where How to test goes: 'qa' (QA has a record), 'flow' (its Output has test
//                               steps), or null (no button: there is nothing to show)
//   stepsToFetch(list, known)   the outputs whose test step count the page must still look up (/api/flows/<id>)
//   explain(id) / howToTest(id, to)  the Flows explanation (FlowsView.explain, else the flow) / the QA page or
//                               the flow's Output tab
//
// Colour is for meaning only (the user's rule): green for passed, red for a failure, neutral otherwise,
// and the word is always there as text too.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const MAX = 4

  const WORD = { working: 'Working', blocked: 'Blocked', waiting: 'Waiting', pending: 'Queued', testing: 'Being tested', rework: 'Sent back', failed: 'Failed', passed: 'Passed', done: 'Done', dropped: 'Dropped' }
  const QA_WORD = { passed: 'Passed', failed: 'Failed', 'qa-failed': 'Failed', testing: 'Being tested', pending: 'Queued' }
  /** Lower comes first in Tickets: what needs you. */
  const ATTENTION = { failed: 0, rework: 1, blocked: 2, waiting: 3 }

  const stageStatus = t => (t?.stage?.node ? String(t.stage.status || '') : 'dropped')
  const word = t => WORD[stageStatus(t)] || stageStatus(t) || 'Unknown'
  const tone = t => {
    const s = stageStatus(t)
    const q = t?.qa?.status
    if (s === 'failed' || s === 'rework' || q === 'failed' || q === 'qa-failed') return 'bad'
    if (s === 'passed') return 'ok'
    return ''
  }
  const attention = t => ATTENTION[stageStatus(t)] ?? 9
  const newest = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  const byNeed = (a, b) => attention(a) - attention(b) || newest(a, b)
  const visible = (t, archived) => archived || !t.archived

  /** { nodeId: label } from the graph, so a row can say where its ticket is. */
  const labelsOf = graph => Object.fromEntries((graph?.nodes || []).map(n => [n.id, n.label]))
  /** Where a ticket stands: its progress's current step (the flow is the source of truth), else its stage. */
  const nodeOf = t => (Array.isArray(t?.progress) && window.FlowRoute ? window.FlowRoute.at(t.progress) : t?.stage?.node)
  /** `build · QA`: the type and the current step, as a row says them; the stage's node before progress exists. */
  const whereOf = (t, labels) => {
    const now = window.FlowRoute && Array.isArray(t?.progress) ? window.FlowRoute.nowLabel(t) : labels[t?.stage?.node]
    return [t?.route?.type, now || 'Dropped'].filter(Boolean).join(' · ')
  }

  function byNode(tickets) {
    const out = {}
    for (const t of tickets || []) {
      const node = nodeOf(t)
      if (!node || t.archived) continue
      ;(out[node] ||= []).push(t)
    }
    for (const list of Object.values(out)) list.sort(byNeed)
    return out
  }
  const chips = list => ({ shown: (list || []).slice(0, MAX), more: Math.max(0, (list || []).length - MAX) })
  const chipRows = groups => Math.min(MAX, Math.max(0, ...Object.values(groups || {}).map(l => l.length)))

  const tipOf = (t, labels) => [t.title || t.id, whereOf(t, labels || {}), word(t)].filter(Boolean).join(' · ')

  function chipHtml(t, labels) {
    const tn = tone(t)
    return `<button type="button" class="pl-chip${tn ? ` t-${tn}` : ''}" data-ticket="${esc(t.id)}" title="${esc(tipOf(t, labels))}">${esc(t.title || t.id)}</button>`
  }

  // ═══ Tickets ═══

  const ticketList = (tickets, { archived = false } = {}) => (tickets || []).filter(t => visible(t, archived)).sort(byNeed)

  function ticketsHtml(list, { labels = {}, selected = null } = {}) {
    if (!list.length) return '<p class="empty">No tickets on the pipeline yet.</p>'
    return `<ul class="pl-rows">${list
      .map(t => {
        const tn = tone(t)
        const on = t.id === selected
        return `<li><button type="button" class="pl-row${t.archived ? ' pl-archived' : ''}" data-ticket="${esc(t.id)}" aria-pressed="${on}" title="${esc(tipOf(t, labels))}">` +
          `<span class="pl-row-title">${esc(t.title || t.id)}</span>` +
          `<span class="pl-row-meta"><span class="pl-row-stage">${esc(whereOf(t, labels))}</span><span class="pl-word${tn ? ` t-${tn}` : ''}">${esc(word(t))}</span></span>` +
          '</button></li>'
      })
      .join('')}</ul>`
  }

  // ═══ Outputs ═══

  const finished = t => t.status === 'done' || t.stage?.node === 'outcome'
  const outputList = (tickets, { archived = false } = {}) =>
    (tickets || []).filter(t => visible(t, archived) && finished(t) && (t.hasOutput || t.qa?.status === 'passed')).sort(newest)

  const qaWord = t => QA_WORD[t.qa?.status] || (t.codeProducing ? 'Not tested' : 'No code changes')
  const qaTone = t => (t.qa?.status === 'passed' ? 'ok' : t.qa?.status === 'failed' || t.qa?.status === 'qa-failed' ? 'bad' : '')

  /**
   * Where How to test goes. ⚠️ ONLY a ticket QA has a record of goes to /QA: one it never saw (a flow with no
   * code changes skips QA by design) used to open #/qa/<id> on a red "QA has no record" dead end. Without a
   * record it is the flow's own How to test (its Output tab), when its agent wrote test steps; `steps` is that
   * count (derived.output.tests), undefined until the page has looked it up. Nothing to show: no button.
   */
  const testTarget = (t, steps) => (t?.qa ? 'qa' : steps > 0 ? 'flow' : null)
  const stepsToFetch = (list, known = {}) => (list || []).filter(t => !t.qa && !(t.id in known)).map(t => t.id)

  function outputsHtml(list, { selected = null, steps = {} } = {}) {
    if (!list.length) return '<p class="empty">Nothing finished with an output yet.</p>'
    return `<ul class="pl-rows">${list
      .map(t => {
        const tn = qaTone(t)
        const on = t.id === selected
        const to = testTarget(t, steps[t.id])
        return `<li class="pl-out"><button type="button" class="pl-row${t.archived ? ' pl-archived' : ''}" data-ticket="${esc(t.id)}" aria-pressed="${on}" title="${esc(t.title || t.id)}">` +
          `<span class="pl-row-title">${esc(t.title || t.id)}</span>` +
          `<span class="pl-row-meta"><span class="pl-word${tn ? ` t-${tn}` : ''}">${esc(qaWord(t))}</span></span></button>` +
          `<div class="pl-out-acts"><button type="button" class="link" data-explain="${esc(t.id)}">Explain</button>` +
          (to ? `<button type="button" class="link" data-test="${esc(t.id)}" data-to="${to}">How to test</button>` : '') + '</div></li>'
      })
      .join('')}</ul>`
  }

  // ═══ handing over to another page ═══

  /** The explanation on Flows (the Flows page adds FlowsView.explain); before it exists, the flow itself. */
  function explain(id) {
    const F = window.FlowsView
    if (typeof F?.explain === 'function') return F.explain(id)
    if (typeof F?.gotoFlow === 'function') return F.gotoFlow(id)
    location.hash = '#/flows'
  }
  /**
   * How to test it. `to` 'qa' (testTarget): the QA page at this ticket (its address when the page cannot open
   * it). `to` 'flow': the flow on its Output tab, scrolled to its How to test block once it is drawn.
   */
  function howToTest(id, to) {
    if (to === 'qa') {
      const Q = window.QaPage
      if (typeof Q?.gotoFlow === 'function') return Q.gotoFlow(id)
      location.hash = `#/qa/${encodeURIComponent(id)}`
      return
    }
    const F = window.FlowsView
    if (typeof F?.gotoFlow !== 'function') return void (location.hash = '#/flows')
    F.gotoFlow(id, null, 'output')
    // that flow's block, not one still showing from the flow open before it (flows.js marks .fl-open with data-flow)
    const sel = `#flowsView .fl-open[data-flow="${String(id).replace(/["\\]/g, '\\$&')}"] .ob-test`
    window.Shell?.whenReady?.(sel, el => el.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 3000)
  }

  window.PipelineTickets = { labelsOf, tone, word, byNode, chips, chipRows, chipHtml, ticketList, ticketsHtml, outputList, outputsHtml, qaWord, testTarget, stepsToFetch, explain, howToTest, MAX }
})()
