// The Agents page (#/agents): the orchestration diagram. Who hands work to whom, from the Request to the
// Output, drawn from /api/pipeline's graph (pipeline-layout.js, pipeline-view.js), every ticket as a chip on
// the node it stands at now, a details pane below (pipeline-details.js: the clicked agent's card from
// agent-cards.js, Progress report and all), and a pull-out panel on the right (pipeline-panel.js) whose
// Tickets and Outputs lists select a ticket and light its path through the diagram. Above the diagram, the
// pipeline score (score-strip.js), read again with every pipeline read.
//
// shell.js calls AgentsPage.open/close; app.js hands every /api/status load to AgentsPage.update(data)
// (and the same data again every 15 s, to refresh the times). A NEW /api/status load also re-reads
// /api/pipeline, so the diagram refreshes at exactly the status cadence (every minute, and on Refresh).
// The diagram is built once and patched after, so a refresh never flickers or drops the selection.
//
//   click a node        its details below (again: back to the default pane)
//   click a chip        that ticket's explanation on Flows (FlowsView.explain, else the flow)
//   click a panel row   select the ticket: its route lights up from its own progress (flow-route.js highlight):
//                       done and current in the accent, the steps still ahead as a dashed accent outline; the
//                       same row again, or Escape, clears it
//   Settings (an agent's)  its specification and rules as an editor in the pane (agent-rules.js): kept as it is
//                       through every redraw; Escape closes it before it clears anything else
//   AgentsPage.showNode(nodeId, flowId)   from a flow's step line (flow-route.js go): this page with that node's
//                       details open and that flow selected
;(() => {
  let showing = false
  let box = null
  let view = null
  let panel = null
  let details = null
  let score = null
  let pipeline = null
  let failure = null
  let status = null // the last /api/status data
  let statusSeen = null // the status object the pipeline was last read for
  let loading = false
  let selNode = null
  let selTicket = null
  // How many test steps each output QA never saw has on its own Output (derived.output.tests), from
  // /api/flows/<id>, so How to test shows only where there is something to show (PipelineTickets.testTarget).
  const steps = {} // id -> count
  const stepsAt = {} // id -> the updatedAt that count was read at

  // The legend behind the header chip's ?.
  const AGENTS_HELP = '<p>Who hands work to whom: a request goes to the coordinator, who hands it to a producer; every code change goes to QA, ' +
    'which pushes it on a pass or sends it back on a failure (the return arrows). Work with no code changes goes straight to the Output (dashed), ' +
    'and so does the chat agent\'s: it answers, explains and reviews, and changes no code.</p>' +
    '<p>Each chip is a ticket where it stands now: green passed, red failed, grey anything else. Click a step for its details, a chip for its explanation, ' +
    'and open Tickets on the right to light one ticket\'s route: the steps it has taken in the accent, those still ahead dashed. A red mark on an agent means it pushed outside QA today.</p>'

  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  function mount() {
    const section = document.getElementById('agentsView')
    section.innerHTML = `<div class="pl-page">
      <div class="pl-main">
        <div class="psc" id="plScore"></div>
        <div class="pl-wrap" id="plDiagram"></div>
        <div class="pl-details" id="plDetails"></div>
      </div>
      <aside class="pl-panel" id="plPanel" aria-label="Tickets and outputs"></aside>
    </div>`
    box = section.querySelector('.pl-page')
    details = section.querySelector('#plDetails')
    view = window.PipelineView.create(section.querySelector('#plDiagram'), { onNode: pickNode, onChip: id => window.PipelineTickets.explain(id) })
    panel = window.PipelinePanel.create(section.querySelector('#plPanel'), { page: box, onSelect: pickTicket })
    window.AgentRules?.bind(details, render)
    // the scorecard above the diagram (score-strip.js): read again with every pipeline read
    score = window.ScoreStrip?.create(section.querySelector('#plScore')) || null
    // Delegated: the agent card's Progress report (agent-cards.js leaves [data-report] to its page), a
    // subagent row (watch it live), the pane's Close, and the ticket rows of Here now.
    details.addEventListener('click', e => {
      const rep = e.target.closest('[data-report]')
      if (rep) return window.OrchestrationGrid?.report(rep.dataset.report, rep.dataset.label)
      const sub = e.target.closest('[data-href]')
      if (sub) return (location.hash = sub.dataset.href)
      if (e.target.closest('[data-close]')) return pickNode(selNode)
      const row = e.target.closest('[data-ticket]')
      if (row) pickTicket(row.dataset.ticket)
    })
    // Escape clears the ticket, then the node, one per press; never one typed in the Ask drawer, and never
    // one a popover or the palette already took (they preventDefault, as shell.js expects).
    document.addEventListener('keydown', e => {
      if (!showing || e.key !== 'Escape' || e.defaultPrevented || e.target?.closest?.('#drawer')) return
      if (window.AgentRules?.escape()) return e.preventDefault() // an open Settings editor first
      if (selTicket) selTicket = null
      else if (selNode) selNode = null
      else return
      e.preventDefault()
      render()
    })
  }

  function pickNode(id) {
    selNode = selNode === id ? null : id
    render()
    if (selNode && details.getBoundingClientRect().top > window.innerHeight - 80) details.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'nearest' })
  }
  function pickTicket(id) {
    selTicket = selTicket === id ? null : id
    render()
  }

  async function loadPipeline() {
    if (loading) return
    loading = true
    window.AgentRules?.load() // the saved specifications and rules, at the same cadence
    score?.refresh()
    try {
      const r = await fetch('/api/pipeline')
      if (!r.ok) throw new Error(await r.text())
      pipeline = await r.json()
      failure = null
    } catch (e) {
      failure = e.message || String(e)
    } finally {
      loading = false
    }
    render()
    if (pipeline) loadSteps(pipeline.tickets)
  }

  /** Looks up the test steps of the outputs with no QA record that are new or changed since last read. */
  async function loadSteps(tickets) {
    const T = window.PipelineTickets
    const outputs = T.outputList(tickets, { archived: true })
    for (const t of outputs) if (t.id in steps && stepsAt[t.id] !== t.updatedAt) delete steps[t.id]
    const ids = T.stepsToFetch(outputs, steps).slice(0, 20)
    if (!ids.length) return
    await Promise.all(ids.map(async id => {
      try {
        const r = await fetch(`/api/flows/${encodeURIComponent(id)}`)
        if (r.status === 404) steps[id] = 0
        else if (r.ok) steps[id] = Number((await r.json())?.derived?.output?.tests) || 0
        else return // a failed read: no button for now, looked up again on the next load
        stepsAt[id] = outputs.find(t => t.id === id)?.updatedAt
      } catch {}
    }))
    render()
  }

  function renderDetails(groups, labels) {
    const node = selNode && pipeline.graph.nodes.find(n => n.id === selNode)
    const agent = node?.kind === 'agent' ? (status?.agents || []).find(a => a.label === node.label) || null : null
    const html = node
      ? window.PipelineDetails.html(node, { agent, worktrees: status?.worktrees || [], tickets: groups[node.id] || [], labels, selected: selTicket, rules: node.kind === 'agent' ? window.AgentRules?.paneOpts(node) : null })
      : window.PipelineDetails.empty()
    // AgentRules.paint keeps a Settings editor in use where it is and swaps only what is around it
    if (!(window.AgentRules ? window.AgentRules.paint(details, html) : details._html !== html && ((details.innerHTML = details._html = html), true))) return
    if (!node || node.role === 'chat') window.AgentCards?.renderChat?.() // the default pane and the chat node hold its card
  }

  function renderStatus() {
    const { esc } = window.UI
    const when = window.Shell.ago(pipeline?.builtAt)
    const line = pipeline ? `updated ${when || '—'}` : 'Loading…'
    window.Shell.setStatus(failure ? `<span class="warn">Could not load the pipeline: ${esc(failure)}</span>${pipeline ? ` · ${line}` : ''}` : line, AGENTS_HELP)
    if (status) window.Shell.setTitle('Agents', 'agents', status.agents.length)
  }

  function render() {
    if (!showing || !box) return
    renderStatus()
    if (!pipeline) return
    const { graph, tickets } = pipeline
    // A selection outlives a refresh while what it points at still exists. It is dropped only against a
    // pipeline read NOW: open() draws at once with the one an earlier visit read, and a flow started since
    // (showNode from its head) would lose its selection before the fresh list arrived (QA, 2026-11-24).
    const fresh = !loading
    if (fresh && selNode && !graph.nodes.some(n => n.id === selNode)) selNode = null
    const ticket = selTicket ? tickets.find(t => t.id === selTicket) : null
    if (fresh && !ticket) selTicket = null
    view.update({ graph, tickets, agents: status?.agents || [] })
    view.setPath(ticket ? window.FlowRoute.highlight(graph, ticket.progress) : null)
    view.setNode(selNode)
    panel.update(pipeline, selTicket, steps)
    renderDetails(window.PipelineTickets.byNode(tickets), window.PipelineTickets.labelsOf(graph))
  }

  /** Every /api/status load (and the 15 s redraw with the same data): a new load re-reads the pipeline. */
  function update(data) {
    if (data) status = data
    if (!showing) return
    if (status && status !== statusSeen) {
      statusSeen = status
      loadPipeline()
    }
    render()
  }

  window.AgentsPage = {
    open() {
      showing = true
      if (!box) mount()
      status = window.UI.data() || status
      statusSeen = status
      loadPipeline()
      render()
    },
    close() {
      showing = false
    },
    update,
    /** This page with node `id`'s details open and flow `flowId` selected (its route lit); from a flow's step line. */
    showNode(id, flowId) {
      selNode = id || null
      selTicket = flowId || null
      if (location.hash === '#/agents' && showing) render()
      else location.hash = '#/agents'
    },
  }
})()
