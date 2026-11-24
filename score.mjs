// The pipeline's scorecard: precision, recall, F-score, accuracy and correctness, as a machine-learning model is
// scored, but for the whole orchestration (pipeline.mjs). The pipeline makes ONE call on each piece of work: let it
// through to the Output, or hold it back. Four counts, over a time window:
//
//                        the work was good                   the work was not good
//   went to the Output   RIGHT, DELIVERED                    WRONG, SLIPPED THROUGH
//                        a code flow QA passed (pushed or    a finished (done) code-producing flow with no QA
//                        not), or a finished flow with no    record at all: nobody tested it
//                        code changes
//   held back            WRONG, MISSED                       RIGHT, CAUGHT
//                        dropped; stopped at QA (qa-failed,  EACH QA failure verdict (failed or qa-failed), the
//                        or failed with no producer to go    earlier attempts and the current one: a count of
//                        back to); or stalled: on its way    verdicts, not of flows
//                        with no update for stallDays
//
// WITH SECURITY on the pipeline (config pipeline.security, flow-security.mjs), a code flow is DELIVERED only when QA
// and Security both passed it (counted at Security's verdict); one that FINISHED (done) without a Security pass
// SLIPPED THROUGH; one Security stopped (security-failed) is MISSED, stopped; and EACH Security failure verdict
// (failed or security-failed) is a CATCH, like a QA failure, against the work it reviewed. Without Security on the
// graph a QA pass is delivered as before and no Security verdict is counted, whatever the flow file holds.
// A flow that finished on a route planned BEFORE Security joined the pipeline is judged by QA alone (securityApplies):
// switching Security on never turns work delivered earlier into work that slipped through.
//
// Not counted: flows still on their way (open or blocked, waiting at QA, being tested, or sent back for a fix) that
// changed in the last stallDays (`inFlight`). Trashed flows have no file, so they never reach here; archived flows
// count like any other.
//
// THE WINDOW (days, or null for all time; returned as { days, from, stallDays }): a flow by its updatedAt; a verdict by its own time (`at`, else
// `startedAt`, else the flow's updatedAt); a stalled flow by the moment it stalled (updatedAt + stallDays), so the
// 7 day window still shows stalls (by updatedAt alone it never could, since a stall is 7 days old by definition).
// A flow or verdict with no readable time counts in the all-time window only. The edge is inclusive.
//
// THE SCORES, each { value, top, bottom } with value null when the bottom is 0 (the page says Not enough data yet):
//   precision    delivered / (delivered + slipped)
//   recall       delivered / (delivered + missed)
//   accuracy     (delivered + caught) / all four
//   f[1], f[4]   fBeta of precision and recall: { value, beta }; null when either is null
//   correctness  { value, right, judged }: of the flows QA gave a FINAL verdict on in the window (passed, or
//                stopped), those that passed with NO failure verdict anywhere in their history. A flow that passed,
//                then failed a later re-test, then passed again was not right the first time. With Security, the
//                final pass is QA's and Security's together, and a Security failure is a failure in that history.
// Per agent: `handed` QA attempts on that agent's work (attempt 1 is the flow's agent's; after a failure sent back
// with rework.to, the next attempt is that producer's), `sentBack` failure verdicts on that agent's attempts (their
// sum is `caught`), `firstTime` the flow agent's first-time-right flows (their sum is correctness.right).
//
// ⚠️ PURE like pipeline.mjs: no file, no git, no config (the route passes the flows and the graph). The wording in
// MEANING is the page's too: MUST CHANGE IN LOCKSTEP with public/score-view.js MEANING (a test compares them).
//
//   scoreOf(flows, graph, { now, days, stallDays })   the whole scorecard
//   securityVerdictsOf(flow)                          every Security verdict on a flow, oldest first
//   fBeta(p, r, beta)                                 the F-score of a precision and a recall
//   scoreText(score)                                  a few plain lines: the five scores with their counts

import { isCodeProducing, stageOf } from './pipeline.mjs'

export const DAY = 86_400_000
/** The failure verdicts: each one is a catch. */
export const FAILED = new Set(['failed', 'qa-failed'])
/** Security's failure verdicts (flow-security.mjs): each one is a catch too. */
export const SECURITY_FAILED = new Set(['failed', 'security-failed'])
const ON_ITS_WAY_AT_QA = new Set(['pending', 'testing'])

