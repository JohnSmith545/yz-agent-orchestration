// Completed: the user's sign-off on a finished flow, and the reminders that ask for it. PURE: no file, no config
// read, no clock of its own (every `now` is passed in), so the routes, the CLI and the tests share one copy.
//
//   outputSettings(raw, warn)          config.json `outputs`, checked: { max, warnAfterDays }; a bad value keeps its
//                                      default with ONE warning per key, never a failed startup
//   isCompleted(flow)                  the user marked it completed (`completedAt`)
//   isFinished(flow, graph)            it stands at the end: status done, or its stage is the Output (pipeline.mjs
//                                      stageOf: QA pushed it while the flow is still open). Dropped never is
//   atOutput(flow, graph)              its stage is the Output (pipeline.mjs stageOf): a done flow still on its way (code
//                                      QA has not tested, a pass Push still waits for) is finished but not there yet
//   waitsForSignOff(flow, graph)       at the Output, and neither completed nor archived nor deleted: what the reminders
//                                      count and the amber mark shows
//   finishedAt(flow, graph)            when it finished, in ms: the time the scorecard counts it at (score.mjs cellOf),
//                                      else its last update; null when it has neither
//   isOverdue(flow, graph, now, s)     it has waited `warnAfterDays` whole days (24 h each) or more since it finished
//   outputsSummary(flows, graph, s, now)  { waiting: [{ id, title, agent, finishedAt, overdue }], counts: { waiting,
//                                      overdue }, max, warnAfterDays, piled }, the oldest finish first
//   waitingLine(n) / reminderLine(n)   the two sentences every page says, so they never drift apart
//   completeRefusal(flow, graph)       why `flow` cannot be completed, one plain sentence, or ''
//   applyComplete(flow, on, now)       sets or clears the mark in memory (the caller writes the flow)
//
// THE RULES
// - Completed is the USER'S, like a tick (flows.mjs verified) and like Archive: only the dashboard's own page sets or
//   clears it (completed-routes.mjs, the page's Origin required and present). No agent command sets it, and a
//   `flow write` keeps or drops the stored mark exactly as it does archivedAt (flows.mjs mergeKeepingAnswers).
// - Completing ARCHIVES the flow in the same write (archivedAt = completedAt), so every board that leaves an archived
//   flow out leaves a completed one out too; uncompleting clears both and notes `uncompletedAt` for the Log.
// - Completing moves NOTHING else: no status, no story line, and the flow's updatedAt is kept as it was (flows.mjs
//   writeFlow { stamp: false }), so the scorecard, Pipeline time and the Log count it exactly as before. Its only
//   trace is the Log's `completed` (and `uncompleted`) event, by You (score-log.mjs).
// - OVERDUE is elapsed time, not calendar days: finished at 23:59 is not overdue at 00:01 two dates later (24 h 2 min).
//   One rule that a clock change or a late-night finish cannot bend.
// - PILED is waiting >= max: at 7 (the default) the reminder shows, at 6 nothing does. A reminder, never a block.

import { DAY, cellOf } from './score.mjs'
import { stageOf } from './pipeline.mjs'

export const OUTPUT_DEFAULTS = Object.freeze({ max: 7, warnAfterDays: 2 })
/** The bounds a setting must sit in: a whole number in each range. */
const LIMITS = Object.freeze({ max: [1, 1000], warnAfterDays: [1, 365] })
/** Who completes a flow: always the person on the page, never an agent. */
export const COMPLETED_BY = 'you'

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
const msOf = now => (now instanceof Date ? now.getTime() : Number(now))

/** config.json `outputs`, checked: left out is the defaults; each bad key keeps its default with one warning. */
export function outputSettings(raw, warn = console.warn) {
  const out = { ...OUTPUT_DEFAULTS }
  if (raw === undefined) return out
  if (!isObject(raw)) {
    warn('config.json: outputs should be an object such as { "max": 7, "warnAfterDays": 2 }; the defaults are used.')
    return out
  }
  for (const key of Object.keys(OUTPUT_DEFAULTS)) {
    if (raw[key] === undefined) continue
    const [lo, hi] = LIMITS[key]
    if (Number.isInteger(raw[key]) && raw[key] >= lo && raw[key] <= hi) out[key] = raw[key]
    else warn(`config.json: outputs.${key} needs a whole number from ${lo} to ${hi}; ${out[key]} is used.`)
  }
  return out
}

