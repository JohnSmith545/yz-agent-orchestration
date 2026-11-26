// The alerts, PURE: arithmetic on stored records, no model, no file, no clock (now is passed in). The route
// (predict-routes.mjs) reads the flows and the token index, and hides what the user dismissed (predict-state.mjs).
//
//   stuckAlerts({ flows, graph, now, settings })                       an open flow far longer than usual at its stage
//   spikeAlerts({ files, labelOf, names, now, settings })              a session burning tokens far faster than usual
//   contextAlerts({ files, live, labelOf, prices, now, settings })     a live session re-reading a large history
//   dailyAlerts({ files, prices, now, settings })                      today past a daily limit the user set
// Each alert: { key, kind, text, measure, flow?, agent?, session?, onYou?, handover?, figures }. `key` is what a
// dismissal remembers; `measure` is the number that grows as it gets worse (predict-state.mjs: it comes back once
// that is half as large again). `text` is one or two plain sentences for one person, no jargon.
//
// THE RULES (settings: predict-settings.mjs alertSettings)
// - STUCK: an open flow (not archived, not stalled: a flow the score counts as stalled after a week with no update is
//   already shown as stalled there) has stood at its current stage (predict-stage.mjs) longer than stuckFactor times
//   that stage's MEDIAN over the last 30 days (Pipeline time's own stage times, time-stats.mjs) and at least
//   stuckMinMinutes. Fewer than 5 past flows for the stage (or a stage with no history: a question, a push): the plain
//   limit stuckHours. A stage that waits on the user says it waited on you, never that an agent is stuck.
// - SPIKE: a session's tokens in the last hour (its subagents with it) above spikeFactor times its own median ACTIVE
//   hour (an hour with any tokens) over the 7 days before, and above spikeMinTokens. Fewer than 5 active hours: too
//   little history to judge, nothing. The last hour is the hour going on plus the share of the hour before it that
//   falls in the last 60 minutes (the index keeps hour totals; an hour's tokens are taken as spread evenly).
// - CONTEXT: for each LIVE session (open now), the cache reads of its last replies are the size of the history it
//   re-reads each turn. When the MEDIAN of the last 10 (at least 3) passes contextTokens: what a turn now costs at the
//   configured prices (the median reply's cost), and a fresh session with a short handover is suggested. A session
//   in two accounts' folders reads its newest transcript.
// - DAILY: today's tokens and their estimated dollars (local day, every transcript) past dailyUsd or dailyTokens, when
//   the user set one: one alert per limit per day.

import { DAY } from './score.mjs'
import { STAGES } from './time-stages.mjs'
import { timeStats } from './time-stats.mjs'
import { currentStage } from './predict-stage.mjs'
import { durationText, tokensText, usdText } from './predict-words.mjs'
import { R, costOf, localDay, priceFor, sizeOf } from './token-usage.mjs'

const HOUR = 3_600_000
const MIN = 60_000
const STALL_MS = 7 * DAY
/** Past flows a stage needs before its median is trusted; active hours a session needs before a spike is judged. */
export const STUCK_HISTORY = 5
export const SPIKE_HISTORY = 5
const CONTEXT_REPLIES = 10
const CONTEXT_MIN = 3
/** The sentence the Copy handover request button copies: it asks, and sends nothing by itself. */
export const HANDOVER_REQUEST = 'Please write a short handover note for a fresh session: what you are doing, what is done, what is left, the decisions made and why, and the files and commands that matter. Keep it under 300 words and tell me where you saved it.'

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
const times = n => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10)

// ═══ stuck ═══

/** What the stage is called in a sentence: `with QA`, `back with Agent 1 for a fix`. */
function whereText(stage) {
  switch (stage.key) {
    case 'rework':
      return `back with ${stage.who} for a fix`
    case 'push':
      return 'waiting to be pushed'
    default:
      return `with ${stage.who}`
  }
}
const ON_YOU = {
  ask: 'a question is open',
  blocked: 'its agent marked it blocked',
  stopped: 'it was stopped after too many failures, and only you can move it on',
  human: 'it has steps only you can do',
}

