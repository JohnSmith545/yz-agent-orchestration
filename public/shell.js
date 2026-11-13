// The app shell (spec 5): the left rail, the one-row page header, the chat
// drawer frame and hash routing. Each page keeps its own section and its own
// window.X object; the shell shows exactly one section and calls that page's
// open/close, the way app.js route() did before.
//
// Routes: #/ Home, #/flows, #/tickets, #/timeline, #/agents, #/glossary,
// #/agent/<id>[/<sub>]. Old links redirect (#/factory → #/tickets,
// #/flow → #/timeline) and anything unknown goes Home.
//
// Shell.resolve is pure and is attached BEFORE the DOM code, which returns
// early when there is no document, so test/shell.test.mjs can load this file
// in a vm with a bare window.
;(() => {
  const VIEWS = ['home', 'flows', 'tickets', 'timeline', 'agents', 'glossary', 'settings', 'agent']
  const OLD = { factory: 'tickets', flow: 'timeline' }
  const route = (view, params = {}, redirect = null) => ({ view, params, redirect })
  const decode = s => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s // a malformed % escape: keep the raw text rather than throw
    }
  }

  /** Pure: a location hash → { view, params, redirect }. `redirect` is the canonical hash for an old or unknown route, else null. */
  function resolve(hash) {
    const h = typeof hash === 'string' ? hash : ''
    if (h === '' || h === '#' || h === '#/') return route('home')
    const agent = /^#\/agent\/([^/]+)(?:\/([^/]*))?/.exec(h)
    if (agent) return route('agent', { id: decode(agent[1]), sub: agent[2] ? decode(agent[2]) : null })
    const page = /^#\/([a-z]+)\/?$/.exec(h)?.[1]
    if (page && page !== 'home' && page !== 'agent' && VIEWS.includes(page)) return route(page)
    const old = /^#\/(factory|flow)\b/.exec(h)?.[1]
    if (old) return route(OLD[old], {}, `#/${OLD[old]}`)
    return route('home', {}, '#/')
  }

  /**
   * Wait for a page to mount after a route change: polls `selector` every 50 ms
   * and calls `fn(el)` once it matches, or gives up after `timeoutMs`. The page
   * mounts on the hashchange that follows Shell.go, so a caller cannot reach
   * into it straight away. Resolves to the element, or null on a timeout.
   */
  function whenReady(selector, fn, timeoutMs = 2000) {
    const until = Date.now() + timeoutMs
    return new Promise(done => {
      const tick = () => {
        const el = window.document?.querySelector(selector)
        if (el) {
          fn?.(el)
          return done(el)
        }
        if (Date.now() >= until) return done(null)
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  /**
   * Pure: how long ago `iso` was, short (spec 6): `now` under a minute (a
   * clock a little ahead too), then whole `3m`, `2h`, `5d`. '' for anything
   * that is not a time. THE one relative-time helper: every page uses it.
   */
  function ago(iso, now = Date.now()) {
    const t = iso ? Date.parse(iso) : NaN
    if (Number.isNaN(t)) return ''
    const s = Math.floor((now - t) / 1000)
    if (s < 60) return 'now'
    if (s < 3600) return `${Math.floor(s / 60)}m`
    if (s < 86400) return `${Math.floor(s / 3600)}h`
    return `${Math.floor(s / 86400)}d`
  }

  /** How the rail's title says each chat state (the drawer head and the cards say the one glossary word). */
  const CHAT_WORDS = { working: 'working', waiting: 'waiting on you', idle: 'idle' }
  /**
   * Pure: Independent's state from what the page knows: `busy` (the chat's own
   * stream, always current) and `state` (the last /api/pulse chat.state). A
   * running turn is working; otherwise only the pulse's waiting counts, so a
   * pulse that still says working after the turn ended reads idle.
   */
  const chatState = ({ busy, state } = {}) => (busy ? 'working' : state === 'waiting' ? 'waiting' : 'idle')

  let current = null
  const listeners = []
  // go, setStatus, setTitle, setWaiting, the drawer, collapseRail and onRoute are
  // function declarations further down (hoisted), so the object can name them here.
  window.Shell = {
    resolve,
    whenReady,
    ago,
    chatState,
    go,
    get current() {
      return current
    },
    setStatus,
    setTitle,
    setWaiting,
    drawer: {
      open: () => setDrawer(true),
      close: () => setDrawer(false),
      toggle: () => setDrawer(!drawerOpen()),
      get isOpen() {
        return drawerOpen()
      },
    },
    onRoute,
    collapseRail,
  }
  if (!window.document) return

  // ═══ the page ═══

  const doc = window.document
  const $ = id => doc.getElementById(id)
  const PIN_KEY = 'shell.railPinned'
  const HOVER_MS = 300
  const TITLE = { home: 'Home', flows: 'Flows', tickets: 'Tickets', timeline: 'Timeline', agents: 'Agents', glossary: 'Glossary', settings: 'Settings', agent: 'Agent' }
  // Which section each view shows, and which page object it opens and closes.
  const SECTION = { home: 'home', flows: 'flowsView', tickets: 'factoryView', timeline: 'flowView', agents: 'agentsView', glossary: 'glossaryView', settings: 'settingsView', agent: 'agentView' }
  const PAGE = { flows: 'FlowsPage', tickets: 'FactoryView', timeline: 'FlowView', agents: 'AgentsPage', glossary: 'GlossaryPage', settings: 'SettingsPage', agent: 'AgentView' }
  // The rail item lit for each view; one agent belongs under Agents.
  const RAIL = { agent: 'agents' }

  // ─── icons: 24-unit boxes drawn at 20 px, 1.75 stroke (shell.css) ───
  const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`
  const ICON = {
    home: svg('<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>'),
    flows: svg('<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 7.2v9.6"/><path d="M18 9.2c0 5-6 4.6-10.6 8.3"/>'),
    tickets: svg('<path d="M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4Z"/><path d="M14.5 8v1.5M14.5 11.25v1.5M14.5 14.5V16"/>'),
    timeline: svg('<path d="M3 12h4l3-7 4 14 3-7h4"/>'),
    agents: svg('<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.8c1.8.6 3 2.5 3 5.2"/>'),
    glossary: svg('<path d="M5 5a2 2 0 0 1 2-2h12v14H7a2 2 0 0 0-2 2Z"/><path d="M5 19a2 2 0 0 0 2 2h12v-4"/><path d="M9 7.5h6M9 11h4"/>'),
    // a gear: a ring with eight short teeth around a small hub
    settings: svg('<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.2"/><path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2 18 18M6 18l1.8-1.8M16.2 7.8 18 6"/>'),
    ask: svg('<path d="M12 3.5a8.5 8.5 0 0 0-7.4 12.7L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5Z"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
    moon: svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
    pin: svg('<path d="M9 3h6l-1 6 3 4H7l3-4Z"/><path d="M12 13v8"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  }

  // ─── the rail ───
  // The command palette shortcut (palette.js), named in the Ask tooltip: Cmd on a Mac, Ctrl elsewhere.
  const PALETTE_KEY = /Mac|iPhone|iPad/.test(window.navigator?.platform || window.navigator?.userAgent || '') ? '⌘K' : 'Ctrl K'
  const ASK_TIP = `Ask · ${PALETTE_KEY} goes to anything`
  const link = (view, hash, label) =>
    `<a class="rail-item" href="${hash}" data-view="${view}" title="${label}"><span class="rail-icon">${ICON[view]}</span><span class="rail-label">${label}</span></a>`
  const rail = $('rail')
  rail.innerHTML = `
    <div class="rail-top">
      <a class="rail-item rail-brand" href="#/" data-view="home" title="Home"><span class="rail-icon"><span class="rail-mark">${ICON.home}</span></span><span class="rail-label">Home</span></a>
      <button type="button" class="rail-pin" id="railPin" aria-pressed="false" title="Keep the rail open">${ICON.pin}</button>
    </div>
    <nav class="rail-nav" aria-label="Pages">
      ${link('flows', '#/flows', 'Flows')}${link('tickets', '#/tickets', 'Tickets')}${link('timeline', '#/timeline', 'Timeline')}${link('agents', '#/agents', 'Agents')}${link('glossary', '#/glossary', 'Glossary')}
    </nav>
    <div class="rail-bottom">
      <button type="button" class="rail-item" id="railAsk" aria-controls="drawer" aria-expanded="false" title="${ASK_TIP}"><span class="rail-icon">${ICON.ask}</span><span class="rail-label">Ask</span></button>
      <div class="rail-item rail-slot" id="railAlerts"></div>
      <div class="rail-item rail-slot" id="railSpend" hidden></div>
      ${link('settings', '#/settings', 'Settings')}
      <button type="button" class="rail-item" id="themeToggle" title="Theme"><span class="rail-icon"><span class="theme-sun">${ICON.sun}</span><span class="theme-moon">${ICON.moon}</span><i class="theme-dot" aria-hidden="true"></i></span><span class="rail-label">Theme</span></button>
    </div>`

  // Labels as tooltips by default; after a 300 ms hover the rail opens to
  // 200 px over the page. Pinned, it stays open and pushes the page instead.
  const store = {
    get(k) {
      try {
        return window.localStorage.getItem(k)
      } catch {
        return null
      }
    },
    set(k, v) {
      try {
        if (v == null) window.localStorage.removeItem(k)
        else window.localStorage.setItem(k, v)
      } catch {}
    },
  }
  const root = doc.documentElement
  const paintPin = pinned => {
    root.classList.toggle('rail-pinned', pinned)
    const b = $('railPin')
    b.setAttribute('aria-pressed', String(pinned))
    b.title = pinned ? 'Let the rail close' : 'Keep the rail open'
    b.setAttribute('aria-label', b.title)
  }
  paintPin(store.get(PIN_KEY) === '1')
  $('railPin').addEventListener('click', () => {
    const pinned = !root.classList.contains('rail-pinned')
    store.set(PIN_KEY, pinned ? '1' : null)
    paintPin(pinned)
  })
  let hoverTimer = 0
  rail.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => rail.classList.add('open'), HOVER_MS)
  })
  rail.addEventListener('mouseleave', collapseRail)
  /** Fold a hover-opened rail (a pinned one stays open): the Alerts panel opens beside the 56 px rail, not over its labels. */
  function collapseRail() {
    clearTimeout(hoverTimer)
    rail.classList.remove('open')
  }

  // ─── the header ───
  const escText = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  /**
   * The status chip: `html` is the one short line (fetched 3m); `help`, when
   * given, is the rest of the meta behind the chip's ? popover (help.js).
   * Both are HTML the caller owns. The ? stays the same node across calls, so
   * an open popover follows the new text instead of losing its anchor.
   */
  function setStatus(html, help) {
    const text = $('pageStatusText')
    const q = $('pageHelp')
    if (!text || !q) return
    text.innerHTML = html
    q.hidden = !help
    if (help) window.Help?.attach(q, help)
    else if (q.getAttribute('aria-expanded') === 'true') window.Help?.close()
  }
  /**
   * The page title: `text` as a <dfn> the explainer opens (explain.js: the
   * rail labels stay plain links, so the page is explained here) for glossary
   * `term`, then ` · N` when `count` is a number. A count under the same title
   * counts up to its new value (motion.js) instead of jumping.
   */
  function setTitle(text, term, count) {
    const h = $('pageTitle')
    if (!h) return
    const dfn = `<dfn data-term="${escText(term)}" tabindex="0">${escText(text)}</dfn>`
    const n = h.querySelector('#pageCount')
    const same = h.dataset.title === `${term}|${text}`
    if (same && n && count != null) return window.Motion ? window.Motion.countUp(n, count) : (n.textContent = String(count))
    h.dataset.title = `${term}|${text}`
    h.innerHTML = count == null ? dfn : `${dfn} <span class="faint">· <span class="num" id="pageCount">${Number(count)}</span></span>`
  }
  function setWaiting(n) {
    const b = $('pageWaiting')
    if (!b) return
    const count = Math.max(0, Number(n) || 0)
    b.hidden = !count
    b.innerHTML = count ? `<i class="wait-dot" aria-hidden="true"></i>${count} waiting on you` : ''
    b.title = count ? 'Open the asks on the Flows page' : ''
  }
  // Through FlowsView.gotoFlow, so the strip scrolls into view even when #/flows already shows (a flow opened below it).
  $('pageWaiting')?.addEventListener('click', () => (window.FlowsView?.gotoFlow ? window.FlowsView.gotoFlow() : go('#/flows')))

  // ─── the chat drawer ───
  // ONE head: #drawerHead holds Ask until the chat mounts, then the chat writes
  // its own line there (Ask · name, the model, Stop, New chat; factory-chat.js
  // frame). The chat mounts the first time the drawer opens and stays mounted,
  // EventSource and all, while the page lives: closing only hides it.
  const DRAWER_KEY = 'shell.drawerOpen'
  const drawer = $('drawer')
  drawer.innerHTML = `<div class="drawer-head"><div class="drawer-title" id="drawerHead"><h2>Ask</h2></div><button type="button" class="drawer-x" aria-label="Close" title="Close">${ICON.close}</button></div><div class="drawer-body" id="drawerBody"></div>`
  let chatMounted = false
  function drawerOpen() {
    return !!drawer && !drawer.hidden
  }
  function setDrawer(open) {
    if (!drawer) return
    if (open && !chatMounted && window.FactoryChat) {
      chatMounted = true
      window.FactoryChat.mount($('drawerBody'), $('drawerHead'))
    }
    drawer.hidden = !open
    doc.body.classList.toggle('drawer-open', open)
    $('railAsk').setAttribute('aria-expanded', String(open))
    store.set(DRAWER_KEY, open ? '1' : null)
  }
  $('railAsk').addEventListener('click', () => setDrawer(!drawerOpen()))
  // Ask shows Independent's state (chatState): a breathing dot while it works, an
  // amber dot while it waits on you. Busy comes from the chat's own stream
  // (chat:status, factory-chat.js; notify.js until the drawer mounts), waiting
  // from the pulse (its chat.state, orchestration.mjs chatState).
  const chatNow = { busy: false, state: 'idle', name: '' }
  function paintAsk() {
    const ask = $('railAsk')
    const s = chatState(chatNow)
    ask.classList.toggle('busy', s === 'working')
    ask.classList.toggle('waiting', s === 'waiting')
    ask.title = `${chatNow.name || window.FactoryChat?.name || 'Independent'} is ${CHAT_WORDS[s]}\n${ASK_TIP}`
  }
  doc.addEventListener('chat:status', e => {
    chatNow.busy = Boolean(e.detail?.busy)
    paintAsk()
  })
  doc.addEventListener('pulse', e => {
    const chat = e.detail?.chat || {}
    chatNow.state = chat.state || 'idle'
    if (chat.name) chatNow.name = chat.name
    paintAsk()
  })
  drawer.querySelector('.drawer-x').addEventListener('click', () => setDrawer(false))
  // On window, bubble: the LAST to hear a key, after every document listener a
  // page added (a report modal, the Timeline popover). One that took the
  // Escape calls preventDefault, so one Escape closes one thing.
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drawerOpen() && !e.defaultPrevented) setDrawer(false)
  })

  // ─── routing ───
  function go(hash) {
    if (window.location.hash === hash) show()
    else window.location.hash = hash
  }
  function onRoute(fn) {
    listeners.push(fn)
  }
  function show() {
    const r = resolve(window.location.hash)
    // An old or unknown link: swap it for the canonical one in history; the
    // hashchange that follows routes again. The old Factory page always showed
    // the chat, so its link (the one old route that lands on #/tickets) also
    // opens the drawer (spec 5).
    if (r.redirect) {
      if (r.redirect === '#/tickets') setDrawer(true)
      return window.location.replace(r.redirect)
    }
    // A new page starts from a blank chip and its plain name, BEFORE it opens:
    // the page then writes its own (a count, a collection name) whenever its
    // data lands, and a page left behind never leaves its chip on the next one.
    if (r.view !== current?.view) {
      setStatus('')
      setTitle(TITLE[r.view], r.view)
    }
    current = r
    for (const [view, id] of Object.entries(SECTION)) {
      const el = $(id)
      if (el) el.hidden = view !== r.view
    }
    for (const [view, name] of Object.entries(PAGE)) if (view !== r.view) window[name]?.close?.()
    const page = window[PAGE[r.view]]
    if (r.view === 'agent') page?.open?.(r.params.id, r.params.sub)
    else page?.open?.()
    const lit = RAIL[r.view] || r.view
    rail.querySelectorAll('a.rail-item').forEach(a => (a.dataset.view === lit ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')))
    for (const fn of listeners) fn(r)
  }
  window.addEventListener('hashchange', show)
  // ONE delegated listener lights the card under the pointer on every page (motion.js).
  window.Motion?.spotlight(doc.querySelector('main'))
  // Once every page script has attached its window.X: the drawer as it was
  // left (closed by default, and closed when storage throws), then the route.
  // The spend chip (spend.js) mounts in its slot above Theme; it shows itself once today is above zero.
  doc.addEventListener('DOMContentLoaded', () => {
    window.Spend?.mount($('railSpend'))
    setDrawer(store.get(DRAWER_KEY) === '1')
    show()
  })
})()
