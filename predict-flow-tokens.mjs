// What each flow really cost in tokens: the transcripts' per hour totals (token-index.mjs) PLACED on the flows that
// spent them, for the flow's Output tab (`Tokens: 12.4M, about $4.10`), the estimates (predict-estimate.mjs) and the
// placed and unplaced line of Pipeline tokens.
//
//   placeTokens({ files, flows, graph, labelOf, prices, now, from, stallMs })
//       { flows: Map(id -> { tokens, usd, unpriced }), placed, unplaced, total }: placed, unplaced and total are
//       { tokens, usd } over the hours from `from` (all hours when it is null); a flow's own figure is every hour
//   flowTokens(flowId)              THE CONTRACT for feat/smart-learn: { tokens, usd, unpriced } or null, through the
//   setFlowTokenSource(fn)          source the server sets (predict-routes.mjs); null when none is set or it fails
//
// THE PLACEMENT RULE
// - A reply counts for a flow when its session's LABEL (token-usage.mjs sessionLabels: the name the dashboard or the
//   transcript gives it, then config's maps) has a span on the flow (predict-spans.mjs: that agent's start and end
//   on it, the times the flow file can date) and the reply's time falls in that span.
// - SPLIT EVENLY: when the same agent has several flows open at that moment, each takes an equal share.
// - SUBAGENTS count with the session that started them (their transcript carries that session's id).
// - BY THE HOUR: the index keeps per hour totals, so a reply's exact minute is not known. Each hour's tokens are spread
//   evenly over the hour (the hour going on now: over the part of it that has passed), and a span covering a quarter
//   of the hour takes a quarter. Whatever falls outside every span of its label is UNPLACED, and shown as such: the
//   chat, a session on no flow, an unnamed session, time between flows.
// - Dollars at the configured prices (token-usage.mjs priceFor, costOf); a model with no price leaves the flow's
//   dollars for that part out: usd is the priced part, null when nothing had a price, and `unpriced` says so.
// ⚠️ PURE apart from the one registered source: no file, no clock (now is passed in), no config.

import { agentSpans } from './predict-spans.mjs'
import { costOf, priceFor, sizeOf } from './token-usage.mjs'

const HOUR = 3_600_000
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** Every agent's spans over every flow, by label: [{ id, from, to }], sorted by start. */
function spansByLabel(flows, graph, now, stallMs) {
  const by = new Map()
  for (const f of flows) {
    if (!isObject(f) || typeof f.id !== 'string') continue
    for (const s of agentSpans(f, graph, { now, ...(stallMs ? { stallMs } : {}) })) {
      if (!by.has(s.label)) by.set(s.label, [])
      by.get(s.label).push({ id: f.id, from: s.from, to: s.to })
    }
  }
  for (const list of by.values()) list.sort((a, b) => a.from - b.from)
  return by
}

/**
 * The shares of one hour [hs, he) among `spans` (one label's): [[flowId, fraction of the hour's tokens]] and the
 * fraction no span covers. A flow with two spans in the hour (a rework) adds both.
 */
function sharesOf(spans, hs, he) {
  const inside = spans.filter(s => s.from < he && s.to > hs)
  if (!inside.length) return { shares: [], rest: 1 }
  const cuts = new Set([hs, he])
  for (const s of inside) {
    if (s.from > hs) cuts.add(s.from)
    if (s.to < he) cuts.add(s.to)
  }
  const points = [...cuts].sort((a, b) => a - b)
  const shares = new Map()
  let rest = 0
  const len = he - hs
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const part = (b - a) / len
    const open = new Set(inside.filter(s => s.from <= a && s.to >= b).map(s => s.id))
    if (!open.size) {
      rest += part
      continue
    }
    for (const id of open) shares.set(id, (shares.get(id) || 0) + part / open.size)
  }
  return { shares: [...shares], rest }
}

const sum = () => ({ tokens: 0, usd: 0, priced: false, unpriced: false })
function add(s, tokens, usd) {
  s.tokens += tokens
  if (usd === null) s.unpriced = true
  else {
    s.usd += usd
    s.priced = true
  }
}
/** Dollars for the priced part, null when nothing had a price; `unpriced` says some tokens had none (the help says so). */
const out = s => ({ tokens: s.tokens, usd: s.priced ? s.usd : null, unpriced: s.unpriced })

export function placeTokens({ files = [], flows = [], graph, labelOf = () => 'Unnamed sessions', prices = {}, now = Date.now(), from = null, stallMs = null } = {}) {
  const spans = spansByLabel(Array.isArray(flows) ? flows : [], graph, now, stallMs)
  const perFlow = new Map()
  const placed = sum()
  const unplaced = sum()
  const total = sum()
  const priceCache = new Map()
  const priced = model => {
    if (!priceCache.has(model)) priceCache.set(model, priceFor(model, prices))
    return priceCache.get(model)
  }
  for (const f of Array.isArray(files) ? files : []) {
    if (!isObject(f) || !isObject(f.hours)) continue
    const mine = spans.get(labelOf(f.sessionId)) || []
    for (const [key, models] of Object.entries(f.hours)) {
      const hs = Number(key) * HOUR
      if (!Number.isFinite(hs) || !isObject(models) || hs > now) continue
      const he = Math.min(hs + HOUR, Math.max(now, hs + 1))
      const inPeriod = from === null || hs >= from
      const { shares, rest } = sharesOf(mine, hs, he)
      for (const [model, vec] of Object.entries(models)) {
        if (!Array.isArray(vec) || vec.length < 6) continue
        const tokens = sizeOf(vec)
        if (!tokens) continue
        const p = priced(model)
        const usd = p ? costOf(vec, p.price) : null
        const part = share => [tokens * share, usd === null ? null : usd * share]
        if (inPeriod) add(total, tokens, usd)
        for (const [id, share] of shares) {
          if (!perFlow.has(id)) perFlow.set(id, sum())
          add(perFlow.get(id), ...part(share))
          if (inPeriod) add(placed, ...part(share))
        }
        if (rest > 0 && inPeriod) add(unplaced, ...part(rest))
      }
    }
  }
  return {
    flows: new Map([...perFlow].map(([id, s]) => [id, out(s)])),
    placed: out(placed),
    unplaced: out(unplaced),
    total: out(total),
  }
}

// ═══ the contract: one flow's tokens, through the source the server sets ═══

let source = null

/** The server's source of one flow's tokens (predict-routes.mjs); null takes it away. */
export function setFlowTokenSource(fn) {
  source = typeof fn === 'function' ? fn : null
}

/** One flow's placed tokens: { tokens, usd, unpriced }, or null when there is no source, no such flow, or a failure. */
export function flowTokens(flowId) {
  if (!source) return null
  try {
    return source(String(flowId)) ?? null
  } catch {
    return null
  }
}
