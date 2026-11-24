// The Flows page (spec 5, #/flows): the Waiting on you strip above the flows
// board, both drawn by flows.js. The shell calls open and close as the route
// comes and goes; this file only builds the two boxes, mounts FlowsView into
// them, and writes the page head (`Flows · N`, N the cards on the board: FlowBoard.groups live)
// and the status chip (when the newest flow changed, the rest behind its ?,
// which also says what Archive and the Trash do) from each poll.
;(() => {
  const view = () => document.getElementById('flowsView')
  let on = false
  let last = null // the data of the last poll, to write the head again after a re-route

  // shown: an archived flow open by link sits in the data, but never in the head's count (flow-board.js)
  const flowsOf = d => window.FlowBoard?.shown(d?.flows) || d?.flows || []
  // the cards on the board: every flow still on its way along its route (FlowBoard.groups), a done one at Push too
  const live = d => window.FlowBoard.groups(d?.flows).live
  const newest = d => flowsOf(d).map(f => f.updatedAt).filter(Boolean).sort().pop()

  function paint() {
    if (!on || window.Shell.current?.view !== 'flows') return
    const n = last ? live(last).length : null
    window.Shell.setTitle('Flows', 'flows', n)
    if (!last) return window.Shell.setStatus('Loading…')
    const at = newest(last)
    const all = flowsOf(last).length
    window.Shell.setStatus(at ? `updated ${window.Shell.ago(at)}` : 'No flows',
      `<p>The number is the flows still on their way: <b>${n}</b> of <b>${all}</b>, open and blocked ones, and done ones whose route has not reached the Output yet (QA passed, Push waiting). ` +
      'Flows that reached the Output sit below them under Done; dropped ones behind Show dropped.</p>' +
      '<p>Updated is the newest change to any flow. The page reads them again every 15 seconds.</p>' +
      '<p><b>Archive</b> (a flow\'s ⋯ menu) puts a flow away without deleting it: Archived, under the board, lists them.</p>' +
      '<p><b>Trash</b>: a deleted flow waits there for 24 hours, then it is gone for good, its screenshots with it.</p>')
  }

  function open() {
    if (on) return paint()
    on = true
    const el = view()
    el.innerHTML = '<div id="fxWaiting"></div><div id="fxFlows"></div>'
    window.FlowsView.mount(document.getElementById('fxWaiting'), document.getElementById('fxFlows'))
    paint() // the last poll's head straight away; the mount's own load repaints it
  }
  function close() {
    if (!on) return
    on = false
    window.FlowsView.unmount()
    view().innerHTML = ''
  }

  window.FlowsView.onLoad(d => {
    last = d
    paint()
  })
  window.FlowsPage = { open, close }
})()
