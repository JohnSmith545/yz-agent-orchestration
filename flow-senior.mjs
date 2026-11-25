// Senior, the data half. Senior (config pipeline.senior, pipeline.mjs) sits after the Human task box: it reviews
// work that has NO code to test (CI/CD setup, cloud console changes, commands run in a terminal, settings in a
// third-party account), done by the user from the flow's by-hand steps (hand-steps.mjs) or by an agent's own tools.
// It reads, asks for evidence and gives a verdict; it never changes a live project itself (docs/senior-agent-brief.md).
// Its record is `flow.senior`:
//
//   flow.senior = {
//     status     asked | reviewing | passed | failed | senior-failed (failed too often: stopped, the flow blocked)
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

export const SENIOR_STATUS = Object.freeze(['asked', 'reviewing', 'passed', 'failed', 'senior-failed'])
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

/** One or two lines on Senior for `flow show` (stderr), or nothing when it has no record. */
export function seniorBlock(flow) {
  const s = flow?.senior
  if (!isObject(s)) return []
  const lines = [`  senior: ${s.status}${s.by ? ` (${s.by})` : ''}${failedSoFar(s).length ? `, sent back ${failedSoFar(s).length} time${failedSoFar(s).length === 1 ? '' : 's'}` : ''}`]
  if (isObject(s.ask) && s.status === 'asked') lines.push(`    asked by ${s.ask.by}: ${s.ask.text}`)
  if (isText(s.summary)) lines.push(`    ${s.status === 'failed' ? 'redo' : 'verdict'}: ${s.summary}${Array.isArray(s.redo) && s.redo.length ? ` (steps ${s.redo.join(', ')})` : ''}`)
  return lines
}
