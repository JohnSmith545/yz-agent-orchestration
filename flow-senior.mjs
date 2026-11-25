// Senior, the data half. Senior (config pipeline.senior, pipeline.mjs) sits after the Human task box: it reviews
// work that has NO code to test (CI/CD setup, cloud console changes, commands run in a terminal, settings in a
// third-party account), done by the user from the flow's by-hand steps (hand-steps.mjs) or by an agent's own tools.
// It reads, asks for evidence and gives a verdict; it never changes a live project itself (docs/senior-agent-brief.md).
// Its record is `flow.senior`:
//
//   flow.senior = {
//     status     due | asked | reviewing | passed | failed | senior-failed (failed too often: stopped, the flow blocked)
//                | released.  due: THE HOLD, recorded by the store (flows.mjs writeFlow) the moment the flow has by-hand
//                steps while Senior is configured (QA 2026-11-25 B-1: a hold read off the steps an agent could clear was
//                no hold). Every write keeps the stored record, so clearing or dropping the steps never lifts it: only
//                Senior's pass, or the user's release on the dashboard (released, human-routes.mjs seniorReleaseRoute:
//                the flow is done, and the scorecard counts it slipped through, since nobody reviewed it).
//     by, at     who wrote the record last (the asking agent for `asked`, else Senior's label) and when
//     startedAt  when Senior started its review
//     ask        { text, by, at }: `flow senior-ask`, an agent sending a no-code flow to Senior on purpose
//     summary    the verdict in one plain paragraph: what was checked, or what to redo (at most 1000 characters)
//     redo       on a failure, the by-hand step ids Senior unticked (every step when it named none)
//     history    the earlier FAILED verdicts, oldest first ({ status, by, startedAt?, at, summary, redo }), at most 20
//   }
//
// A failure goes back to the Human task box (the user), not to a producer: its summary shows at the top of the
// flow's by-hand checklist (public/flow-hand.js) and in Human review (human.mjs), and the steps it names wait to be
// ticked again. Senior failures share pipeline.maxReworks (failuresSoFar). Only the Senior commands
// (tools/senior-cli.mjs) write this block, and a rewrite of the flow keeps the stored one (keepSenior). A flow on the
// QA path (it has a `qa` record) is never Senior's. Pure: no file access, no git.

import { handSteps } from './pipeline-hand.mjs'

export const SENIOR_STATUS = Object.freeze(['due', 'asked', 'reviewing', 'passed', 'failed', 'senior-failed', 'released'])
/** The statuses that no longer hold the flow: Senior passed it, stopped it (the user decides), or the user released it. */
export const SENIOR_FREE = Object.freeze(['passed', 'senior-failed', 'released'])
export const SENIOR_MAX = Object.freeze({ summary: 1000, ask: 500, history: 20 })

/** MUST CHANGE IN LOCKSTEP with flows.mjs AGENT_LABEL. */
const LABEL = /^[A-Za-z0-9 ._-]{1,40}$/
const STEP_ID = /^[a-z0-9-]+$/
/** MUST CHANGE IN LOCKSTEP with flows.mjs ISO_TIME. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
const isTime = v => typeof v === 'string' && ISO_TIME.test(v) && !Number.isNaN(Date.parse(v))
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''

/** The problems of one verdict's common fields, each line starting with `at`. */
function verdictProblems(v, at) {
  const problems = []
  if (v.by !== undefined && !(typeof v.by === 'string' && LABEL.test(v.by))) problems.push(`${at} by must be a label of 1 to 40 letters, digits, spaces, dots, dashes or underscores`)
  for (const key of ['at', 'startedAt']) if (v[key] != null && !isTime(v[key])) problems.push(`${at} ${key} must be a time`)
  if (v.summary != null && !(typeof v.summary === 'string' && v.summary.length <= SENIOR_MAX.summary)) problems.push(`${at} summary must be text of at most ${SENIOR_MAX.summary} characters`)
  if (v.redo != null && !(Array.isArray(v.redo) && v.redo.every(id => typeof id === 'string' && STEP_ID.test(id)))) problems.push(`${at} redo must be a list of by-hand step ids`)
  return problems
}

/** Every problem with a flow's `senior` block, one line each; [] when it is valid. */
export function validateSenior(s) {
  if (!isObject(s)) return ['senior must be a JSON object']
  const problems = []
  if (!SENIOR_STATUS.includes(s.status)) problems.push(`senior status must be one of ${SENIOR_STATUS.join(', ')}`)
  problems.push(...verdictProblems(s, 'senior'))
  if (s.ask != null) {
    const a = s.ask
    if (!isObject(a)) problems.push('senior ask must be null or a JSON object')
    else {
      if (!(isText(a.text) && a.text.length <= SENIOR_MAX.ask)) problems.push(`senior ask text must say what to review, in at most ${SENIOR_MAX.ask} characters`)
      if (!(typeof a.by === 'string' && LABEL.test(a.by))) problems.push('senior ask by must be the label of the agent that asked')
      if (!isTime(a.at)) problems.push('senior ask at must be a time')
    }
  }
  if (s.history !== undefined) {
    if (!Array.isArray(s.history)) problems.push('senior history must be a list of the earlier failed verdicts')
    else {
      if (s.history.length > SENIOR_MAX.history) problems.push(`senior history keeps at most ${SENIOR_MAX.history} verdicts`)
      s.history.forEach((h, i) => {
        if (!isObject(h) || h.status !== 'failed') return problems.push(`senior history #${i + 1} must be a failed verdict`)
        problems.push(...verdictProblems(h, `senior history #${i + 1}`))
      })
    }
  }
  return problems
}

