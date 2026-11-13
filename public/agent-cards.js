// The agents as cards, from ONE renderer in two modes (spec 5).
//
//   full (the Agents page): a tree. Master's card is the root; the coding
//   agents hang off it on branch lines and can be dragged to reorder
//   (card-stack.js); each agent's subagents branch off its own card, and each
//   card has a Progress report button. Sessions outside the team sit in their
//   own stack below, without lines.
//   compact (Home): name, state, the last action on one line and up to four
//   ticket chips, as a plain grid in the same order. No drag stacks: the order
//   is the one you dragged on the Agents page, read from the same keys.
//
// Independent, the chat agent, is not a transcript session the status scan
// finds, so it has its own compact card (chatCard) from /api/pulse, drawn into
// every .ac-chat-slot (Home and the Agents page); a click opens the Ask drawer.
//
// Click a card (or Enter) to watch that agent; click a subagent row to watch
// the subagent. AgentCards.card(agent, opts) is PURE (an agent in, HTML out)
// so test/agent-cards.test.mjs can check both modes in a vm.
//
// Needs app.js first (window.UI). app.js calls AgentCards.render(data,
// { compact: true, root: 'agentCards' }) after every /api/status load;
// agents-page.js calls it in full mode for #agentsCards.
;(function () {
  const ORDER = { workers: 'agentCardOrder.workers', others: 'agentCardOrder.others' }
  const COMPACT_CHIPS = 4
  // Full-mode drag stacks, per root element (only the Agents page today).
  const trees = new Map()

  const read = k => {
    try {
      return JSON.parse(localStorage.getItem(k) || '[]')
    } catch {
      return []
    }
  }
  const write = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {}
  }

  // ─── one card ──────────────────────────────────────────────────────────────

  const roleOf = a => (a.name === 'Master' ? 'Coordinator' : a.coding ? 'Coding agent' : 'Session')

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
    const nowLine = now ? `<div class="ac-now" title="${esc(now)}">${esc(now)}</div>` : ''
    if (compact) {
      return `<div class="ac ac-compact${a.coding ? '' : ' ac-quiet'}" data-state="${esc(a.state)}">
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
    return `<div class="ac${a.coding ? '' : ' ac-quiet'}" data-state="${esc(a.state)}">
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

  // A click on the report button belongs to the report (a delegated click
  // handler in agents-page.js), never to opening the agent.
  const open = (a, target) => {
    if (!a || target?.closest?.('[data-report]')) return
    location.hash = target?.closest?.('[data-href]')?.dataset.href || `#/agent/${encodeURIComponent(a.sessionId)}`
  }

  // Master, the coding agents by name, then everyone else most recently
  // active first; a saved drag order wins inside each group.
  function groups(agents) {
    const byName = (x, y) => x.label.localeCompare(y.label)
    return {
      master: agents.find(a => a.name === 'Master') || null,
      workers: agents.filter(a => a.coding && a.name !== 'Master').sort(byName),
      others: agents.filter(a => !a.coding).sort((x, y) => String(y.transcriptAt || '').localeCompare(String(x.transcriptAt || ''))),
    }
  }
  const saved = (list, key) => {
    const order = read(key)
    const rank = a => (order.includes(a.sessionId) ? order.indexOf(a.sessionId) : order.length)
    return list.map((a, i) => [a, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(x => x[0])
  }

  // ─── compact: a plain grid ─────────────────────────────────────────────────

  function renderCompact(box, data) {
    const g = groups(data.agents)
    const list = [...(g.master ? [g.master] : []), ...saved(g.workers, ORDER.workers), ...saved(g.others, ORDER.others)]
    if (!box._wired) {
      box._wired = true
      const pick = e => box._agents?.get(e.target.closest('[data-session]')?.dataset.session)
      box.addEventListener('click', e => open(pick(e), e.target))
      box.addEventListener('keydown', e => {
        if (e.target.matches('[data-session]') && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          open(pick(e), e.target)
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

  // ─── full: the tree ────────────────────────────────────────────────────────

  function setup(box) {
    box.innerHTML = `
      <div class="ac-root"></div>
      <div class="ac-branches"></div>
      <div class="ac-others" hidden>
        <h3 class="ac-group">Other sessions</h3>
        <div class="ac-others-list"></div>
      </div>`
    const t = { worktrees: [] }
    const mk = (sel, key) =>
      window.CardStack.mount(box.querySelector(sel), {
        key: a => a.sessionId,
        label: a => a.label,
        render: a => card(a, { worktrees: t.worktrees }),
        order: read(key),
        gap: 12,
        onReorder: ids => write(key, ids),
        onOpen: open,
      })
    t.workers = mk('.ac-branches', ORDER.workers)
    t.others = mk('.ac-others-list', ORDER.others)

    // The root is not draggable: a plain card that opens on click or Enter.
    const root = box.querySelector('.ac-root')
    root.addEventListener('click', e => open(root._agent, e.target))
    root.addEventListener('keydown', e => {
      if (e.target === root && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        open(root._agent, e.target)
      }
    })
    trees.set(box, t)
    return t
  }

  function renderRoot(box, master, worktrees) {
    const root = box.querySelector('.ac-root')
    root._agent = master
    if (!master) {
      root.removeAttribute('tabindex')
      root.removeAttribute('role')
      root.className = 'ac-root ac-missing'
      root.innerHTML = '<div class="ac"><div class="ac-head"><span class="ac-name">Master</span><span class="ac-role">not running</span></div></div>'
      root._html = null
      return
    }
    root.className = 'ac-root'
    root.tabIndex = 0
    root.setAttribute('role', 'button')
    root.setAttribute('aria-label', `${master.label}. Open to watch it work.`)
    const html = card(master, { worktrees })
    if (root._html !== html) {
      root.innerHTML = html
      root._html = html
    }
  }

  function renderFull(box, data) {
    const t = trees.get(box) || setup(box)
    t.worktrees = data.worktrees || []
    const g = groups(data.agents)
    renderRoot(box, g.master, t.worktrees)
    t.workers.update(g.workers)
    t.others.update(g.others)
    box.querySelector('.ac-others').hidden = !g.others.length
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
    card,
    chatCard,
    renderChat,
    /** Draws `data.agents` into `root` (an element or its id): compact on Home, full on the Agents page. */
    render(data, { compact = false, root } = {}) {
      const box = typeof root === 'string' ? document.getElementById(root) : root
      if (!box || !data) return
      if (compact) renderCompact(box, data)
      else renderFull(box, data)
    },
  }
})()
