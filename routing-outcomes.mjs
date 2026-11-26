// The outcome of every finished flow, one line each, for a later learning method (a contextual bandit at about
// OUTCOME_TARGET finished flows, the number the user was told): what kind of task it was, what was suggested and
// used, and how it went. No learning method is built now: this file only collects the data and sums it for the
// Routing page (public/routing-page.js).
//
//   data/routing-outcomes.jsonl   APPEND-ONLY, one JSON line per finished flow, written ONCE (a flow already in the
//                                 file is never written again, even if it is reopened later):
//     { at, flow, type, size, risk, agent, model, effort, followed, passedFirstTime, qaAttempts, minutes, tokens?,
//       usd?, delivered, end, missing? }
//
//   outcomeOf(flow, graph, { now, stallDays, flowTokens })   the line for a FINISHED flow, or null
//   recordOutcomes({ flows, graph, now, file, flowTokens, readyFor })  append the lines of finished flows not yet in
//                                                    the file whose tokens are final: readyFor(finishedAt ms) true
//                                                    (routing-providers.mjs tokensReady); until then a flow has no line
//   readOutcomes(file) / listOutcomes({ since }, file)       the lines, oldest first (the CONTRACT other features read)
//   outcomeTable(lines)                                      the Routing page's table, per task type and model
//
// ═══ FROM STORED RECORDS ONLY ═══
// - FINISHED is the scorecard's own call (score.mjs cellOf), never a second copy: delivered (end delivered),
//   finished without the checks it needed (end slipped: delivered false), stopped by QA, Security or Senior (end
//   stopped), or dropped (end dropped). On its way or stalled is not finished: a stalled flow may still move.
// - `at` is the time the scorecard counts it at; `minutes` from the flow's createdAt to then (null without a start).
// - `passedFirstTime`: true when QA (and Security) passed it with no failure verdict anywhere, or Senior passed it
//   with none; false after any failure, or when it was stopped; null when no reviewer judged it (an ask, a slip).
// - type, size, risk, agent, model, effort and followed come from the flow's routing record (routing-flow.mjs);
//   a flow from before that record gets its type from its title and its agent, with the model, effort and followed
//   left null: not known, never guessed.
// - tokens and usd come from the injected provider (routing-providers.mjs flowTokens, feat/smart-predict). Without
//   one they are LEFT OUT and `missing: ['tokens', 'usd']` says so.
// - A torn or hand-made line is skipped on read; one bad line never hides the rest.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { DATA_DIR } from './factory-state.mjs'
import { cellOf, DAY, FAILED, SECURITY_FAILED, SENIOR_FAILED, securityVerdictsOf, seniorVerdictsOf, verdictsOf } from './score.mjs'
import { taskTypeOf } from './routing-type.mjs'

export const OUTCOMES_FILE = path.join(DATA_DIR, 'routing-outcomes.jsonl')
/** How many finished flows the user was told a learning method needs. */
export const OUTCOME_TARGET = 100
/** Under this many flows a row of the table says Too few to trust. */
export const FEW = 5
const NL = '\n'

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** delivered | slipped | stopped | dropped, or null when the flow is not finished. */
function endOf(cell, why) {
  if (cell === 'delivered') return 'delivered'
  if (cell === 'slipped') return 'slipped'
  if (cell === 'missed' && why === 'stopped') return 'stopped'
  if (cell === 'missed' && why === 'dropped') return 'dropped'
  return null
}

/** Right first time, from the reviewers' verdicts (see the header). */
function firstTime(flow, end) {
  const qa = verdictsOf(flow)
  if (qa.length) {
    if (end === 'stopped' || qa.some(a => FAILED.has(a.status)) || securityVerdictsOf(flow).some(v => SECURITY_FAILED.has(v.status))) return false
    return flow.qa?.status === 'passed' ? true : null
  }
  const senior = seniorVerdictsOf(flow)
  if (senior.length) return end === 'stopped' || senior.some(v => SENIOR_FAILED.has(v.status)) ? false : flow.senior?.status === 'passed' ? true : null
  return null
}

/** { tokens, usd } from the provider, or null when it does not know or fails. */
function tokensOf(flowTokens, id) {
  try {
    const t = flowTokens?.(id)
    return isObj(t) && num(t.tokens) !== null && num(t.usd) !== null ? { tokens: t.tokens, usd: t.usd } : null
  } catch {
    return null
  }
}

