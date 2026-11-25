// The quality commands, behind `node tools/factory.mjs flow …` (tools/flow-cli.mjs registers them over its own):
//
//   self-check <flow> [--done "<id>=ok|no:<note>"]...
//       Without --done: the checklist for THIS flow (quality-selfcheck.mjs: the core checks, then the lessons that
//       match it), with how to answer. With --done: every item answered, recorded as flow.selfcheck; a `no` needs a
//       note, an unknown id or a missing answer is refused with one line and nothing is written.
//   new, rules [<flow>], plan (the planner's hand-out)
//       After the command's own output (and the rules it prints), the ACTIVE lessons that match the task, at most 7,
//       each with its area and why (quality-lessons.mjs lessonsFor). `rules` with no flow reads the agent's newest
//       open flow, and with none of its own, the general lessons only. `new` and `plan` also store the risk label
//       (quality-risk.mjs) and lay it over the planned route (riskRoute): Security or Senior join it when the label
//       asks and that agent is on the pipeline.
//   qa-start
//       With pipeline.requireSelfCheck, a CODE flow with no self-check is refused BEFORE anything is written
//       (selfCheckRefusal). After a good start: the producer's self-check, the risk label, and for a label that asks
//       for a deeper QA pass, one extra line.
//
// A refused command prints nothing extra (it has nothing to start). Like the other flow commands they return
// { out, code } and never print; `config` comes from runFlow's context (tests pass their own), else config.mjs CONFIG.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG } from '../config.mjs'
import { changeRoute } from '../flow-route.mjs'
import { listFlows, readFlow, writeFlow } from '../flows.mjs'
import { pipelineGraph } from '../pipeline.mjs'
import { qualityOf } from '../quality-config.mjs'
import { riskFacts, taskOf } from '../quality-facts.mjs'
import { lessonsBlock, lessonsFor, readLessons } from '../quality-lessons.mjs'
import { riskOf, riskRoute, riskText } from '../quality-risk.mjs'
import { answerChecklist, checklistFor, checklistText, doneValues, selfCheckBlock, selfCheckRefusal } from '../quality-selfcheck.mjs'
import { taskAreas } from '../quality-areas.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'factory.mjs').replace(/\\/g, '/')
const DEEP_QA = 'This task asks for a deeper QA pass: test the edge cases its risk names (wrong input, a signed-out user, a second click, a failure half way), not only the happy path.'
const fail = out => ({ out, code: 1 })
const ok = out => ({ out, code: 0 })
const now = () => new Date().toISOString()
const add = (result, block) => (result.code || !block ? result : { ...result, out: `${result.out}\n${block}` })
const configOf = ctx => ctx.config || CONFIG

function load(id) {
  const flow = readFlow(id)
  if (!flow) throw new Error(`No flow ${id}`)
  return flow
}

/** The lessons that match `flow` (or, with no flow, the general ones), as the brief prints them. */
function lessonsText(flow, config) {
  const q = qualityOf(config)
  return lessonsBlock(lessonsFor(flow ? taskOf(flow) : {}, { store: readLessons(), areas: q.areas }))
}

/**
 * Work out the risk label and store it on the flow, laying it over a stored route (riskRoute). Writes only when
 * something changed. Never throws: the label is a side note on a command that already succeeded.
 */
export function storeRisk(id, config, by) {
  try {
    const flow = readFlow(id)
    if (!flow) return null
    const risk = riskOf(flow, { ...riskFacts(flow), rules: qualityOf(config).riskRules })
    let changed = JSON.stringify([risk.level, risk.reasons, risk.needs]) !== JSON.stringify([flow.risk?.level, flow.risk?.reasons, flow.risk?.needs])
    if (changed) flow.risk = { ...risk, at: now() }
    const laid = flow.route ? riskRoute(flow.route, risk, pipelineGraph(config)) : null
    if (laid?.changed) {
      changeRoute(flow, { type: flow.route.type, steps: laid.steps, at: now(), by: by || flow.agent })
      changed = true
    }
    if (changed) writeFlow(flow)
    return flow.risk
  } catch (err) {
    console.error(`quality: could not store the risk label of ${id}: ${err?.message || err}`)
    return null
  }
}

