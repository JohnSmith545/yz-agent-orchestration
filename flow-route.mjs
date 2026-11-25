// The route of a flow: the sequence of pipeline steps one request is planned to pass through, from the Request to
// the Output, and how far it has come along it. The flow file is the source of truth for that request: its route
// is stored on it (`flow.route`), and where it stands along that route is derived from the flow alone, on read.
//
// ═══ THE FLOW TYPES ═══ New with this file, built ONLY from request kinds and agents the dashboard already has:
//   build   a code change: Request -> the coordinator -> the producer -> QA -> Push -> Output. When the
//           coordinator builds its own change it is Request -> coordinator -> QA -> Push -> Output (the graph's
//           `own changes` edge). Tracker tickets passed to an agent from the Tickets page, changes asked of Master.
//   review  a code review of a tracker ticket, which the chat agent (Independent) does and records as a review
//           mark: Request -> Independent -> Output.
//   ask     a question, an explanation or an investigation one agent answers with no code change:
//           Request -> that agent -> Human task -> Output (a producer is reached through the coordinator, as the
//           graph says; through Senior too when there is one). An answer with no by-hand steps passes Human task
//           and Senior without stopping, so on its progress they read skipped (pipeline-hand.mjs).
//           The Ask drawer, "Explain this ticket", and the old `decide` command.
// Answers, Request test steps, the QA rework loop and term questions are NOT request types: they happen inside a
// flow that already exists.
// With the optional agents on the pipeline (pipeline.mjs gateLabels), a producer's BUILD goes Request -> the
// coordinator -> the planner -> the producer -> QA -> Security -> Push -> Output (each only when configured); the
// coordinator's own build skips the planner. Review and ask routes do not change: the planner hands out build work
// only, so an ask may still go from the coordinator to a producer. The planner and Security, like QA, have no route
// of their own: they record their work on the flow they plan or review. Neither has Senior: it reviews by-hand
// work on the flow it was sent (tools/senior-cli.mjs).
// ⚠️ ROUTES FROM BEFORE HUMAN TASK: a stored ask route goes straight from its agent to the Output. checkRoute still
// takes such a hop when the graph makes it through the by-hand boxes alone (byHand), and routeProgress puts Human
// task and Senior in where the flow really stopped at them, so an old route reads as it did and a flow waiting on
// the user still says where.
//
// ═══ THE ROUTE BLOCK ═══  flow.route = { type, steps, at, by, history? }
//   steps    graph node ids in planned order, starting `request` and ending `outcome`, each once
//   at, by   when and by whom the route was set (the agent's --by)
//   history  the routes it had before, oldest first, at most HISTORY_MAX: an agent changes a route only with
//            `flow route`, and the old plan stays visible
// The SHAPE is checked by validateFlow (validateRoute here), with no graph: a config change must never turn a
// stored flow invalid. The GRAPH is checked when an agent sets a route (checkRoute, from the CLI). The route is
// the agent's, like `output`, but a rewrite never changes it: keepRoute takes the stored one (mergeKeepingAnswers).
// A route the dashboard made up for a flow with none (inferRoute) carries `inferred: true` and is never stored.
//
// ═══ PROGRESS ═══  routeProgress(flow, graph) -> [{ node, label, role, state, visits, status? }]
//   state   done | current | upcoming | skipped; ONE step is current while the flow is on its way, none once it
//           reached the Output (every step done, or skipped where it went round) and none for a dropped flow
//   visits  how many times the flow was at that step (pipeline.mjs stageOf's path), so a rework loop shows
//   status  on the current step only: the stage's word (working, blocked, waiting, pending, testing, reviewing,
//           rework, failed)
// It is stageOf (pipeline.mjs) laid over the planned steps, so the Agents diagram, the QA page and the Flows
// page all read the same answer. ⚠️ Pure: no file, no config (callers pass the graph). It must not import
// flows.mjs (flows.mjs imports this file) or config.mjs.

import { handSteps } from './pipeline-hand.mjs'
import { isCodeProducing, stageOf } from './pipeline.mjs'

export const ROUTE_TYPES = ['build', 'review', 'ask']
/** The one line that says what each type is for, in every refusal that needs a type. */
export const TYPE_HELP = '--type build|review|ask: build for a code change (it goes through QA and Push), review for a code review of a ticket, ask for a question, an explanation or an investigation'
export const HISTORY_MAX = 20

