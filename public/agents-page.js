// The Agents page (#/agents, spec 5): the full agent tree (agent-cards.js in
// full mode: branch lines, subagents, drag order) with each agent's Progress
// report button. The report is the same modal the orchestration grid's column
// head opens (OrchestrationGrid.report in orchestration.js), never a copy.
//
// shell.js calls AgentsPage.open/close; app.js hands every /api/status load to
// AgentsPage.update(data), which draws only while the page is showing.
;(() => {
  let box = null
  let showing = false
  // The legend behind the header chip's ? (spec 6): what the tree and the words on it mean.
  const AGENTS_HELP = '<p>Every Claude Code session the dashboard found, built from the session transcripts and read again every minute.</p>' +
    '<p>Coordinator is the root; the coding agents hang off it (drag a card to reorder), and each agent lists its subagents. ' +
    'A state is a dot and one word: Idle, Working, Waiting, Blocked or Done. Click a card to watch it live.</p>'

  function mount() {
    const section = document.getElementById('agentsView')
    // Independent first, in its own slot (agent-cards.js renderChat, from the pulse)
    section.innerHTML = '<div class="agent-cards ac-grid ac-chat-slot" hidden></div><div class="agent-cards" id="agentsCards"></div>'
    box = section.querySelector('#agentsCards')
    window.AgentCards.renderChat?.()
    // Delegated, so it works for the root card and every stacked card;
    // agent-cards.js leaves clicks on [data-report] to this handler.
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-report]')
      if (b) window.OrchestrationGrid.report(b.dataset.report, b.dataset.label)
    })
  }

  function update(data) {
    if (!showing || !data) return
    window.AgentCards.render(data, { root: box })
    window.Shell.setTitle('Agents', 'agents', data.agents.length)
    window.Shell.setStatus(`updated ${window.Shell.ago(data.builtAt) || '—'}`, AGENTS_HELP)
  }

  window.AgentsPage = {
    open() {
      showing = true
      if (!box) mount()
      const data = window.UI.data()
      if (data) update(data)
      else window.Shell.setStatus('Loading…')
    },
    close() {
      showing = false
    },
    update,
  }
})()
