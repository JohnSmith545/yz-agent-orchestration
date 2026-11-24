// The Explain tab of an opened flow, the data half (flow-explain-view.js draws it):
// a short walkthrough built from the flow, one slide per thing its data can show,
// like a presentation of the ticket. Each slide only when its data exists; What
// and why and the path always do.
//
//   what     What and why              the title, the why, the story lines (flow.derived.story)
//   change   Before and after          a before and after pair (flow-compare.js: side by side, or the
//                                      slider), else the Before / Now lines; left out with neither
//   how      How it works              the agent diagram (and how it worked before), when there is one
//   path     Path through the agents   this flow's route from the Request to the Output, drawn from its
//                                      own `progress` (/api/flows, flow-route.js chart): the steps it
//                                      took, where it is now marked with its state, the steps still
//                                      ahead dashed, a rework as a return arrow; a note instead for a
//                                      dropped flow, or one with no progress
//   qa       QA result                 passed or failed, the summary, the commit, the rework line
//
//   slidesOf(flow)   PURE: [{ kind, title, ... }], from the flow as /api/flows sends it
;(() => {
  const TITLES = { what: 'What and why', change: 'Before and after', how: 'How it works', path: 'Path through the agents', qa: 'QA result' }

  function pathSlide(flow) {
    const base = { kind: 'path', title: TITLES.path, chart: null, note: '', where: '' }
    const R = window.FlowRoute
    if (flow.status === 'dropped') return { ...base, note: 'This flow was dropped: it left the pipeline.' }
    const chart = R?.chart(flow)
    if (!chart) return { ...base, note: 'This flow has no route yet.' }
    return { ...base, chart, where: R.where(flow) }
  }

  function slidesOf(flow) {
    const m = window.FlowOutput.model(flow)
    const C = window.FlowCompare
    const lines = (flow.derived?.story || []).map(l => ({ who: l.who || '', did: l.did || '', why: l.why || '' }))
    const slides = [{ kind: 'what', title: TITLES.what, heading: flow.title || '', why: flow.why || '', lines }]
    const pairs = C.pairs(m).pairs.length
    if (pairs || m.change) {
      slides.push({ kind: 'change', title: TITLES.change, pairs, compare: C.views(m).includes('compare'), text: m.change ? { before: m.change.before, after: m.change.after } : null })
    }
    if (m.diagram) slides.push({ kind: 'how', title: TITLES.how, diagram: m.diagram, diagramBefore: m.diagramBefore })
    slides.push(pathSlide(flow))
    const qa = flow.qa
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

  window.FlowExplain = { slidesOf, TITLES }
})()
