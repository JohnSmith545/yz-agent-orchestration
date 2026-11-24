// The Flows page (spec 5, #/flows): the Waiting on you strip above the flows
// board, both drawn by flows.js. The shell calls open and close as the route
// comes and goes; this file only builds the two boxes, mounts FlowsView into
// them, opens the flow a link names (`#/flows?flow=<id>[&node=<id>][&at=hand]`,
// openFromQuery), and writes the page head (`Flows · N`, N the cards on the board: FlowBoard.groups live)
// and the status chip (when the newest flow changed, the rest behind its ?,
// which also says what Archive and Delete do) from each poll.
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
      '<p><b>Archive</b> and <b>Delete</b> (on each card, and in an open flow\'s ⋯ menu) take a flow off the board. Both keep it in the <b>flow archive</b> (the link under the board): ' +
      'an archived flow is put away, a deleted one waits there until you choose Delete for good. Nothing leaves by a timer.</p>')
  }

  function open(query = {}) {
    if (on) return paint(), openFromQuery(query)
    on = true
    const el = view()
    el.innerHTML = '<div id="fxWaiting"></div><div id="fxFlows"></div>'
    window.FlowsView.mount(document.getElementById('fxWaiting'), document.getElementById('fxFlows'))
    paint() // the last poll's head straight away; the mount's own load repaints it
    openFromQuery(query)
  }
  /** A link that names a flow opens it: at a node (its row on Status), or at its by-hand steps (`at=hand`). */
  function openFromQuery(q) {
    const id = typeof q?.flow === 'string' && /^[a-z0-9-]+$/.test(q.flow) ? q.flow : ''
    if (!id) return
    if (q.at === 'hand') return window.FlowsView.gotoHand?.(id)
    window.FlowsView.open(id, typeof q.node === 'string' && q.node ? q.node : undefined)
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