/** What each score means, in one plain sentence. MUST CHANGE IN LOCKSTEP with public/score-view.js MEANING. */
export const MEANING = Object.freeze({
  precision: 'Of everything delivered, how much was checked and right.',
  recall: 'Of everything that should have been delivered, how much was.',
  f: 'Precision and recall in one number.',
  accuracy: 'How often the pipeline made the right call.',
  correctness: 'How often the work was right the first time.',
})

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
const ratio = (top, bottom) => ({ value: bottom > 0 ? top / bottom : null, top, bottom })

/** The F-score of precision `p` and recall `r`: (1 + b²)·p·r / (b²·p + r). Null when either is missing; 0 when both are 0. */
export function fBeta(p, r, beta) {
  if (!Number.isFinite(p) || !Number.isFinite(r)) return null
  const b2 = beta * beta
  const bottom = b2 * p + r
  return bottom > 0 ? ((1 + b2) * p * r) / bottom : 0
}

/**
 * The window over `days` days up to `now` (null: all time): `from` in ms or null, `view` as the route returns it, and
 * `has(t)`: a time inside it. A missing time is never inside, all time included: what cannot be dated is not
 * counted, so the log (score-log.mjs) can place every count it shows.
 */
export function windowOf(now, days, stallDays = 7) {
  const from = Number.isFinite(days) && days > 0 ? now - days * DAY : null
  return {
    from,
    view: { days: from === null ? null : days, from: from === null ? null : new Date(from).toISOString(), stallDays },
    has: t => t !== null && (from === null || t >= from),
  }
}

/**
 * Every QA attempt on a flow, oldest first: { attempt, status, at, startedAt, pushedAt (ms or null), pushError, by,
 * backTo, agent }. `agent` is whose work the attempt tested; `backTo` the producer a failure went back to. Times are
 * the attempt's own, never borrowed from the flow.
 */
export function verdictsOf(flow) {
  const qa = flow?.qa
  if (!isObject(qa)) return []
  return attemptsOf(flow).map(({ a, i, agent }) => {
    const backTo = FAILED.has(a.status) && isText(a.rework?.to) ? a.rework.to : null
    return {
      attempt: Number.isInteger(a.attempt) ? a.attempt : i + 1, status: a.status, at: timeOf(a.at), startedAt: timeOf(a.startedAt),
      pushedAt: timeOf(a.pushedAt), pushError: isText(a.pushError) ? a.pushError : null, by: isText(a.by) ? a.by : null, backTo, agent,
    }
  })
}

/**
 * Each QA attempt of a flow, oldest first, as { a, i, agent }: `agent` whose work it tested, the flow's agent first,
 * then whoever a QA failure, or a Security failure of that attempt, went back to.
 */
function attemptsOf(flow) {
  const qa = flow.qa
  let agent = isText(flow.agent) ? flow.agent : 'Unknown'
  return [...(Array.isArray(qa.attempts) ? qa.attempts.filter(isObject) : []), qa].map((a, i) => {
    const out = { a, i, agent }
    const back = FAILED.has(a.status) ? a.rework?.to : SECURITY_FAILED.has(a.security?.status) ? a.security.rework?.to : null
    if (isText(back)) agent = back
    return out
  })
}

/**
 * Every Security verdict on a flow (flow-security.mjs qa.security, at most one per QA attempt), oldest first:
 * { attempt, status, at (ms or null), by, backTo, agent }, `agent` whose work it reviewed (that QA attempt's). A
 * review still going (reviewing) is no verdict and is left out.
 */
export function securityVerdictsOf(flow) {
  if (!isObject(flow?.qa)) return []
  return attemptsOf(flow).flatMap(({ a, i, agent }) => {
    const s = a.security
    if (!isObject(s) || !(s.status === 'passed' || SECURITY_FAILED.has(s.status))) return []
    const backTo = SECURITY_FAILED.has(s.status) && isText(s.rework?.to) ? s.rework.to : null
    return [{ attempt: Number.isInteger(a.attempt) ? a.attempt : i + 1, status: s.status, at: timeOf(s.at), by: isText(s.by) ? s.by : null, backTo, agent }]
  })
}

