// The flow's `estimate` (predict-estimate.mjs) on the flow file: its shape, and that it is the SERVER'S. Kept in a
// file of its own with no imports, because flows.mjs imports it (and flows.mjs must not be imported back).
//
//   flow.estimate = { at, minutes, usd, tokens, basedOn: [flow ids], spread, few? }
//     at        when the server worked it out (the flow had just started work)
//     minutes   the median time of the similar flows, start to finish; null when there were too few
//     usd       their median placed cost at the configured prices; null when fewer than 3 had one
//     tokens    their median placed tokens; null likewise
//     basedOn   the similar flows it was worked out from (at most 20)
//     spread    { minutes: [fastest, slowest], usd: [lo, hi] | null, tokens: [lo, hi] | null }, or null with too few
//     few       true when fewer than 3 similar flows had finished: no estimate, and the page says so
//
//   keepEstimate(incoming, existing)   an agent rewrite (flows.mjs mergeKeepingAnswers) takes it from the stored file
//                                      only, like archivedAt: no agent can add, change or drop it
//   validateEstimate(e)                its problems, one line each; [] when it is fine (flows.mjs validateFlow)

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/ // flows.mjs ISO_TIME
const SLUG = /^[a-z0-9-]+$/
export const BASED_ON_MAX = 20

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isAmount = v => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)
const isPair = v => v === null || (Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0))

export function keepEstimate(incoming, existing) {
  if (existing?.estimate) incoming.estimate = existing.estimate
  else delete incoming.estimate
}

export function validateEstimate(e) {
  if (!isObject(e)) return ['estimate must be a JSON object']
  const problems = []
  if (typeof e.at !== 'string' || !ISO_TIME.test(e.at) || Number.isNaN(Date.parse(e.at))) problems.push('estimate at must be a time')
  for (const key of ['minutes', 'usd', 'tokens']) if (!isAmount(e[key])) problems.push(`estimate ${key} must be a number of 0 or more, or null`)
  if (!Array.isArray(e.basedOn) || !e.basedOn.every(id => typeof id === 'string' && SLUG.test(id))) problems.push('estimate basedOn must be a list of flow ids')
  else if (e.basedOn.length > BASED_ON_MAX) problems.push(`estimate basedOn holds at most ${BASED_ON_MAX} flow ids`)
  if (e.spread !== null && (!isObject(e.spread) || !['minutes', 'usd', 'tokens'].every(k => isPair(e.spread[k] ?? null)))) problems.push('estimate spread must be null or two numbers for each of minutes, usd and tokens')
  if (e.few !== undefined && typeof e.few !== 'boolean') problems.push('estimate few must be true or false')
  return problems
}
