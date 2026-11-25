// Pipeline tokens on the Agents page, the DOM half: a block under Pipeline time with five tiles (Tokens used,
// Estimated cost, Per finished job, Cache share, The dashboard's own runs), the bars per day in tokens or dollars
// with their list, the by model table, the by agent table and a How it is counted disclosure. The words and HTML come
// from token-view.js (pure); the numbers from GET /api/tokens (token-routes.mjs).
//
//   TokenStrip.create(el)  -> { refresh() }   agents-page.js calls refresh() whenever it re-reads the pipeline
//
// Rules it keeps:
// - ONE window switch drives all three blocks: the score strip's (score-strip.js). This block reads
//   ScoreStrip.windowNow() when it loads and listens for the `score-window` event the switch sends.
// - While the server builds its index for the first time the answer says so: a note shows how far it got, and the
//   block asks again every few seconds until it is done (then only with the page's own cadence).
// - The markup is built ONCE; a refresh only sets text and swaps a panel's inner HTML when it changed, so nothing
//   flickers and an open disclosure stays open.
// - Tokens or dollars for the bars, and collapsed or open, are remembered in this browser; every storage access is
//   in try/catch, and a blocked store only means the defaults (tokens, open). Dollars is off with no price set.
// - The per day bars are one tab stop: the arrow keys (and Home, End) move along them, each saying its day and value.
// - A failed load keeps the last numbers and says so in one line; the newest request always wins.
;(() => {
  const KEYS = Object.freeze({ measure: 'agents.tokenMeasure', collapsed: 'agents.tokenCollapsed' })
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
        window.localStorage.setItem(k, v)
      } catch {}
    },
  }
  const SPAN = Object.freeze({ 7: 'Last 7 days', 30: 'Last 30 days', all: 'All time' })
  const BUILDING_POLL_MS = 3000

  function create(el) {
    const V = window.TokenView
    const winNow = () => window.ScoreStrip?.windowNow?.() || '30'
    const st = {
      win: winNow(),
      measure: V.measureOf(store.get(KEYS.measure)),
      collapsed: store.get(KEYS.collapsed) === '1',
      stats: null,
      failure: null,
      seq: 0,
      html: {},
      poll: null,
    }
    el.innerHTML = V.skeleton()
    const $ = sel => el.querySelector(sel)
    const body = $('.psc-body')
    const lineEl = $('.ptk-line')
    const spanEl = $('.ptk-span')
    const note = $('.psc-note')
    const building = $('.ptk-building')
    const toggle = $('.psc-toggle')
    const daysHead = $('#ptkDaysH')
    const setText = (node, text) => {
      if (node && node.textContent !== text) node.textContent = text
    }

    document.addEventListener('score-window', e => {
      const win = e.detail?.win
      if (!win || win === st.win) return
      st.win = win
      paint()
      load()
    })

    el.addEventListener('click', e => {
      const m = e.target.closest('[data-measure]')
      if (m) {
        if (m.disabled) return
        st.measure = V.measureOf(m.dataset.measure)
        store.set(KEYS.measure, st.measure)
        return paint()
      }
      if (e.target.closest('.psc-toggle')) {
        st.collapsed = !st.collapsed
        store.set(KEYS.collapsed, st.collapsed ? '1' : '0')
        paint()
      }
    })

    // the bars: one tab stop, the arrow keys move along them (a roving tabindex)
    el.addEventListener('keydown', e => {
      const col = e.target.closest?.('.ptm-col')
      if (!col) return
      const cols = [...el.querySelectorAll('.ptm-col')]
      const i = cols.indexOf(col)
      const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: cols.length - 1 }[e.key]
      if (to === undefined || !cols[to]) return
      e.preventDefault()
      col.tabIndex = -1
      cols[to].tabIndex = 0
      cols[to].focus()
    })

    async function load() {
      const seq = ++st.seq
      clearTimeout(st.poll)
      el.setAttribute('aria-busy', 'true')
      try {
        const r = await fetch(`/api/tokens?days=${encodeURIComponent(st.win)}`)
        const j = await r.json().catch(() => null)
        if (!r.ok) throw new Error(j?.error || `the server answered ${r.status}`)
        if (seq !== st.seq) return
        st.stats = j
        st.failure = null
      } catch (err) {
        if (seq !== st.seq) return
        st.failure = err?.message || String(err)
      }
      el.removeAttribute('aria-busy')
      paint()
      // the first build is still running: ask again soon, so the numbers fill in without a reload
      if (st.stats?.building) st.poll = setTimeout(load, BUILDING_POLL_MS)
    }

    /** Swaps a panel's inside only when it changed; a focused bar keeps its focus (by its place in the row). */
    function swap(sel, html) {
      if (st.html[sel] === html) return
      const node = $(sel)
      const bar = node.contains(document.activeElement) ? document.activeElement?.dataset?.bar : undefined
      node.innerHTML = html
      st.html[sel] = html
      if (bar === undefined) return
      const cols = [...node.querySelectorAll('.ptm-col')]
      const back = cols.find(c => c.dataset.bar === bar) || cols.at(-1)
      if (!back) return
      for (const c of cols) c.tabIndex = c === back ? 0 : -1
      back.focus()
    }

    function paint() {
      const s = st.stats
      const dollars = Number.isFinite(s?.cost?.usd)
      const measure = st.measure === 'usd' && dollars ? 'usd' : 'tokens'
      for (const b of el.querySelectorAll('[data-measure]')) {
        b.setAttribute('aria-pressed', String(b.dataset.measure === measure))
        b.disabled = b.dataset.measure === 'usd' && !dollars
        b.title = b.disabled ? 'No model has a price set, so there are no dollars to show' : ''
      }
      el.classList.toggle('collapsed', st.collapsed)
      toggle.setAttribute('aria-expanded', String(!st.collapsed))
      body.hidden = st.collapsed
      lineEl.hidden = !st.collapsed
      setText(spanEl, SPAN[st.win] || '')
      note.hidden = !st.failure
      setText(note, st.failure ? `Could not load Pipeline tokens: ${st.failure}` : '')
      if (!s) return setText(lineEl, 'Loading…')
      const words = V.note(s)
      building.hidden = !words
      setText(building, words)
      setText(lineEl, V.line(s))
      for (const t of V.tiles(s)) {
        const tile = el.querySelector(`[data-tile="${t.key}"]`)
        const num = tile.querySelector('.psc-num')
        setText(num, t.number)
        if (num.title !== t.title) num.title = t.title
        num.classList.toggle('empty', t.empty)
        setText(tile.querySelector('.psc-frac'), t.side)
        setText(tile.querySelector('.psc-mean'), t.line)
      }
      const per = s.window?.bucket === 'week' ? 'Per week' : 'Per day'
      setText(daysHead, per)
      swap('.ptk-days', V.chartHtml(s, measure))
      swap('.ptk-models-box', V.modelsHtml(s))
      swap('.ptk-agents', V.agentsHtml(s))
      swap('.ptk-how', V.howHtml(s))
    }

    paint()
    return { refresh: load }
  }

  window.TokenStrip = { create }
})()
