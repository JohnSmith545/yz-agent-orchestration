// The details pane under the Agents page diagram (#/agents). Click a node and it shows:
//   - an agent (the coordinator, a producer, QA): THAT agent's card exactly as the old tree drew it
//     (agent-cards.js card(): state, what it is doing, who it last talked to, recent tickets, branch,
//     subagents and the Progress report button, which agents-page.js wires to OrchestrationGrid.report),
//     what its role is, a line when it pushed outside QA, and the tickets standing on it;
//   - a step (Request, Push, Outcome): a short plain description and the tickets standing there.
// With nothing clicked it holds the Independent chat card (agent-cards.js renderChat) and one line of help.
// Pure: a node and what is known about it in, HTML out (test/pipeline-details.test.mjs).
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  /** What each role does, in a line. */
  const ROLE = {
    request: 'Where work starts: a request you give the coordinator, who hands it out.',
    coordinator: 'Hands each request to a producer, or does it itself. Its own code changes go to QA too.',
    producer: 'Writes the code. Finished code goes to QA; work with no code changes goes straight to the Outcome.',
    qa: 'Tests every code change. A pass goes on to Push; a failure goes back to the producer that made it.',
    push: 'QA pushes the branch at the exact commit it tested: never forced, never a protected branch.',
    outcome: 'Where work ends: pushed after a QA pass, or done with no code changes. You open the pull request with Send.',
  }

  const pushes = a => Math.max(0, Number(a?.pushesOutsideQa) || 0)
  const pushLine = n => `Pushed ${n} ${n === 1 ? 'time' : 'times'} outside QA today`

  function here(tickets, labels, selected) {
    const T = window.PipelineTickets
    const list = (tickets || []).slice()
    const head = `<h3 class="pl-det-sub">Here now <span class="faint">· ${list.length}</span></h3>`
    return list.length ? head + T.ticketsHtml(T.ticketList(list, { archived: true }), { labels, selected }) : `${head}<p class="pl-none">No tickets here right now.</p>`
  }

  /**
   * One node's details. `agent` is its /api/status record (found by label; null when it is not running),
   * `worktrees` the /api/status rows (for the card's branch), `tickets` the ones on this node, `selected` the
   * ticket whose path the diagram lights (its row shows pressed).
   */
  function html(node, { agent = null, worktrees = [], tickets = [], labels = {}, selected = null } = {}) {
    const role = ROLE[node.role] || ''
    const n = pushes(agent)
    const watch = agent ? `<a class="link" href="#/agent/${encodeURIComponent(agent.sessionId)}" title="Watch it work, live">Watch live</a>` : ''
    let body = ''
    if (node.kind === 'agent') {
      body = agent ? `<div class="pl-card">${window.AgentCards.card(agent, { worktrees })}</div>` : `<div class="pl-card pl-missing">${window.AgentCards.missingRoot(node.label)}</div>`
    }
    return `<div class="pl-det" data-node="${esc(node.id)}">
      <div class="pl-det-head"><h2>${esc(node.label)}</h2>${watch}<button type="button" class="link pl-det-x" data-close>Close</button></div>
      ${role ? `<p class="pl-desc">${esc(role)}</p>` : ''}
      ${n ? `<p class="pl-push-line"><i class="pl-push-dot" aria-hidden="true"></i>${pushLine(n)}</p>` : ''}
      ${body}
      ${here(tickets, labels, selected)}
    </div>`
  }

  /** Nothing clicked yet: the Independent chat card (drawn into its slot by AgentCards.renderChat) and how to use the page. */
  const empty = () => '<div class="agent-cards ac-grid ac-chat-slot" hidden></div><p class="pl-hint">Click a step to see who is there and what they are doing. Open Tickets on the right to follow one through the pipeline.</p>'

  window.PipelineDetails = { html, empty, pushes, pushLine, ROLE }
})()
