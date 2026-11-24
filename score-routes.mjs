// The score routes (factory-routes.mjs mounts them beside the pipeline routes):
//
//   GET /api/score[?days=7|30|all]   { window, counts, lists, precision, recall, accuracy, f, correctness, agents,
//                                    inFlight, builtAt }: score.mjs scoreOf over every flow file (archived ones
//                                    too; the Trash never, a trashed flow has no file in data/flows) on the
//                                    orchestration graph. Left out (or empty) is 30 days.
//   GET /api/log[?days=7|30|all&cell=<cell>&kind=<kind>]   { events, total, window, builtAt }: score-log.mjs
//                                    orchestrationLog over the same flows, newest first, at most LOG_MAX events;
//                                    `cell` keeps the events that put a count in that scorecard cell (delivered,
//                                    caught, missed, slipped), `kind` one kind (the panel's Rules filter is
//                                    kind=rule). `total` is how many matched before the cut.
// Any other value is a 400 with one plain sentence. The log also carries every saved change to an agent's rules
// (agent-rules.mjs readLog and ruleEvents) as `rule` events; orchestrationLog keeps the ones inside the window.
//
// Each handler returns { status, body }. `config` is config.mjs CONFIG by default; tests may pass `now`.

import { readLog, ruleEvents } from './agent-rules.mjs'
import { CONFIG } from './config.mjs'
import { listFlows } from './flows.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { LOG_CELLS, LOG_KINDS, orchestrationLog } from './score-log.mjs'
import { scoreOf, windowOf } from './score.mjs'

/** The windows the page offers, by their query value: a number of days, or null for all time. */
export const SCORE_WINDOWS = Object.freeze({ 7: 7, 30: 30, all: null })
export const LOG_MAX = 300

const BAD_WINDOW = { status: 400, body: { error: 'The window must be 7, 30 or all days.' } }
/** The window a query value names (left out or empty: 30 days), or undefined for a bad one. */
const daysOf = raw => {
  const key = raw == null || raw === '' ? '30' : String(raw)
  return Object.hasOwn(SCORE_WINDOWS, key) ? SCORE_WINDOWS[key] : undefined
}

export function scoreGet(raw, { config = CONFIG, now = Date.now() } = {}) {
  const days = daysOf(raw)
  if (days === undefined) return BAD_WINDOW
  const score = scoreOf(listFlows({ archived: 'any' }).flows, pipelineGraph(config), { now, days })
  return { status: 200, body: { ...score, builtAt: new Date(now).toISOString() } }
}

/** Every saved rule change as a log event; the window is applied by orchestrationLog, so none is cut here. */
const ruleChanges = now => ruleEvents(readLog(), { now, days: Infinity })

export function logGet({ days: rawDays, cell, kind } = {}, { config = CONFIG, now = Date.now(), extra = ruleChanges(now) } = {}) {
  const days = daysOf(rawDays)
  if (days === undefined) return BAD_WINDOW
  if (cell && !LOG_CELLS.includes(cell)) return { status: 400, body: { error: 'The cell must be delivered, caught, missed or slipped.' } }
  if (kind && !LOG_KINDS.includes(kind)) {
    return { status: 400, body: { error: `The kind must be one of ${LOG_KINDS.slice(0, -1).join(', ')} or ${LOG_KINDS.at(-1)}.` } }
  }
  const all = orchestrationLog(listFlows({ archived: 'any' }).flows, pipelineGraph(config), { now, days, extra })
  const events = all.filter(e => (!cell || e.cell === cell) && (!kind || e.kind === kind))
  return { status: 200, body: { events: events.slice(0, LOG_MAX), total: events.length, window: windowOf(now, days).view, builtAt: new Date(now).toISOString() } }
}
