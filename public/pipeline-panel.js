// The pull-out panel on the Agents page (#/agents): it slides out from the right edge (a slim tab stays
// visible while it is closed), with a three-way switch, Tickets | Outputs | Log (lists from pipeline-tickets.js
// and pipeline-log.js).
//
//   PipelinePanel.create(el, { page, onSelect })  -> { update(pipeline, selectedId, steps), isOpen() }
//
// - Tickets: every ticket on /api/pipeline, archived ones behind Show archived; a click on a row selects it
//   (onSelect), and the page lights its path through the diagram.
// - Outputs: finished tickets with output or a QA pass, each with Explain (the Flows explanation) and, when
//   there is something to show, How to test: the QA page for a ticket QA has a record of, else the flow's own
//   How to test on its Output tab (PipelineTickets.testTarget).
// - Log: the orchestration log (GET /api/log), newest first, with filter chips (All, Delivered, Caught, Missed,
//   Slipped through, Rules). It counts over the scorecard's window (ScoreStrip.windowNow, and its `score-window`
//   event), so a filter lists exactly the events behind that count. Read again whenever the page re-reads the
//   pipeline (a new pipeline object in update), on a chip, and on a window change; a click on an event with a flow
//   selects that ticket like a Tickets row. The scorecard's See these in the log sends `pipeline-log` { filter }:
//   the panel opens on Log with that filter.
// A refresh never flickers or jumps: a list is swapped only when its HTML changed, and the scroll position is kept
// while the mode stays the same; the filter lives here, so a refresh keeps it.
// Open or closed and the switch are remembered in this browser (localStorage, every access in try/catch);
// `page` gets `panel-open` so a wide window makes room for the panel instead of covering the diagram.
// The motion is a transform only, and none under prefers-reduced-motion (pipeline.css).
;(() => {
  const OPEN_KEY = 'agents.panelOpen'
  const MODE_KEY = 'agents.panelMode'
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
  /** The mode a stored value means: Outputs or Log only when chosen, else Tickets. */
  const modeOf = stored => (stored === 'outputs' || stored === 'log' ? stored : 'tickets')
  const X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'

  function create(el, { page = null, onSelect = () => {} } = {}) {
    const T = window.PipelineTickets
    const L = window.PipelineLog
    const st = { open: store.get(OPEN_KEY) === '1', archived: false, pipeline: null, selected: null, steps: {}, html: '', htmlMode: null }
    // the Log's own state: the last answer, the filter, which pipeline read it followed, and the newest request
    const log = { data: null, failure: null, filter: 'all', key: null, seq: 0, pipeline: null, chips: '' }
    // ONE source for the mode, read at every paint, so the switch always shows the list that opens (QA found the
    // closed switch on Tickets while opening restored Outputs). `chosen` stands in when storage is blocked.
    let chosen = null
    const mode = () => modeOf(store.get(MODE_KEY) ?? chosen)
    const win = () => window.ScoreStrip?.windowNow?.() || '30'
    el.innerHTML = `
      <button type="button" class="pl-tab" aria-controls="plPanelBody"><span>Tickets</span></button>
      <div class="pl-panel-body" id="plPanelBody">
        <div class="pl-panel-head">
          <div class="pl-switch" role="group" aria-label="Show">
            <button type="button" data-mode="tickets">Tickets</button><button type="button" data-mode="outputs">Outputs</button><button type="button" data-mode="log">Log</button>
          </div>
          <button type="button" class="pl-panel-x" aria-label="Close the panel" title="Close">${X}</button>
        </div>
        <label class="check pl-arch"><input type="checkbox"> Show archived</label>
        <div class="lg-chips-box" hidden></div>
        <div class="pl-panel-list"></div>
      </div>`
    const tab = el.querySelector('.pl-tab')
    const body = el.querySelector('.pl-panel-body')
    const list = el.querySelector('.pl-panel-list')
    const arch = el.querySelector('.pl-arch')
    const chipsBox = el.querySelector('.lg-chips-box')

    function paintFrame() {
      el.classList.toggle('open', st.open)
      page?.classList.toggle('panel-open', st.open)
      tab.setAttribute('aria-expanded', String(st.open))
      tab.title = st.open ? 'Close tickets and outputs' : 'Open tickets and outputs'
      body.inert = !st.open
      if (!st.open) body.setAttribute('aria-hidden', 'true')
      else body.removeAttribute('aria-hidden')
      const m = mode()
      for (const b of el.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === m))
      arch.hidden = m === 'log' // the log already holds archived flows
      chipsBox.hidden = m !== 'log'
      const chips = L.chipsHtml(log.filter)
      if (m === 'log' && chips !== log.chips) {
        const focused = chipsBox.contains(document.activeElement) ? document.activeElement.dataset.logChip : null
        chipsBox.innerHTML = chips
        log.chips = chips
        if (focused) chipsBox.querySelector(`[data-log-chip="${focused}"]`)?.focus()
      }
    }
    function paintList() {
      const m = mode()
      let html
      if (m === 'log') html = L.listHtml(log, { selected: st.selected, win: win(), filter: log.filter })
      else {
        const p = st.pipeline
        if (!p) return
        const labels = T.labelsOf(p.graph)
        html = m === 'outputs'
          ? T.outputsHtml(T.outputList(p.tickets, { archived: st.archived }), { selected: st.selected, steps: st.steps })
          : T.ticketsHtml(T.ticketList(p.tickets, { archived: st.archived }), { labels, selected: st.selected })
      }
      if (html !== st.html) {
        const same = st.htmlMode === m
        const top = same ? list.scrollTop : 0 // same list read again: stay where the reader was
        // and on the same row: a selection by keyboard swaps the list, which must not drop the focus
        const rows = () => [...list.querySelectorAll('button')]
        const at = same && list.contains(document.activeElement) ? rows().indexOf(document.activeElement) : -1
        list.innerHTML = html
        list.scrollTop = top
        if (at >= 0) rows()[at]?.focus({ preventScroll: true })
        st.html = html
        st.htmlMode = m
      }
    }
    /** Reads the log for the window and filter now; the newest request wins, and the last list stays meanwhile. */
    async function loadLog() {
      const seq = ++log.seq
      const key = `${win()}|${log.filter}`
      if (log.key !== key) log.data = null // a different question: say Loading rather than show the old answer
      log.key = key
      try {
        const r = await fetch(L.queryOf(win(), log.filter))
        const j = await r.json().catch(() => null)
        if (!r.ok) throw new Error(j?.error || `the server answered ${r.status}`)
        if (seq !== log.seq) return
        log.data = j
        log.failure = null
      } catch (err) {
        if (seq !== log.seq) return
        log.failure = err?.message || String(err)
      }
      if (mode() === 'log') paintList()
    }
    function setMode(m) {
      chosen = modeOf(m)
      store.set(MODE_KEY, chosen === 'tickets' ? null : chosen)
      paintFrame()
      paintList()
      if (chosen === 'log' && (log.key !== `${win()}|${log.filter}` || !log.data)) loadLog()
    }
    function setOpen(open) {
      st.open = open
      store.set(OPEN_KEY, open ? '1' : null)
      paintFrame()
      paintList()
    }

    // The tab hides while the panel is open (pipeline.css), so focus moves to the close button and back.
    tab.addEventListener('click', () => {
      setOpen(!st.open)
      if (st.open) el.querySelector('.pl-panel-x').focus()
    })
    el.querySelector('.pl-panel-x').addEventListener('click', () => {
      setOpen(false)
      tab.focus()
    })
    el.querySelector('.pl-arch input').addEventListener('change', e => {
      st.archived = e.target.checked
      paintList()
    })
    el.addEventListener('click', e => {
      const pick = e.target.closest('[data-mode]')?.dataset.mode
      if (pick) return setMode(pick)
      const chip = e.target.closest('[data-log-chip]')?.dataset.logChip
      if (chip) {
        log.filter = L.filterOf(chip)
        paintFrame()
        paintList()
        return void loadLog()
      }
      const ex = e.target.closest('[data-explain]')
      if (ex) return T.explain(ex.dataset.explain)
      const how = e.target.closest('[data-test]')
      if (how) return T.howToTest(how.dataset.test, how.dataset.to)
      const row = e.target.closest('[data-ticket]')
      if (row) onSelect(row.dataset.ticket)
    })
    // From the scorecard above the diagram: its window changed, or See these in the log was clicked.
    page?.addEventListener('score-window', () => {
      if (mode() === 'log') loadLog()
      else log.key = null
    })
    page?.addEventListener('pipeline-log', e => {
      log.filter = L.filterOf(e.detail?.filter)
      log.key = null
      setMode('log')
      if (!st.open) setOpen(true)
      chipsBox.querySelector(`[data-log-chip="${log.filter}"]`)?.focus()
    })
    paintFrame()

    return {
      /** `steps`: { ticketId: test step count } for the outputs QA never saw (PipelineTickets.testTarget). */
      update(pipeline, selected, steps = {}) {
        const fresh = pipeline !== st.pipeline
        st.pipeline = pipeline
        st.selected = selected || null
        st.steps = steps
        paintList()
        // a new pipeline read is a refresh: the log is read again with it (the 15 s redraw passes the same one)
        if (fresh && mode() === 'log' && log.pipeline !== pipeline) {
          log.pipeline = pipeline
          loadLog()
        }
      },
      isOpen: () => st.open,
    }
  }

  window.PipelinePanel = { create, modeOf }
})()
