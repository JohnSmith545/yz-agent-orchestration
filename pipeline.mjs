// The orchestration definition: who hands work to whom, as ONE graph every page draws from.
//
//   Request -> Coordinator -> each producer (parallel branches) -> QA -> Push -> Output
//   Request -> the chat agent (Independent) -> Output                   (questions, explanations, code reviews)
//
// - The coordinator (config coordinator / coordinatorLabel) takes each request and hands it out.
// - The producers write the code: `pipeline.producers`, or when that is null every `codingAgents`
//   label other than the coordinator's and QA's, once each, in config order.
// - QA (`pipeline.qa`, a dashboard label) is the LAST stage before the push for every flow that
//   produced code. It tests, and on a pass it pushes the flow's branch itself at the exact commit it
//   tested (tools/qa-cli.mjs `flow qa-push`, never forced, never a protected branch); on a fail the
//   flow goes back to the producer that made the change (qa-rework.mjs delivers the report), at most
//   `pipeline.maxReworks` times, then it stops. The user then opens the pull request with Send.
// - A flow that changed no code (an investigation, a plan, an ask) skips QA and Push: the coordinator's and each
//   producer's `no code changes` edge goes to the HUMAN TASK box (id `human`, role `human`, always drawn: it is the
//   user, not an agent), and from there to the Output (`done by hand`), or through Senior when there is one.
//   A flow with no by-hand steps passes it without stopping; one with steps waits there until the user ticks them
//   all (pipeline-hand.mjs handStage).
// - The chat agent (config factory.chat.name, the Ask drawer) answers, explains and reviews; it changes no
//   code, so it takes requests straight from the Request and its work ends at the Output. Rework never goes to
//   it. A config with no chat name, or one that names an agent already in the graph, draws no chat node.
// - The end node's id stays `outcome` (stored paths and routes name it); only its label says Output.
// - Three OPTIONAL agents, each drawn only when config names it (`pipeline.planner`, `pipeline.security`,
//   `pipeline.senior`, a dashboard label) and that label is not already the coordinator, QA, a producer, the chat
//   agent or an earlier optional agent (gateLabels):
//     the planner   between the coordinator and the producers: Request -> coordinator -> planner -> each producer.
//                   It only plans and hands out tasks (tools/plan-cli.mjs), so the coordinator no longer hands to a
//                   producer directly; its `own changes` and `no code changes` edges stay.
//     Security      after QA, before Push: QA -> Security on a pass, Security -> Push on a pass, Security -> each
//                   producer on a failure (rework, like QA's). QA still pushes, but only once Security passed the
//                   very commit QA passed (tools/security-cli.mjs, flow-security.mjs).
//     Senior        after Human task: Human task -> Senior (`done by hand`) -> Output (`reviewed`), and Senior -> Human
//                   task (`redo`) on a failure. It reviews work with no code to test (CI/CD, a cloud console, commands
//                   run in a terminal, a third-party account's settings): tools/senior-cli.mjs, flow-senior.mjs.
//   None is ever a producer (producersOf skips them when it derives the list). Their ids are taken after the
//   chat agent's, so no id of a config without them ever moves; with none the graph is exactly as before.
//
// Everything here is PURE: no file, no git, no config.json (config.mjs passes its values in), so the
// tests build any graph they like. ⚠️ It must not import flows.mjs or config.mjs: config.mjs imports
// this file, and flows.mjs fixes its data folder when it is first imported.
//
//   pipelineSettings(raw, warn)  the `pipeline` block of config.json, checked (config.mjs)
//   pipelineGraph(config)        { nodes: [{ id, kind, label, role }], edges: [{ from, to, label?, kind }] }
//   producersOf(config)          the producer labels
//   gateLabels(config)           { planner, security, senior }: the label of each optional agent that draws a box, or null
//   isCodeProducing(flow)        commit or diff evidence, a change in the summary, or a recorded pull request
//   stageOf(flow, graph)         { node, status, path, reworks }: where the flow stands, and how it got there

import { handStage } from './pipeline-hand.mjs'

