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
//                                    kind=rule). `total` is how many matched before the cut. The kinds of the
//                                    optional agents (score-log.mjs GATE_KINDS: security, planned, senior) are accepted
//                                    only on a pipeline that has that agent, and only then named in the refusal.
//                                    The DEFAULT view (no cell, kind or completed) leaves out every event of a flow the
//                                    user marked completed (completed.mjs): it is put away. `completed=1` lists only
//                                    those, with every `uncompleted` and `reopened` event; a cell or kind filter keeps them, so the
//                                    scorecard's See these in the log still finds every event it counted.
// Any other value is a 400 with one plain sentence. The log also carries every saved change to an agent's rules
// (agent-rules.mjs readLog and ruleEvents) as `rule` events; orchestrationLog keeps the ones inside the window.
//
// Each handler returns { status, body }. `config` is config.mjs CONFIG by default; tests may pass `now`.

import { readLog, ruleEvents } from './agent-rules.mjs'
import { CONFIG } from './config.mjs'
import { listFlows } from './flows.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { GATE_KINDS, GATE_ROLE, LOG_CELLS, LOG_KINDS, orchestrationLog, SIGN_OFF_KINDS } from './score-log.mjs'
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

export function logGet({ days: rawDays, cell, kind, completed } = {}, { config = CONFIG, now = Date.now(), extra = ruleChanges(now) } = {}) {
  const days = daysOf(rawDays)
  if (days === undefined) return BAD_WINDOW
  if (cell && !LOG_CELLS.includes(cell)) return { status: 400, body: { error: 'The cell must be delivered, caught, missed or slipped.' } }
  const graph = pipelineGraph(config)
  const roles = new Set(graph.nodes.map(n => n.role))
  const kinds = [...LOG_KINDS, ...GATE_KINDS.filter(k => roles.has(GATE_ROLE[k])), ...SIGN_OFF_KINDS]
  if (kind && !kinds.includes(kind)) {
    return { status: 400, body: { error: `The kind must be one of ${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}.` } }
  }
  if (completed != null && completed !== '' && completed !== '1') return { status: 400, body: { error: 'completed must be 1 when given.' } }
  const flows = listFlows({ archived: 'any' }).flows
  const all = orchestrationLog(flows, graph, { now, days, extra })
  const signed = new Set(flows.filter(f => f.completedAt).map(f => f.id))
  const isSigned = e => !!e.flow && signed.has(e.flow.id)
  const view = completed === '1' ? e => isSigned(e) || e.kind === 'uncompleted' || e.kind === 'reopened' : !cell && !kind ? e => !isSigned(e) : () => true
  const events = all.filter(e => (!cell || e.cell === cell) && (!kind || e.kind === kind) && view(e))
  return { status: 200, body: { events: events.slice(0, LOG_MAX), total: events.length, window: windowOf(now, days).view, builtAt: new Date(now).toISOString() } }
}
