// Estimates from similar past work: `about 70 minutes and $40, based on 5 similar flows`, worked out when a flow
// starts work (stored on it as `estimate`, predict-keep.mjs) and on the fly for a ticket not yet started (the Tickets
// page); then set against what the flow really took (its Output tab), and over many flows (the accuracy table in
// Pipeline time). PURE: no file, no clock (now is passed in), no config.
//
//   wordsOf(title)                               the title words that count: lower case, 3 letters or more, not
//                                                the common small words
//   targetOf({ flow } | { ticket, now }, riskOf) what is being estimated: { id, routeType, tickets, agent, title,
//                                                start, risk }
//   rankSimilar(target, flows, opts)             the finished flows that may be similar, nearest first:
//                                                [{ id, score, minutes, finish, flow }]
//   estimateFor(target, flows, opts)             { at, minutes, usd, tokens, basedOn, spread, few? }
//   accuracyOf(flows, opts)                      how good the estimates have been: { stored, afterwards, from }
//   misses(flows, { graph, since, now, tokensOf }) finished flows outside their estimate's range, one line each
//   opts: { graph, tickets: Map(id -> { title, labels, type }), now, tokensOf(id) -> { tokens, usd } | null,
//           riskOf(flow) -> a risk level | null (feat/smart-quality's provider; none by default), nearest (8) }
//
// THE RULES
// - FINISHED is the scorecard's delivered (score.mjs cellOf), the same as Pipeline time: its time is from the start
//   (createdAt) to when the scorecard counts the delivery. Slipped, dropped and stopped flows are no example to go by.
// - ONLY THE PAST: a flow's estimate uses only flows that finished before it started, never itself; so an estimate
//   worked out late (a flow that started before this feature existed) says what could have been said at the start.
// - SIMILAR is the same route type first (a flow of another type is never similar; a ticket not yet started has no
//   route yet, so any type), then a score: shared ticket labels (twice the share of labels in common), a shared ticket
//   type (1), the same agent (1), the same risk level when a risk provider gives one (1), and title words in common
//   (twice the share of words in common). Ties go to the flow that finished last, then the id.
// - THE NEAREST 3 TO 8 (estimates.nearest): their MEDIAN time, cost and tokens, with the range from the fastest to the
//   slowest. Fewer than 3: no number at all (`few`), the page says `No estimate yet: too few similar flows`. A cost
//   needs 3 of them with a placed cost (predict-flow-tokens.mjs); with fewer the cost is left out, never guessed.
// - ACCURACY keeps the estimates stored when a flow started apart from those WORKED OUT AFTERWARDS (for a finished flow
//   that has none stored: the same rule, from the flows that had finished before it started). The error of one is
//   how far the actual was from the estimate, as a share of the estimate; the table shows the median error and how
//   many fell inside their range. Under 5 is `Too few to trust`.

import { cellOf } from './score.mjs'
import { durationText, usdText } from './predict-words.mjs'

const MIN = 60_000
export const FLOOR = 3
const TRUST = 5
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'are', 'was', 'were', 'its', 'not', 'but', 'all', 'any', 'can', 'has', 'have', 'had', 'you', 'your', 'our', 'out', 'when', 'what', 'which', 'who', 'how', 'why', 'than', 'then', 'there', 'their', 'them', 'they', 'will', 'one', 'off', 'per', 'via'])

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
const median = list => {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const range = list => (list.length ? [Math.min(...list), Math.max(...list)] : null)
const round = (v, places) => (v === null ? null : Math.round(v * 10 ** places) / 10 ** places)

export function wordsOf(title) {
  return new Set(String(title ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w)))
}
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const x of a) if (b.has(x)) shared++
  return shared / (a.size + b.size - shared)
}

/** A flow's route type: its stored route's, else build when QA has a record on it (older flows have no route). */
const routeTypeOf = flow => (isText(flow?.route?.type) ? flow.route.type : isObject(flow?.qa) ? 'build' : null)

export function targetOf({ flow, ticket, now = Date.now() } = {}, riskOf = null) {
  if (flow) {
    const risk = riskOf ? riskOf(flow) ?? null : null
    return { id: flow.id, routeType: routeTypeOf(flow), tickets: Array.isArray(flow.tickets) ? flow.tickets.filter(isText) : [], agent: isText(flow.agent) ? flow.agent : null, title: String(flow.title || ''), start: timeOf(flow.createdAt), risk }
  }
  return { id: null, routeType: null, tickets: ticket?.id ? [ticket.id] : [], agent: null, title: String(ticket?.title || ''), start: now, risk: null }
}

/** The finished flow's start, finish and minutes, or null when the scorecard does not count it delivered. */
function finishedOf(flow, graph, now) {
  let c
  try {
    c = cellOf(flow, graph, now, Infinity)
  } catch {
    return null
  }
  const start = timeOf(flow.createdAt)
  if (c.cell !== 'delivered' || start === null || !Number.isFinite(c.time) || c.time < start) return null
  return { start, finish: c.time, minutes: (c.time - start) / MIN }
}

/** The labels and types of a set of ticket ids, from the ticket sources. */
function factsOf(ids, tickets) {
  const labels = new Set()
  const types = new Set()
  for (const id of ids) {
    const t = tickets?.get?.(id)
    for (const l of Array.isArray(t?.labels) ? t.labels : []) if (isText(l)) labels.add(l.toLowerCase())
    if (isText(t?.type)) types.add(t.type.toLowerCase())
  }
  return { labels, types }
}

