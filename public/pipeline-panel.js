// The pull-out panel on the Agents page (#/agents): it slides out from the right edge (a slim tab stays
// visible while it is closed), with a two-way switch, Tickets | Outputs (lists from pipeline-tickets.js).
//
//   PipelinePanel.create(el, { page, onSelect })  -> { update(pipeline, selectedId, steps), isOpen() }
//
// - Tickets: every ticket on /api/pipeline, archived ones behind Show archived; a click on a row selects it
//   (onSelect), and the page lights its path through the diagram.
// - Outputs: finished tickets with output or a QA pass, each with Explain (the Flows explanation) and, when
//   there is something to show, How to test: the QA page for a ticket QA has a record of, else the flow's own
//   How to test on its Output tab (PipelineTickets.testTarget).
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
  /** The mode a stored value means: Outputs only when Outputs was chosen, else Tickets. */
  const modeOf = stored => (stored === 'outputs' ? 'outputs' : 'tickets')
  const X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'

  function create(el, { page = null, onSelect = () => {} } = {}) {
    const T = window.PipelineTickets
    const st = { open: store.get(OPEN_KEY) === '1', archived: false, pipeline: null, selected: null, steps: {}, html: '' }
    // ONE source for the mode, read at every paint, so the switch always shows the list that opens (QA found the
    // closed switch on Tickets while opening restored Outputs). `chosen` stands in when storage is blocked.
    let chosen = null
    const mode = () => modeOf(store.get(MODE_KEY) ?? chosen)
    el.innerHTML = `
      <button type="button" class="pl-tab" aria-controls="plPanelBody"><span>Tickets</span></button>
      <div class="pl-panel-body" id="plPanelBody">
        <div class="pl-panel-head">
          <div class="pl-switch" role="group" aria-label="Show">
            <button type="button" data-mode="tickets">Tickets</button><button type="button" data-mode="outputs">Outputs</button>
          </div>
          <button type="button" class="pl-panel-x" aria-label="Close the panel" title="Close">${X}</button>
        </div>
        <label class="check pl-arch"><input type="checkbox"> Show archived</label>
        <div class="pl-panel-list"></div>
      </div>`
    const tab = el.querySelector('.pl-tab')
    const body = el.querySelector('.pl-panel-body')
    const list = el.querySelector('.pl-panel-list')

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
    }
    function paintList() {
      const p = st.pipeline
      if (!p) return
      const labels = T.labelsOf(p.graph)
      const html = mode() === 'outputs'
        ? T.outputsHtml(T.outputList(p.tickets, { archived: st.archived }), { selected: st.selected, steps: st.steps })
        : T.ticketsHtml(T.ticketList(p.tickets, { archived: st.archived }), { labels, selected: st.selected })
      if (html !== st.html) {
        list.innerHTML = html
        st.html = html
      }
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
      if (pick) {
        chosen = modeOf(pick)
        store.set(MODE_KEY, chosen === 'outputs' ? chosen : null)
        paintFrame()
        return paintList()
      }
      const ex = e.target.closest('[data-explain]')
      if (ex) return T.explain(ex.dataset.explain)
      const how = e.target.closest('[data-test]')
      if (how) return T.howToTest(how.dataset.test, how.dataset.to)
      const row = e.target.closest('[data-ticket]')
      if (row) onSelect(row.dataset.ticket)
    })
    paintFrame()

    return {
      /** `steps`: { ticketId: test step count } for the outputs QA never saw (PipelineTickets.testTarget). */
      update(pipeline, selected, steps = {}) {
        st.pipeline = pipeline
        st.selected = selected || null
        st.steps = steps
        paintList()
      },
      isOpen: () => st.open,
    }
  }

  window.PipelinePanel = { create, modeOf }
})()
