// The route of a flow from the command line (tools/flow-cli.mjs registers and calls these; the rules are
// flow-route.mjs's): every request gets a flow FIRST, with its type, and follows that route.
//
//   flow new <id> "<title>" --type build|review|ask ...   newRoute: refused without --type, or with a type the
//                                                         agent has no route for (one line saying why)
//   flow write <file.json>                               settleRoute: a NEW flow needs `"route": { "type": ... }`
//                                                         (the steps are planned for its agent when left out,
//                                                         and checked against the pipeline when given); a
//                                                         rewrite keeps the stored route, with a warning when the
//                                                         file brought another; a flow from before routes needs none
//   flow route <flow> --type build|review|ask --by <label>   the ONE way to change a route; the old one goes into
//                                                         route.history, so a changed plan stays visible
//   routeBlock(flow)                                     the `route:` line of flow show's Output block (stderr)
//
// Like the other flow commands they return { out, code } and never print. `config` (from runFlow's context, so
// tests pass their own) gives the pipeline graph; left out, config.mjs CONFIG.

import { CONFIG } from '../config.mjs'
import { changeRoute, checkRoute, planRoute, routeOf, routeProgress, TYPE_HELP, validateRoute } from '../flow-route.mjs'
import { readFlow, writeFlow } from '../flows.mjs'
import { pipelineGraph } from '../pipeline.mjs'

export const NO_TYPE = `flow new needs ${TYPE_HELP}`
const NEEDS_ROUTE = 'a new flow needs a route: add "route": { "type": "build" } (or review, ask) to the file, or start it with flow new --type'

const fail = out => ({ out, code: 1 })
const ok = out => ({ out, code: 0 })
const now = () => new Date().toISOString()
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const graphOf = config => pipelineGraph(config || CONFIG)
const typeGiven = t => typeof t === 'string' && t !== ''
const sameRoute = (a, b) => a?.type === b?.type && JSON.stringify(a?.steps) === JSON.stringify(b?.steps)

/** `Request -> Master -> … -> Output`: a route's steps by their labels on the graph. */
function labels(steps, graph) {
  const byId = new Map((graph?.nodes || []).map(n => [n.id, n.label]))
  return steps.map(s => byId.get(s) || s).join(' -> ')
}

/** The route of a new flow of `type` that `agent` takes on, signed by `by`. Throws one line when there is none. */
export function newRoute(type, agent, by, config) {
  if (!typeGiven(type)) throw new Error(NO_TYPE)
  const plan = planRoute(type, agent, graphOf(config))
  if (plan.error) throw new Error(plan.error)
  return { type, steps: plan.steps, at: now(), by }
}

/**
 * For `flow write`: settles `incoming.route` against the `stored` flow (null for a new one), before the file is
 * validated. Returns { warning, problems }: a warning for stderr ('' for none), and one line per problem when a
 * new flow has no route or the route it gives does not fit the pipeline. With problems the route is taken off
 * the file (so validateFlow does not say them twice), and the caller writes nothing.
 */
export function settleRoute(incoming, stored, { by, config } = {}) {
  const given = incoming.route
  const done = (problems = [], warning = '') => ({ warning, problems })
  if (isObject(stored?.route)) {
    incoming.route = stored.route // keepRoute (mergeKeepingAnswers) does it too: here so the warning can be said
    return done([], given === undefined || sameRoute(given, stored.route) ? '' : `Warning: route kept: change it with flow route ${incoming.id} --type build|review|ask (the old plan stays in its history).`)
  }
  // a flow from before routes stays as it was: its route is inferred on read
  if (given === undefined) return done(stored ? [] : [NEEDS_ROUTE])
  if (!isObject(given)) return done() // validateFlow says what is wrong with it
  const graph = graphOf(config)
  const plan = given.steps === undefined ? planRoute(given.type, incoming.agent, graph) : { steps: given.steps }
  const route = { type: given.type, steps: plan.steps, at: now(), by: by || incoming.agent }
  const problems = plan.error ? [plan.error] : validateRoute(route)
  if (!problems.length) problems.push(...checkRoute(route, graph))
  if (problems.length) {
    delete incoming.route
    return done(problems)
  }
  incoming.route = route
  return done()
}

/** flow route <flow> --type build|review|ask: plan the route again for the flow's agent, keeping the old one in its history. */
function cmdRoute(noName) {
  return (f, { by, config }) => {
    if (!by) return fail(noName)
    const flow = readFlow(f._[0])
    if (!flow) return fail(`No flow ${f._[0]}`)
    if (!typeGiven(f.type)) return fail(`flow route needs ${TYPE_HELP}`)
    const graph = graphOf(config)
    const plan = planRoute(f.type, flow.agent, graph)
    if (plan.error) return fail(plan.error)
    const next = { type: f.type, steps: plan.steps, at: now(), by }
    const line = `${f.type}, ${labels(plan.steps, graph)}`
    if (sameRoute(next, flow.route)) return ok(`Flow ${flow.id} route unchanged: ${line}`)
    const was = flow.route?.type
    changeRoute(flow, next)
    writeFlow(flow)
    return ok(`Flow ${flow.id} route: ${line}${was ? `; was ${was}` : ''}`)
  }
}

export const routeCommands = noName => ({ route: cmdRoute(noName) })

/** flow show's `route:` line: the plan and where the flow is on it; an inferred route says how to set it. */
export function routeBlock(flow, config) {
  const graph = graphOf(config)
  const route = routeOf(flow, graph)
  if (route.inferred) return [`  route: ${route.type} (inferred: set it with flow route ${flow.id} --type build|review|ask)`]
  // the steps as the page shows them (flow-route.mjs routeProgress): Human task and Senior where the flow needs them
  const progress = routeProgress(flow, graph, route)
  const now = progress.find(s => s.state === 'current')
  const where = now ? `now at ${now.label} (${now.status})` : flow.status === 'dropped' ? 'dropped' : 'at the Output'
  return [`  route: ${route.type}, ${labels(progress.map(s => s.node), graph)}; ${where}`]
}