const SLUG = /^[a-z0-9-]+$/
/** MUST CHANGE IN LOCKSTEP with flows.mjs AGENT_LABEL (it cannot be imported here: flows.mjs imports this file). */
const LABEL = /^[A-Za-z0-9 ._-]{1,40}$/
const isText = v => typeof v === 'string' && v.trim() !== ''
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

// ═══ the shape ═══

/** The problems with one route's type and steps, prefixed `at`. */
function stepsProblems(r, at) {
  const problems = []
  if (!ROUTE_TYPES.includes(r.type)) problems.push(`${at}.type must be one of ${ROUTE_TYPES.join(', ')}`)
  if (!Array.isArray(r.steps)) return [...problems, `${at}.steps must be a list of pipeline step ids`]
  const seen = new Set()
  for (const s of r.steps) {
    if (typeof s !== 'string' || !SLUG.test(s)) problems.push(`route step ${s} must match /^[a-z0-9-]+$/`)
    else if (seen.has(s)) problems.push(`route step ${s} is there twice: a route visits each step once (a rework loop is counted, not planned)`)
    seen.add(s)
  }
  if (r.steps[0] !== 'request' || r.steps.at(-1) !== 'outcome' || r.steps.length < 3) problems.push(`${at}.steps must start at request and end at outcome, with an agent between`)
  return problems
}

/** Every problem with a stored `route`, one line each; [] when it is fine. Shape only: no graph (see checkRoute). */
export function validateRoute(route) {
  if (!isObject(route)) return ['route must be a JSON object']
  const problems = stepsProblems(route, 'route')
  if (!isText(route.at) || Number.isNaN(Date.parse(route.at))) problems.push('route.at must be a time')
  if (typeof route.by !== 'string' || !LABEL.test(route.by)) problems.push('route.by must be a label of 1 to 40 letters, digits, spaces, dots, dashes or underscores')
  if (route.inferred !== undefined) problems.push("route.inferred is the dashboard's, never stored: leave it out")
  if (route.history !== undefined) {
    if (!Array.isArray(route.history)) problems.push('route.history must be a list of the earlier routes')
    else route.history.forEach((h, i) => {
      if (!isObject(h)) return problems.push(`route.history #${i + 1} must be a JSON object`)
      problems.push(...stepsProblems(h, `route.history #${i + 1}`))
    })
  }
  return problems
}

// ═══ against the graph ═══

const nodesOf = graph => new Map((graph?.nodes || []).map(n => [n.id, n]))
const roleNode = (graph, role) => (graph?.nodes || []).find(n => n.role === role) || null
/** The by-hand boxes: the user's Human task and Senior. A route may go past them without naming them. */
const BY_HAND = new Set(['human', 'senior'])

/** Whether the graph goes from `a` to `b` through the by-hand boxes alone (an old route's `agent -> outcome` hop). */
function byHand(a, b, graph) {
  const role = new Map((graph?.nodes || []).map(n => [n.id, n.role]))
  const fwd = (graph?.edges || []).filter(e => e.kind !== 'rework')
  const seen = new Set()
  const todo = fwd.filter(e => e.from === a && BY_HAND.has(role.get(e.to))).map(e => e.to)
  while (todo.length) {
    const id = todo.shift()
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of fwd) {
      if (e.from !== id) continue
      if (e.to === b) return true
      if (BY_HAND.has(role.get(e.to))) todo.push(e.to)
    }
  }
  return false
}

