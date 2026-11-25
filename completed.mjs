// Completed: the user's sign-off on a finished flow, and the reminders that ask for it. PURE: no file, no config
// read, no clock of its own (every `now` is passed in), so the routes, the CLI and the tests share one copy.
//
//   outputSettings(raw, warn)          config.json `outputs`, checked: { max, warnAfterDays }; a bad value keeps its
//                                      default with ONE warning per key, never a failed startup
//   isCompleted(flow)                  the user marked it completed (`completedAt`)
//   isFinished(flow, graph)            what the user may complete: status done, or at the Output (atOutput: QA pushed
//                                      it while the flow is still open). Dropped never is
//   atOutput(flow, graph)              its route has reached the Output, as every page reads it (flow-route.mjs
//                                      routeProgress, public/flow-route.js at): a done flow still on its way (code QA
//                                      has not tested, a pass Push still waits for) is finished but not there yet, and
//                                      a flow whose route was planned before Security joined is there once QA pushed
//   waitsForSignOff(flow, graph)       at the Output, and neither completed nor deleted: what the reminders
//                                      count and the amber mark shows
//   finishedAt(flow, graph)            when it finished, in ms: the time the scorecard counts it at (score.mjs cellOf),
//                                      else its last update; null when it has neither
//   isOverdue(flow, graph, now, s)     it has waited `warnAfterDays` whole days (24 h each) or more since it finished
//   outputsSummary(flows, graph, s, now)  { waiting: [{ id, title, agent, finishedAt, overdue, archived }], counts: { waiting,
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
//   flow out leaves a completed one out too; uncompleting clears both.
// - THE HISTORY: every press that changes the mark appends { at, did: 'completed' | 'uncompleted' } to `flow.signoff`
//   (the newest SIGNOFF_MAX kept), so toggling twice loses nothing and the Log shows every one. completedAt stays the
//   CURRENT mark. The list is the user's like the mark: a flow write keeps the stored one (flows.mjs).
// - Completing moves NOTHING else: no status, no story line, and the flow's updatedAt is kept as it was (flows.mjs
//   writeFlow { stamp: false }), so the scorecard, Pipeline time and the Log count it exactly as before. Its only
//   trace is the Log's `completed` (and `uncompleted`) event, by You (score-log.mjs).
// - OVERDUE is elapsed time, not calendar days: finished at 23:59 is not overdue at 00:01 two dates later (24 h 2 min).
//   One rule that a clock change or a late-night finish cannot bend.
// - ARCHIVING IS NOT A SIGN-OFF: a flow at the Output the user archived but never completed still waits (it counts,
//   it is in the Output list with an Archived mark, the reminders name it). Putting work away is not saying it is done;
//   only Completed is. So the callers count over every flow file, archived ones included (listFlows archived any).
// - PILED is waiting >= max: at 7 (the default) the reminder shows, at 6 nothing does. A reminder, never a block.

import { routeProgress } from './flow-route.mjs'
import { DAY, cellOf } from './score.mjs'

export const OUTPUT_DEFAULTS = Object.freeze({ max: 7, warnAfterDays: 2 })
/** The bounds a setting must sit in: a whole number in each range. */
const LIMITS = Object.freeze({ max: [1, 1000], warnAfterDays: [1, 365] })
/** Who completes a flow: always the person on the page, never an agent. */
export const COMPLETED_BY = 'you'
/** How many sign-offs a flow keeps in its history, the newest. */
export const SIGNOFF_MAX = 100
export const SIGNOFF_DID = Object.freeze(['completed', 'uncompleted'])

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

/** MUST CHANGE IN LOCKSTEP with public/flow-route.js at(): the Output box draws a flow where that says it stands. */
export function atOutput(flow, graph) {
  if (!isObject(flow) || flow.status === 'dropped') return false
  try {
    const steps = routeProgress(flow, graph)
    const now = steps.find(s => s.state === 'current')
    if (now) return now.node === 'outcome'
    return steps.at(-1)?.node === 'outcome' && steps.at(-1).state === 'done'
  } catch {
    return false // a graph that cannot place the flow: not at the end
  }
}

export const waitsForSignOff = (flow, graph) => atOutput(flow, graph) && !isCompleted(flow) && !flow.deletedAt

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
      return { id: f.id, title: String(f.title || f.id), agent: String(f.agent || ''), finishedAt: at === null ? null : new Date(at).toISOString(), overdue: isOverdue(f, graph, now, s), archived: !!f.archivedAt }
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
 * The mark, in memory. On: completedAt, completedBy and archivedAt, all at `now`. Off: all three go. Either way the
 * press is appended to the history (`signoff`). Returns true when anything changed, so a second press writes nothing.
 */
export function applyComplete(flow, on, now = Date.now()) {
  const at = new Date(msOf(now)).toISOString()
  if (on === !!flow.completedAt) return false
  if (on) {
    flow.completedAt = at
    flow.completedBy = COMPLETED_BY
    flow.archivedAt = at
  } else {
    delete flow.completedAt
    delete flow.completedBy
    delete flow.archivedAt
  }
  const history = Array.isArray(flow.signoff) ? flow.signoff : []
  flow.signoff = [...history, { at, did: on ? 'completed' : 'uncompleted' }].slice(-SIGNOFF_MAX)
  return true
}

/** The problems with a flow's `signoff` history, one line each; [] when it is fine. MUST MATCH applyComplete's shape. */
export function validateSignoff(list, isTime) {
  if (!Array.isArray(list)) return ['signoff must be a list']
  if (list.length > SIGNOFF_MAX) return [`signoff has ${list.length} entries, at most ${SIGNOFF_MAX}`]
  const problems = []
  list.forEach((e, i) => {
    const at = `signoff #${i + 1}`
    if (!isObject(e)) return problems.push(`${at} must be a JSON object`)
    if (!isTime(e.at)) problems.push(`${at} at must be a time`)
    if (!SIGNOFF_DID.includes(e.did)) problems.push(`${at} did must be completed or uncompleted`)
  })
  return problems
}
