// The three views of an opened flow, as tabs on its title row (flows.js draws them):
//   Output   the story, one picture, how to test it, and Details folded away (flow-output.js)
//   Status   what is built, missing and waiting on you, row by row (flow-status.js)
//   Process  the chart of how it got there (flow-chart.js)
//
//   tabs(current)    the tab buttons (role tab, one in the tab order)
//   step(view, by)   the view `by` places along, wrapping (the Left and Right keys)
//   view.get / set   the remembered choice, localStorage `flows.view` (JSON like
//                    flows.js's other `flows.` keys); anything unreadable is Output
;(() => {
  const VIEWS = ['output', 'status', 'process']
  const NAMES = { output: 'Output', status: 'Status', process: 'Process' }
  const KEY = 'flows.view'

  const view = {
    get() {
      try {
        const v = JSON.parse(localStorage.getItem(KEY))
        return VIEWS.includes(v) ? v : 'output'
      } catch { return 'output' }
    },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)) } catch {} },
  }

  const tabs = current =>
    `<div class="fl-tabs" role="tablist" aria-label="View">${VIEWS.map(v => {
      const name = NAMES[v]
      return `<button type="button" role="tab" id="flTab${name}" aria-controls="flPanel${name}" aria-selected="${v === current}" tabindex="${v === current ? 0 : -1}" data-view="${v}">${name}</button>`
    }).join('')}</div>`

  const step = (v, by) => VIEWS[(VIEWS.indexOf(v) + by + VIEWS.length) % VIEWS.length]

  window.FlowTabs = { VIEWS, tabs, step, view }
})()
