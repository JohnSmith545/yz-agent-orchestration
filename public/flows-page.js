// The Flows page (spec 5, #/flows): the Waiting on you strip above the flows
// board, both drawn by flows.js. The shell calls open and close as the route
// comes and goes; this file only builds the two boxes, mounts FlowsView into
// them, and writes the page head (`Flows · N`, N the open and blocked flows)
// and the status chip (when the newest flow changed, the rest behind its ?)
// from each poll.
;(() => {
  const view = () => document.getElementById('flowsView')
  let on = false
  let last = null // the data of the last poll, to write the head again after a re-route

  const live = d => (d?.flows || []).filter(f => f.status === 'open' || f.status === 'blocked')
  const newest = d => (d?.flows || []).map(f => f.updatedAt).filter(Boolean).sort().pop()

  function paint() {
    if (!on || window.Shell.current?.view !== 'flows') return
    const n = last ? live(last).length : null
    window.Shell.setTitle('Flows', 'flows', n)
    if (!last) return window.Shell.setStatus('Loading…')
    const at = newest(last)
    const all = last.flows?.length || 0
    window.Shell.setStatus(at ? `updated ${window.Shell.ago(at)}` : 'No flows',
      `<p>The number is the open and blocked flows: <b>${n}</b> of <b>${all}</b>. Done flows sit below them; dropped ones behind Show dropped.</p>` +
      '<p>Updated is the newest change to any flow. The page reads them again every 15 seconds.</p>')
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
