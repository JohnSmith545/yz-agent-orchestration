// The orchestration log: ONE timeline of what happened to every flow, built from what the flow files really hold,
// each event marked with the scorecard cell (score.mjs) it put a count in, so a reader can see which events each
// score was counted from.
//
//   orchestrationLog(flows, graph, { now, days, stallDays, extra }) -> [{ at, kind, flow: { id, title } | null,
//                                                                         agent, text, cell }], newest first
//
// THE KINDS, each dated by a time the flow file stores, never a guessed one:
//   started   the flow was created (createdAt)
//   route     its route was planned or changed (route.at, and each route.history entry's at)
//   handed    work handed to QA: a QA attempt started (that attempt's startedAt)
//   passed, failed   each verdict, earlier attempts included (the attempt's at); a failure says who it went back to
//   pushed    QA pushed the commit it tested (pushedAt)
//   done      finished with no QA record: delivered with no code changes, or slipped through with code (updatedAt:
//             the file holds no time of its own for the status change, and the scorecard counts it at this time)
//   dropped   dropped (updatedAt, for the same reason)
//   stopped   QA stopped the flow: it will not reach the Output (the final verdict's time). New beside the verdict:
//             a stopped flow puts TWO counts in, its last failure (caught) and the flow itself (missed)
//   stalled   on its way with no update for stallDays (updatedAt + stallDays, as the scorecard counts it)
//   rule      from `extra` only (another store's rule changes), merged by time
// SIGN_OFF_KINDS, the user's own, never a count:
//   completed    the user marked the finished flow completed (completedAt, completed.mjs), by You
//   uncompleted  the user took that mark off in the flow archive (uncompletedAt: the last time only), by You
// GATE_KINDS, only on a pipeline with the planner or Security (pipeline.mjs gateLabels), their own kinds:
//   security  each Security verdict (flow-security.mjs, the verdict's at): a failure says who it went back to and is
//             a catch, like a QA failure; the final pass carries the delivered cell (with Security on the graph a QA
//             pass carries none: score.mjs cellOf counts the flow at Security's verdict)
//   planned   the planner handed the flow to a producer with a plan (flow-plan.mjs, each hand-out's at)
//   senior    Senior's work on a no-code flow (flow-senior.mjs), on a pipeline with Senior: each review it started
//             (startedAt) and each verdict (at). A failure went back to Human task and is a catch; the final pass
//             carries the delivered cell (score.mjs cellOf counts a flow Senior gates at its pass)
// LEFT OUT: push-refused. The file keeps the refusal's text (qa.pushError) but no time for it, so it is never shown.
// An attempt with no startedAt has no `handed` event; a verdict with no `at` has no event and no count.
//
// THE CELL, delivered | caught | missed | slipped | null, sits on the SAME event that puts the count in that cell:
// every failure verdict is a catch, and the flow cells come from score.mjs cellOf (its kind and time), never a second
// copy of the rules. So summing the cells of the events in a window gives exactly scoreOf's counts for that window
// (test/score-log.test.mjs checks this on fixtures and on the real flows). An `extra` event never carries a cell.
//
// `text` is one plain sentence with agent labels only: no ids, no file names. Ties in time keep the order things
// happen in (a verdict before the stop it causes), newest first. ⚠️ PURE like score.mjs: no file, no git, no config.

import { DAY, FAILED, SECURITY_FAILED, SENIOR_FAILED, cellOf, securityOn, securityVerdictsOf, seniorApplies, seniorOn, seniorVerdictsOf, verdictsOf, windowOf } from './score.mjs'

export const LOG_KINDS = Object.freeze(['started', 'route', 'handed', 'passed', 'failed', 'pushed', 'done', 'dropped', 'stopped', 'stalled', 'rule'])
/** The kinds of the optional agents (above): kept apart so a pipeline without them reads exactly as before. */
export const GATE_KINDS = Object.freeze(['security', 'planned', 'senior'])
/** The graph role each gate kind needs: its kind is offered only on a pipeline with that agent (score-routes.mjs). */
export const GATE_ROLE = Object.freeze({ security: 'security', planned: 'planner', senior: 'senior' })
/** The user's sign-off (completed.mjs): kept apart from LOG_KINDS, so the log of a flow never completed reads exactly as before. */
export const SIGN_OFF_KINDS = Object.freeze(['completed', 'uncompleted'])
export const LOG_CELLS = Object.freeze(['delivered', 'caught', 'missed', 'slipped'])

