// What routing reads from the other smart features, through ONE place with safe defaults, so routing works with them
// or without them (the coordinator wires the real ones at merge with setRoutingProviders, in server.mjs and
// tools/factory.mjs):
//
//   riskOf(flow)        low | medium | high, or null           feat/smart-quality; default: no risk (null)
//   flowTokens(flowId)  { tokens, usd } or null                 feat/smart-predict; default: not known (null)
//
// A provider that throws or answers something else counts as not known: routing never fails because another
// feature did. routingProviders() returns the current pair; tests set their own and put the defaults back.

const DEFAULTS = Object.freeze({ riskOf: () => null, flowTokens: () => null })
let current = { ...DEFAULTS }

export const routingProviders = () => current

/** Set one or both providers (a missing or non-function one keeps the default). */
export function setRoutingProviders({ riskOf, flowTokens } = {}) {
  current = {
    riskOf: typeof riskOf === 'function' ? riskOf : DEFAULTS.riskOf,
    flowTokens: typeof flowTokens === 'function' ? flowTokens : DEFAULTS.flowTokens,
  }
}
