// Where a no-code flow stands on the by-hand route of the graph (pipeline.mjs): the Human task box (the user) and,
// when config names one, Senior (pipeline.senior), who reviews work that has no code to test. stageOf calls handStage
// for a flow with no QA record; null means the flow is not on this route and stageOf goes on as it always did.
//
//   no by-hand steps, no Senior record       null: it passes both boxes without stopping (an investigation or an
//                                            answer never starts waiting on anyone), and ends at the Output when done
//   by-hand steps, not all ticked            human, waiting (open or blocked): the user has work to do
//   every step ticked, Senior on the graph   senior, waiting (for `flow senior-start`)
//   every step ticked, no Senior             human, waiting, until the flow is marked done; then the Output, done
//   finished (done) with no Senior record    the Output, done, whatever the ticks: a flow finished before Senior
//                                            existed, or before this box did, never turns into unfinished work
// With a Senior record (flow-senior.mjs flow.senior), and Senior on the graph, the record decides:
//   asked (senior-ask)                       senior, waiting: an agent sent it on purpose, steps or not
//   reviewing                                senior, reviewing
//   passed                                   the Output, passed
//   failed                                   back to Human task, rework (the steps Senior named were unticked);
//                                            once every step is ticked again: senior, waiting
//   senior-failed (failed too often)         senior, failed: stopped
// Each earlier failed verdict (`history`) is one more Human task -> Senior -> Human task loop in the path, and one
// rework. Senior data on a graph without Senior is not drawn: the steps alone decide, as without Senior.
//
// ⚠️ Pure like pipeline.mjs, and it must not import pipeline.mjs (pipeline.mjs imports this file).

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const live = flow => flow?.status === 'open' || flow?.status === 'blocked'

/** The by-hand steps of a flow, objects only. */
export const handSteps = flow => (Array.isArray(flow?.hand?.steps) ? flow.hand.steps.filter(isObject) : [])

/** Every by-hand step ticked by the user, and at least one. */
export const allTicked = flow => {
  const steps = handSteps(flow)
  return steps.length > 0 && steps.every(s => !!s.done)
}

/** The earlier failed Senior verdicts of a record, oldest first. */
export const pastFailures = rec => (Array.isArray(rec?.history) ? rec.history.filter(h => isObject(h) && h.status === 'failed') : [])

/** { node, status, path, reworks } of a flow on the by-hand route, or null when it is not on it. `path` ends at its own agent. */
export function handStage(flow, graph, path) {
  const nodes = graph?.nodes || []
  const human = nodes.find(n => n.role === 'human')
  if (!human) return null
  const senior = nodes.find(n => n.role === 'senior') || null
  const rec = senior && isObject(flow?.senior) ? flow.senior : null
  const steps = handSteps(flow)
  if (!rec && !steps.length) return null
  const out = (node, status, p, reworks = 0) => ({ node, status, path: p, reworks })
  const p = [...path]
  if (steps.length) p.push(human.id)
  if (!rec) {
    if (flow?.status === 'done' || !live(flow)) return out('outcome', 'done', [...p, 'outcome'])
    if (senior && allTicked(flow)) return out(senior.id, 'waiting', [...p, senior.id])
    return out(human.id, 'waiting', p)
  }
  let reworks = 0
  for (let k = pastFailures(rec).length; k > 0; k--) {
    p.push(senior.id, human.id)
    reworks++
  }
  switch (rec.status) {
    case 'asked':
      return out(senior.id, 'waiting', [...p, senior.id], reworks)
    case 'reviewing':
      return out(senior.id, 'reviewing', [...p, senior.id], reworks)
    case 'passed':
      return out('outcome', 'passed', [...p, senior.id, 'outcome'], reworks)
    case 'failed':
      p.push(senior.id, human.id)
      reworks++
      return allTicked(flow) ? out(senior.id, 'waiting', [...p, senior.id], reworks) : out(human.id, 'rework', p, reworks)
    default: // senior-failed, or anything a hand-edited file says: stopped at Senior
      return out(senior.id, 'failed', [...p, senior.id], reworks)
  }
}