/** Whether the graph has Security between QA and Push (pipeline.mjs). Without it, Security data in a flow is not counted. */
export const securityOn = graph => (graph?.nodes || []).some(n => n.role === 'security')

/**
 * Whether Security's pass is part of what THIS flow needs to count as delivered. ⚠️ Turning Security on must not
 * rewrite the past: a flow that FINISHED on a route planned before Security existed (its stored route has no
 * Security step, and Security never reviewed it) is judged by QA alone, as it was when it finished. Without this,
 * every flow delivered before the switch would count as slipped through the day Security joins the pipeline.
 * A finished flow with no stored route at all is older still (every new flow gets a route), so it is judged the
 * same way. Security does apply to: a flow it reviewed (any attempt), a flow whose stored route goes through it,
 * and any flow still on its way (QA pushes only after Security passed, so it will be reviewed).
 */
export function securityApplies(flow, graph) {
  const id = (graph?.nodes || []).find(n => n.role === 'security')?.id
  if (!id) return false
  const qa = isObject(flow?.qa) ? flow.qa : null
  if (isObject(qa?.security) || (Array.isArray(qa?.attempts) ? qa.attempts : []).some(a => isObject(a?.security))) return true
  const steps = Array.isArray(flow?.route?.steps) ? flow.route.steps : []
  return steps.includes(id) || flow.status !== 'done'
}

/**
 * THE rule for the three flow cells, shared with the log: { cell: delivered | slipped | missed | null, why, kind,
 * time }. `why` (missed only) is dropped | stopped | stalled; `kind` is the log event that puts the flow in its cell
 * (passed, done, dropped, stopped, stalled), and `time` is that event's time: the final verdict for a flow QA passed
 * or stopped, the stall moment for a stalled one, the flow's last update for the rest. A flow on its way has cell
 * null. Mirrors pipeline.mjs stageOf, which decides stopped at QA versus sent back. ⚠️ score-log.mjs builds its
 * cell events from this and nothing else: never a second copy of these rules.
 */
export function cellOf(flow, graph, now, stallMs) {
  const updated = timeOf(flow.updatedAt)
  const out = (cell, kind, time, why = null) => ({ cell, why, kind, time })
  if (flow.status === 'dropped') return out('missed', 'dropped', updated, 'dropped')
  const qa = isObject(flow.qa) ? flow.qa : null
  const last = () => verdictsOf(flow).at(-1)?.at ?? null
  if (qa?.status === 'passed' && securityApplies(flow, graph)) {
    // QA passed: delivered only once Security passed it too (flow-security.mjs); kind `security` is its verdict
    const s = isObject(qa.security) ? qa.security : null
    if (s?.status === 'passed') return out('delivered', 'security', timeOf(s.at))
    if (s && SECURITY_FAILED.has(s.status) && stageOf(flow, graph).status === 'failed') return out('missed', 'stopped', timeOf(s.at), 'stopped')
    if (flow.status === 'done') return out('slipped', 'done', updated)
  } else if (qa?.status === 'passed') return out('delivered', 'passed', last())
  else if (qa && !ON_ITS_WAY_AT_QA.has(qa.status) && stageOf(flow, graph).status === 'failed') return out('missed', 'stopped', last(), 'stopped')
  if (!qa && flow.status === 'done') return out(isCodeProducing(flow) ? 'slipped' : 'delivered', 'done', updated)
  // on its way: working, blocked, waiting at or tested by QA, or sent back for a fix
  if (updated !== null && now - updated >= stallMs) return out('missed', 'stalled', updated + stallMs, 'stalled')
  return out(null, null, updated)
}

