// The Agents page (#/agents): the orchestration diagram. Who hands work to whom, from the Request to the
// Outcome, drawn from /api/pipeline's graph (pipeline-layout.js, pipeline-view.js), every ticket as a chip on
// the node it stands at now, a details pane below (pipeline-details.js: the clicked agent's card from
// agent-cards.js, Progress report and all), and a pull-out panel on the right (pipeline-panel.js) whose
// Tickets and Outputs lists select a ticket and light its path through the diagram.
//
// shell.js calls AgentsPage.open/close; app.js hands every /api/status load to AgentsPage.update(data)
// (and the same data again every 15 s, to refresh the times). A NEW /api/status load also re-reads
// /api/pipeline, so the diagram refreshes at exactly the status cadence (every minute, and on Refresh).
// The diagram is built once and patched after, so a refresh never flickers or drops the selection.
//
//   click a node        its details below (again: back to the default pane)
//   click a chip        that ticket's explanation on Flows (FlowsView.explain, else the flow)
//   click a panel row   select the ticket: its stage.path lights up; the same row again, or Escape, clears it
;(() => {
  let showing = false
  let box = null
  let view = null
  let panel = null
  let details = null
  let pipeline = null
  let failure = null
  let status = null // the last /api/status data
  let statusSeen = null // the status object the pipeline was last read for
  let loading = false
  let selNode = null
  let selTicket = null

  // The legend behind the header chip's ?.
  const AGENTS_HELP = '<p>Who hands work to whom: a request goes to the coordinator, who hands it to a producer; every code change goes to QA, ' +
    'which pushes it on a pass or sends it back on a failure (the return arrows). Work with no code changes goes straight to the Outcome (dashed).</p>' +
    '<p>Each chip is a ticket where it stands now: green passed, red failed, grey anything else. Click a step for its details, a chip for its explanation, ' +
    'and open Tickets on the right to light one ticket\'s path. A red mark on an agent means it pushed outside QA today.</p>'

  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  function mount() {
    const section = document.getElementById('agentsView')
    section.innerHTML = `<div class="pl-page">
      <div class="pl-main">
        <div class="pl-wrap" id="plDiagram"></div>
        <div class="pl-details" id="plDetails"></div>
      </div>
      <aside class="pl-panel" id="plPanel" aria-label="Tickets and outputs"></aside>
    </div>`
    box = section.querySelector('.pl-page')
    details = section.querySelector('#plDetails')
    view = window.PipelineView.create(section.querySelector('#plDiagram'), { onNode: pickNode, onChip: id => window.PipelineTickets.explain(id) })
    panel = window.PipelinePanel.create(section.querySelector('#plPanel'), { page: box, onSelect: pickTicket })
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
  }

  function renderDetails(groups, labels) {
    const node = selNode && pipeline.graph.nodes.find(n => n.id === selNode)
    const agent = node?.kind === 'agent' ? (status?.agents || []).find(a => a.label === node.label) || null : null
    const html = node
      ? window.PipelineDetails.html(node, { agent, worktrees: status?.worktrees || [], tickets: groups[node.id] || [], labels, selected: selTicket })
      : window.PipelineDetails.empty()
    if (details._html === html) return
    details.innerHTML = html
    details._html = html
    if (!node) window.AgentCards?.renderChat?.()
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
    // a selection outlives a refresh while what it points at still exists
    if (selNode && !graph.nodes.some(n => n.id === selNode)) selNode = null
    const ticket = selTicket ? tickets.find(t => t.id === selTicket) : null
    if (!ticket) selTicket = null
    view.update({ graph, tickets, agents: status?.agents || [] })
    view.setPath(ticket ? window.PipelineLayout.highlight(graph, ticket.stage?.path) : null)
    view.setNode(selNode)
    panel.update(pipeline, selTicket)
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
  }
})()