/** The problems with a route on THIS graph: unknown steps, a hand-over the graph does not have, a build skipping QA. */
export function checkRoute(route, graph) {
  const byId = nodesOf(graph)
  const steps = Array.isArray(route?.steps) ? route.steps : []
  const problems = []
  for (const s of steps) if (!byId.has(s)) problems.push(`route step ${s} is not on the pipeline (its steps are ${[...byId.keys()].join(', ')})`)
  if (problems.length) return problems
  const hands = new Set((graph.edges || []).filter(e => e.kind !== 'rework').map(e => `${e.from}>${e.to}`))
  // the planner hands out build work only: a question may still go from the coordinator to a producer
  const coordinator = roleNode(graph, 'coordinator')
  const direct = route?.type !== 'build' && roleNode(graph, 'planner') ? new Set(graph.nodes.filter(n => n.role === 'producer').map(n => `${coordinator?.id}>${n.id}`)) : new Set()
  for (let i = 1; i < steps.length; i++) {
    const hop = `${steps[i - 1]}>${steps[i]}`
    if (!hands.has(hop) && !direct.has(hop) && !byHand(steps[i - 1], steps[i], graph)) problems.push(`the route goes from ${steps[i - 1]} to ${steps[i]}, but the pipeline hands no work that way`)
  }
  const qa = roleNode(graph, 'qa')
  if (route?.type === 'build' && !(steps.includes(qa?.id) && steps.includes('push'))) problems.push('a build route must go through QA and Push: every code change is tested and pushed by QA')
  const security = roleNode(graph, 'security')
  if (route?.type === 'build' && security && !steps.includes(security.id)) problems.push(`a build route must go through Security: ${security.label} reviews every code change before QA pushes it`)
  const chat = roleNode(graph, 'chat')
  if (route?.type === 'review' && !(chat && steps.includes(chat.id))) problems.push(`a review route goes through ${chat?.label || 'the chat agent'}: reviews are the chat agent's`)
  return problems
}

// ═══ planning ═══

/** The agent node of `label`; an agent not on the pipeline works through the coordinator (as stageOf places it). */
function ownNode(label, graph) {
  const own = (graph?.nodes || []).find(n => n.kind === 'agent' && n.label === label)
  return own || roleNode(graph, 'coordinator')
}

/** { steps } for a request of `type` that `agent` (a dashboard label) takes on, or { error } in one line. */
export function planRoute(type, agent, graph) {
  if (!ROUTE_TYPES.includes(type)) return { error: `say what kind of request this is with ${TYPE_HELP}` }
  const coordinator = roleNode(graph, 'coordinator')
  const qa = roleNode(graph, 'qa')
  const chat = roleNode(graph, 'chat')
  const own = ownNode(agent, graph)
  const planner = roleNode(graph, 'planner')
  const security = roleNode(graph, 'security')
  const via = own.role === 'producer' ? [coordinator.id, own.id] : [coordinator.id]
  if (type === 'review') {
    if (!chat) return { error: 'this dashboard has no chat agent (config factory.chat.name), so there is no review route: use ask' }
    if (own.role !== 'chat') return { error: `a review is ${chat.label}'s: it reviews the code and records the mark; for your own question use --type ask` }
    return { steps: ['request', chat.id, 'outcome'] }
  }
  if (own.role === 'chat') {
    if (type === 'build') return { error: `${own.label} is the chat agent and makes no code changes, so it has no build route: pass the change to an agent, or use --type ask or review` }
    return { steps: ['request', own.id, 'outcome'] }
  }
  if (own.role === 'qa') {
    if (type === 'build') return { error: 'QA tests other flows with the qa commands; it has no build route of its own' }
    return { error: 'QA asks on the flow it tests (flow ask), never in a flow of its own' }
  }
  if (own.role === 'planner') {
    if (type === 'build') return { error: `${own.label} plans and hands out work with flow plan-start and flow plan; it has no build route of its own` }
    return { error: `${own.label} asks on the flow it plans (flow ask), never in a flow of its own` }
  }
  if (own.role === 'security' || own.role === 'senior') {
    if (type === 'build') return { error: `${own.label} reviews other flows with the ${own.role} commands; it has no build route of its own` }
    return { error: `${own.label} asks on the flow it reviews (flow ask), never in a flow of its own` }
  }
  if (type === 'build') {
    // a producer's task comes through the planner when there is one; Security reviews every build after QA
    const through = own.role === 'producer' && planner ? [coordinator.id, planner.id, own.id] : via
    return { steps: ['request', ...through, qa.id, ...(security ? [security.id] : []), 'push', 'outcome'] }
  }
  // an ask ends past the by-hand boxes: the Human task, and Senior when there is one
  const hand = ['human', 'senior'].map(r => roleNode(graph, r)?.id).filter(Boolean)
  return { steps: ['request', ...via, ...hand, 'outcome'] }
}