/** The QA label, the producers (null: derived), the branches QA never pushes to, and how often a flow goes back. */
export const DEFAULT_PIPELINE = Object.freeze({ qa: 'QA', producers: null, protectedBranches: Object.freeze(['dev', 'stage', 'main', 'master']), maxReworks: 3 })
/** MUST CHANGE IN LOCKSTEP with flows.mjs AGENT_LABEL: the QA label ends up in relay prompts and `--by` checks. */
const LABEL = /^[A-Za-z0-9 ._-]{1,40}$/
/** A branch name or a pattern with `*`, like config.mjs pr.protect. */
const PATTERN = /^[A-Za-z0-9._/*][A-Za-z0-9._/*-]{0,99}$/
const MAX_REWORKS = 20

const fresh = () => ({ ...DEFAULT_PIPELINE, protectedBranches: [...DEFAULT_PIPELINE.protectedBranches] })

/**
 * The `pipeline` settings from the config value `raw`. Left out is the default. Each bad key keeps its default
 * with ONE warning (`warn`), never a failed startup: a typo must not stop the dashboard, and the defaults are the
 * safe side (QA is still the only one that pushes, and the shared branches stay protected).
 */
export function pipelineSettings(raw, warn = console.warn) {
  const out = fresh()
  if (raw === undefined) return out
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn('config.json: pipeline should be an object such as { "qa": "QA" }; the defaults are used.')
    return out
  }
  if (raw.qa !== undefined) {
    if (typeof raw.qa === 'string' && LABEL.test(raw.qa.trim())) out.qa = raw.qa.trim()
    else warn(`config.json: pipeline.qa needs a dashboard label (letters, digits, spaces, dots, dashes, underscores, at most 40); ${out.qa} is used.`)
  }
  if (raw.producers !== undefined && raw.producers !== null) {
    if (Array.isArray(raw.producers) && raw.producers.every(p => typeof p === 'string' && LABEL.test(p))) out.producers = [...new Set(raw.producers)]
    else warn('config.json: pipeline.producers needs null or a list of dashboard labels such as ["Agent 1"]; every coding agent is used.')
  }
  if (raw.protectedBranches !== undefined) {
    if (Array.isArray(raw.protectedBranches) && raw.protectedBranches.every(p => typeof p === 'string' && PATTERN.test(p) && !p.includes('..'))) out.protectedBranches = [...raw.protectedBranches]
    else warn(`config.json: pipeline.protectedBranches needs a list of branch names or patterns such as ["dev", "release/*"]; ${out.protectedBranches.join(', ')} are used.`)
  }
  if (raw.maxReworks !== undefined) {
    if (Number.isInteger(raw.maxReworks) && raw.maxReworks >= 0 && raw.maxReworks <= MAX_REWORKS) out.maxReworks = raw.maxReworks
    else warn(`config.json: pipeline.maxReworks needs a whole number from 0 to ${MAX_REWORKS}; ${out.maxReworks} is used.`)
  }
  gateSetting(raw, 'planner', out, warn)
  gateSetting(raw, 'security', out, warn)
  gateSetting(raw, 'senior', out, warn)
  return out
}

/** What a warning calls each optional agent when there is none. */
const NONE = { planner: 'planner', security: 'Security agent', senior: 'Senior agent' }

/**
 * An optional agent's label (`planner`, `security`, `senior`): left out or null is none, and then the key stays off the
 * settings, so a config without them reads exactly as before. A bad value is one warning and none.
 */
function gateSetting(raw, key, out, warn) {
  const v = raw[key]
  if (v === undefined || v === null) return
  if (typeof v === 'string' && LABEL.test(v.trim())) out[key] = v.trim()
  else warn(`config.json: pipeline.${key} needs null or a dashboard label (letters, digits, spaces, dots, dashes, underscores, at most 40); there is no ${NONE[key]}.`)
}

/** The settings a config object carries, or the defaults (a test config, an older config with no key). */
const settingsOf = config => ({ ...fresh(), ...(config?.pipeline || {}) })
const isLabel = v => typeof v === 'string' && v.trim() !== ''

/**
 * The producer labels: the configured list, else every coding agent's label but the coordinator's, QA's, the
 * planner's and Security's, once each. An explicit list wins: a label it names stays a producer (and a planner or
 * Security of that label then draws no box, gateLabels).
 */
export function producersOf(config) {
  const s = settingsOf(config)
  if (Array.isArray(s.producers)) return [...s.producers]
  const skip = new Set([config?.coordinatorLabel, s.qa, s.planner, s.security, s.senior].filter(isLabel))
  return [...new Set(Object.values(config?.codingAgents || {}).filter(l => typeof l === 'string' && l && !skip.has(l)))]
}