export function stuckAlerts({ flows = [], graph, now = Date.now(), settings }) {
  const list = (Array.isArray(flows) ? flows : []).filter(f => isObject(f) && isText(f.id))
  const history = new Map(timeStats(list, graph, { now, days: 30 }).stages.map(s => [s.key, s]))
  const known = new Set(STAGES.map(s => s.key))
  const out = []
  for (const flow of list) {
    if (flow.archivedAt || flow.deletedAt || flow.completedAt) continue
    const updated = timeOf(flow.updatedAt)
    if (updated !== null && now - updated >= STALL_MS) continue
    const stage = currentStage(flow, graph)
    if (!stage || stage.since > now) continue
    const elapsed = now - stage.since
    const past = known.has(stage.key) ? history.get(stage.key) : null
    const trusted = past && past.flows >= STUCK_HISTORY && Number.isFinite(past.median) && past.median > 0
    const limit = trusted ? Math.max(settings.stuckFactor * past.median, settings.stuckMinMinutes * MIN) : settings.stuckHours * HOUR
    if (elapsed <= limit) continue
    const title = String(flow.title || flow.id)
    const span = durationText(elapsed)
    let text
    if (stage.onYou) text = `${title} has waited on you for ${span}: ${ON_YOU[stage.key] || 'it needs you'}.`
    else if (trusted) text = `${title} has been ${whereText(stage)} for ${span}, ${times(elapsed / past.median)} times the usual ${durationText(past.median)} for that step.`
    else text = `${title} has been ${whereText(stage)} for ${span}. There are too few past flows to know the usual time, so the plain limit of ${durationText(settings.stuckHours * HOUR)} applies.`
    out.push({
      key: `stuck:${flow.id}:${stage.key}`, kind: 'stuck', text, measure: elapsed, flow: flow.id, agent: stage.onYou ? undefined : stage.who, onYou: stage.onYou,
      figures: { stage: stage.key, since: new Date(stage.since).toISOString(), elapsed, usual: trusted ? past.median : null, limit },
    })
  }
  return out.sort((a, b) => b.measure - a.measure || a.key.localeCompare(b.key))
}

// ═══ spike ═══

/** Each session's tokens per epoch hour, its subagents with it: Map(sessionId -> Map(hour -> tokens)). */
function hoursBySession(files) {
  const by = new Map()
  for (const f of Array.isArray(files) ? files : []) {
    if (!isObject(f) || !isText(f.sessionId) || !isObject(f.hours)) continue
    if (!by.has(f.sessionId)) by.set(f.sessionId, new Map())
    const into = by.get(f.sessionId)
    for (const [h, models] of Object.entries(f.hours)) {
      if (!isObject(models)) continue
      let n = 0
      for (const vec of Object.values(models)) if (Array.isArray(vec)) n += sizeOf(vec)
      into.set(Number(h), (into.get(Number(h)) || 0) + n)
    }
  }
  return by
}

/** A session as the alert names it: its label, and the dashboard's name for it when that says something more. */
const sessionWords = (label, name) => (isText(name) && name !== label ? `${label} (${name})` : label)

export function spikeAlerts({ files = [], labelOf = () => 'Unnamed sessions', names = new Map(), now = Date.now(), settings }) {
  const current = Math.floor(now / HOUR)
  const prevShare = 1 - (now - current * HOUR) / HOUR
  const first = Math.floor((now - 7 * DAY) / HOUR)
  const out = []
  for (const [sessionId, hours] of hoursBySession(files)) {
    const last = (hours.get(current) || 0) + (hours.get(current - 1) || 0) * prevShare
    const active = []
    for (const [h, n] of hours) if (h >= first && h < current - 1 && n > 0) active.push(n)
    if (active.length < SPIKE_HISTORY) continue
    const usual = median(active)
    if (!(last > settings.spikeFactor * usual) || !(last > settings.spikeMinTokens)) continue
    const label = labelOf(sessionId)
    out.push({
      key: `spike:${sessionId}`, kind: 'spike', session: sessionId, agent: label, measure: last,
      text: `${sessionWords(label, names?.get?.(sessionId))} used ${tokensText(last)} tokens in the last hour, ${times(last / usual)} times its usual ${tokensText(usual)} in an active hour.`,
      figures: { lastHour: Math.round(last), usual: Math.round(usual), activeHours: active.length },
    })
  }
  return out.sort((a, b) => b.measure - a.measure || a.key.localeCompare(b.key))
}