const ROUTE_WORD = { build: 'a code change', review: 'a code review', ask: 'a question' }
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
/** 'A', 'A and B', 'A, B and C'. */
const listed = words => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`)

/** The route events of a flow: the earliest planned, each later one a change. */
function routeEvents(flow, labels, add) {
  const r = flow.route
  if (!isObject(r)) return
  const all = [...(Array.isArray(r.history) ? r.history.filter(isObject) : []), r]
  all.forEach((x, i) => {
    const at = timeOf(x.at)
    if (at === null) return
    const by = isText(x.by) ? x.by : 'An agent'
    const what = ROUTE_WORD[x.type] || 'a request'
    const through = (Array.isArray(x.steps) ? x.steps : []).filter(s => s !== 'request' && s !== 'outcome').map(s => labels.get(s) || s)
    const via = through.length ? `, through ${listed(through)}` : ''
    add(at, 'route', by, i === 0 ? `${by} planned this as ${what}${via}.` : `${by} changed the plan to ${what}${via}.`)
  })
}

/** The planner's hand-outs of a flow (flow-plan.mjs): the earlier ones in its history, then the current one. */
function planEvents(flow, add) {
  const p = flow.plan
  if (!isObject(p)) return
  const all = [...(Array.isArray(p.history) ? p.history.filter(isObject) : []), ...(p.status === 'handed' ? [p] : [])]
  for (const h of all) {
    const at = timeOf(h.at)
    if (at === null || !isText(h.to)) continue
    const by = isText(h.by) ? h.by : 'The planner'
    add(at, 'planned', by, `${by} handed this to ${h.to}, with a plan.`)
  }
}

/** Every event of one flow, oldest first (by generation, which sorting keeps for ties). */
function flowEvents(flow, graph, now, stallMs, labels, qaLabel, securityLabel, seniorLabel, push) {
  const ref = { id: flow.id, title: isText(flow.title) ? flow.title : flow.id }
  const owner = isText(flow.agent) ? flow.agent : null
  const add = (at, kind, agent, text, cell = null) => push({ at, kind, flow: ref, agent, text, cell })
  const started = timeOf(flow.createdAt)
  if (started !== null) add(started, 'started', owner, owner ? `${owner} started this.` : 'This was started.')
  routeEvents(flow, labels, add)
  planEvents(flow, add)

  const { cell, kind, time } = cellOf(flow, graph, now, stallMs)
  const verdicts = verdictsOf(flow)
  const reviews = securityOn(graph) ? securityVerdictsOf(flow) : [] // Security off the graph: its data is not shown
  verdicts.forEach((v, i) => {
    const qa = v.by || qaLabel
    if (v.startedAt !== null) add(v.startedAt, 'handed', v.agent, i === 0 ? `${v.agent} handed this to QA.` : `${v.agent} handed this to QA again, for attempt ${v.attempt}.`)
    if (v.at !== null && FAILED.has(v.status)) add(v.at, 'failed', qa, v.backTo ? `${qa} failed this and sent it back to ${v.backTo}.` : `${qa} failed this.`, 'caught')
    if (v.at !== null && v.status === 'passed') {
      const final = i === verdicts.length - 1 && kind === 'passed'
      add(v.at, 'passed', qa, v.attempt > 1 ? `${qa} passed this on attempt ${v.attempt}.` : `${qa} passed this.`, final ? cell : null)
    }
    // Security's verdict on this attempt, after QA's: a failure is a catch; the final pass carries the flow's cell
    const r = reviews.find(x => x.attempt === v.attempt)
    if (r && r.at !== null) {
      const who = r.by || securityLabel
      const failed = SECURITY_FAILED.has(r.status)
      const text = failed ? (r.backTo ? `${who} failed this and sent it back to ${r.backTo}.` : `${who} failed this.`) : `${who} passed this.`
      add(r.at, 'security', who, text, failed ? 'caught' : i === verdicts.length - 1 && kind === 'security' ? cell : null)
    }
    if (v.pushedAt !== null) add(v.pushedAt, 'pushed', qa, `${qa} pushed the change it tested.`)
  })
  // Senior's reviews of work done by hand (no QA record: code is QA's), oldest first; off the graph: not shown
  const senior = seniorOn(graph) && !isObject(flow.qa) ? seniorVerdictsOf(flow) : []
  const review = isObject(flow.senior) && flow.senior.status === 'reviewing' && seniorOn(graph) && !isObject(flow.qa) ? flow.senior : null
  senior.forEach((v, i) => {
    const who = v.by || seniorLabel
    if (v.startedAt !== null) add(v.startedAt, 'senior', who, `${who} started reviewing the work done by hand.`)
    if (v.at === null) return
    const failed = SENIOR_FAILED.has(v.status)
    const text = v.status === 'failed' ? `${who} failed this and sent it back to Human task.` : failed ? `${who} failed this.` : `${who} passed the work done by hand.`
    add(v.at, 'senior', who, text, failed ? 'caught' : i === senior.length - 1 && kind === 'senior' ? cell : null)
  })
  if (review && timeOf(review.startedAt) !== null) {
    const who = isText(review.by) ? review.by : seniorLabel
    add(timeOf(review.startedAt), 'senior', who, `${who} started reviewing the work done by hand.`)
  }

  // the user's sign-off: never a cell, and completing moves no other event (completed-routes.mjs keeps updatedAt)
  const signed = timeOf(flow.completedAt)
  if (signed !== null) add(signed, 'completed', 'You', 'You marked this completed.')
  const unsigned = timeOf(flow.uncompletedAt)
  if (unsigned !== null) add(unsigned, 'uncompleted', 'You', 'You took the completed mark off.')

  // the flow's own cell event (a pass already carries its cell above)
  if (time === null || kind === null || kind === 'passed' || kind === 'security' || kind === 'senior') return
  const lastReview = reviews.at(-1)
  const stoppedBySecurity = kind === 'stopped' && lastReview && SECURITY_FAILED.has(lastReview.status) && lastReview.attempt === verdicts.at(-1)?.attempt
  const stoppedBySenior = kind === 'stopped' && senior.at(-1)?.status === 'senior-failed'
  const qa = stoppedBySenior ? senior.at(-1).by || seniorLabel : stoppedBySecurity ? lastReview.by || securityLabel : verdicts.at(-1)?.by || qaLabel
  const untested = verdicts.at(-1)?.status === 'passed' ? `${securityLabel} never passed` : 'QA never tested'
  const byHand = seniorApplies(flow, graph) // a flow Senior gates that slipped: it finished before Senior passed it
  const TEXT = {
    done: cell === 'slipped' ? (byHand && !verdicts.length ? `This finished by hand before ${seniorLabel} passed it.` : `This finished with code changes that ${untested}.`) : 'This finished with no code changes.',
    dropped: 'This was dropped.',
    stopped: `${qa} stopped this, so it will not reach the Output.`,
    stalled: `This had no update for ${Math.round(stallMs / DAY)} days.`,
  }
  add(time, kind, kind === 'stopped' ? qa : owner, TEXT[kind], cell)
}

/** The log over the last `days` days (null: all time) up to `now`, newest first. */
export function orchestrationLog(flows, graph, { now = Date.now(), days = 30, stallDays = 7, extra = [] } = {}) {
  const win = windowOf(now, days, stallDays)
  const stallMs = stallDays * DAY
  const labels = new Map((graph?.nodes || []).map(n => [n.id, n.label]))
  const qaLabel = (graph?.nodes || []).find(n => n.role === 'qa')?.label || 'QA'
  const securityLabel = (graph?.nodes || []).find(n => n.role === 'security')?.label || 'Security'
  const seniorLabel = (graph?.nodes || []).find(n => n.role === 'senior')?.label || 'Senior'
  const out = []
  let seq = 0
  const push = e => {
    if (win.has(e.at)) out.push({ ...e, seq: seq++ })
  }
  for (const flow of Array.isArray(flows) ? flows : []) {
    if (!isObject(flow) || !isText(flow.id)) continue
    flowEvents(flow, graph, now, stallMs, labels, qaLabel, securityLabel, seniorLabel, push)
  }
  for (const e of Array.isArray(extra) ? extra : []) {
    if (!isObject(e)) continue
    const at = timeOf(e.at)
    if (at === null) continue
    push({ at, kind: isText(e.kind) ? e.kind : 'rule', flow: isObject(e.flow) ? e.flow : null, agent: isText(e.agent) ? e.agent : null, text: isText(e.text) ? e.text : '', cell: null })
  }
  return out
    .sort((a, b) => b.at - a.at || b.seq - a.seq)
    .map(({ seq: _, at, ...e }) => ({ at: new Date(at).toISOString(), kind: e.kind, flow: e.flow, agent: e.agent, text: e.text, cell: e.cell }))
}