export const isCompleted = flow => !!flow?.completedAt

export const isFinished = (flow, graph) => isObject(flow) && flow.status !== 'dropped' && (flow.status === 'done' || atOutput(flow, graph))

export function atOutput(flow, graph) {
  if (!isObject(flow) || flow.status === 'dropped') return false
  try {
    return stageOf(flow, graph)?.node === 'outcome'
  } catch {
    return false
  }
}

export const waitsForSignOff = (flow, graph) => atOutput(flow, graph) && !isCompleted(flow) && !flow.archivedAt && !flow.deletedAt

export function finishedAt(flow, graph) {
  let counted = null
  try {
    const c = cellOf(flow, graph, Number.MAX_SAFE_INTEGER, Infinity)
    if (c.cell === 'delivered' || c.cell === 'slipped') counted = c.time
  } catch {
    counted = null
  }
  return Number.isFinite(counted) ? counted : timeOf(flow?.updatedAt)
}

export function isOverdue(flow, graph, now, settings = OUTPUT_DEFAULTS) {
  const at = finishedAt(flow, graph)
  return at !== null && msOf(now) - at >= settings.warnAfterDays * DAY
}

export function outputsSummary(flows, graph, settings = OUTPUT_DEFAULTS, now = Date.now()) {
  const s = outputSettings(settings, () => {})
  const waiting = (Array.isArray(flows) ? flows : [])
    .filter(f => isObject(f) && typeof f.id === 'string' && waitsForSignOff(f, graph))
    .map(f => {
      const at = finishedAt(f, graph)
      return { id: f.id, title: String(f.title || f.id), agent: String(f.agent || ''), finishedAt: at === null ? null : new Date(at).toISOString(), overdue: isOverdue(f, graph, now, s) }
    })
    .sort((a, b) => String(a.finishedAt || '').localeCompare(String(b.finishedAt || '')) || a.id.localeCompare(b.id))
  const overdue = waiting.filter(w => w.overdue).length
  return { waiting, counts: { waiting: waiting.length, overdue }, max: s.max, warnAfterDays: s.warnAfterDays, piled: waiting.length >= s.max }
}

const outputs = n => `${n} ${n === 1 ? 'output waits' : 'outputs wait'}`
/** `3 outputs wait for your sign-off` (1 output waits). MUST CHANGE IN LOCKSTEP with public/completed-view.js. */
export const waitingLine = n => `${outputs(n)} for your sign-off`
/** The pile-up reminder: the Ask drawer, the Tickets page and `flow new` say exactly this. */
export const reminderLine = n => `${waitingLine(n)}. Mark ${n === 1 ? 'it' : 'them'} completed before a new request.`

export function completeRefusal(flow, graph) {
  if (!isObject(flow)) return 'There is no such flow.'
  if (isFinished(flow, graph)) return ''
  const what = flow.status === 'dropped' ? 'it was dropped' : flow.status === 'blocked' ? 'it is blocked' : 'it is still on its way'
  return `Only a finished flow can be marked completed: ${what}.`
}

/**
 * The mark, in memory. On: completedAt, completedBy and archivedAt, all at `now`. Off: both go, and uncompletedAt
 * notes when (the Log's `uncompleted` event). Returns true when anything changed, so a second press writes nothing.
 */
export function applyComplete(flow, on, now = Date.now()) {
  const at = new Date(msOf(now)).toISOString()
  if (on) {
    if (flow.completedAt) return false
    flow.completedAt = at
    flow.completedBy = COMPLETED_BY
    flow.archivedAt = at
    return true
  }
  if (!flow.completedAt) return false
  delete flow.completedAt
  delete flow.completedBy
  delete flow.archivedAt
  flow.uncompletedAt = at
  return true
}
