// The by-hand commands agents run, behind `node tools/factory.mjs flow …`, for work the user must do themselves
// (a human decision, CI/CD, cloud setup, a console setting). The agent records the steps and STOPS; it never runs
// that work itself (docs/agent-brief.md):
//
//   hand-step <flow> "<do this>" --expect "<you should see>" [--where "<path or click path>"] [--copy "<value>"]
//             [--why "<one line>"] [--id h3] [--replace]      one step, added at the end, or rewritten in place
//   hand-clear <flow>                                         empties the steps, to record them again
//
// ⚠️ SENIOR'S HOLD (pipeline.senior, flow-senior.mjs): the first step records the hold on the flow, and hand-clear
// never lifts it. On a flow Senior holds, hand-clear is refused once the user ticked any step (rewrite a step with
// --replace instead), and allowed before that, the hold staying in place: the flow still needs Senior's pass, or the
// user's release on the dashboard, to be done.
//
// The shape and limits are hand-steps.mjs's; flows.mjs validates them on every write. A step rewritten with
// --replace keeps the user's tick only while it asks the same thing (hand-steps.mjs sameAsk): a changed step is a
// new thing to do. No command ever sets a tick. Like the other Output commands, these return { out, code } and
// never print: tools/flow-cli.mjs registers them (handCommands) and tools/factory.mjs prints.

import { readFlow, seniorHold, validateFlow, writeFlow } from '../flows.mjs'
import { fieldProblem, HAND_MAX, sameAsk } from '../hand-steps.mjs'

const fail = out => ({ out, code: 1 })
const ok = out => ({ out, code: 0 })
const STEP_ID = /^[a-z0-9-]+$/
/** h<highest h-number + 1>, like the test steps' t-numbers. */
const nextId = steps => 'h' + (Math.max(0, ...steps.map(s => /^h(\d+)$/.exec(s.id)?.[1]).filter(Boolean).map(Number)) + 1)

function load(id) {
  const flow = readFlow(id)
  if (!flow) throw new Error(`No flow ${id}`)
  return flow
}

/** The by-hand part of `flow show`'s Output block (stderr): each step, and whether the user has ticked it; nothing for a flow without any. */
export function handBlock(flow) {
  const steps = flow.hand?.steps || []
  if (!steps.length && !flow.hand?.requestedAt) return []
  const lines = [`  by-hand steps: ${steps.length ? `${steps.filter(s => s.done).length} of ${steps.length} done by the user` : 'none'}`]
  for (const [i, s] of steps.entries()) lines.push(`    ${i + 1}. [${s.id}] ${s.done ? '(done) ' : ''}${s.do} -> ${s.expect}${s.where ? ` (at ${s.where})` : ''}`)
  if (flow.hand?.requestedAt && !steps.some(s => String(s.at || '') > flow.hand.requestedAt)) {
    lines.push(flow.hand.requestError
      ? `  the request for by-hand steps at ${flow.hand.requestedAt} was not sent (${flow.hand.requestError})`
      : `  the user asked for by-hand steps at ${flow.hand.requestedAt}: record them with hand-step, then stop`)
  }
  return lines
}

/** The commands, given the CLI's refusal for a missing name (tools/flow-cli.mjs NO_NAME). */
export function handCommands(noName) {
  function handStep(f, { by }) {
    if (!by) return fail(noName)
    const [id, what] = f._
    if (typeof what !== 'string' || !what.trim()) return fail('hand-step needs what to do: hand-step <flow> "<do this>" --expect "<what the user should see>"')
    if (typeof f.expect !== 'string' || !f.expect.trim()) return fail('hand-step needs --expect "<what the user should see when it worked>"')
    const step = { do: what.trim(), expect: f.expect.trim() }
    for (const key of ['why', 'where', 'copy']) {
      if (f[key] === undefined) continue
      const v = key === 'copy' ? String(f[key]) : String(f[key]).trim()
      if (!v.trim()) return fail(`--${key} is empty: leave it out, or say it`)
      step[key] = v
    }
    for (const key of ['do', 'why', 'where', 'copy', 'expect']) {
      const p = fieldProblem(key, step[key])
      if (p) return fail(key === 'do' ? p.replace(/^do/, 'the step') : `--${p}`)
    }
    if (f.replace && f.id === undefined) return fail('--replace needs --id <the step to rewrite>')
    if (f.id !== undefined && !STEP_ID.test(f.id)) return fail('--id must match /^[a-z0-9-]+$/')
    const flow = load(id)
    const steps = flow.hand?.steps || []
    const at = f.id === undefined ? -1 : steps.findIndex(s => s.id === f.id)
    if (f.replace && at < 0) return fail(`${flow.id} has no by-hand step ${f.id} to replace`)
    if (!f.replace && at >= 0) return fail(`${flow.id} already has a by-hand step ${f.id}: add --replace to rewrite it`)
    if (at < 0 && steps.length >= HAND_MAX.steps) return fail(`${flow.id} already has ${HAND_MAX.steps} by-hand steps, the most a flow takes: say the rest in fewer steps`)
    const stepId = f.id ?? nextId(steps)
    const old = at >= 0 ? steps[at] : null
    const next = { id: stepId, ...step, at: new Date().toISOString(), done: sameAsk(old, step) ? old.done ?? null : null }
    flow.hand = { ...flow.hand, steps: at >= 0 ? steps.map((s, i) => (i === at ? next : s)) : [...steps, next] }
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    writeFlow(flow)
    return ok(`${flow.id} ${stepId}: by-hand step ${at >= 0 ? 'replaced' : 'added'}${old?.done && !next.done ? ' (it changed, so the user tick on it was cleared)' : ''}`)
  }

  function handClear(f, { by }) {
    if (!by) return fail(noName)
    const flow = load(f._[0])
    const held = !!seniorHold(flow)
    if (held && (flow.hand?.steps || []).some(s => s.done)) return fail(`${flow.id}: the user already ticked a by-hand step, so the steps cannot be cleared. Rewrite a step with hand-step --id <step> --replace instead.`)
    flow.hand = { ...flow.hand, steps: [] }
    writeFlow(flow)
    return ok(`${flow.id}: by-hand steps cleared${held ? '. Senior still holds this flow: it needs a Senior review, or the user to release it on the dashboard, before it is done' : ''}`)
  }

  return { 'hand-step': handStep, 'hand-clear': handClear }
}
