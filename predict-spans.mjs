// Who worked on a flow, and when: each agent's SPANS on one flow, for placing the transcripts' tokens on it
// (predict-flow-tokens.mjs). Built like Pipeline time's stages (time-stages.mjs): only from times the flow file really
// stores, never guessed. A span whose ends the file cannot date is left out, so its tokens stay unplaced.
//
//   agentSpans(flow, graph, { now, stallMs })   [{ label, from, to }] in ms, every span inside the flow's own life
//   lifeOf(flow, graph, { now, stallMs })       { start, end }: the flow's start (createdAt) and the end of its work
//
// THE SPANS (labels are the graph's, so they match the session labels Pipeline tokens uses)
//   the planner    from the start to its first hand-out (flow-plan.mjs), or to the end while it is still planning
//   the owner      the flow's agent: from the hand-out (or the start) to the first QA attempt starting; with no QA
//                  record to its first by-hand step, or Senior's first review, or the end. The chat agent's own
//                  flow is all its own: start to end
//   QA             each attempt from its startedAt to its verdict, the attempt under way to the end
//   Security       each reviewed attempt from QA's pass to its verdict, a review under way to the end
//   reworks        each failure (QA's, or Security's on that attempt) to the next attempt starting, with whoever it
//                  went back to (rework.to), else with the agent whose work it was; the one under way to the end
//   Senior         each review from its startedAt to its verdict, a review under way to the end
// The Human task is the user, not an agent: no span. The coordinator has a span only on a flow it owns: handing a
// request on leaves no time in the file.
//
// THE END of a flow's work: when the scorecard counts it finished, dropped or stopped (score.mjs cellOf); an open
// flow the user archived, at archivedAt; an open flow left with no update for the stall time (a week by default, the
// score's own rule), at its last update, so a forgotten flow does not take a share of everything its agent does after;
// any other open flow, now.
// ⚠️ PURE: no file, no clock (now is passed in), no config.

import { DAY, cellOf, verdictsOf } from './score.mjs'
import { handSteps } from './pipeline-hand.mjs'

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
const FAILED = new Set(['failed', 'qa-failed'])
const SEC_FAILED = new Set(['failed', 'security-failed'])

/** The flow's start and the end of its work (the rules above); start null when it has no createdAt. */
export function lifeOf(flow, graph, { now = Date.now(), stallMs = 7 * DAY } = {}) {
  const start = timeOf(flow?.createdAt)
  const updated = timeOf(flow?.updatedAt)
  let end = now
  let c = null
  try {
    c = cellOf(flow, graph, now, stallMs)
  } catch {
    c = null
  }
  if (c?.why === 'stalled') end = updated ?? now
  else if (c?.cell && Number.isFinite(c.time)) end = c.time
  else if (flow?.status === 'done' || flow?.status === 'dropped') end = updated ?? now
  else if (timeOf(flow?.archivedAt) !== null) end = timeOf(flow.archivedAt)
  return { start, end: Math.min(end, now) }
}

/** The planner's first hand-out time (as time-stages.mjs firstHandOut), or null. */
function firstHandOut(plan) {
  const all = [...(Array.isArray(plan.history) ? plan.history.filter(isObject) : []), ...(plan.status === 'handed' ? [plan] : [])]
  const times = all.map(h => timeOf(h.at)).filter(t => t !== null)
  return times.length ? Math.min(...times) : null
}

export function agentSpans(flow, graph, opts = {}) {
  const { start, end } = lifeOf(flow, graph, opts)
  if (start === null || end === null || end <= start) return []
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const roleLabel = role => nodes.find(n => n.role === role)?.label ?? null
  const owner = isText(flow.agent) ? flow.agent : roleLabel('coordinator') || 'Unknown'
  const spans = []
  const put = (label, from, to) => {
    if (!isText(label) || from === null || to === null) return
    const a = Math.max(from, start)
    const b = Math.min(to, end)
    if (b > a) spans.push({ label, from: a, to: b })
  }

  // the chat agent's own flow: it answers from the request to the end, with nobody else on it
  if (nodes.some(n => n.role === 'chat' && n.label === owner)) {
    put(owner, start, end)
    return spans
  }

  const plan = isObject(flow.plan) ? flow.plan : null
  const handOut = plan ? firstHandOut(plan) : null
  const planner = roleLabel('planner')
  if (plan && planner && planner !== owner) put(planner, start, handOut ?? end)
  const workStart = plan ? handOut : start

  // the owner, to the first QA attempt (or the first by-hand step, or Senior's first review, or the end)
  const hasQa = isObject(flow.qa)
  const attempts = hasQa ? [...(Array.isArray(flow.qa.attempts) ? flow.qa.attempts.filter(isObject) : []), flow.qa] : []
  const steps = handSteps(flow)
  const senior = isObject(flow.senior) ? flow.senior : null
  const seniorPast = senior && Array.isArray(senior.history) ? senior.history.filter(isObject) : []
  const reviews = senior ? [...seniorPast, senior].filter(r => timeOf(r.startedAt) !== null) : []
  const firstStep = steps.map(s => timeOf(s.at)).filter(t => t !== null)
  let ownerEnd = end
  if (hasQa) ownerEnd = timeOf(attempts[0].startedAt) ?? timeOf(attempts[0].at)
  else if (firstStep.length) ownerEnd = Math.min(...firstStep)
  else if (reviews.length) ownerEnd = timeOf(reviews[0].startedAt)
  if (workStart !== null) put(owner, workStart, ownerEnd)

  // QA: each attempt, the one under way to the end
  const qaLabel = roleLabel('qa')
  attempts.forEach((a, i) => {
    const last = i === attempts.length - 1
    // a test under way runs to the end (its `at` is when it started, not a verdict); a pending one has not started
    if (a.status === 'pending') return
    put(qaLabel, timeOf(a.startedAt), a.status === 'testing' ? (last ? end : null) : timeOf(a.at))
  })

  // Security: from QA's pass of an attempt to its verdict, the review under way to the end
  const secLabel = roleLabel('security')
  attempts.forEach((a, i) => {
    if (a.status !== 'passed' || !isObject(a.security)) return
    const last = i === attempts.length - 1
    const done = a.security.status === 'passed' || SEC_FAILED.has(a.security.status)
    put(secLabel, timeOf(a.at), done ? timeOf(a.security.at) : last ? end : null)
  })

  // reworks: each failure to the next attempt starting, with whoever it went back to
  const verdicts = hasQa ? verdictsOf(flow) : []
  attempts.forEach((a, i) => {
    const qaFailed = FAILED.has(a.status)
    const secFailed = a.status === 'passed' && isObject(a.security) && SEC_FAILED.has(a.security.status)
    if (!qaFailed && !secFailed) return
    const back = qaFailed ? a.rework?.to : a.security.rework?.to
    const label = isText(back) ? back : verdicts[i]?.agent || owner
    const from = qaFailed ? timeOf(a.at) : timeOf(a.security.at)
    const next = attempts[i + 1]
    // a stop (qa-failed with nowhere to go, the flow blocked) on the last attempt waits on the user: no agent span
    if (!next && !isText(back)) return
    put(label, from, next ? timeOf(next.startedAt) ?? timeOf(next.at) : end)
  })

  // Senior: each review, the one under way to the end
  const seniorLabel = roleLabel('senior')
  reviews.forEach((r, i) => {
    const last = i === reviews.length - 1
    put(seniorLabel, timeOf(r.startedAt), r.status === 'reviewing' ? (last ? end : null) : timeOf(r.at))
  })
  return spans
}
