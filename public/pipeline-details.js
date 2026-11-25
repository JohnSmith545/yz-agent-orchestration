// The details pane under the Agents page diagram (#/agents). A click on an agent box opens its settings WINDOW
// (agent-window.js); this pane holds a step, or an agent a flow's step line pointed at (AgentsPage.showNode):
//   - an agent (the coordinator, the planner, a producer, QA, Security): THAT agent's card exactly as the old tree drew it
//     (agent-cards.js card(): state, what it is doing, who it last talked to, recent tickets, branch,
//     subagents and the Progress report button, which agents-page.js wires to OrchestrationGrid.report),
//     what its role is, a line when it pushed outside QA, and the tickets standing on it;
//     and the user's Specification and Rules for it, with a Settings button in the head that turns them into
//     an editor (agent-rules-view.js draws them; agent-rules.js owns the editor; with neither loaded, the role line);
//   - a step (Request, Human task, Push, Output): a short plain description and the tickets standing there (a click
//     on the Human task box itself goes to the Human review list instead: agents-page.js).
// With nothing clicked it holds the Independent chat card (agent-cards.js renderChat) and one line of help.
// Pure: a node and what is known about it in, HTML out (test/pipeline-details.test.mjs).
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  /** What each role does, in a line. */
  const ROLE = {
    request: 'Where work starts: a request you give the coordinator, who hands it out.',
    coordinator: 'Hands each request to a producer (through the planner when there is one), or does it itself. Its own code changes go to QA too.',
    planner: 'Plans each task the coordinator hands it and gives it to a producer. It writes no code. Always on Opus at high effort.',
    producer: 'Writes the code. Finished code goes to QA; work with no code changes goes to Human task.',
    chat: 'The chat agent in the Ask drawer: answers questions, explains tickets and reviews code. It changes no code, so its work goes straight to the Output.',
    qa: 'Tests every code change. A pass goes on to Push (through Security when there is one); a failure goes back to the producer that made it.',
    security: 'Reviews every change QA passed, at the same commit. A pass lets QA push it; a failure goes back to the producer that made it. Always on Opus at high effort.',
    human: 'You. Work with no code changes passes through here; a flow with steps only you can do (CI/CD, a cloud console, an account setting) waits here until you tick them all.',
    senior: 'Reviews work done by hand that has no code to test: CI/CD, cloud console changes, commands run in a terminal. A pass goes to the Output; a failure goes back to Human task. Always on Opus at high effort.',
    push: 'QA pushes the branch at the exact commit it tested (and Security passed, when there is Security): never forced, never a protected branch.',
    outcome: 'Where work ends: pushed after a QA pass (and a Security pass, when there is Security), or done with no code changes past Human task (and Senior, when there is one). You open the pull request with Send.',
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
   * ticket whose path the diagram lights (its row shows pressed). `rules` is { entry, draft, limits } for an
   * agent (agent-rules.js paneOpts): its saved specification and rules, and the editor's draft while it is open.
   */
  function html(node, { agent = null, worktrees = [], tickets = [], labels = {}, selected = null, rules = null } = {}) {
    const role = ROLE[node.role] || ''
    const n = pushes(agent)
    const watch = agent ? `<a class="link" href="#/agent/${encodeURIComponent(agent.sessionId)}" title="Watch it work, live">Watch live</a>` : ''
    const R = node.kind === 'agent' ? window.AgentRulesView : null
    const settings = R ? R.settingsButton(node, !!rules?.draft) : ''
    const about = R ? R.slotHtml(node, role, rules || {}) : role ? `<p class="pl-desc">${esc(role)}</p>` : ''
    let body = ''
    // the chat agent is no session to look up: its own card (state, cost, opens the drawer), drawn by AgentCards.renderChat
    if (node.role === 'chat') body = '<div class="agent-cards ac-grid ac-chat-slot" hidden></div>'
    else if (node.kind === 'agent') {
      body = agent ? `<div class="pl-card">${window.AgentCards.card(agent, { worktrees })}</div>` : `<div class="pl-card pl-missing">${window.AgentCards.missingRoot(node.label)}</div>`
    }
    return `<div class="pl-det" data-node="${esc(node.id)}">
      <div class="pl-det-head"><h2>${esc(node.label)}</h2>${watch}${settings}<button type="button" class="link pl-det-x" data-close>Close</button></div>
      ${about}
      ${n ? `<p class="pl-push-line"><i class="pl-push-dot" aria-hidden="true"></i>${pushLine(n)}</p>` : ''}
      ${body}
      ${here(tickets, labels, selected)}
    </div>`
  }

  /** Nothing clicked yet: the Independent chat card (drawn into its slot by AgentCards.renderChat) and how to use the page. */
  const empty = () => '<div class="agent-cards ac-grid ac-chat-slot" hidden></div><p class="pl-intro">Click a step to see who is there and what they are doing. Open Tickets on the right to follow one through the pipeline.</p>'

  window.PipelineDetails = { html, empty, pushes, pushLine, ROLE }
})()