/** The newest open (or blocked) flow of agent `by`, or null. */
function newestOf(by) {
  const mine = listFlows({ agent: by }).flows.filter(f => f.status === 'open' || f.status === 'blocked')
  return mine.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null
}

/** Does this task have a screen to look at: the ui area, or result shots on the flow. */
const hasScreen = (flow, config) => taskAreas(taskOf(flow), qualityOf(config).areas).has('ui') || (flow.output?.result || []).length > 0

/**
 * The quality commands over `given` (flow-cli.mjs's COMMANDS): the four it wraps are taken NOW, so assigning the
 * result back over the same object never makes a wrapper call itself.
 */
export function qualityCommands(given, { noName }) {
  const commands = { new: given.new, rules: given.rules, plan: given.plan, 'qa-start': given['qa-start'] }
  function selfCheck(f, ctx) {
    if (!ctx.by) return fail(noName)
    const config = configOf(ctx)
    const flow = load(f._[0])
    const picked = lessonsFor(taskOf(flow), { store: readLessons(), areas: qualityOf(config).areas })
    const items = checklistFor(picked, { ui: hasScreen(flow, config) })
    let values
    try {
      values = doneValues(ctx.argv)
    } catch (err) {
      return fail(err.message)
    }
    if (!values.length) {
      const risk = flow.risk ? `\n${riskText(flow.risk)}` : ''
      return ok(`${checklistText(flow.id, items, CLI)}${risk}`)
    }
    const r = answerChecklist(items, values)
    if (r.error) return fail(r.error)
    flow.selfcheck = { at: now(), by: ctx.by, items: r.items }
    writeFlow(flow)
    const no = r.items.filter(it => !it.ok).length
    return ok(`${flow.id}: self-check recorded, ${r.items.length - no} ok, ${no} no. QA reads it when it starts testing.`)
  }

  const afterNew = (f, ctx) => {
    const r = commands.new(f, ctx)
    if (r.code) return r
    storeRisk(f._[0], configOf(ctx), ctx.by)
    return add(r, lessonsText(readFlow(f._[0]), configOf(ctx)))
  }

  const afterRules = (f, ctx) => {
    const r = commands.rules(f, ctx)
    if (r.code) return r
    const flow = f._[0] ? load(f._[0]) : newestOf(ctx.by)
    return add(r, lessonsText(flow, configOf(ctx)))
  }

  const afterPlan = (f, ctx) => {
    const r = commands.plan(f, ctx)
    if (r.code) return r
    storeRisk(f._[0], configOf(ctx), ctx.by)
    const flow = readFlow(f._[0])
    const block = lessonsText(flow, configOf(ctx))
    const risk = flow?.risk ? riskText(flow.risk) : ''
    return add(r, [block && `Pass these on to ${flow.agent} with the plan.\n${block}`, risk].filter(Boolean).join('\n'))
  }

  const aroundQaStart = (f, ctx) => {
    const config = configOf(ctx)
    const flow = readFlow(f._[0])
    // the QA label check comes first (the command's own), so a stranger is never told about the self-check
    if (flow && ctx.by === config.pipeline?.qa) {
      const refused = selfCheckRefusal(flow, qualityOf(config))
      if (refused) return fail(refused)
    }
    const r = commands['qa-start'](f, ctx)
    if (r.code) return r
    const started = readFlow(f._[0])
    const risk = started.risk || riskOf(started, { ...riskFacts(started), rules: qualityOf(config).riskRules })
    return add(r, [selfCheckBlock(started), riskText(risk), ...(risk.needs?.includes('deep-qa') ? [DEEP_QA] : [])].join('\n'))
  }

  return { 'self-check': selfCheck, new: afterNew, rules: afterRules, plan: afterPlan, 'qa-start': aroundQaStart }
}