/** The coordinator's label as the graph draws it. */
const coordinatorOf = config => config?.coordinatorLabel || config?.coordinator || 'Coordinator'

/** The chat agent's label when it draws a node (a name not already the coordinator, a producer or QA), else ''. */
function chatOf(config, producers) {
  const label = String(config?.factory?.chat?.name ?? '').trim()
  return label && ![coordinatorOf(config), ...producers, settingsOf(config).qa].includes(label) ? label : ''
}

/**
 * { planner, security, senior }: each optional agent's configured label when it draws a box, else null. A label that
 * is already the coordinator, QA, a producer or the chat agent draws no second box, and a later one may not take an
 * earlier one's label either (the planner is placed first, then Security, then Senior).
 */
export function gateLabels(config) {
  const s = settingsOf(config)
  const producers = producersOf(config)
  const taken = new Set([coordinatorOf(config), s.qa, ...producers, chatOf(config, producers)].filter(isLabel))
  const pick = v => {
    if (!isLabel(v) || taken.has(v)) return null
    taken.add(v)
    return v
  }
  const planner = pick(s.planner)
  const security = pick(s.security)
  return { planner, security, senior: pick(s.senior) }
}

/** `Agent 1` -> `agent-1`; never empty. */
const slug = label => String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'

/**
 * The graph, in execution order. Node ids are stable slugs of the labels; the fixed steps keep their own ids
 * (request, human, push, outcome), and a label that would take an id already used gets -2, -3 … Edge kinds:
 *   main    the way every code change goes
 *   branch  the coordinator handing work out (one per producer, and to QA for its own changes)
 *   rework  QA sending a failure back to a producer
 *   skip    a flow that changed no code: to Human task, then on to the Output (through Senior when there is one)
 * A Senior failure going back to Human task is a `rework` edge too (`redo`).
 */
export function pipelineGraph(config) {
  const s = settingsOf(config)
  const used = new Set(['request', 'human', 'push', 'outcome'])
  const idFor = label => {
    const base = slug(label)
    let id = base
    for (let k = 2; used.has(id); k++) id = `${base}-${k}`
    used.add(id)
    return id
  }
  const coordinatorLabel = coordinatorOf(config)
  const coordinator = { id: idFor(coordinatorLabel), kind: 'agent', label: coordinatorLabel, role: 'coordinator' }
  const producers = producersOf(config).map(label => ({ id: idFor(label), kind: 'agent', label, role: 'producer' }))
  const qa = { id: idFor(s.qa), kind: 'agent', label: s.qa, role: 'qa' }
  // the chat agent's id is taken LAST, so it never moves QA's; a name already in the graph draws no chat node
  const chatLabel = chatOf(config, producers.map(p => p.label))
  const chat = chatLabel ? { id: idFor(chatLabel), kind: 'agent', label: chatLabel, role: 'chat' } : null
  // the optional agents' ids after even the chat agent's, so a config without them keeps every id it had
  const gates = gateLabels(config)
  const planner = gates.planner ? { id: idFor(gates.planner), kind: 'agent', label: gates.planner, role: 'planner' } : null
  const security = gates.security ? { id: idFor(gates.security), kind: 'agent', label: gates.security, role: 'security' } : null
  const senior = gates.senior ? { id: idFor(gates.senior), kind: 'agent', label: gates.senior, role: 'senior' } : null
  const nodes = [
    { id: 'request', kind: 'start', label: 'Request', role: 'request' },
    coordinator,
    ...(planner ? [planner] : []),
    ...producers,
    ...(chat ? [chat] : []),
    qa,
    ...(security ? [security] : []),
    // the user's own box: a fixed step like Push, never an agent (no settings window, no model)
    { id: 'human', kind: 'step', label: 'Human task', role: 'human' },
    ...(senior ? [senior] : []),
    { id: 'push', kind: 'step', label: 'Push', role: 'push' },
    { id: 'outcome', kind: 'end', label: 'Output', role: 'outcome' },
  ]
  const edges = [{ from: 'request', to: coordinator.id, kind: 'main' }]
  // with a planner the coordinator hands each producer's task to it, and the planner hands it out
  if (planner) edges.push({ from: coordinator.id, to: planner.id, kind: 'main' })
  for (const p of producers) edges.push({ from: (planner || coordinator).id, to: p.id, kind: 'branch' })
  // the coordinator's own changes are tested too; with no producers that is the main way
  edges.push(producers.length ? { from: coordinator.id, to: qa.id, label: 'own changes', kind: 'branch' } : { from: coordinator.id, to: qa.id, kind: 'main' })
  for (const p of producers) edges.push({ from: p.id, to: qa.id, kind: 'main' })
  // with Security a QA pass goes to it first, and only its own pass goes on to Push
  if (security) edges.push({ from: qa.id, to: security.id, label: 'passed', kind: 'main' }, { from: security.id, to: 'push', label: 'passed', kind: 'main' })
  else edges.push({ from: qa.id, to: 'push', label: 'passed', kind: 'main' })
  for (const p of producers) edges.push({ from: qa.id, to: p.id, label: 'failed', kind: 'rework' })
  if (security) for (const p of producers) edges.push({ from: security.id, to: p.id, label: 'failed', kind: 'rework' })
  edges.push({ from: 'push', to: 'outcome', kind: 'main' })
  // no code changes: to Human task (the user), where a flow with by-hand steps waits, then on to the Output
  for (const p of producers) edges.push({ from: p.id, to: 'human', label: 'no code changes', kind: 'skip' })
  edges.push({ from: coordinator.id, to: 'human', label: 'no code changes', kind: 'skip' })
  if (senior) edges.push({ from: 'human', to: senior.id, label: 'done by hand', kind: 'skip' }, { from: senior.id, to: 'outcome', label: 'reviewed', kind: 'skip' }, { from: senior.id, to: 'human', label: 'redo', kind: 'rework' })
  else edges.push({ from: 'human', to: 'outcome', label: 'done by hand', kind: 'skip' })
  // last, so every edge above keeps its index (the Agents page keys its arrows by it)
  if (chat) edges.push({ from: 'request', to: chat.id, kind: 'branch' }, { from: chat.id, to: 'outcome', label: 'no code changes', kind: 'skip' })
  return { nodes, edges }
}

