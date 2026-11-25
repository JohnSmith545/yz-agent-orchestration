// Pipeline time on the Agents page, the DOM half: a block under the Pipeline score with five tiles (Finished, Per
// day, Per hour, Time per job, Waiting on you), the stage bar with its table, the bars per day with their list,
// the per agent table and a How it is counted disclosure, plus a Minutes | Hours | Days | Auto switch. The words and
// HTML come from time-view.js (pure); the numbers from GET /api/time (time-routes.mjs).
//
//   TimeStrip.create(el)  -> { refresh() }   agents-page.js calls refresh() whenever it re-reads the pipeline
//
// Rules it keeps:
// - ONE window switch drives both blocks: the score strip's (score-strip.js). This block reads ScoreStrip.windowNow()
//   when it loads and listens for the `score-window` event the switch sends, so it has no switch of its own.
// - The markup is built ONCE; a refresh only sets text and swaps a panel's inner HTML when it changed, so nothing
//   flickers and an open disclosure stays open.
// - The unit and collapsed or open are remembered in this browser; every storage access is in try/catch, and a
//   blocked store only means the defaults (Auto, open).
// - The per day bars are one tab stop: the arrow keys (and Home, End) move along them, each saying its day and
//   count; the focus stays on the same bar when the bars are drawn again.
// - A failed load keeps the last numbers and says so in one line; the newest request always wins.
;(() => {
  const KEYS = Object.freeze({ unit: 'agents.timeUnit', collapsed: 'agents.timeCollapsed' })
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

  function create(el) {
    const V = window.TimeView
    const winNow = () => window.ScoreStrip?.windowNow?.() || '30'
    const st = {
      win: winNow(),
      unit: V.unitOf(store.get(KEYS.unit)),
      collapsed: store.get(KEYS.collapsed) === '1',
      stats: null,
      failure: null,
      seq: 0,
      html: {},
    }
    el.innerHTML = V.skeleton()
    const $ = sel => el.querySelector(sel)
    const body = $('.psc-body')
    const lineEl = $('.ptm-line')
    const spanEl = $('.ptm-span')
    const note = $('.psc-note')
    const toggle = $('.psc-toggle')
    const daysHead = $('#ptmDaysH')
    const setText = (node, text) => {
      if (node && node.textContent !== text) node.textContent = text
    }

    // the score strip's switch: one switch for both blocks
    document.addEventListener('score-window', e => {
      const win = e.detail?.win
      if (!win || win === st.win) return
      st.win = win
      paint()
      load()
    })

    el.addEventListener('click', e => {
      const u = e.target.closest('[data-unit]')
      if (u) {
        st.unit = V.unitOf(u.dataset.unit)
        store.set(KEYS.unit, st.unit)
        return paint()
      }
      if (e.target.closest('.psc-toggle')) {
        st.collapsed = !st.collapsed
        store.set(KEYS.collapsed, st.collapsed ? '1' : '0')
        paint()
      }
    })

    // the bars: one tab stop; the arrow keys, Home and End move along them, and a click moves it too (strip-panels.js)
    window.StripPanels.rove(el)

    async function load() {
      const seq = ++st.seq
      el.setAttribute('aria-busy', 'true')
      try {
        const r = await fetch(`/api/time?days=${encodeURIComponent(st.win)}`)
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
    }

    /**
     * Swaps a panel's inside only when it changed (strip-panels.js): an open As a list stays open, a focused bar keeps
     * its focus (by its place in the row) and the bars keep one tab stop.
     */
    function swap(sel, html) {
      if (st.html[sel] === html) return
      window.StripPanels.swap($(sel), html)
      st.html[sel] = html
    }

    function paint() {
      for (const b of el.querySelectorAll('[data-unit]')) b.setAttribute('aria-pressed', String(b.dataset.unit === st.unit))
      el.classList.toggle('collapsed', st.collapsed)
      toggle.setAttribute('aria-expanded', String(!st.collapsed))
      body.hidden = st.collapsed
      lineEl.hidden = !st.collapsed
      setText(spanEl, SPAN[st.win] || '')
      note.hidden = !st.failure
      setText(note, st.failure ? `Could not load Pipeline time: ${st.failure}` : '')
      const s = st.stats
      if (!s) return setText(lineEl, 'Loading…')
      setText(lineEl, V.line(s, st.unit))
      for (const t of V.tiles(s, st.unit)) {
        const tile = el.querySelector(`[data-tile="${t.key}"]`)
        const num = tile.querySelector('.psc-num')
        setText(num, t.number)
        num.classList.toggle('empty', t.empty)
        setText(tile.querySelector('.psc-frac'), t.side)
        setText(tile.querySelector('.psc-mean'), t.line)
      }
      setText(daysHead, s.window?.bucket === 'week' ? 'Finished per week' : 'Finished per day')
      swap('.ptm-stages', V.stagesHtml(s, st.unit))
      swap('.ptm-days', V.chartHtml(s))
      swap('.ptm-agents', V.agentsHtml(s, st.unit))
      swap('.ptm-how', V.howHtml(s))
    }

    paint()
    return { refresh: load }
  }

  window.TimeStrip = { create }
})()