export function outcomeOf(flow, graph, { now = Date.now(), stallDays = 7, flowTokens = null } = {}) {
  if (!isObj(flow) || !isText(flow.id)) return null
  const { cell, why, time } = cellOf(flow, graph, now, stallDays * DAY)
  const end = endOf(cell, why)
  if (!end || time === null) return null
  const r = isObj(flow.routing) ? flow.routing : null
  const used = isObj(r?.used) ? r.used : null
  const start = timeOf(flow.createdAt)
  const qaAttempts = verdictsOf(flow).length
  const line = {
    at: new Date(time).toISOString(), flow: flow.id,
    type: r ? r.type ?? null : taskTypeOf({ title: flow.title, text: flow.why }).type,
    size: r?.size ?? null, risk: r?.risk ?? null,
    agent: used?.agent ?? (isText(flow.agent) ? flow.agent : null), model: used?.model ?? null, effort: used?.effort ?? null,
    followed: r ? r.followed ?? null : null, passedFirstTime: firstTime(flow, end), qaAttempts,
    minutes: start !== null && time >= start ? Math.round((time - start) / 6000) / 10 : null,
  }
  const t = tokensOf(flowTokens, flow.id)
  if (t) Object.assign(line, t)
  Object.assign(line, { delivered: end === 'delivered', end })
  if (!t) line.missing = ['tokens', 'usd']
  return line
}

/** Every well-formed line of the file, oldest first. */
export function readOutcomes(file = OUTCOMES_FILE) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const raw of text.split(NL)) {
    if (!raw.trim()) continue
    try {
      const l = JSON.parse(raw)
      if (isObj(l) && isText(l.flow) && timeOf(l.at) !== null) out.push(l)
    } catch {
      // a torn line: the rest still reads
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/** The CONTRACT: the recorded outcomes, oldest first; with `since` (a time) only those at or after it. */
export function listOutcomes({ since } = {}, file = OUTCOMES_FILE) {
  const from = timeOf(since)
  const all = readOutcomes(file)
  return from === null ? all : all.filter(l => Date.parse(l.at) >= from)
}

/** readyFor(at), where a throw is not ready. */
function isReady(readyFor, at) {
  try {
    return readyFor(at) !== false
  } catch {
    return false
  }
}

/** Append the line of each finished flow not yet in the file. Returns how many were written; never throws. */
export function recordOutcomes({ flows = [], graph, now = Date.now(), file = OUTCOMES_FILE, flowTokens = null, stallDays = 7, readyFor = () => true } = {}) {
  try {
    const seen = new Set(readOutcomes(file).map(l => l.flow))
    const lines = []
    for (const f of flows) {
      if (!isObj(f) || seen.has(f.id)) continue
      const line = outcomeOf(f, graph, { now, stallDays, flowTokens })
      if (!line || !isReady(readyFor, Date.parse(line.at))) continue // written once, so only with its final tokens
      seen.add(f.id)
      lines.push(JSON.stringify(line))
    }
    if (!lines.length) return 0
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, lines.join(NL) + NL)
    return lines.length
  } catch (err) {
    console.error(`routing outcomes: could not record: ${err?.message || err}`)
    return 0
  }
}

const median = list => {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** The Routing page's table: one row per task type and model, most flows first. */
export function outcomeTable(lines) {
  const groups = new Map()
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!isObj(l)) continue
    const type = typeof l.type === 'string' ? l.type : null
    const model = typeof l.model === 'string' ? l.model : null
    const key = JSON.stringify([type, model])
    if (!groups.has(key)) groups.set(key, { type, model, list: [] })
    groups.get(key).list.push(l)
  }
  const rows = [...groups.values()].map(({ type, model, list }) => {
    const judged = list.filter(l => typeof l.passedFirstTime === 'boolean')
    const right = judged.filter(l => l.passedFirstTime).length
    const minutes = list.map(l => num(l.minutes)).filter(v => v !== null)
    const usd = list.map(l => num(l.usd)).filter(v => v !== null)
    return {
      type, model, flows: list.length, right, judged: judged.length, firstTime: judged.length ? right / judged.length : null,
      medianMinutes: median(minutes), medianUsd: median(usd), costOf: usd.length, fewer: list.length < FEW,
    }
  }).sort((a, b) => b.flows - a.flows || String(a.type).localeCompare(String(b.type)) || String(a.model).localeCompare(String(b.model)))
  return { rows, recorded: Array.isArray(lines) ? lines.filter(isObj).length : 0, target: OUTCOME_TARGET }
}
