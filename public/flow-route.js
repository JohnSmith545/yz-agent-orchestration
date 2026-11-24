// A flow's way through the pipeline, from the Request to the Output, as every page draws it. The server sends
// each flow with its `route` ({ type, steps, inferred? }) and its `progress` ([{ node, label, role, state,
// visits, status? }], flow-route.mjs withRoute) on /api/flows, /api/pipeline and /api/qa alike: this file only
// draws that answer, it never works out a stage of its own.
//
//   at(progress)        the node it stands at: the current step, the Output once every step is done, else null
//   nowLabel(f)         that step's name ('Output' at the end, 'dropped' for a dropped flow)
//   strip(f)            the board card's compact strip: the type, where it is now, every step by name
//   line(f)             an opened flow's head: the full path as a step line, each step with a detail a button
//   detailOf(role)      where a step's detail is: 'agents' (its node on Agents), 'qa' (the QA page), 'output'
//                       (the Output tab), or null (the Request has none)
//   go(flowId, node, role)   open that detail (a click on the line goes through here)
//   highlight(graph, progress)  for the Agents diagram: { nodes, edges } lit in the accent (done and current,
//                       a rework's return arrow), and `next`: { nodes, edges } still ahead, drawn dashed
//   chart(f)            the Explain slide's path: a Diagram graph of the steps taken and those ahead
//   where(f)            the one line under that chart
//
// States: done (neutral filled), current (the accent), upcoming (outlined), skipped (left out or faint). Colour
// is for meaning only: green and red only on the QA step, for QA passed and failed.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const steps = f => (Array.isArray(f?.progress) ? f.progress : [])
  const current = progress => (Array.isArray(progress) ? progress.find(s => s.state === 'current') : null) || null
  const LIVE = new Set(['open', 'blocked'])

  function at(progress) {
    const list = Array.isArray(progress) ? progress : []
    const now = current(list)
    if (now) return now.node
    const last = list.at(-1)
    return last?.node === 'outcome' && last.state === 'done' ? 'outcome' : null
  }

  function nowLabel(f) {
    const now = current(f?.progress)
    if (now) return now.label
    return at(f?.progress) === 'outcome' ? 'Output' : f?.status === 'dropped' ? 'dropped' : ''
  }

  /** Green on the QA step when QA passed, red when it failed; nothing anywhere else. */
  function tone(s, f) {
    if (s.role !== 'qa') return ''
    const q = f?.qa?.status
    return q === 'passed' ? ' qa-ok' : q === 'failed' || q === 'qa-failed' ? ' qa-bad' : ''
  }

  const DETAIL = { coordinator: 'agents', producer: 'agents', chat: 'agents', qa: 'qa', push: 'qa', outcome: 'output' }
  const detailOf = role => DETAIL[role] || null

  const unset = f => (f?.route?.inferred && LIVE.has(f.status)
    ? ' <span class="rt-unset" title="This flow was started before routes: its path is a guess until its agent sets it (flow route)">route not set</span>'
    : '')

  function strip(f) {
    const list = steps(f)
    if (!list.length) return ''
    const said = list.map(s => `${s.label} ${s.state}`).join(', ')
    const now = nowLabel(f)
    return `<div class="rt-card"><span class="rt-type">${esc(f.route?.type || '')}</span>${now ? ` · <span class="rt-now">at ${esc(now)}</span>` : ''}${unset(f)}</div>` +
      `<ol class="rt-strip" aria-label="Route: ${esc(said)}">${list.map(s => `<li class="rt-s s-${esc(s.state)}${tone(s, f)}">${esc(s.label)}</li>`).join('')}</ol>`
  }

  function line(f) {
    const list = steps(f)
    if (!list.length) return ''
    const items = list.map(s => {
      const back = s.visits > 1 ? `<span class="rt-visits" title="Here ${s.visits} times: sent back by QA">×${s.visits}</span>` : ''
      const name = `${esc(s.label)}${back}`
      const word = `<span class="rt-sr">${esc(s.state)}${s.state === 'current' && s.status ? `: ${esc(s.status)}` : ''}</span>`
      const to = detailOf(s.role)
      const body = to
        ? `<button type="button" class="rt-go" data-route-step="${esc(s.node)}" data-route-role="${esc(s.role)}" data-route-flow="${esc(f.id)}" title="${esc(TITLE[to])}">${name}</button>`
        : `<span class="rt-go">${name}</span>`
      return `<li class="rt-s s-${esc(s.state)}${tone(s, f)}"${s.state === 'current' ? ' aria-current="step"' : ''}>${body}${word}</li>`
    })
    return `<nav class="rt-line" aria-label="Path from Request to Output"><span class="rt-type">${esc(f.route?.type || '')}</span>${unset(f)}<ol>${items.join('')}</ol></nav>`
  }
  const TITLE = { agents: 'Show this step on Agents', qa: 'Show it on the QA page', output: 'Show the Output' }

  function go(flowId, node, role) {
    const to = detailOf(role)
    if (to === 'agents') {
      if (typeof window.AgentsPage?.showNode === 'function') return window.AgentsPage.showNode(node, flowId)
      return void (window.location.hash = '#/agents')
    }
    if (to === 'qa') {
      if (typeof window.QaPage?.gotoFlow === 'function') return window.QaPage.gotoFlow(flowId)
      return void (window.location.hash = `#/qa/${encodeURIComponent(flowId)}`)
    }
    if (to === 'output') window.FlowsView?.gotoFlow?.(flowId, null, 'output')
  }

  // ═══ the Agents diagram ═══

  function highlight(graph, progress) {
    if (!Array.isArray(progress) || !progress.length || !Array.isArray(graph?.edges)) return null
    const index = (a, b, rework = false) => graph.edges.findIndex(e => e.from === a && e.to === b && (e.kind === 'rework') === rework)
    const pairs = list => {
      const out = []
      for (let i = 1; i < list.length; i++) {
        const k = index(list[i - 1].node, list[i].node)
        if (k >= 0) out.push(k)
      }
      return out
    }
    const lit = progress.filter(s => s.state === 'done' || s.state === 'current')
    const edges = pairs(lit)
    const nodes = lit.map(s => s.node)
    const qa = progress.find(s => s.role === 'qa')
    for (const s of progress) {
      if (s.role !== 'producer' || s.visits < 2 || !qa) continue
      const k = index(qa.node, s.node, true)
      if (k >= 0) edges.push(k)
      if (!nodes.includes(qa.node)) nodes.push(qa.node)
    }
    const now = progress.findIndex(s => s.state === 'current')
    const ahead = now < 0 ? [] : progress.slice(now).filter(s => s.state === 'current' || s.state === 'upcoming')
    const sort = list => [...new Set(list)].sort((a, b) => a - b)
    return {
      nodes,
      edges: sort(edges),
      next: { nodes: ahead.filter(s => s.state === 'upcoming' && !nodes.includes(s.node)).map(s => s.node), edges: sort(pairs(ahead)) },
    }
  }

  // ═══ the Explain slide ═══

  const ENDS = new Set(['request', 'outcome'])
  /** How many times QA sent it back: the most visits any producer step had, less the first. */
  const reworks = list => Math.max(0, ...list.filter(s => s.role === 'producer').map(s => (s.visits || 0) - 1))

  function chart(f) {
    const list = steps(f).filter(s => s.state !== 'skipped')
    if (!list.length) return null
    const nodes = list.map(s => {
      const n = { id: s.node, label: s.label, kind: ENDS.has(s.role) ? 'actor' : 'box' }
      if (s.state === 'current') Object.assign(n, { cls: 'xp-now', sub: `now: ${s.status || 'here'}` })
      else if (s.state === 'upcoming') n.cls = 'xp-next'
      return n
    })
    const edges = []
    for (let i = 1; i < list.length; i++) {
      const e = { from: list[i - 1].node, to: list[i].node }
      if (list[i].state === 'upcoming') e.cls = 'xp-next'
      edges.push(e)
    }
    const qa = list.find(s => s.role === 'qa')
    for (const s of list) {
      if (s.role !== 'producer' || s.visits < 2 || !qa) continue
      const n = s.visits - 1
      edges.push({ from: qa.node, to: s.node, label: n > 1 ? `failed ×${n}` : 'failed', cls: 'xp-rework' })
    }
    return { nodes, edges }
  }

  function where(f) {
    const list = steps(f)
    const now = current(list)
    if (now) {
      const n = reworks(list)
      const back = n === 1 ? ' · sent back once' : n > 1 ? ` · sent back ${n} times` : ''
      return `Now at ${now.label}${now.status ? ` · ${now.status}` : ''}${back}`
    }
    return at(list) === 'outcome' ? 'Reached the Output' : f?.status === 'dropped' ? 'Dropped: it left the pipeline' : ''
  }

  // A click on a step of the line, on any page (the Flows head, the QA page).
  if (window.document?.addEventListener) {
    document.addEventListener('click', e => {
      const b = e.target.closest?.('[data-route-step]')
      if (b) go(b.dataset.routeFlow, b.dataset.routeStep, b.dataset.routeRole)
    })
  }

  window.FlowRoute = { at, nowLabel, strip, line, detailOf, go, highlight, chart, where }
})()