export function rankSimilar(target, flows, { graph, tickets = new Map(), now = Date.now(), riskOf = null } = {}) {
  const mine = factsOf(target.tickets || [], tickets)
  const words = wordsOf(target.title)
  const out = []
  for (const flow of Array.isArray(flows) ? flows : []) {
    if (!isObject(flow) || !isText(flow.id) || flow.id === target.id) continue
    if (target.routeType && routeTypeOf(flow) !== target.routeType) continue
    const f = finishedOf(flow, graph, now)
    if (!f || (target.start !== null && target.start !== undefined && f.finish > target.start)) continue
    const theirs = factsOf(Array.isArray(flow.tickets) ? flow.tickets : [], tickets)
    let score = 2 * jaccard(mine.labels, theirs.labels) + 2 * jaccard(words, wordsOf(flow.title))
    if ([...mine.types].some(t => theirs.types.has(t))) score += 1
    if (target.agent && flow.agent === target.agent) score += 1
    if (target.risk && riskOf && riskOf(flow) === target.risk) score += 1
    out.push({ id: flow.id, score, minutes: f.minutes, finish: f.finish, flow })
  }
  return out.sort((a, b) => b.score - a.score || b.finish - a.finish || a.id.localeCompare(b.id))
}

export function estimateFor(target, flows, opts = {}) {
  const { now = Date.now(), tokensOf = () => null, nearest = 8 } = opts
  const picked = rankSimilar(target, flows, opts).slice(0, Math.max(FLOOR, nearest))
  const basedOn = picked.map(p => p.id)
  const at = new Date(now).toISOString()
  if (picked.length < FLOOR) return { at, minutes: null, usd: null, tokens: null, basedOn, spread: null, few: true }
  const costs = picked.map(p => tokensOf(p.id)).filter(c => c && c.tokens > 0)
  const usds = costs.map(c => c.usd).filter(v => Number.isFinite(v))
  const toks = costs.map(c => c.tokens)
  const minutes = picked.map(p => p.minutes)
  return {
    at,
    minutes: round(median(minutes), 1),
    usd: usds.length >= FLOOR ? round(median(usds), 2) : null,
    tokens: toks.length >= FLOOR ? Math.round(median(toks)) : null,
    basedOn,
    spread: {
      minutes: range(minutes).map(v => round(v, 1)),
      usd: usds.length >= FLOOR ? range(usds).map(v => round(v, 2)) : null,
      tokens: toks.length >= FLOOR ? range(toks).map(Math.round) : null,
    },
  }
}

// ═══ how good the estimates have been ═══

/** One measure's errors: { flows, median (a share of the estimate), inRange, ranged, few }. */
function scoreOf(list) {
  const errors = list.map(x => Math.abs(x.actual - x.est) / x.est)
  const ranged = list.filter(x => x.range)
  return { flows: list.length, median: median(errors), inRange: ranged.filter(x => x.actual >= x.range[0] && x.actual <= x.range[1]).length, ranged: ranged.length, few: list.length < TRUST }
}

export function accuracyOf(flows, opts = {}) {
  const { graph, now = Date.now(), from = null, tokensOf = () => null } = opts
  const list = (Array.isArray(flows) ? flows : []).filter(f => isObject(f) && isText(f.id))
  const rows = { stored: { minutes: [], usd: [] }, afterwards: { minutes: [], usd: [] } }
  for (const flow of list) {
    const f = finishedOf(flow, graph, now)
    if (!f || (from !== null && f.finish < from)) continue
    const stored = isObject(flow.estimate) && Number.isFinite(flow.estimate.minutes) ? flow.estimate : null
    const e = stored || estimateFor(targetOf({ flow }, opts.riskOf), list, { ...opts, now: f.start })
    if (!Number.isFinite(e.minutes) || e.minutes <= 0) continue
    const into = rows[stored ? 'stored' : 'afterwards']
    into.minutes.push({ actual: f.minutes, est: e.minutes, range: e.spread?.minutes || null })
    const cost = tokensOf(flow.id)
    if (Number.isFinite(e.usd) && e.usd > 0 && Number.isFinite(cost?.usd)) into.usd.push({ actual: cost.usd, est: e.usd, range: e.spread?.usd || null })
  }
  const kind = r => ({ minutes: scoreOf(r.minutes), usd: scoreOf(r.usd) })
  return { stored: kind(rows.stored), afterwards: kind(rows.afterwards), from: from === null ? null : new Date(from).toISOString() }
}

/** Finished flows (in the window) whose time, or cost, fell outside their stored estimate's range. */
export function misses(flows, { graph, since = null, now = Date.now(), tokensOf = () => null } = {}) {
  const out = []
  for (const flow of Array.isArray(flows) ? flows : []) {
    const e = isObject(flow?.estimate) ? flow.estimate : null
    if (!e || !Number.isFinite(e.minutes) || !e.spread?.minutes) continue
    const f = finishedOf(flow, graph, now)
    if (!f || (since !== null && f.finish < since)) continue
    const [lo, hi] = e.spread.minutes
    const cost = tokensOf(flow.id)
    const costOut = Number.isFinite(e.usd) && e.spread.usd && Number.isFinite(cost?.usd) && (cost.usd < e.spread.usd[0] || cost.usd > e.spread.usd[1])
    if (f.minutes >= lo && f.minutes <= hi && !costOut) continue
    const took = `${String(flow.title || flow.id)} took ${durationText(f.minutes * MIN)}; the estimate said about ${durationText(e.minutes * MIN)} (${durationText(lo * MIN)} to ${durationText(hi * MIN)})`
    const spent = costOut ? `, and it cost ${usdText(cost.usd)} against about ${usdText(e.usd)}` : ''
    out.push({ kind: 'estimate-miss', text: `${took}${spent}.`, flow: flow.id, agent: isText(flow.agent) ? flow.agent : undefined, at: new Date(f.finish).toISOString() })
  }
  return out
}
