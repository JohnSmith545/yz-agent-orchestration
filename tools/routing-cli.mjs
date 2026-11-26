// The routing suggestion where work is handed out on the command line (tools/flow-cli.mjs wraps these):
//
//   withRoutingNew(cmdNew)        `flow new`: after its usual line, the task type and the suggestion; the flow gets its
//                                 routing record (routing-flow.mjs), `used` being the starting agent at its settings then
//   withRoutingPlan(commands)     the planner's `plan-start` prints the suggestion for the request; `plan` (the hand-out)
//                                 records the producer it went to, at its settings then, says whether that follows the
//                                 suggestion, and takes the size from the plan file's file count
//
// ⚠️ A SUGGESTION, NEVER AN ORDER, and NEVER A FAILURE: the command has already done its work when these run, so any
// problem here (an unreadable settings file, a provider that throws) leaves the command's own result as it was and
// prints nothing more. Nothing is switched: the user or the coordinator takes the suggestion or not.
//
// The rules are config.json's `routing` block as it is NOW (routing-config.mjs), or `ctx.config.routing` when the
// caller passes its own config (the tests). The risk comes from the injected provider (routing-providers.mjs).

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { readAgentSettings } from '../agent-settings.mjs'
import { CONFIG } from '../config.mjs'
import { EVIDENCE_DIR, readFlow, writeFlow } from '../flows.mjs'
import { pipelineGraph } from '../pipeline.mjs'
import { routingNow } from '../routing-config.mjs'
import { planRouting, usedFrom, withUsed } from '../routing-flow.mjs'
import { routingProviders } from '../routing-providers.mjs'
import { routingSettings, suggestionLine } from '../routing-rules.mjs'
import { planFileCount, typeName } from '../routing-type.mjs'

const NOT_AN_ORDER = 'A suggestion, not an order: nothing was switched.'

/** The rules this command reads: the caller's config when it passed one, else config.json now. */
const rulesOf = ctx => (ctx?.config ? routingSettings(ctx.config.routing, () => {}) : routingNow()).rules
const graphOf = ctx => pipelineGraph(ctx?.config || CONFIG)
/** The lines as a note on stderr next to the good result, after any note it already had (the pile-up reminder). */
const add = (result, lines) => (lines.length ? { ...result, err: [result.err, ...lines].filter(Boolean).join('\n') } : result)

/** `Task type: wording (likely), small.` (or Unsure, with the reason). */
function typeLine(r) {
  if (!r.type) return `Task type: not known (${r.reason}) Correct it on the flow page when you know.`
  return `Task type: ${typeName(r.type)} (${r.typeBy === 'you' ? 'set by you' : r.confidence}), ${r.size}.`
}

/** Work out, store and describe one flow's routing; [] when anything goes wrong (never a failure). */
function route(id, ctx, { files = null, recordUsed = false } = {}) {
  try {
    const flow = readFlow(id)
    if (!flow) return { lines: [] }
    const graph = graphOf(ctx)
    let r = planRouting(flow, { rules: rulesOf(ctx), graph, riskOf: routingProviders().riskOf, files })
    if (recordUsed) r = withUsed(r, usedFrom(flow.agent, readAgentSettings(), graph))
    flow.routing = r
    writeFlow(flow)
    // nothing fits: no note at all, the agent has nothing to weigh
    return { r, lines: r.suggested ? [typeLine(r), `${suggestionLine(r.suggested)}. ${NOT_AN_ORDER}`] : [] }
  } catch {
    return { lines: [] }
  }
}

export function withRoutingNew(cmdNew) {
  return (f, ctx) => {
    const result = cmdNew(f, ctx)
    if (result.code) return result
    return add(result, route(f._[0], ctx, { recordUsed: true }).lines)
  }
}

/** The file count of the plan the hand-out copied into the flow's evidence folder (0 when it cannot be read). */
function filesOfPlan(flow) {
  try {
    return planFileCount(readFileSync(path.join(EVIDENCE_DIR, flow.plan.file), 'utf8'))
  } catch {
    return 0
  }
}

export function withRoutingPlan(commands) {
  const start = commands['plan-start']
  const plan = commands.plan
  return {
    ...commands,
    'plan-start': (f, ctx) => {
      const result = start(f, ctx)
      if (result.code) return result
      return add(result, route(f._[0], ctx).lines)
    },
    plan: (f, ctx) => {
      const result = plan(f, ctx)
      if (result.code) return result
      let files = 0
      try {
        files = filesOfPlan(readFlow(f._[0]))
      } catch {
        files = 0
      }
      const { r, lines } = route(f._[0], ctx, { files, recordUsed: true })
      if (!r?.suggested) return result
      const verdict = r.followed === true ? 'You followed the routing suggestion.'
        : r.followed === false ? `This hand-out differs from the routing suggestion. It is recorded; that is fine when you had a reason.` : ''
      return add(result, [lines[0], suggestionLine(r.suggested), verdict].filter(Boolean))
    },
  }
}