// ═══ context ═══

export function contextAlerts({ files = [], live = new Map(), labelOf = () => 'Unnamed sessions', prices = {}, now = Date.now(), settings }) {
  const newest = new Map()
  for (const f of Array.isArray(files) ? files : []) {
    if (!isObject(f) || f.sub || !live?.has?.(f.sessionId) || !Array.isArray(f.recent) || !f.recent.length) continue
    const was = newest.get(f.sessionId)
    if (!was || (Number(f.mtimeMs) || 0) > (Number(was.mtimeMs) || 0)) newest.set(f.sessionId, f)
  }
  const out = []
  for (const [sessionId, f] of newest) {
    const replies = f.recent.filter(r => isObject(r) && Array.isArray(r.vec) && Number.isFinite(r.at) && r.at <= now).slice(-CONTEXT_REPLIES)
    if (replies.length < CONTEXT_MIN) continue
    const read = median(replies.map(r => r.vec[R]))
    if (!(read > settings.contextTokens)) continue
    const costs = replies.map(r => {
      const p = priceFor(r.model, prices)
      return p ? costOf(r.vec, p.price) : null
    }).filter(Number.isFinite)
    const turn = costs.length ? median(costs) : null
    const label = labelOf(sessionId)
    const cost = turn === null ? 'Its model has no price set, so the cost of a turn is not known.' : `A turn now costs about ${usdText(turn)} at the configured prices.`
    out.push({
      key: `context:${sessionId}`, kind: 'context', session: sessionId, agent: label, measure: read,
      text: `${sessionWords(label, live.get(sessionId))} re-reads about ${tokensText(read)} tokens of its own history every turn. ${cost} A fresh session that starts from a short handover note would cost far less a turn.`,
      handover: HANDOVER_REQUEST,
      figures: { read: Math.round(read), turnUsd: turn, replies: replies.length },
    })
  }
  return out.sort((a, b) => b.measure - a.measure || a.key.localeCompare(b.key))
}

// ═══ daily ═══

export function dailyAlerts({ files = [], prices = {}, now = Date.now(), settings }) {
  if (settings.dailyUsd === null && settings.dailyTokens === null) return []
  const day = localDay(now)
  let tokens = 0
  let usd = 0
  let priced = false
  for (const f of Array.isArray(files) ? files : []) {
    const models = isObject(f?.days) && isObject(f.days[day]) ? f.days[day] : {}
    for (const [model, vec] of Object.entries(models)) {
      if (!Array.isArray(vec)) continue
      tokens += sizeOf(vec)
      const p = priceFor(model, prices)
      if (p) {
        usd += costOf(vec, p.price)
        priced = true
      }
    }
  }
  const out = []
  if (settings.dailyUsd !== null && priced && usd > settings.dailyUsd) {
    out.push({ key: `daily:usd:${day}`, kind: 'daily', measure: usd, text: `Today has used about ${usdText(usd)} of tokens at the configured prices, past your daily limit of ${usdText(settings.dailyUsd)}.`, figures: { usd, limit: settings.dailyUsd } })
  }
  if (settings.dailyTokens !== null && tokens > settings.dailyTokens) {
    out.push({ key: `daily:tokens:${day}`, kind: 'daily', measure: tokens, text: `Today has used ${tokensText(tokens)} tokens, past your daily limit of ${tokensText(settings.dailyTokens)}.`, figures: { tokens, limit: settings.dailyTokens } })
  }
  return out
}
