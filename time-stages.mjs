// Where one finished flow's time went, and how long it waited on the user: the per-flow half of the Pipeline time
// block (time-stats.mjs takes the medians over many flows). Like the scorecard (score.mjs) and its Log
// (score-log.mjs), EVERY number here is the gap between two times the flow file really stores. A stage whose ends
// are not both stored is left out of that stage for this flow (listed in `undated`), never guessed or borrowed.
//
//   stagesOf(flow, graph, { start, finish })   { times: { <stage key>: ms }, undated: [<stage key>] }
//   waitingOf(flow, { start, finish })         { ms } or null when a wait has no stored end or start
//
// THE STAGES (STAGES, in the order the bar draws them). A stage the flow never went through is simply absent.
//   planning    Coordinator and planner: from the flow's start (createdAt) to the planner's FIRST hand-out
//               (flow-plan.mjs: plan.history[].at, and plan.at once handed). Only on a flow the planner planned.
//   producing   Producer: from the hand-out (or the start, with no planner) to the first QA attempt's startedAt. With
//               no planner, the coordinator's hand-over to a producer has no time in the file, so that time counts
//               here. A flow with no QA record (no code to test) is the producer's until its first by-hand step was
//               written (hand-steps.mjs step.at), or Senior started on it, or, with neither, until it finished.
//   qa          QA: each attempt from its startedAt to its verdict (at), summed over every attempt.
//   security    Security (only with Security on the graph, score.mjs securityOn): from QA's pass of an attempt to
//               Security's verdict on it, summed over the reviewed attempts.
//   human       Human task: from the first by-hand step written to Senior starting its first review, or with no
//               Senior review, to the last tick (done.at). Every step must be ticked with a time.
//   senior      Senior (only with Senior on the graph, and no QA record): each review from startedAt to its verdict.
//   rework      Reworks: from each failure verdict (QA's, Security's on that attempt, or Senior's) to the next attempt
//               or review starting. The fix and the wait for it, back with the producer or the user.
// ⚠️ A stage counts whole or not at all: one attempt with a missing time leaves QA out for that flow, since a sum
// with a hole in it would read shorter than it was. A gap that ran backwards (end before start) is undated too.
// Not stages: the wait between a QA pass and the push (pushedAt), since the scorecard counts the delivery at the
// verdict and the push comes after it; and the gap between the last tick and Senior starting, which no box owns.
//
// WAITING ON THE USER: each question from when it was asked (the ask's `at`) to its answer (answeredAt), and each
// by-hand step from when it was written to its tick, overlaps counted once and clipped to the flow's start and
// finish. A flow with no question and no by-hand step waited 0, a real zero. One wait with a missing end or start
// (an ask from before asks carried a time, a question never answered) makes the whole flow undated: null.
//
// ⚠️ PURE like score.mjs: no file, no git, no config.

import { FAILED, SECURITY_FAILED, SENIOR_FAILED, securityOn, securityVerdictsOf, seniorOn, seniorVerdictsOf, verdictsOf } from './score.mjs'
import { handSteps } from './pipeline-hand.mjs'

export const STAGES = Object.freeze([
  Object.freeze({ key: 'planning', label: 'Coordinator and planner' }),
  Object.freeze({ key: 'producing', label: 'Producer' }),
  Object.freeze({ key: 'qa', label: 'QA' }),
  Object.freeze({ key: 'security', label: 'Security' }),
  Object.freeze({ key: 'human', label: 'Human task' }),
  Object.freeze({ key: 'senior', label: 'Senior' }),
  Object.freeze({ key: 'rework', label: 'Reworks' }),
])

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
/** The gap from `a` to `b` in ms, or null when either is missing or it runs backwards. */
const gap = (a, b) => (a === null || b === null || b < a ? null : b - a)
/** The sum of `gaps`, or null when any one is null (a stage counts whole or not at all). */
const sum = gaps => (gaps.some(g => g === null) ? null : gaps.reduce((t, g) => t + g, 0))
const earliest = times => (times.length ? Math.min(...times) : null)

