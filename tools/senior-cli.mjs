// The Senior commands, behind `node tools/factory.mjs flow …` (tools/flow-cli.mjs registers them). Senior (config
// pipeline.senior, pipeline.mjs) reviews work that has no code to test: CI/CD setup, cloud console changes, commands
// run in a terminal, settings in a third-party account. Its record is `flow.senior` (flow-senior.mjs):
//
//   senior-ask <flow> "<what to review>" --by <any agent>
//       Send a no-code flow to Senior on purpose, steps or not (a CI change an agent made through a web console with
//       its own tools, say). The flow then waits at Senior (pipeline-hand.mjs). Again while asked: the new text.
//   senior-start <flow> --by Senior
//       Senior picks the flow up: status reviewing. Refused unless the flow waits at Senior: every by-hand step
//       ticked by the user, or a senior-ask. Again while reviewing: the same, with a fresh time.
//   senior <flow> pass|fail "<what was checked / what to redo>" [--steps h1,h2] --by Senior
//       The verdict, on a flow that waits at Senior or is being reviewed. PASS finishes the flow (done). FAIL sends it
//       back to the Human task box: the steps named with --steps (every step when none is named) are unticked, the
//       text shows at the top of the flow's by-hand checklist, and the user does them again; ticked again, the flow
//       waits at Senior for a new verdict. Past pipeline.maxReworks failures: senior-failed, the flow blocked.
//
// ⚠️ ONLY SENIOR records a review: senior-start and senior refuse unless the pipeline has Senior and --by (or
// FACTORY_BY) is exactly its label. Any agent may senior-ask, but never Senior itself. None of them works on a flow
// with a QA record: code goes to QA. Senior never runs Terraform, never changes a live cloud project or a production
// database: it reads, asks for evidence and gives a verdict.
//
// Like the other flow commands they return { out, code } and never print. `config` comes from runFlow's context.

import { CONFIG } from '../config.mjs'
import { failedSoFar, SENIOR_MAX } from '../flow-senior.mjs'
import { readFlow, validateFlow, writeFlow } from '../flows.mjs'
import { allTicked, handSteps } from '../pipeline-hand.mjs'
import { gateLabels } from '../pipeline.mjs'

const fail = out => ({ out, code: 1 })
const ok = out => ({ out, code: 0 })
const now = () => new Date().toISOString()
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const STEP_ID = /^[a-z0-9-]+$/

function load(id) {
  const flow = readFlow(id)
  if (!flow) throw new Error(`No flow ${id}`)
  return flow
}

/** The record with its current failure moved into history, ready for a new ask or review. */
const fresh = rec => {
  const history = failedSoFar(rec).slice(-SENIOR_MAX.history)
  return history.length ? { history } : {}
}