const isText = v => typeof v === 'string' && v.trim() !== ''

/**
 * Whether the flow produced code, so it must pass QA before it is pushed or sent: a commit or diff in any
 * step's evidence, a commit or diff in its summary's changes, or a pull request it recorded (`flow pr`).
 */
export function isCodeProducing(flow) {
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : []
  if (nodes.some(n => (Array.isArray(n?.evidence) ? n.evidence : []).some(e => e?.kind === 'commit' || e?.kind === 'diff'))) return true
  const out = flow?.output
  if (Array.isArray(out?.changes) && out.changes.some(c => c?.kind === 'commit' || c?.kind === 'diff')) return true
  return !!out?.merge && typeof out.merge === 'object'
}

/** A failed attempt that went back (or is going back) to a producer. */
const sentBack = a => a?.status === 'failed' && isText(a?.rework?.to)

/**
 * Where a flow stands: { node, status, path, reworks }. `node` is a graph node id (null for a dropped flow),
 * `path` the node ids it went through in order, ending at `node`, with one QA visit per attempt and one
 * producer visit per rework, and `reworks` how many times QA sent it back.
 *
 *   dropped                               node null, status dropped
 *   no qa, open or blocked                its agent's node (a producer, the coordinator, QA), working or blocked;
 *                                         an agent not in the graph sits on the coordinator
 *   the chat agent's flow                 on the chat node straight from the request; done is the Output (it
 *                                         changes no code, so it never waits for QA)
 *   no qa, done, no code changes          outcome, done, past Human task (it does not stop there)
 *   no qa, by-hand steps or Senior data   Human task, then Senior: pipeline-hand.mjs handStage says how
 *   no qa, done, code changes             qa, waiting (for QA to pick it up)
 *   qa pending or testing                 qa, pending or testing
 *   qa failed, sent back                  the producer it went back to, rework
 *   qa failed with no producer, qa-failed qa, failed (stopped)
 *   qa passed, not pushed                 push, waiting; failed when the push was refused
 *   qa passed and pushed                  outcome, passed
 * With a planner on the graph (pipeline.planner):
 *   plan planning (flow-plan.mjs)         the planner, working: the coordinator handed it the request
 *   plan handed                           the producer it went to (the flow's agent), through the planner
 *   no plan record                        as above: a flow the producer started itself was never planned
 * With Security on the graph (pipeline.security), between a QA pass and Push (flow-security.mjs, qa.security):
 *   qa passed, no security yet            security, waiting
 *   security reviewing                    security, reviewing
 *   security failed, sent back            the producer it went back to, rework (it counts as a rework)
 *   security failed with no producer,     security, failed (stopped)
 *     security-failed
 *   security passed                       on to Push, as a QA pass is without Security
 * Security data on a graph without Security, a plan on one without a planner, or Senior data on one without Senior,
 * is not drawn.
 */