/** The planner's first hand-out time, or null: every dated hand-out in its history, and the current one once handed. */
function firstHandOut(plan) {
  const all = [...(Array.isArray(plan.history) ? plan.history.filter(isObject) : []), ...(plan.status === 'handed' ? [plan] : [])]
  return earliest(all.map(h => timeOf(h.at)).filter(t => t !== null))
}

/** Each stage of one finished flow that the file can date, and those it went through but cannot. */
export function stagesOf(flow, graph, { start = null, finish = null } = {}) {
  const times = {}
  const undated = []
  const put = (key, ms) => (ms === null ? undated.push(key) : (times[key] = ms))
  const hasQa = isObject(flow?.qa)
  const verdicts = hasQa ? verdictsOf(flow) : []
  const reviews = hasQa && securityOn(graph) ? securityVerdictsOf(flow) : []
  const seniors = !hasQa && seniorOn(graph) ? seniorVerdictsOf(flow) : []
  const steps = handSteps(flow)

  // with the coordinator and planner: only on a flow the planner planned
  const handOut = isObject(flow?.plan) ? firstHandOut(flow.plan) : null
  if (isObject(flow?.plan)) put('planning', gap(start, handOut))
  const workStart = handOut ?? start

  // with the producer: to the first QA attempt, else to the first by-hand step or Senior review, else to the finish
  const firstStep = earliest(steps.map(s => timeOf(s.at)).filter(t => t !== null))
  const firstReview = seniors[0]?.startedAt ?? null
  if (hasQa) put('producing', gap(workStart, verdicts[0]?.startedAt ?? null))
  else if (steps.length) put('producing', steps.every(s => timeOf(s.at) !== null) ? gap(workStart, firstStep) : null)
  else if (seniors.length) put('producing', gap(workStart, firstReview))
  else put('producing', gap(workStart, finish))

  if (verdicts.length) put('qa', sum(verdicts.map(v => gap(v.startedAt, v.at))))
  if (reviews.length) put('security', sum(reviews.map(r => gap(verdicts.find(v => v.attempt === r.attempt)?.at ?? null, r.at))))

  if (steps.length) {
    const ticks = steps.map(s => (isObject(s.done) ? timeOf(s.done.at) : null))
    const end = seniors.length ? firstReview : ticks.some(t => t === null) ? null : Math.max(...ticks)
    put('human', steps.every(s => timeOf(s.at) !== null) ? gap(firstStep, end) : null)
  }
  if (seniors.length) put('senior', sum(seniors.map(v => gap(v.startedAt, v.at))))

  // reworks: each failure to the next attempt (QA) or review (Senior) starting
  const reworks = []
  verdicts.forEach((v, i) => {
    const r = reviews.find(x => x.attempt === v.attempt)
    const failedAt = FAILED.has(v.status) ? v.at : r && SECURITY_FAILED.has(r.status) ? r.at : undefined
    if (failedAt === undefined || i === verdicts.length - 1) return
    reworks.push(gap(failedAt, verdicts[i + 1].startedAt))
  })
  seniors.forEach((v, i) => {
    if (SENIOR_FAILED.has(v.status) && i < seniors.length - 1) reworks.push(gap(v.at, seniors[i + 1].startedAt))
  })
  if (reworks.length) put('rework', sum(reworks))
  return { times, undated }
}

/** The time one finished flow waited on the user, overlaps once, clipped to its start and finish; null when undated. */
export function waitingOf(flow, { start = null, finish = null } = {}) {
  const spans = []
  for (const n of Array.isArray(flow?.nodes) ? flow.nodes : []) {
    if (!isObject(n) || n.type !== 'ask') continue
    const from = timeOf(n.at)
    const to = n.answer == null ? null : timeOf(n.answeredAt)
    if (from === null || to === null) return null
    spans.push([from, to])
  }
  for (const s of handSteps(flow)) {
    const from = timeOf(s.at)
    const to = isObject(s.done) ? timeOf(s.done.at) : null
    if (from === null || to === null) return null
    spans.push([from, to])
  }
  const clipped = spans
    .map(([a, b]) => [start === null ? a : Math.max(a, start), finish === null ? b : Math.min(b, finish)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  let ms = 0
  let end = -Infinity
  for (const [a, b] of clipped) {
    if (b <= end) continue
    ms += b - Math.max(a, end)
    end = b
  }
  return { ms }
}
