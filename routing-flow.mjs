// A flow's routing record: what kind of task it is, how big, what the routing rules SUGGESTED for it, what was
// really USED, and whether the suggestion was followed. The data a later learning method would start from
// (routing-outcomes.mjs writes one line per finished flow from it).
//
//   flow.routing = {
//     type        a task type (routing-type.mjs), or null when unsure with nothing to go on
//     typeBy      'you' when the user corrected the type (it then always wins); left out otherwise
//     confidence  certain | likely | unsure;  reason: one plain line
//     size        small | medium | large;  risk: low | medium | high | null (the risk provider's, when there is one)
//     suggested   { agent, model, effort, rule, why } or null when no rule fits (routing-rules.mjs suggest)
//     used        { agent, model, effort, at } or null: the agent that got the work and ITS SETTINGS AT THAT TIME
//                 (agent-settings.mjs): read when the flow starts (`flow new`) and again when the planner hands it
//                 to a producer (`flow plan`); a fixed role reads Opus high
//     followed    true | false | null (routing-rules.mjs followedOf: null when nothing was suggested, or a part of
//                 what was used is not known, such as a model nobody chose for that agent)
//     at          when it was last worked out
//   }
//
// ⚠️ `used` is the model the user SET for that agent (its window on the Agents page), not a model the dashboard saw
// run: the dashboard cannot switch or read a session open in the editor (agent-settings.mjs). The Routing page says so.
// ⚠️ The dashboard's alone, like `plan` is the planner's: an agent's `flow write` takes it from the stored file only
// (keepRouting, called by mergeKeepingAnswers). The CLI wrappers (tools/routing-cli.mjs) and the user's correction
// (routing-routes.mjs) are the only writers. Pure: no file access; the caller passes the rules, graph and store.

import { entryOf, FIXED, FIXED_ROLES } from './agent-settings.mjs'
import { followedOf, RISKS, suggest } from './routing-rules.mjs'
import { CONFIDENCE, SIZES, sizeOf, TASK_TYPES, taskTypeOf, withCorrection } from './routing-type.mjs'

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const stamp = () => new Date().toISOString()
const roleIn = graph => label => (graph?.nodes || []).find(n => n.kind === 'agent' && n.label === label)?.role ?? null

/** The risk from an injected provider (feat/smart-quality riskOf): one of RISKS, else null. A throw is no risk. */
function riskFrom(riskOf, flow) {
  try {
    const r = riskOf?.(flow)
    return RISKS.includes(r) ? r : null
  } catch {
    return null
  }
}

/**
 * The routing record for `flow` now: its type (the stored correction wins), size (from `files`, a plan's file count,
 * when given), risk, and the suggestion for its agent. `used` and `followed` are carried over from the stored record.
 */
export function planRouting(flow, { rules, graph, riskOf = null, files = null, now = stamp } = {}) {
  const stored = isObj(flow?.routing) ? flow.routing : {}
  const text = [flow?.title, flow?.why].filter(t => typeof t === 'string').join('\n')
  const auto = taskTypeOf({ title: flow?.title, text: flow?.why })
  const t = withCorrection(auto, stored.typeBy === 'you' ? stored.type : null)
  const size = sizeOf({ files, text, type: t.type })
  const risk = riskFrom(riskOf, flow)
  const role = roleIn(graph)
  // an unsure type is no type to the rules: only a rule naming no type fits it (routing-type.mjs says why)
  const suggested = suggest({ type: t.confidence === 'unsure' ? null : t.type, size, risk }, rules, { agent: flow?.agent, role: role(flow?.agent), roleOf: role })
  const used = isObj(stored.used) ? stored.used : null
  const out = { type: t.type ?? null, ...(t.by === 'you' ? { typeBy: 'you' } : {}), confidence: t.confidence, reason: t.reason, size, risk }
  return { ...out, suggested: suggested && { agent: suggested.agent, model: suggested.model, effort: suggested.effort, rule: suggested.rule, why: suggested.why }, used, followed: followedOf(suggested, used), at: now() }
}

/** What `label` was set to run on at this moment: its saved model and effort; a fixed role is Opus high. */
export function usedFrom(label, store, graph) {
  if (FIXED_ROLES.includes(roleIn(graph)(label))) return { agent: label, model: FIXED.model, effort: FIXED.effort }
  const e = entryOf(store, label)
  return { agent: label, model: e.model ?? null, effort: e.effort ?? null }
}

/** The record with what was used (stamped) and followed worked out again. */
export function withUsed(routing, used, now = stamp) {
  const u = { agent: used?.agent ?? null, model: used?.model ?? null, effort: used?.effort ?? null, at: now() }
  return { ...routing, used: u, followed: followedOf(routing?.suggested, u) }
}

/** The user's correction of the flow's type (null takes it off): the record worked out again. Throws on a bad type. */
export function correctType(flow, type, opts = {}) {
  if (type !== null && !TASK_TYPES.includes(type)) throw new Error(`Pick a task type: ${TASK_TYPES.join(', ')}.`)
  const routing = { ...(isObj(flow?.routing) ? flow.routing : {}) }
  if (type === null) delete routing.typeBy
  else Object.assign(routing, { type, typeBy: 'you' })
  return planRouting({ ...flow, routing }, opts)
}

/** The problems of a stored routing record, one plain line each; [] when fine. */
export function validateRouting(r) {
  if (!isObj(r)) return ['routing must be a JSON object']
  const p = []
  if (r.type !== null && r.type !== undefined && !TASK_TYPES.includes(r.type)) p.push(`routing type must be one of ${TASK_TYPES.join(', ')}, or null`)
  if (r.typeBy !== undefined && r.typeBy !== 'you') p.push('routing typeBy must be you')
  if (r.confidence !== undefined && !CONFIDENCE.includes(r.confidence)) p.push('routing confidence must be certain, likely or unsure')
  if (r.size !== undefined && !SIZES.includes(r.size)) p.push('routing size must be small, medium or large')
  if (r.suggested !== undefined && r.suggested !== null && !isObj(r.suggested)) p.push('routing suggested must be an object or null')
  if (r.used !== undefined && r.used !== null && !isObj(r.used)) p.push('routing used must be an object or null')
  if (r.followed !== undefined && ![true, false, null].includes(r.followed)) p.push('routing followed must be true, false or null')
  if (r.at !== undefined && !isTime(r.at)) p.push('routing at must be a time')
  return p
}

/** For `flow write` (mergeKeepingAnswers): the routing record only ever comes from the stored file. */
export function keepRouting(incoming, existing) {
  if (existing?.routing !== undefined) incoming.routing = existing.routing
  else delete incoming.routing
  return incoming
}