/** For mergeKeepingAnswers (flows.mjs): only the Senior commands write `senior`, so a rewrite keeps the stored one. */
export function keepSenior(incoming, existing) {
  if (existing?.senior !== undefined) incoming.senior = existing.senior
  else delete incoming.senior
  return incoming
}

/** A failed verdict as history keeps it. */
export const asPast = s => ({ status: 'failed', by: s.by, ...(s.startedAt ? { startedAt: s.startedAt } : {}), at: s.at, summary: s.summary ?? '', redo: Array.isArray(s.redo) ? s.redo : [] })

/** The record's earlier failed verdicts, plus the current one when it is a failure: what moves into history next. */
export function failedSoFar(s) {
  if (!isObject(s)) return []
  const past = Array.isArray(s.history) ? s.history.filter(h => isObject(h) && h.status === 'failed') : []
  return s.status === 'failed' ? [...past, asPast(s)] : past
}

/** How many times Senior sent a flow back: every failed verdict, the current one included. */
export const failuresSoFar = s => failedSoFar(s).length + (s?.status === 'senior-failed' ? 1 : 0)

/** The failure the user is asked to redo now (status failed), or null: { summary, redo, by, at }. */
export function pendingRedo(flow) {
  const s = flow?.senior
  return isObject(s) && s.status === 'failed' ? { summary: s.summary ?? '', redo: Array.isArray(s.redo) ? s.redo : [], by: s.by || '', at: s.at || '' } : null
}

/**
 * Why the user may not mark a flow done yet because of Senior, in one line, or '': Senior is on `graph`, the flow has
 * no QA record, it has by-hand steps or a Senior record, and Senior has not passed it (nor stopped it: then the user
 * decides). The store asks this on every move to done (flows.mjs writeFlow), so no writer, the flow page's Mark the flow
 * done or an agent's flow set and flow write alike, can finish a flow round Senior.
 */
export function seniorHolds(flow, graph) {
  const senior = (graph?.nodes || []).find(n => n.role === 'senior')
  if (!senior || isObject(flow?.qa)) return ''
  const s = isObject(flow?.senior) ? flow.senior : null
  if (SENIOR_FREE.includes(s?.status)) return ''
  const steps = handSteps(flow).length
  if (!s && !steps) return ''
  // sent on purpose with no steps: it is a change an agent made, not work done by hand (QA B-9)
  if (!steps && isObject(s?.ask) && s.status !== 'due') return `${senior.label} reviews the change sent with senior-ask before the flow is done: send ${senior.label} a message naming flow ${flow.id}.`
  return `${senior.label} reviews the work done by hand before the flow is done: send ${senior.label} a message naming flow ${flow.id}.`
}

/**
 * For writeFlow (flows.mjs), the store's half of the hold: the stored record when the write has none (a rewrite or
 * an agent's file never drops it), then a `due` record when Senior is on `graph`, the flow has by-hand steps, no QA
 * record and no record yet. A flow that was done already and stays done gets none: it finished before Senior held it.
 */
export function recordHold(flow, stored, graph) {
  if (isObject(stored?.senior) && flow.senior === undefined) flow.senior = stored.senior
  if (flow.senior !== undefined || isObject(flow.qa) || !handSteps(flow).length) return flow
  if (!(graph?.nodes || []).some(n => n.role === 'senior')) return flow
  if (stored?.status === 'done' && flow.status === 'done') return flow
  flow.senior = { status: 'due', at: new Date().toISOString() }
  return flow
}

/** One or two lines on Senior for `flow show` (stderr), or nothing when it has no record. */
export function seniorBlock(flow) {
  const s = flow?.senior
  if (!isObject(s)) return []
  const lines = [`  senior: ${s.status === 'due' ? 'due (Senior holds this flow until it passes it)' : s.status}${s.by ? ` (${s.by})` : ''}${failedSoFar(s).length ? `, sent back ${failedSoFar(s).length} time${failedSoFar(s).length === 1 ? '' : 's'}` : ''}`]
  if (isObject(s.ask) && s.status === 'asked') lines.push(`    asked by ${s.ask.by}: ${s.ask.text}`)
  if (isText(s.summary)) lines.push(`    ${s.status === 'failed' ? 'redo' : 'verdict'}: ${s.summary}${Array.isArray(s.redo) && s.redo.length ? ` (steps ${s.redo.join(', ')})` : ''}`)
  return lines
}
