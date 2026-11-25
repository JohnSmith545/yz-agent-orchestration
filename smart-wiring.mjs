// The four smart features, connected. Each one was built on its own against a CONTRACT with a safe default
// (nothing injected = it still works); this file shapes the real providers to those contracts, and nothing else.
// server.mjs and tools/factory.mjs call it; the features themselves are not edited to know each other.
//
//   Learn's evidence pack (learn-wiring.mjs makeLearnServerRoute { lessons, signals })
//     learnLessons(listLessons)   quality-lessons.mjs listLessons({ since, area }) -> ({ since }) -> [{ id, text, area, count }]
//     learnSignals(signals)       predict-signals.mjs signals({ since })          -> ({ since }) -> [{ kind, text, flow?, agent? }]
//   Predict's similarity (predict-routes.mjs makePredictRoute { riskOf })
//     riskLevelOf(riskOf)         quality-risk.mjs riskOf(flow, facts) -> { level, reasons, needs }  ->  (flow) -> level | null
//   Routing (routing-providers.mjs setRoutingProviders { riskOf, flowTokens })
//     wireRouting({ riskOf, flowTokens })   the same level, and predict-flow-tokens.mjs flowTokens(id) as { tokens, usd }
//
// ⚠️ Shapes that differ, and why each adapter exists:
// - Quality's riskOf answers an OBJECT; Predict and Routing compare a level STRING (`riskOf(flow) === target.risk`).
//   The level comes from the label quality-watch.mjs already stored on the flow (`flow.risk`, worked out with the
//   files the change touched) when there is one, else from riskOf on the flow, its facts and the configured rules,
//   exactly as quality-routes.mjs does for the flow page.
// - Learn passes `since` as a time in ms; listLessons reads it with Date.parse, which makes a number NaN and keeps
//   every lesson. The adapter passes an ISO date. Retired lessons are left out: the pack is what the work taught NOW.
// - Predict's flowTokens answers { tokens, usd, unpriced }; Routing's outcome line takes { tokens, usd }, and a
//   flow whose cost could not be priced is not known (usd null), never $0.
//
// ⚠️ A provider that throws never breaks its consumer:
// - Predict calls riskOf with no guard of its own, so riskLevelOf answers null on any throw (no risk part).
// - Routing guards its providers already; the adapters answer null too.
// - Learn's pack catches a throw and NAMES the section as left out (learn-pack.mjs `left`), which is the honest
//   answer, so the Learn adapters let a throw through instead of turning it into an empty, confident-looking list.
//   An answer that is not a list is no list.

import { CONFIG } from './config.mjs'
import { qualityOf } from './quality-config.mjs'
import { riskFacts } from './quality-facts.mjs'
import { setRoutingProviders } from './routing-providers.mjs'

const LEVELS = Object.freeze(['low', 'medium', 'high'])
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** (flow) -> low | medium | high | null, from quality's riskOf; the label stored on the flow wins. */
export function riskLevelOf(riskOf, { factsOf = riskFacts, rules = () => qualityOf(CONFIG).riskRules } = {}) {
  return flow => {
    if (!isObject(flow)) return null
    if (LEVELS.includes(flow.risk?.level)) return flow.risk.level
    if (typeof riskOf !== 'function') return null
    try {
      const level = riskOf(flow, { ...factsOf(flow), rules: rules() })?.level
      return LEVELS.includes(level) ? level : null
    } catch {
      return null
    }
  }
}

/** Learn's lessons provider: the active lessons since `since` (ms or ISO), as { id, text, area, count }. */
export function learnLessons(listLessons) {
  return ({ since } = {}) => {
    const t = typeof since === 'number' ? since : Date.parse(since)
    const list = listLessons({ since: Number.isFinite(t) ? new Date(t).toISOString() : undefined })
    return (Array.isArray(list) ? list : [])
      .filter(l => isObject(l) && isText(l.id) && isText(l.text) && (l.status === undefined || l.status === 'active'))
      .map(l => ({ id: l.id, text: l.text, area: isText(l.area) ? l.area : 'general', count: num(l.count) ?? 1 }))
  }
}

/** Learn's signals provider: Predict's alerts and estimate misses since `since`, each { kind, text, flow?, agent? }. */
export function learnSignals(signals) {
  return ({ since } = {}) => {
    const list = signals({ since })
    return (Array.isArray(list) ? list : [])
      .filter(s => isObject(s) && isText(s.kind) && isText(s.text))
      .map(s => ({ kind: s.kind, text: s.text, ...(isText(s.flow) ? { flow: s.flow } : {}), ...(isText(s.agent) ? { agent: s.agent } : {}) }))
  }
}

/** Routing's tokens provider: one flow's { tokens, usd } from Predict, or null when not known. */
export function routingTokens(flowTokens) {
  return id => {
    if (typeof flowTokens !== 'function') return null
    try {
      const t = flowTokens(id)
      return isObject(t) && num(t.tokens) !== null && num(t.usd) !== null ? { tokens: t.tokens, usd: t.usd } : null
    } catch {
      return null
    }
  }
}

/** Give Routing the risk level (quality) and the tokens (predict). Called once by each entry point. */
export function wireRouting({ riskOf, flowTokens, ...facts } = {}) {
  setRoutingProviders({ riskOf: riskLevelOf(riskOf, facts), flowTokens: routingTokens(flowTokens) })
}