export function stageOf(flow, graph) {
  const byLabel = new Map(graph.nodes.filter(n => n.kind === 'agent').map(n => [n.label, n]))
  const coordinator = graph.nodes.find(n => n.role === 'coordinator')
  const qaNode = graph.nodes.find(n => n.role === 'qa')
  const producerId = label => {
    const n = byLabel.get(label)
    return n?.role === 'producer' ? n.id : null
  }
  const out = (node, status, path, reworks = 0) => ({ node, status, path, reworks })
  if (flow?.status === 'dropped') return out(null, 'dropped', [])

  const own = byLabel.get(flow?.agent) || coordinator
  if (own.role === 'chat') {
    if (flow?.status === 'done') return out('outcome', 'done', ['request', own.id, 'outcome'])
    return out(own.id, flow?.status === 'blocked' ? 'blocked' : 'working', ['request', own.id])
  }
  const path = ['request', coordinator.id]
  const plannerNode = graph.nodes.find(n => n.role === 'planner')
  if (plannerNode && flow?.plan && typeof flow.plan === 'object' && own.id !== plannerNode.id) path.push(plannerNode.id)
  if (own.id !== coordinator.id) path.push(own.id)
  const qa = flow?.qa
  if (!qa || typeof qa !== 'object') {
    if (flow?.status === 'done' && isCodeProducing(flow)) return out(qaNode.id, 'waiting', [...path, qaNode.id])
    // by-hand steps or a Senior record: Human task, then Senior (pipeline-hand.mjs); else as before
    const hand = handStage(flow, graph, path)
    if (hand) return hand
    if (flow?.status === 'done') return out('outcome', 'done', [...path, 'outcome'])
    return out(path.at(-1), flow?.status === 'blocked' ? 'blocked' : 'working', path)
  }

  // the QA side: one visit per attempt, then back to the producer for every one sent back; with Security, a
  // passed attempt Security looked at visits it too, and goes back from there on a Security failure
  const secNode = graph.nodes.find(n => n.role === 'security')
  const reviewOf = a => (secNode && a?.status === 'passed' && a.security && typeof a.security === 'object' ? a.security : null)
  let reworks = 0
  const attempts = [...(Array.isArray(qa.attempts) ? qa.attempts : []), qa]
  for (const a of attempts) {
    path.push(qaNode.id)
    const review = reviewOf(a)
    if (review) path.push(secNode.id)
    const back = (sentBack(a) || sentBack(review)) && producerId((review || a).rework.to)
    if (back) {
      reworks++
      path.push(back)
    }
  }
  const last = path.at(-1)
  switch (qa.status) {
    case 'pending':
    case 'testing':
      return out(qaNode.id, qa.status, path, reworks)
    case 'failed':
      return last === qaNode.id ? out(qaNode.id, 'failed', path, reworks) : out(last, 'rework', path, reworks)
    case 'passed':
      if (secNode) {
        const review = reviewOf(qa)
        if (!review) return out(secNode.id, 'waiting', [...path, secNode.id], reworks)
        if (review.status === 'reviewing') return out(secNode.id, 'reviewing', path, reworks)
        if (review.status === 'failed' && last !== secNode.id) return out(last, 'rework', path, reworks)
        if (review.status !== 'passed') return out(secNode.id, 'failed', path, reworks) // stopped, or no producer to go back to
      }
      path.push('push')
      if (qa.pushedAt) return out('outcome', 'passed', [...path, 'outcome'], reworks)
      return out('push', qa.pushError ? 'failed' : 'waiting', path, reworks)
    default: // qa-failed, or anything a hand-edited file says: stopped at QA
      return out(qaNode.id, 'failed', path, reworks)
  }
}
