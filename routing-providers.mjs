// What routing reads from the other smart features, through ONE place with safe defaults, so routing works with them
// or without them (the coordinator wires the real ones at merge with setRoutingProviders, in server.mjs and
// tools/factory.mjs):
//
//   riskOf(flow)        low | medium | high, or null           feat/smart-quality; default: no risk (null)
//   flowTokens(flowId)  { tokens, usd } or null                 feat/smart-predict; default: not known (null)
//   tokensReady()       false while the token index is still    the server (smart-wiring.mjs); default: true
//                       being built
//
// ⚠️ tokensReady exists because an outcome line is written ONCE per finished flow (routing-outcomes.mjs): on a first
// start the token index takes a while to build, flowTokens answers null meanwhile, and without the wait every
// finished flow would keep `missing: ['tokens', 'usd']` for good. The outcome sweep waits instead (routing-routes.mjs).
//
// A provider that throws or answers something else counts as not known: routing never fails because another
// feature did. routingProviders() returns the current set; tests set their own and put the defaults back.

const DEFAULTS = Object.freeze({ riskOf: () => null, flowTokens: () => null, tokensReady: () => true })
let current = { ...DEFAULTS }

export const routingProviders = () => current

/** Set the providers (a missing or non-function one keeps the default). */
export function setRoutingProviders({ riskOf, flowTokens, tokensReady } = {}) {
  current = {
    riskOf: typeof riskOf === 'function' ? riskOf : DEFAULTS.riskOf,
    flowTokens: typeof flowTokens === 'function' ? flowTokens : DEFAULTS.flowTokens,
    tokensReady: typeof tokensReady === 'function' ? tokensReady : DEFAULTS.tokensReady,
  }
}
