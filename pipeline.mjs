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
// - A flow that changed no code (an investigation, a plan, an ask) skips QA and Push: its producer's
//   `no code changes` edge goes straight to the Output.
// - The chat agent (config factory.chat.name, the Ask drawer) answers, explains and reviews; it changes no
//   code, so it takes requests straight from the Request and its work ends at the Output. Rework never goes to
//   it. A config with no chat name, or one that names an agent already in the graph, draws no chat node.
// - The end node's id stays `outcome` (stored paths and routes name it); only its label says Output.
//
// Everything here is PURE: no file, no git, no config.json (config.mjs passes its values in), so the
// tests build any graph they like. ⚠️ It must not import flows.mjs or config.mjs: config.mjs imports
// this file, and flows.mjs fixes its data folder when it is first imported.
//
//   pipelineSettings(raw, warn)  the `pipeline` block of config.json, checked (config.mjs)
//   pipelineGraph(config)        { nodes: [{ id, kind, label, role }], edges: [{ from, to, label?, kind }] }
//   producersOf(config)          the producer labels
//   isCodeProducing(flow)        commit or diff evidence, a change in the summary, or a recorded pull request
//   stageOf(flow, graph)         { node, status, path, reworks }: where the flow stands, and how it got there

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
  return out
}

/** The settings a config object carries, or the defaults (a test config, an older config with no key). */
const settingsOf = config => ({ ...fresh(), ...(config?.pipeline || {}) })

/** The producer labels: the configured list, else every coding agent's label but the coordinator's and QA's, once each. */
export function producersOf(config) {
  const s = settingsOf(config)
  if (Array.isArray(s.producers)) return [...s.producers]
  const skip = new Set([config?.coordinatorLabel, s.qa].filter(Boolean))
  return [...new Set(Object.values(config?.codingAgents || {}).filter(l => typeof l === 'string' && l && !skip.has(l)))]
}

/** `Agent 1` -> `agent-1`; never empty. */
const slug = label => String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'

/**
 * The graph, in execution order. Node ids are stable slugs of the labels; the fixed steps keep their own ids
 * (request, push, outcome), and a label that would take an id already used gets -2, -3 … Edge kinds:
 *   main    the way every code change goes
 *   branch  the coordinator handing work out (one per producer, and to QA for its own changes)
 *   rework  QA sending a failure back to a producer
 *   skip    a flow that changed no code, straight to the outcome
 */
export function pipelineGraph(config) {
  const s = settingsOf(config)
  const used = new Set(['request', 'push', 'outcome'])
  const idFor = label => {
    const base = slug(label)
    let id = base
    for (let k = 2; used.has(id); k++) id = `${base}-${k}`
    used.add(id)
    return id
  }
  const coordinatorLabel = config?.coordinatorLabel || config?.coordinator || 'Coordinator'
  const coordinator = { id: idFor(coordinatorLabel), kind: 'agent', label: coordinatorLabel, role: 'coordinator' }
  const producers = producersOf(config).map(label => ({ id: idFor(label), kind: 'agent', label, role: 'producer' }))
  const qa = { id: idFor(s.qa), kind: 'agent', label: s.qa, role: 'qa' }
  // the chat agent's id is taken LAST, so it never moves QA's; a name already in the graph draws no chat node
  const chatLabel = String(config?.factory?.chat?.name ?? '').trim()
  const taken = new Set([coordinator.label, ...producers.map(p => p.label), qa.label])
  const chat = chatLabel && !taken.has(chatLabel) ? { id: idFor(chatLabel), kind: 'agent', label: chatLabel, role: 'chat' } : null
  const nodes = [
    { id: 'request', kind: 'start', label: 'Request', role: 'request' },
    coordinator,
    ...producers,
    ...(chat ? [chat] : []),
    qa,
    { id: 'push', kind: 'step', label: 'Push', role: 'push' },
    { id: 'outcome', kind: 'end', label: 'Output', role: 'outcome' },
  ]
  const edges = [{ from: 'request', to: coordinator.id, kind: 'main' }]
  for (const p of producers) edges.push({ from: coordinator.id, to: p.id, kind: 'branch' })
  // the coordinator's own changes are tested too; with no producers that is the main way
  edges.push(producers.length ? { from: coordinator.id, to: qa.id, label: 'own changes', kind: 'branch' } : { from: coordinator.id, to: qa.id, kind: 'main' })
  for (const p of producers) edges.push({ from: p.id, to: qa.id, kind: 'main' })
  edges.push({ from: qa.id, to: 'push', label: 'passed', kind: 'main' })
  for (const p of producers) edges.push({ from: qa.id, to: p.id, label: 'failed', kind: 'rework' })
  edges.push({ from: 'push', to: 'outcome', kind: 'main' })
  for (const p of producers) edges.push({ from: p.id, to: 'outcome', label: 'no code changes', kind: 'skip' })
  edges.push({ from: coordinator.id, to: 'outcome', label: 'no code changes', kind: 'skip' })
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
 *   no qa, done, no code changes          outcome, done, by the skip edge
 *   no qa, done, code changes             qa, waiting (for QA to pick it up)
 *   qa pending or testing                 qa, pending or testing
 *   qa failed, sent back                  the producer it went back to, rework
 *   qa failed with no producer, qa-failed qa, failed (stopped)
 *   qa passed, not pushed                 push, waiting; failed when the push was refused
 *   qa passed and pushed                  outcome, passed
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
  if (own.id !== coordinator.id) path.push(own.id)
  const qa = flow?.qa
  if (!qa || typeof qa !== 'object') {
    if (flow?.status === 'done') {
      if (!isCodeProducing(flow)) return out('outcome', 'done', [...path, 'outcome'])
      return out(qaNode.id, 'waiting', [...path, qaNode.id])
    }
    return out(path.at(-1), flow?.status === 'blocked' ? 'blocked' : 'working', path)
  }

  // the QA side: one visit per attempt, then back to the producer for every one sent back
  let reworks = 0
  const attempts = [...(Array.isArray(qa.attempts) ? qa.attempts : []), qa]
  for (const a of attempts) {
    path.push(qaNode.id)
    const back = sentBack(a) && producerId(a.rework.to)
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
      path.push('push')
      if (qa.pushedAt) return out('outcome', 'passed', [...path, 'outcome'], reworks)
      return out('push', qa.pushError ? 'failed' : 'waiting', path, reworks)
    default: // qa-failed, or anything a hand-edited file says: stopped at QA
      return out(qaNode.id, 'failed', path, reworks)
  }
}
