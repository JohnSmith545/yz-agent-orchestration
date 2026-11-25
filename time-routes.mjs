// The Pipeline time route (factory-routes.mjs mounts it beside the score routes):
//
//   GET /api/time[?days=7|30|all]   { window, finished, rates, took, waiting, stages, bars, agents, left, fewer,
//                                   builtAt }: time-stats.mjs timeStats over every flow file (archived ones too; the
//                                   Trash never, a trashed flow has no file in data/flows) on the orchestration
//                                   graph. Left out (or empty) is 30 days, as the score's; the page asks for the
//                                   window the score strip shows, so one switch drives both blocks.
// Any other window is a 400 with the score's own sentence. The answer is sent with cache-control no-store (send).
//
// Returns { status, body }. `config` is config.mjs CONFIG by default; tests may pass `now`.

import { CONFIG } from './config.mjs'
import { listFlows } from './flows.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { SCORE_WINDOWS } from './score-routes.mjs'
import { timeStats } from './time-stats.mjs'

export function timeGet(raw, { config = CONFIG, now = Date.now() } = {}) {
  const key = raw == null || raw === '' ? '30' : String(raw)
  if (!Object.hasOwn(SCORE_WINDOWS, key)) return { status: 400, body: { error: 'The window must be 7, 30 or all days.' } }
  const stats = timeStats(listFlows({ archived: 'any' }).flows, pipelineGraph(config), { now, days: SCORE_WINDOWS[key] })
  return { status: 200, body: { ...stats, builtAt: new Date(now).toISOString() } }
}