export function seniorCommands({ noName }) {
  /** One line when `by` may not record a review; null when it may. */
  function notSenior(by, config) {
    const label = gateLabels(config).senior
    if (!label) return 'This pipeline has no Senior agent (config pipeline.senior), so there is nothing to review.'
    if (!by) return noName
    return by === label ? null : `Only Senior records a review: --by must be "${label}" (config pipeline.senior), not "${by}".`
  }

  /** A flow Senior can never take: dropped, or on the QA path. */
  function offRoute(flow) {
    if (flow.status === 'dropped') return `${flow.id} is dropped: there is nothing to review.`
    if (isObject(flow.qa)) return `${flow.id} went to QA: code is tested by QA, and Senior reviews only work with no code to test.`
    return null
  }

  /** The record when the flow waits at Senior or is being reviewed, else a one-line refusal that says what is missing. */
  function reviewable(flow) {
    const off = offRoute(flow)
    if (off) return { error: off }
    const rec = isObject(flow.senior) ? flow.senior : null
    if (rec?.status === 'passed') return { error: `${flow.id}: Senior already passed it.` }
    if (rec?.status === 'senior-failed') return { error: `${flow.id}: Senior failed it too often and it is stopped: the user decides what happens next.` }
    if (rec?.status === 'released') return { error: `${flow.id}: the user finished it without a Senior review.` }
    if (rec?.status === 'asked' || rec?.status === 'reviewing') return { rec }
    const steps = handSteps(flow)
    if (!steps.length) return { error: rec?.status === 'failed' ? `${flow.id}: Senior sent it back, and it has no by-hand steps to tick again: the agent sends it again with senior-ask once the work is redone.` : `${flow.id} has no by-hand steps and no one sent it to Senior (senior-ask): there is nothing to review.` }
    if (!allTicked(flow)) return { error: `${flow.id}: the user has ticked ${steps.filter(s => s.done).length} of ${steps.length} by-hand steps. Senior reviews once every step is done.` }
    return { rec }
  }

  function seniorAsk(f, { by, config = CONFIG }) {
    const label = gateLabels(config).senior
    if (!label) return fail('This pipeline has no Senior agent (config pipeline.senior), so there is no one to ask.')
    if (!by) return fail(noName)
    if (by === label) return fail('Senior does not ask itself: it reviews with senior-start and senior.')
    const [id, what] = f._
    const text = typeof what === 'string' ? what.trim() : ''
    if (!text) return fail('senior-ask needs what to review: senior-ask <flow> "<what was changed, where, and how to check it>"')
    if (text.length > SENIOR_MAX.ask) return fail(`say what to review in at most ${SENIOR_MAX.ask} characters (this is ${text.length})`)
    const flow = load(id)
    const off = offRoute(flow)
    if (off) return fail(off)
    const rec = isObject(flow.senior) ? flow.senior : null
    if (rec?.status === 'reviewing') return fail(`${flow.id}: Senior is reviewing it now. Wait for its verdict.`)
    if (rec?.status === 'passed' || rec?.status === 'senior-failed') return fail(`${flow.id}: Senior already gave its last verdict (${rec.status}).`)
    if (rec?.status === 'released') return fail(`${flow.id}: the user finished it without a Senior review.`)
    const at = now()
    flow.senior = { status: 'asked', by, at, ask: { text, by, at }, ...fresh(rec) }
    if (flow.status === 'done') flow.status = 'open' // it is on its way again until Senior passes it
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    writeFlow(flow)
    return ok(`${flow.id}: sent to ${label}. Send ${label} a message naming flow ${flow.id}.`)
  }

  function seniorStart(f, { by, config = CONFIG }) {
    const refused = notSenior(by, config)
    if (refused) return fail(refused)
    const flow = load(f._[0])
    const { rec, error } = reviewable(flow)
    if (error) return fail(error)
    const at = now()
    const cur = rec?.status === 'reviewing' ? rec : null
    flow.senior = { status: 'reviewing', by, startedAt: cur?.startedAt || at, at, ...(isObject(rec?.ask) ? { ask: rec.ask } : {}), ...fresh(rec) }
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    writeFlow(flow)
    return ok(`${flow.id}: ${by} is reviewing it.`)
  }

  function seniorVerdict(f, { by, config = CONFIG }) {
    const refused = notSenior(by, config)
    if (refused) return fail(refused)
    const [id, verdict, said] = f._
    if (!['pass', 'fail'].includes(verdict)) return fail('senior needs a verdict: senior <flow> pass|fail "<what was checked / what to redo>"')
    const text = typeof said === 'string' ? said.trim() : ''
    if (!text) return fail(verdict === 'pass' ? 'say what you checked: senior <flow> pass "<what was checked>"' : 'say what to redo: senior <flow> fail "<what to redo, and why>"')
    if (text.length > SENIOR_MAX.summary) return fail(`say it in at most ${SENIOR_MAX.summary} characters (this is ${text.length})`)
    const flow = load(id)
    const { rec, error } = reviewable(flow)
    if (error) return fail(error)
    const steps = handSteps(flow)
    let redo = []
    if (f.steps !== undefined) {
      if (verdict === 'pass') return fail('--steps names the steps to redo: leave it out of a pass')
      redo = [...new Set(String(f.steps).split(',').map(s => s.trim()).filter(Boolean))]
      const bad = redo.filter(s => !STEP_ID.test(s) || !steps.some(x => x.id === s))
      if (!redo.length || bad.length) return fail(`${flow.id} has no by-hand step ${bad.join(', ') || '(none named)'}: its steps are ${steps.map(s => s.id).join(', ') || 'none'}`)
    }
    const at = now()
    const base = { by, startedAt: rec?.startedAt || at, at, summary: text, ...(isObject(rec?.ask) ? { ask: rec.ask } : {}), ...fresh(rec) }
    if (verdict === 'pass') {
      flow.senior = { status: 'passed', ...base }
      flow.status = 'done'
      return save(flow, `${flow.id}: ${by} passed it; the flow is done and goes to the Output.`)
    }
    const max = config.pipeline?.maxReworks ?? 3
    const sent = failedSoFar(rec).length
    if (sent >= max) {
      flow.senior = { status: 'senior-failed', ...base }
      flow.status = 'blocked'
      return save(flow, `${flow.id}: ${by} failed it; it already went back ${sent} times, the most pipeline.maxReworks allows. The flow is blocked for the user to decide.`)
    }
    const names = redo.length ? redo : steps.map(s => s.id)
    for (const s of steps) if (names.includes(s.id)) s.done = null
    flow.senior = { status: 'failed', ...base, redo: names }
    flow.status = 'open'
    const what = names.length ? `${names.length === 1 ? 'step' : 'steps'} ${names.join(', ')} ${names.length === 1 ? 'waits' : 'wait'} to be done again` : 'the work waits to be redone'
    return save(flow, `${flow.id}: ${by} failed it; it goes back to Human task and ${what}. The user sees why at the top of its by-hand steps.`)
  }

  function save(flow, line) {
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    writeFlow(flow)
    return ok(line)
  }

  return { 'senior-ask': seniorAsk, 'senior-start': seniorStart, senior: seniorVerdict }
}
