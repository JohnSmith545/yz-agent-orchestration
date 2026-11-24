// The pipeline scorecard on the Agents page, the DOM half: a compact strip above the diagram with five tiles
// (Precision, Recall, F-score, Accuracy, Correctness), a window switch (7 days | 30 days | All), an F1 | F4 switch
// on the F-score tile, and a How it is counted disclosure. The words and the HTML come from score-view.js (pure);
// the numbers come from GET /api/score (score-routes.mjs).
//
//   ScoreStrip.create(el)  -> { refresh() }   agents-page.js calls refresh() whenever it re-reads the pipeline
//
// Rules it keeps:
// - The markup is built ONCE; a refresh only sets text (textContent) and swaps the disclosure's inner HTML when it
//   changed, so nothing flickers, the disclosure never closes, and a focused flow link keeps its focus.
// - The window, the F-score choice and collapsed or open are remembered in this browser; every storage access is
//   in try/catch, and a blocked store only means the defaults (30 days, F1, open).
// - Collapsed, the strip is one line with the five numbers, so it never pushes the diagram down.
// - A failed load keeps the last numbers and says so in one line; the newest request always wins.
// - A flow link opens that flow on the Flows page (FlowsView.gotoFlow, as the other pages do).
// - The panel's Log counts over this strip's window: ScoreStrip.windowNow() says which, and a change sends a
//   bubbling `score-window` event; See these in the log sends `pipeline-log` { filter } (pipeline-panel.js).
;(() => {
  const KEYS = Object.freeze({ window: 'agents.scoreWindow', beta: 'agents.scoreBeta', collapsed: 'agents.scoreCollapsed' })
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

  /** The window the strip counts over now ('7' | '30' | 'all'), for the panel's Log; null before a strip exists. */
  let windowNow = () => null

  function create(el) {
    const V = window.ScoreView
    const st = {
      win: V.windowOf(store.get(KEYS.window)),
      beta: V.betaOf(store.get(KEYS.beta)),
      collapsed: store.get(KEYS.collapsed) === '1',
      score: null,
      failure: null,
      seq: 0,
      how: null,
    }
    el.innerHTML = V.skeleton()
    windowNow = () => st.win
    const $ = sel => el.querySelector(sel)
    const body = $('.psc-body')
    const howBody = $('.psc-how-body')
    const lineEl = $('.psc-line')
    const note = $('.psc-note')
    const toggle = $('.psc-toggle')
    const setText = (node, text) => {
      if (node && node.textContent !== text) node.textContent = text
    }

    el.addEventListener('click', e => {
      const w = e.target.closest('[data-window]')
      if (w) {
        if (w.dataset.window === st.win) return
        st.win = V.windowOf(w.dataset.window)
        store.set(KEYS.window, st.win)
        paint()
        // the panel's Log counts over this same window (pipeline-panel.js listens on the page)
        el.dispatchEvent(new CustomEvent('score-window', { bubbles: true, detail: { win: st.win } }))
        return void load()
      }
      const seeLog = e.target.closest('[data-log-filter]')
      if (seeLog) return void el.dispatchEvent(new CustomEvent('pipeline-log', { bubbles: true, detail: { filter: seeLog.dataset.logFilter } }))
      const b = e.target.closest('[data-beta]')
      if (b) {
        st.beta = V.betaOf(b.dataset.beta)
        store.set(KEYS.beta, String(st.beta))
        return paint()
      }
      if (e.target.closest('.psc-toggle')) {
        st.collapsed = !st.collapsed
        store.set(KEYS.collapsed, st.collapsed ? '1' : '0')
        return paint()
      }
      const f = e.target.closest('[data-score-flow]')
      if (f) {
        const F = window.FlowsView
        if (typeof F?.gotoFlow === 'function') F.gotoFlow(f.dataset.scoreFlow)
        else location.hash = '#/flows'
      }
    })

    async function load() {
      const seq = ++st.seq
      el.setAttribute('aria-busy', 'true')
      try {
        const r = await fetch(`/api/score?days=${encodeURIComponent(st.win)}`)
        const j = await r.json().catch(() => null)
        if (!r.ok) throw new Error(j?.error || `the server answered ${r.status}`)
        if (seq !== st.seq) return
        st.score = j
        st.failure = null
      } catch (err) {
        if (seq !== st.seq) return
        st.failure = err?.message || String(err)
      }
      el.removeAttribute('aria-busy')
      paint()
    }

    /** Swaps the disclosure's inside only when it changed, and puts the focus back on the same flow link. */
    function paintHow(html) {
      if (html === st.how) return
      const active = document.activeElement
      const focused = howBody.contains(active) ? active?.dataset?.scoreFlow : null
      howBody.innerHTML = html
      st.how = html
      if (focused) [...howBody.querySelectorAll('[data-score-flow]')].find(b => b.dataset.scoreFlow === focused)?.focus()
    }

    function paint() {
      for (const b of el.querySelectorAll('[data-window]')) b.setAttribute('aria-pressed', String(b.dataset.window === st.win))
      for (const b of el.querySelectorAll('[data-beta]')) b.setAttribute('aria-pressed', String(Number(b.dataset.beta) === st.beta))
      el.classList.toggle('collapsed', st.collapsed)
      toggle.setAttribute('aria-expanded', String(!st.collapsed))
      body.hidden = st.collapsed
      lineEl.hidden = !st.collapsed
      note.hidden = !st.failure
      setText(note, st.failure ? `Could not load the score: ${st.failure}` : '')
      const s = st.score
      if (!s) return setText(lineEl, 'Loading…')
      setText(lineEl, V.line(s, st.beta))
      for (const t of V.tiles(s, st.beta)) {
        const tile = el.querySelector(`[data-tile="${t.key}"]`)
        const num = tile.querySelector('.psc-num')
        setText(num, t.number)
        num.classList.toggle('empty', t.empty)
        setText(tile.querySelector('.psc-frac'), t.fraction)
        setText(tile.querySelector('.psc-mean'), t.meaning)
      }
      paintHow(V.howHtml(s))
    }

    paint()
    return { refresh: load }
  }

  window.ScoreStrip = { create, windowNow: () => windowNow() }
})()
