// Completed's routes (factory-routes.mjs mounts them; every POST has passed its same-origin check there, and
// `complete` is one of the USER'S OWN routes: the page's Origin must be PRESENT and its own, like the by-hand tick).
// Each handler returns { status, body } like trash-routes.mjs.
//
//   POST /api/flows/<id>/complete   { completed?: true | false }: true (the default) marks a finished flow completed
//                                   and archives it in the same write; false takes the mark off and unarchives it
//                                   (the flow archive's Uncomplete). { ok, completedAt, archivedAt } (null when off).
//                                   A second press is a 200 that writes nothing. 404 an unknown flow; 400 a flow that
//                                   is not finished (completed.mjs completeRefusal, one plain sentence) or a bad body
//   GET  /api/outputs               completed.mjs outputsSummary over every flow file, with builtAt: what waits for the
//                                   user's sign-off, how many are overdue, and whether they piled up (outputs.max)
//
// ⚠️ The write keeps the flow's updatedAt (flows.mjs writeFlow { stamp: false }): the scorecard, Pipeline time and the
// Log date a finished flow by it, and a sign-off is not a change to the work. Nothing else moves: no status, no story,
// no relay line (the agent is not told; there is nothing for it to do). The Log shows it from completedAt alone.

import { applyComplete, completeRefusal, outputsSummary } from './completed.mjs'
import { CONFIG } from './config.mjs'
import { listFlows, readFlow, writeFlow } from './flows.mjs'
import { pipelineGraph } from './pipeline.mjs'

const ok = body => ({ status: 200, body })
const no = (status, error) => ({ status, body: { error } })

/** Complete or uncomplete flow `id`. `now` is for tests. */
export function completeRoute(id, b, { config = CONFIG, now = Date.now() } = {}) {
  const on = b?.completed === undefined ? true : b.completed
  if (typeof on !== 'boolean') return no(400, 'completed must be true or false')
  const flow = readFlow(id)
  if (!flow) return no(404, `No flow ${id}.`)
  if (on && !flow.completedAt) {
    const refused = completeRefusal(flow, pipelineGraph(config))
    if (refused) return no(400, refused)
  }
  if (applyComplete(flow, on, now)) writeFlow(flow, { stamp: false })
  return ok({ ok: true, completedAt: flow.completedAt ?? null, archivedAt: flow.archivedAt ?? null })
}

export function outputsGet({ config = CONFIG, now = Date.now() } = {}) {
  // archived flows too: archiving is not a sign-off (completed.mjs)
  const summary = outputsSummary(listFlows({ archived: 'any' }).flows, pipelineGraph(config), config.outputs, now)
  return ok({ ...summary, builtAt: new Date(now).toISOString() })
}
