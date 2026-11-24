// The planner's commands, behind `node tools/factory.mjs flow …` (tools/flow-cli.mjs registers them). The planner
// (config pipeline.planner, pipeline.mjs) sits between the coordinator and the producers: it only plans and hands
// out tasks, and writes no code. Its record is the flow's `plan` block (flow-plan.mjs):
//
//   plan-start <flow> --by Planner
//       The planner took the request from the coordinator: plan.status planning, so the flow stands on the
//       planner (pipeline.mjs stageOf). Again while planning: the same, with a fresh time. After a hand-out: a new
//       plan (the hand-out stays in plan.history). A dropped flow is refused.
//   plan <flow> --file <plan.md|plan.txt> --to "<producer label>" --by Planner
//       The hand-out: the plan file is copied into the flow's evidence folder (<flow>/plan-<n>.md), plan.status
//       handed, and the flow's agent becomes that producer, so its answers, and any QA or Security failure, go to
//       it. A build flow's route is planned again for that producer (through the planner; the old route stays in
//       its history). The planner then messages the producer itself, naming the flow.
//
// ⚠️ ONLY THE PLANNER: both refuse unless the pipeline has a planner and --by (or FACTORY_BY) is exactly its label,
// like the QA commands (tools/qa-cli.mjs). These are the only writers of `flow.plan`.
//
// Like the other flow commands they return { out, code } and never print. `config` comes from runFlow's context
// (tests pass their own); left out, config.mjs CONFIG.

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

import { CONFIG } from '../config.mjs'
import { asHandout, PLAN_EXT, PLAN_HISTORY } from '../flow-plan.mjs'
import { changeRoute, planRoute } from '../flow-route.mjs'
import { EVIDENCE_DIR, readFlow, validateFlow, writeFlow } from '../flows.mjs'
import { gateLabels, pipelineGraph, producersOf } from '../pipeline.mjs'

const fail = out => ({ out, code: 1 })
const ok = out => ({ out, code: 0 })
const now = () => new Date().toISOString()

function load(id) {
  const flow = readFlow(id)
  if (!flow) throw new Error(`No flow ${id}`)
  return flow
}

/**
 * Where a Markdown or text document goes in the flow's evidence folder: <flow>/<stem>.<md|txt>, numbered -2, -3 …
 * when taken; null when the file is missing, not a file, or not .md or .txt (a document is never HTML). Shared
 * with tools/security-cli.mjs; the same rules as tools/qa-cli.mjs's report.
 */
export function docTarget(flowId, stem, given, cwd, exts = PLAN_EXT) {
  if (given === undefined || given === true) return null
  const src = path.resolve(cwd, String(given))
  const ext = path.extname(src).slice(1).toLowerCase()
  if (!exts.includes(ext) || !existsSync(src) || !statSync(src).isFile()) return null
  let name = `${stem}.${ext}`
  for (let k = 2; existsSync(path.resolve(EVIDENCE_DIR, flowId, name)); k++) name = `${stem}-${k}.${ext}`
  const dest = path.resolve(EVIDENCE_DIR, flowId, name)
  const rel = path.relative(EVIDENCE_DIR, dest)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || path.dirname(rel) !== flowId) return null
  return { src, dest, ref: `${flowId}/${name}` }
}

/** The `plan:` line of flow show's Output block (stderr), or nothing when the flow was never planned. */
export function planBlock(flow) {
  const p = flow.plan
  if (!p || typeof p !== 'object') return []
  return [p.status === 'handed' ? `  plan: handed to ${p.to} by ${p.by} at ${p.at}, the plan in ${p.file}` : `  plan: ${p.by} is planning it (since ${p.startedAt})`]
}

/** The planner's commands, given the CLI's refusal for a missing name and its evidence copier. */
export function planCommands({ noName, copyEvidence }) {
  /** One line when `by` may not record a plan; null when it may. */
  function notPlanner(by, config) {
    const planner = gateLabels(config).planner
    if (!planner) return 'This pipeline has no planner (config pipeline.planner), so there is no plan to record.'
    if (!by) return noName
    return by === planner ? null : `Only the planner records a plan: --by must be "${planner}" (config pipeline.planner), not "${by}".`
  }

  function planStart(f, { by, config = CONFIG }) {
    const refused = notPlanner(by, config)
    if (refused) return fail(refused)
    const flow = load(f._[0])
    if (flow.status === 'dropped') return fail(`${flow.id} is dropped: there is nothing to plan.`)
    const cur = flow.plan && typeof flow.plan === 'object' ? flow.plan : null
    const at = now()
    const history = cur?.status === 'handed' ? [...(cur.history || []), asHandout(cur)].slice(-PLAN_HISTORY) : cur?.history || []
    flow.plan = { status: 'planning', by, startedAt: cur?.status === 'planning' ? cur.startedAt : at, at, ...(history.length ? { history } : {}) }
    if (flow.status === 'done' || flow.status === 'blocked') flow.status = 'open'
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    writeFlow(flow)
    return ok(`${flow.id}: ${by} is planning it. Hand it out with flow plan ${flow.id} --file <plan.md> --to "<producer>".`)
  }

  function planHandout(f, { by, cwd, config = CONFIG }) {
    const refused = notPlanner(by, config)
    if (refused) return fail(refused)
    const flow = load(f._[0])
    if (flow.status === 'dropped') return fail(`${flow.id} is dropped: there is nothing to hand out.`)
    const producers = producersOf(config)
    if (typeof f.to !== 'string' || !f.to) return fail(`plan needs --to "<producer>": who gets the task (${producers.join(', ') || 'there are no producers'})`)
    if (!producers.includes(f.to)) return fail(`${f.to} is not a producer, so it cannot get the task. The producers are ${producers.join(', ') || 'none'}.`)
    const cur = flow.plan && typeof flow.plan === 'object' ? flow.plan : null
    const earlier = cur?.status === 'handed' ? [...(cur.history || []), asHandout(cur)] : cur?.history || []
    const copy = docTarget(flow.id, `plan-${earlier.length + 1}`, f.file, cwd)
    if (!copy) return fail('plan needs --file <plan.md>: an existing .md or .txt file with the plan (never HTML)')
    const at = now()
    const history = earlier.slice(-PLAN_HISTORY)
    flow.plan = { status: 'handed', by, startedAt: cur?.status === 'planning' ? cur.startedAt : at, at, to: f.to, file: copy.ref, ...(history.length ? { history } : {}) }
    flow.agent = f.to
    if (flow.status === 'done' || flow.status === 'blocked') flow.status = 'open'
    // a build is planned again for the producer that has it now: through the planner (flow-route.mjs)
    let routed = ''
    if (!flow.route || flow.route.type === 'build') {
      const plan = planRoute('build', f.to, pipelineGraph(config))
      if (plan.steps && JSON.stringify(plan.steps) !== JSON.stringify(flow.route?.steps)) {
        changeRoute(flow, { type: 'build', steps: plan.steps, at, by })
        routed = ' Its route now goes through you to it.'
      }
    }
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    copyEvidence(copy)
    writeFlow(flow)
    return ok(`${flow.id}: handed to ${f.to} with the plan.${routed} Now send ${f.to} a message naming flow ${flow.id}: its answers, and any QA or Security failure, go to it.`)
  }

  return { 'plan-start': planStart, plan: planHandout }
}