/**
 * The route a flow written before routes most likely had, flagged `inferred: true` (never stored): build when it
 * changed code or QA has it (never for the chat agent, which builds nothing), ask otherwise, with its own agent;
 * an agent with no route of its own (QA) is read as the coordinator.
 */
export function inferRoute(flow, graph) {
  const own = ownNode(flow?.agent, graph)
  const type = own?.role !== 'chat' && (isObject(flow?.qa) || isCodeProducing(flow)) ? 'build' : 'ask'
  let plan = planRoute(type, flow?.agent, graph)
  if (!plan.steps) plan = planRoute(type, roleNode(graph, 'coordinator')?.label, graph)
  return { type, steps: plan.steps, at: flow?.createdAt || flow?.updatedAt || null, by: 'dashboard', inferred: true }
}

/** The route a flow follows: the stored one as it is, else the inferred one. */
export const routeOf = (flow, graph) => (isObject(flow?.route) && Array.isArray(flow.route.steps) ? flow.route : inferRoute(flow, graph))

// ═══ keeping and changing ═══

/** For mergeKeepingAnswers: a rewrite never changes a stored route (only `flow route` does); a flow with none takes the file's. */
export function keepRoute(incoming, existing) {
  if (isObject(existing?.route)) incoming.route = existing.route
}

/** Set `next` as the flow's route; the route it had goes into history (without its own history), oldest first. */
export function changeRoute(flow, next) {
  const old = isObject(flow.route) ? flow.route : null
  const route = { type: next.type, steps: [...next.steps], at: next.at, by: next.by }
  if (old) {
    const { history = [], ...was } = old
    route.history = [...history, was].slice(-HISTORY_MAX)
  }
  flow.route = route
  return route
}

// ═══ progress ═══

export function routeProgress(flow, graph, route = routeOf(flow, graph)) {
  const byId = nodesOf(graph)
  const dropped = flow?.status === 'dropped'
  // a dropped flow has no stage; where it was when dropped is where it would stand open
  const stage = stageOf(dropped ? { ...flow, status: 'open' } : flow, graph)
  // a by-hand box the flow really reached but its route does not name (a route from before it): put in before the end
  const planned = Array.isArray(route?.steps) ? route.steps : []
  // and, once a no-code flow has by-hand steps or a Senior record, Senior's box is planned from the start (QA B-6)
  const senior = roleNode(graph, 'senior')
  const due = senior && !isObject(flow?.qa) && (handSteps(flow).length > 0 || isObject(flow?.senior))
  const byHandIds = due ? [...stage.path, roleNode(graph, 'human')?.id, senior.id] : stage.path
  const extra = [...new Set(byHandIds.filter(id => BY_HAND.has(byId.get(id)?.role) && !planned.includes(id)))].sort((a, b) => (byId.get(a).role === 'senior') - (byId.get(b).role === 'senior'))
  const steps = extra.length && planned.at(-1) === 'outcome' ? [...planned.slice(0, -1), ...extra, 'outcome'] : planned
  const visits = new Map()
  for (const id of stage.path) visits.set(id, (visits.get(id) || 0) + 1)
  // a stage outside the plan: a done flow is at its end; else the furthest planned step it reached
  let cur = stage.node
  if (!steps.includes(cur)) cur = flow?.status === 'done' ? 'outcome' : [...stage.path].reverse().find(id => steps.includes(id)) || steps[0]
  const at = steps.indexOf(cur)
  const reached = !dropped && cur === 'outcome'
  return steps.map((node, i) => {
    const g = byId.get(node)
    const seen = visits.get(node) || 0
    let state
    if (dropped) state = i < at && seen ? 'done' : 'skipped'
    else if (i < at || (reached && i === at)) state = seen || i === at ? 'done' : 'skipped'
    else state = i === at ? 'current' : 'upcoming'
    const item = { node, label: g?.label || node, role: g?.role || null, state, visits: reached && i === at ? Math.max(1, seen) : seen }
    if (state === 'current') item.status = stage.status
    return item
  })
}

/** What every page reads about a flow's way through the pipeline: its route (stored or inferred) and its progress. */
export function withRoute(flow, graph) {
  const route = routeOf(flow, graph)
  return { route, progress: routeProgress(flow, graph, route) }
}