/** The whole scorecard of `flows` on `graph`, over the last `days` days (null: all time) up to `now`. */
export function scoreOf(flows, graph, { now = Date.now(), days = 30, stallDays = 7 } = {}) {
  const win = windowOf(now, days, stallDays)
  const inWindow = win.has
  const stallMs = stallDays * DAY
  const counts = { delivered: 0, slipped: 0, missed: 0, caught: 0 }
  const lists = { slipped: [], missed: [] }
  const agents = new Map()
  const agent = label => {
    if (!agents.has(label)) agents.set(label, { label, handed: 0, firstTime: 0, sentBack: 0 })
    return agents.get(label)
  }
  let inFlight = 0
  let right = 0
  let judged = 0

  for (const flow of Array.isArray(flows) ? flows : []) {
    if (!isObject(flow) || !isText(flow.id)) continue
    const { cell, why, time } = cellOf(flow, graph, now, stallMs)
    if (inWindow(time)) {
      if (cell === null) inFlight++
      else counts[cell]++
      if (cell === 'slipped') lists.slipped.push({ id: flow.id, title: flow.title ?? '', time })
      if (cell === 'missed') lists.missed.push({ id: flow.id, title: flow.title ?? '', why, time })
    }
    const attempts = verdictsOf(flow)
    for (const a of attempts) {
      if (inWindow(a.startedAt ?? a.at)) agent(a.agent).handed++
      // every failure verdict is one catch, at its own time: the log's `failed` events carry exactly these
      if (FAILED.has(a.status) && inWindow(a.at)) {
        counts.caught++
        agent(a.agent).sentBack++
      }
    }
    // every Security failure verdict is one catch too, at its own time: the log's failed `security` events
    const reviews = securityOn(graph) ? securityVerdictsOf(flow) : []
    for (const r of reviews) {
      if (SECURITY_FAILED.has(r.status) && inWindow(r.at)) {
        counts.caught++
        agent(r.agent).sentBack++
      }
    }
    // a final verdict: passed (by QA, and by Security when it is on the graph), or stopped (not a failure on its way
    // back to a producer), at the time cellOf counts the flow: without Security that is the last QA verdict's
    const final = (flow.qa?.status === 'passed' && cell === 'delivered') || why === 'stopped'
    const last = attempts.at(-1)
    if (final && last && inWindow(time)) {
      judged++
      if (why !== 'stopped' && !attempts.some(a => FAILED.has(a.status)) && !reviews.some(r => SECURITY_FAILED.has(r.status))) {
        right++
        agent(isText(flow.agent) ? flow.agent : 'Unknown').firstTime++
      }
    }
  }

  const newestFirst = (a, b) => (b.time ?? 0) - (a.time ?? 0)
  const strip = ({ time, ...rest }) => rest
  const precision = ratio(counts.delivered, counts.delivered + counts.slipped)
  const recall = ratio(counts.delivered, counts.delivered + counts.missed)
  return {
    window: win.view,
    counts,
    lists: { slipped: lists.slipped.sort(newestFirst).map(strip), missed: lists.missed.sort(newestFirst).map(strip) },
    precision,
    recall,
    accuracy: ratio(counts.delivered + counts.caught, counts.delivered + counts.slipped + counts.missed + counts.caught),
    f: { 1: { value: fBeta(precision.value, recall.value, 1), beta: 1 }, 4: { value: fBeta(precision.value, recall.value, 4), beta: 4 } },
    correctness: { value: judged > 0 ? right / judged : null, right, judged },
    agents: [...agents.values()].sort((a, b) => b.handed - a.handed || a.label.localeCompare(b.label)),
    inFlight,
  }
}

// ═══ the text ═══

const pct = v => `${Math.round(v * 100)}%`
const lower = s => s[0].toLowerCase() + s.slice(1)

/** A few plain lines for another page or a message: the window, then each score with its counts and meaning. */
export function scoreText(score) {
  const span = score.window.days ? `last ${score.window.days} days` : 'all time'
  const line = (name, r, key, top = r.top, bottom = r.bottom) =>
    r.value === null ? `${name}: not enough data yet.` : `${name} ${pct(r.value)} (${top} of ${bottom}): ${lower(MEANING[key])}`
  const f1 = score.f[1].value
  const f4 = score.f[4].value
  return [
    `Pipeline score, ${span}:`,
    line('Precision', score.precision, 'precision'),
    line('Recall', score.recall, 'recall'),
    f1 === null ? 'F-score: not enough data yet.' : `F1 ${pct(f1)} and F4 ${pct(f4)}: ${lower(MEANING.f)} F4 counts recall far more.`,
    line('Accuracy', score.accuracy, 'accuracy'),
    line('Correctness', { value: score.correctness.value, top: score.correctness.right, bottom: score.correctness.judged }, 'correctness'),
  ].join('\n')
}
