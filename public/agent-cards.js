// The agent card, from ONE renderer in two forms (spec 5).
//
//   full (the Agents page details pane, pipeline-details.js): the role, every
//   ticket, the branch of its newest worktree, who it talks to, its subagents
//   and a Progress report button.
//   compact (Home): name, state, the last action on one line and up to four
//   ticket chips, as a plain grid: Coordinator, the coding agents by name, then
//   everyone else most recently active first.
//
// Independent, the chat agent, is not a transcript session the status scan
// finds, so it has its own compact card (chatCard) from /api/pulse, drawn into
// every .ac-chat-slot (Home and the Agents page); a click opens the Ask drawer.
//
// Click a Home card (or Enter) to watch that agent. AgentCards.card(agent,
// opts) is PURE (an agent in, HTML out) so test/agent-cards.test.mjs can check
// both forms in a vm.
//
// Needs app.js first (window.UI). app.js calls AgentCards.render(data,
// { root: 'agentCards' }) after every /api/status load; pipeline-details.js
// draws card() and missingRoot() into the Agents page details pane.
;(function () {
  const COMPACT_CHIPS = 4

  // ─── one card ──────────────────────────────────────────────────────────────

  const roleOf = a => (a.coordinator ? 'Coordinator' : a.coding ? 'Coding agent' : 'Session')

  // A talking partner can be a subagent id; show its brief instead.
  const partner = a => {
    const t = a.talkingWith
    if (!t) return ''
    const sub = a.subagents.find(s => s.id === t.with)
    const who = sub ? `subagent: ${sub.description}` : t.with
    return `${t.direction === 'to' ? '→' : '←'} ${who} · ${window.Shell.ago(t.t)}`
  }

  const doing = a => {
    const t = a.lastTool
    if (!t) return ''
    // Some tools log their raw input as the summary; a JSON blob says nothing.
    const raw = String(t.summary || '').replace(/\s+/g, ' ')
    const what = /^[[{]/.test(raw) ? '' : raw.slice(0, 110)
    return a.state === 'idle' ? `Last: ${t.tool}${what ? `, ${what}` : ''} · ${window.Shell.ago(t.t)}` : `${t.tool}: ${what}`
  }

  /**
   * Pure: one agent's card as HTML. `compact` keeps the name, the state, one
   * last-action line and up to four ticket chips (+N for the rest); full adds
   * the role, every ticket, the branch of its newest worktree (from
   * `worktrees`, the /api/status rows), who it talks to, its subagents and the
   * Progress report button.
   */
  function card(a, { compact = false, worktrees = [] } = {}) {
    const { esc, stateChip } = window.UI
    const ids = compact ? a.recentTickets.slice(0, COMPACT_CHIPS) : a.recentTickets
    const more = a.recentTickets.length - ids.length
    const tickets = ids.map(id => `<span class="id chip">${esc(id)}</span>`).join('') + (more > 0 ? `<span class="ac-more">+${more}</span>` : '')
    const now = doing(a)
    // stopped for your permission or reply (waiting.mjs, the server's waitingOnYou)
    const w = a.waitingOnYou
    const needs = w ? `<div class="ac-needs" title="${esc(w.reason)}">${w.kind === 'question' ? 'Asked you' : 'Needs your OK'}: ${esc(w.reason)}</div>` : ''
    const waitCls = w ? ' is-waiting' : ''
    const nowLine = needs + (now ? `<div class="ac-now" title="${esc(now)}">${esc(now)}</div>` : '')
    if (compact) {
      return `<div class="ac ac-compact${a.coding ? '' : ' ac-quiet'}${waitCls}" data-state="${esc(a.state)}">
      <div class="ac-head"><span class="ac-name">${esc(a.label)}</span><span class="ac-state">${stateChip(a.state)}</span></div>
      ${nowLine}
      ${tickets ? `<div class="ac-foot">${tickets}</div>` : ''}
    </div>`
    }
    const wt = worktrees.find(w => w.name === a.recentWorktrees[0])
    const branch = wt
      ? `<span class="branch">${esc(wt.branch)}</span>${wt.dirty ? `<span class="warn small">${wt.dirty} uncommitted</span>` : ''}`
      : ''
    const subs = a.subagents.length
      ? `<ul class="ac-subs">${a.subagents
          .map(
            s => `<li data-href="#/agent/${encodeURIComponent(a.sessionId)}/${encodeURIComponent(s.id)}" data-state="${esc(s.state)}">
              <span class="ac-sub-name">${esc(s.description)}</span>${stateChip(s.state)}<span class="small">${window.Shell.ago(s.updatedAt)}</span>
            </li>`
          )
          .join('')}</ul>`
      : ''
    const talk = partner(a)
    return `<div class="ac${a.coding ? '' : ' ac-quiet'}${waitCls}" data-state="${esc(a.state)}">
      <div class="ac-head">
        <span class="ac-name">${esc(a.label)}</span>
        <span class="ac-role">${roleOf(a)}</span>
        <span class="ac-state">${stateChip(a.state)}</span>
      </div>
      ${nowLine}
      ${talk ? `<div class="ac-talk">${esc(talk)}</div>` : ''}
      ${tickets || branch ? `<div class="ac-foot">${tickets}${branch}</div>` : ''}
      ${subs}
      <div class="ac-links"><button type="button" class="link ac-report" data-report="${esc(a.sessionId)}" data-label="${esc(a.label)}" title="What it did, from its transcript">Progress report</button></div>
    </div>`
  }

  // Coordinator, the coding agents by name, then everyone else most recently
  // active first.
  function groups(agents) {
    const byName = (x, y) => x.label.localeCompare(y.label)
    return {
      coordinator: agents.find(a => a.coordinator) || null,
      workers: agents.filter(a => a.coding && !a.coordinator).sort(byName),
      others: agents.filter(a => !a.coding).sort((x, y) => String(y.transcriptAt || '').localeCompare(String(x.transcriptAt || ''))),
    }
  }

  /** Pure: the coordinator's card while its session is not running, under the label the config gives it. */
  const missingRoot = label => `<div class="ac"><div class="ac-head"><span class="ac-name">${window.UI.esc(label || 'Coordinator')}</span><span class="ac-role">not running</span></div></div>`

  // ─── compact: a plain grid ─────────────────────────────────────────────────

  function renderCompact(box, data) {
    const g = groups(data.agents)
    const list = [...(g.coordinator ? [g.coordinator] : []), ...g.workers, ...g.others]
    if (!box._wired) {
      box._wired = true
      const pick = e => box._agents?.get(e.target.closest('[data-session]')?.dataset.session)
      const open = a => a && (location.hash = `#/agent/${encodeURIComponent(a.sessionId)}`)
      box.addEventListener('click', e => open(pick(e)))
      box.addEventListener('keydown', e => {
        if (e.target.matches('[data-session]') && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          open(pick(e))
        }
      })
    }
    box._agents = new Map(list.map(a => [a.sessionId, a]))
    const { esc } = window.UI
    const html = list.length
      ? list
          .map(a => `<div class="ac-tile" role="button" tabindex="0" data-session="${esc(a.sessionId)}" aria-label="${esc(a.label)}. Open to watch it work.">${card(a, { compact: true })}</div>`)
          .join('')
      : '<div class="empty">No agents running.</div>'
    if (box._html !== html) {
      box.innerHTML = html
      box._html = html
    }
  }

  // ─── Independent: the chat agent's own card (Home and the Agents page) ─────

  /** The chat state (orchestration.mjs chatState) as the agent state stateChip knows: working reads Working. */
  const CHAT_CHIP = { working: 'active', waiting: 'waiting', idle: 'idle' }

  /**
   * Pure: the chat agent's compact card from /api/pulse `chat` ({ name, state,
   * lastAt }): its name, a dot and the state word (Working, Waiting, Idle), and
   * when the last message was. `data-chat` makes a click open the drawer.
   */
  function chatCard(chat = {}) {
    const { esc, stateChip } = window.UI
    const chip = CHAT_CHIP[chat.state] || 'idle'
    const when = window.Shell.ago(chat.lastAt)
    const name = chat.name || 'Independent'
    return `<div class="ac-tile ac-chat" role="button" tabindex="0" data-chat aria-label="${esc(name)}. Open the chat.">
      <div class="ac ac-compact" data-state="${chip}">
        <div class="ac-head"><span class="ac-name">${esc(name)}</span><span class="ac-state">${stateChip(chip)}</span></div>
        <div class="ac-now">${when ? `Last message ${esc(when)}` : 'No messages yet'} · the chat in Ask</div>
      </div>
    </div>`
  }

  /** The last pulse's chat, so a slot that mounts later (the Agents page) draws at once. */
  let lastChat = null
  /** Draws the Independent card into every `.ac-chat-slot` on the page; a click or Enter opens the drawer. */
  function renderChat(chat = lastChat) {
    if (typeof document === 'undefined' || !chat) return
    lastChat = chat
    for (const slot of document.querySelectorAll('.ac-chat-slot')) {
      if (!slot._wired) {
        slot._wired = true
        const openChat = () => window.Shell?.drawer?.open()
        slot.addEventListener('click', e => e.target.closest('[data-chat]') && openChat())
        slot.addEventListener('keydown', e => {
          if (e.target.matches('[data-chat]') && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            openChat()
          }
        })
      }
      const html = chatCard(chat)
      if (slot._html !== html) {
        slot.innerHTML = html
        slot._html = html
      }
      slot.hidden = false
    }
  }
  // notify.js dispatches every /api/pulse on document
  if (typeof document !== 'undefined') document.addEventListener('pulse', e => renderChat(e.detail?.chat))

  window.AgentCards = {
    groups,
    missingRoot,
    card,
    chatCard,
    renderChat,
    /** Draws `data.agents` into `root` (an element or its id) as Home's compact grid. */
    render(data, { root } = {}) {
      const box = typeof root === 'string' ? document.getElementById(root) : root
      if (box && data) renderCompact(box, data)
    },
  }
})()
