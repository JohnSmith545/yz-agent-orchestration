// The Explain tab of an opened flow, the data half (flow-explain-view.js draws it):
// a short walkthrough built from the flow, one slide per thing its data can show,
// like a presentation of the ticket. Each slide only when its data exists; What
// and why and the path always do.
//
//   what     What and why              the title, the why, the story lines (flow.derived.story)
//   change   Before and after          a before and after pair (flow-compare.js: side by side, or the
//                                      slider), else the Before / Now lines; left out with neither
//   how      How it works              the agent diagram (and how it worked before), when there is one
//   path     Path through the agents   this ticket's stage.path drawn on the pipeline graph's nodes
//                                      (GET /api/pipeline): only the nodes it visited, in order, a
//                                      rework as a return arrow, where it is now marked; a note
//                                      instead while the pipeline loads, or for a flow not on it
//   qa       QA result                 passed or failed, the summary, the commit, the rework line
//
//   slidesOf(flow, ticket, graph)   PURE: [{ kind, title, ... }]; `ticket` is the flow's row of
//                                   /api/pipeline (or null), `graph` its graph (or null, not loaded)
//   pathGraph(stage, graph)         PURE: a Diagram graph of the path, or null when there is none
;(() => {
  const TITLES = { what: 'What and why', change: 'Before and after', how: 'How it works', path: 'Path through the agents', qa: 'QA result' }
  // a pill at either end of the pipeline, a box for each agent and step (diagram.js kinds)
  const KIND = { start: 'actor', end: 'actor' }

  function pathGraph(stage, graph) {
    const path = Array.isArray(stage?.path) ? stage.path : []
    if (!path.length || !Array.isArray(graph?.nodes)) return null
    const byId = new Map(graph.nodes.map(n => [n.id, n]))
    const edgeOf = (from, to) => (graph.edges || []).find(e => e.from === from && e.to === to)
    const ids = [...new Set(path)]
    const nodes = ids.map(id => {
      const g = byId.get(id)
      const n = { id, label: g?.label || id, kind: KIND[g?.kind] || 'box' }
      if (id === stage.node) Object.assign(n, { cls: 'xp-now', sub: `now: ${stage.status}` })
      return n
    })
    // each hop once, in the order first taken; a hop taken again (a second rework) counts on its label
    const hops = new Map()
    for (let i = 1; i < path.length; i++) {
      const key = `${path[i - 1]}>${path[i]}`
      if (path[i - 1] === path[i]) continue
      hops.set(key, (hops.get(key) || 0) + 1)
    }
    const edges = [...hops].map(([key, n]) => {
      const [from, to] = key.split('>')
      const g = edgeOf(from, to)
      const e = { from, to }
      // a rework goes back to the producer every time; a forward hop taken again is the same arrow
      if (g?.label) e.label = g.kind === 'rework' && n > 1 ? `${g.label} ×${n}` : g.label
      if (g?.kind === 'rework') e.cls = 'xp-rework'
      return e
    })
    return { nodes, edges }
  }

  function pathSlide(flow, ticket, graph) {
    const base = { kind: 'path', title: TITLES.path, chart: null, note: '', node: '', status: '', reworks: 0 }
    if (!graph) return { ...base, note: 'Loading the pipeline…' }
    if (flow.status === 'dropped' || ticket?.stage?.status === 'dropped') return { ...base, note: 'This flow was dropped: it left the pipeline.' }
    const stage = ticket?.stage
    const chart = pathGraph(stage, graph)
    if (!chart) return { ...base, note: 'This flow is not on the pipeline now: it shows open flows and those changed in the last 14 days.' }
    const at = graph.nodes.find(n => n.id === stage.node)
    return { ...base, chart, node: at?.label || stage.node || '', status: stage.status || '', reworks: Number(stage.reworks) || 0 }
  }

  function slidesOf(flow, ticket, graph) {
    const m = window.FlowOutput.model(flow)
    const C = window.FlowCompare
    const lines = (flow.derived?.story || []).map(l => ({ who: l.who || '', did: l.did || '', why: l.why || '' }))
    const slides = [{ kind: 'what', title: TITLES.what, heading: flow.title || '', why: flow.why || '', lines }]
    const pairs = C.pairs(m).pairs.length
    if (pairs || m.change) {
      slides.push({ kind: 'change', title: TITLES.change, pairs, compare: C.views(m).includes('compare'), text: m.change ? { before: m.change.before, after: m.change.after } : null })
    }
    if (m.diagram) slides.push({ kind: 'how', title: TITLES.how, diagram: m.diagram, diagramBefore: m.diagramBefore })
    slides.push(pathSlide(flow, ticket, graph))
    const qa = flow.qa || ticket?.qa
    const state = qa ? window.FlowQa.state({ ...flow, qa }) : null
    if (state) {
      slides.push({
        kind: 'qa', title: TITLES.qa, state, attempt: qa.attempt ?? null, summary: qa.summary || '', commit: qa.commit || '', branch: qa.branch || '',
        pushedAt: qa.pushedAt || null, pushError: qa.pushError || null, steps: Array.isArray(qa.steps) ? qa.steps.length : 0,
        rework: window.FlowQa.rework({ ...flow, qa }),
      })
    }
    return slides
  }

  window.FlowExplain = { slidesOf, pathGraph, TITLES }
})()
