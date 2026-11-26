// The command palette (spec F3): Ctrl+K or Cmd+K anywhere opens one box that
// reaches any page, flow, ticket or agent, and a few actions, from the
// keyboard. Type to filter, Up and Down to choose, Enter to go, Escape to
// close. No network: it searches what the pages ALREADY loaded, gathered
// fresh on each open:
//   pages    EVERY rail link, in the rail's groups and order (rail-groups.js: Work, Agents, Quality, History),
//            then Settings; the same list the rail draws, so a new page is in both or in neither
//   flows    FlowsView.data.flows (flows.js), opened with FlowsView.gotoFlow
//   tickets  FactoryView.tickets() (the Tickets collection, once it loaded),
//            opened with FactoryView.gotoTicket
//   agents   App.agents() (the last /api/status build), opened at #/agent/<sessionId>
//   actions  Ask, Refresh, Theme: light / dark / system, Mark read (only
//            while the Since card shows on Home)
//
// The empty list shows every page and every action under a small label per group (listHtml); typing ranks
// everything, at most 12, with no labels. ⚠️ The empty list had a cap of 12 too, which left Learn, Lessons and
// Routing out of the palette altogether (QA, 2026-11-26): it has no cap now, and the list scrolls.
//
// Keys: ONE keydown listener on window, CAPTURE, added before notify.js adds
// its own (index.html loads this file first, pinned by test/palette.test.mjs;
// notify.js also skips its Escape while Palette.isOpen, so the order is a
// second guard, not the only one). Ctrl+K is ignored while another
// text field has the focus, so it never steals a shortcut from what you type;
// in the palette input it closes the palette. While the palette is open it
// takes Escape with preventDefault AND stopImmediatePropagation: the palette
// sits above the alerts panel (45) and the drawer (35), so it is the
// top-most thing and the one an Escape closes; the alerts panel listener (same
// target, same phase) and the shell drawer listener (window, bubble,
// defaultPrevented check) both stay out.
//
// Palette.search and Palette.gather are pure and attach BEFORE the DOM code,
// which returns early when there is no document, so test/palette.test.mjs can
// run them in a vm with a bare window.
;(() => {
  const MAX = 12
  // Words a page is also found by, never shown: Generators keeps its old names and its two tools.
  const KEYS = { script: ['script', 'prompt', 'brainstorming', 'standup', 'stand up'] }
  // The label over Settings and the actions in the empty list (the rail's own groups name the rest).
  const LAST_GROUP = 'Settings and actions'
  const KIND = { page: 'Page', flow: 'Flow', ticket: 'Ticket', agent: 'Agent', action: 'Action' }
  // Live flows first, then the finished ones; a dropped flow is still findable, last.
  const FLOW_RANK = { open: 0, blocked: 0, done: 1, dropped: 2 }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const lower = s => String(s ?? '').toLowerCase()
  const list = v => (Array.isArray(v) ? v : [])
  /** A getter that throws or answers nothing is no items, never an error in the palette. */
  const safe = fn => {
    try {
      return list(fn())
    } catch {
      return []
    }
  }

  /**
   * Pure: the items shown for `query`. An empty query lists EVERY page, then
   * every action, uncapped. Otherwise, at most 12, case-insensitive: the items
   * whose label (or one of its `keys`, such as a ticket number) STARTS with the
   * query come first, then the ones whose label or hint CONTAINS it, each
   * group in the order the items came.
   */
  function search(query, items) {
    const all = list(items)
    const q = lower(query).trim()
    if (!q) return [...all.filter(i => i.kind === 'page'), ...all.filter(i => i.kind === 'action')]
    const prefix = []
    const within = []
    for (const i of all) {
      if (lower(i.label).startsWith(q) || list(i.keys).some(k => lower(k).startsWith(q))) prefix.push(i)
      else if (lower(i.label).includes(q) || lower(i.hint).includes(q)) within.push(i)
    }
    return [...prefix, ...within].slice(0, MAX)
  }

  /**
   * Pure over `w` (the window): every item, as { kind, label, hint, keys?,
   * run }, read from what the pages already hold. Pages, flows, tickets,
   * agents, then the actions.
   */
  function gather(w) {
    const doc = w.document
    const byId = id => doc?.getElementById?.(id) || null
    // The pages: the rail's groups as rail-groups.js holds them (the shell has registered its later links by now).
    const rail = w.RailGroups || window.RailGroups
    const pages = [
      ...safe(() => rail?.groups()).flatMap(g => list(g?.entries).map(e => [e, g.label])),
      ...safe(() => rail?.foot()).map(e => [e, LAST_GROUP]),
    ]
    const items = pages.map(([e, group]) => ({ kind: 'page', label: e.label, hint: e.href, group, ...(KEYS[e.view] ? { keys: KEYS[e.view] } : {}), run: () => w.Shell?.go(e.href) }))

    // an archived flow is only in the page's data while it is open by link: not a palette item (the Archived action lists them)
    const flows = safe(() => w.FlowsView?.data?.flows).filter(f => f && f.id && !f.archivedAt)
    flows.sort((a, b) => (FLOW_RANK[a.status] ?? 1) - (FLOW_RANK[b.status] ?? 1))
    for (const f of flows) {
      items.push({ kind: 'flow', label: f.title || f.id, hint: [f.status, f.agent].filter(Boolean).join(' · '), run: () => w.FlowsView?.gotoFlow(f.id) })
    }
    for (const t of safe(() => w.FactoryView?.tickets?.())) {
      if (!t?.id) continue
      // The number alone (101) is a prefix too, so it ranks the ticket above a flow title that only mentions it.
      const num = /-(\d+)$/.exec(t.id)?.[1]
      items.push({ kind: 'ticket', label: `${t.id} ${t.title || ''}`.trim(), hint: t.state || '', keys: num ? [num] : [], run: () => w.FactoryView?.gotoTicket(t.id) })
    }
    for (const a of safe(() => w.App?.agents?.())) {
      if (!a?.sessionId) continue // nothing to open without a session
      const label = a.label || a.name || a.sessionId
      items.push({ kind: 'agent', label, hint: [a.name !== label ? a.name : '', a.state].filter(Boolean).join(' · '), run: () => w.Shell?.go(`#/agent/${encodeURIComponent(a.sessionId)}`) })
    }

    items.push({ kind: 'action', label: 'Ask', hint: 'Open the chat', run: () => w.Shell?.drawer?.open() })
    // The Tickets page swaps the header Refresh for its own (#fxRefresh), which reads every ticket from
    // its source (a headless turn, so it can cost money); elsewhere the shell one rebuilds the page. The
    // label and hint come from the button it clicks, so the palette never names one action for another.
    const fx = byId('fxRefresh')
    const refresh = fx || byId('refresh')
    if (refresh) {
      items.push({
        kind: 'action',
        label: fx ? 'Refresh tickets' : 'Refresh',
        hint: refresh.title || (fx ? 'Read every ticket from its source now' : 'Rebuild this page now'),
        run: () => refresh.click(),
      })
    }
    const theme = (() => {
      try {
        return w.Theme?.get?.()
      } catch {
        return null
      }
    })()
    for (const t of ['light', 'dark', 'system']) {
      items.push({ kind: 'action', label: `Theme: ${t}`, hint: t === theme ? 'Current theme' : 'Switch the theme', run: () => w.Theme?.set(t) })
    }
    const since = byId('homeSince')
    if (since && !since.hidden) items.push({ kind: 'action', label: 'Mark read', hint: 'Clear Since you were away', run: () => w.Since?.markRead() })
    // (The Flow archive was an action here while the page list was capped; it is a page now, in History.)
    for (const i of items) if (i.kind === 'action') i.group = LAST_GROUP
    return items
  }

  const row = (it, i, sel) =>
    `<li class="pl-item" role="option" id="pl-o-${i}" data-i="${i}" aria-selected="${i === sel}">` +
    `<span class="pl-kind">${esc(KIND[it.kind] || it.kind)}</span><span class="pl-label">${esc(it.label)}</span>` +
    `${it.hint ? `<span class="pl-hint">${esc(it.hint)}</span>` : ''}</li>`

  /**
   * Pure: the list's markup for `shown`, with option `sel` chosen. `grouped` (the empty list) puts each run of
   * one group in a labelled role=group under a small label; a typed list is ranked, so it has no labels. Every
   * option keeps its index in `shown` (pl-o-<i>), so Up, Down and Enter count through the whole list either way.
   */
  function listHtml(shown, sel, grouped) {
    const all = list(shown)
    if (!all.length) return '<li class="pl-empty" role="presentation">Nothing matches.</li>'
    if (!grouped) return all.map((it, i) => row(it, i, sel)).join('')
    const out = []
    for (let i = 0, g = 0; i < all.length; ) {
      const label = all[i].group || ''
      let end = i
      while (end < all.length && (all[end].group || '') === label) end++
      const rows = all.slice(i, end).map((it, k) => row(it, i + k, sel)).join('')
      out.push(label ? `<li class="pl-sec" role="group" aria-labelledby="pl-g-${g}"><div class="pl-group" id="pl-g-${g}">${esc(label)}</div><ul class="pl-sub" role="none">${rows}</ul></li>` : rows)
      if (label) g++
      i = end
    }
    return out.join('')
  }

  let api = { search, gather, listHtml, open() {}, close() {}, isOpen: false }
  window.Palette = api
  if (!window.document) return

  // ═══ the page ═══

  const doc = window.document
  let back = null // the backdrop, holding the dialog
  let input = null
  let box = null // the listbox
  let items = []
  let shown = []
  let sel = 0
  let before = null // the focus to give back on close

  function build() {
    back = doc.createElement('div')
    back.className = 'pl-back'
    back.hidden = true
    back.innerHTML = `<div class="pl" role="dialog" aria-modal="true" aria-label="Go to">
        <input class="pl-input" id="plInput" type="text" role="combobox" aria-expanded="true" aria-controls="plList" aria-autocomplete="list"
          autocomplete="off" spellcheck="false" placeholder="Go to a page, flow, ticket or agent" aria-label="Go to">
        <ul class="pl-list" id="plList" role="listbox" aria-label="Results"></ul>
        <div class="pl-foot"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
      </div>`
    doc.body.appendChild(back)
    input = back.querySelector('.pl-input')
    box = back.querySelector('.pl-list')
    input.addEventListener('input', () => {
      sel = 0
      render()
    })
    box.addEventListener('click', e => {
      const li = e.target?.closest?.('[data-i]')
      if (li) runAt(Number(li.dataset.i))
    })
    // A press on the backdrop (outside the dialog) closes it.
    back.addEventListener('mousedown', e => {
      if (e.target === back) close()
    })
  }

  function render() {
    shown = search(input.value, items)
    if (sel >= shown.length) sel = 0
    box.innerHTML = listHtml(shown, sel, !input.value.trim())
    if (shown.length) input.setAttribute('aria-activedescendant', `pl-o-${sel}`)
    else input.removeAttribute('aria-activedescendant')
  }

  function move(by) {
    if (!shown.length) return
    sel = (sel + by + shown.length) % shown.length
    render()
    box.querySelector(`#pl-o-${sel}`)?.scrollIntoView?.({ block: 'nearest' })
  }

  /** Close first (the focus goes back), then run: a run that moves the focus (the chat input) keeps it. */
  function runAt(i) {
    const it = shown[i]
    if (!it) return
    close()
    try {
      it.run?.()
    } catch (e) {
      window.console?.error?.('palette:', e)
    }
  }

  // The report modal (.ox-modal, z 70, orchestration.js) sits above the palette (60): never open under it.
  const modalUp = () => !!doc.querySelector?.('.ox-modal:not([hidden])')

  function open() {
    if (modalUp()) return
    if (!back) build()
    if (!back.hidden) return
    before = doc.activeElement
    items = gather(window)
    input.value = ''
    sel = 0
    back.hidden = false
    render()
    // One-shot per list element (motion.js), so only the first open enters; off under reduced motion.
    window.Motion?.enterList(box, '.pl-item')
    input.focus()
  }

  function close() {
    if (!back || back.hidden) return
    back.hidden = true
    const to = before
    before = null
    if (to && to !== doc.body && to.isConnected !== false) to.focus?.()
    else doc.activeElement?.blur?.()
  }

  const editable = t => !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
  const shortcut = e => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')
  const isOpen = () => !!back && !back.hidden

  window.addEventListener(
    'keydown',
    e => {
      if (e.isComposing) return
      if (shortcut(e)) {
        if (isOpen()) {
          e.preventDefault()
          return close()
        }
        if (editable(e.target) || modalUp()) return // typing somewhere else, or a modal on top: not ours
        e.preventDefault()
        return open()
      }
      if (!isOpen()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        move(e.key === 'ArrowDown' ? 1 : -1)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        runAt(sel)
      } else if (e.key === 'Tab') {
        e.preventDefault() // the input is the dialog's one stop: the focus stays in it
      }
    },
    true,
  )

  api = {
    search,
    gather,
    listHtml,
    open,
    close,
    get isOpen() {
      return isOpen()
    },
  }
  window.Palette = api
})()
