// The ONE cheap model run of ticket intake: when the rules are unsure about some open tickets and the user switched
// the model sort on (config.json routing.intakeModel, a model id, off by default), up to MODEL_MAX of them go to the
// model in ONE run, and its answers are stored with by: model (routing-intake-store.mjs). The user can correct any.
//
//   makeIntakeRunner({ generate, save, now })   { run(tickets, model), running() }
//     run   resolves { ok, sorted, asked, cost } or { error, cost? }; { busy: true } while another run is going
//
// Rules this file keeps:
// - It is the clean headless run of script.mjs (`generate` with a `turn`): no tools, no MCP, no settings, no session,
//   in an empty temp folder, the text on stdin; the cost recorded ONCE as spend kind `intake` (spend.mjs). Low effort.
// - ONE run at a time: a second press while one runs answers busy, never a second paid turn.
// - ⚠️ The model never writes anything itself: its reply is parsed (routing-intake.mjs parseIntakeReply), only
//   answers for the ids it was asked about, with a known kind, are kept, and never over the user's own correction.
// - `generate` and `save` are injected, so tests never run a model or touch data/.

import { generate as realGenerate } from './script.mjs'
import { setModelKinds } from './routing-intake-store.mjs'
import { intakePrompt, MODEL_MAX, parseIntakeReply } from './routing-intake.mjs'

const MESSAGES = Object.freeze({
  missing: 'Claude Code was not found on this machine, so the tickets were not sent.',
  failed: 'The sorting run stopped before it finished. Try again in a moment.',
  refusal: 'The model chose not to sort these tickets.',
  timeout: 'No reply for 2 minutes, so the sorting run was stopped.',
  cancelled: 'Stopped.',
})

export function makeIntakeRunner({ generate = realGenerate, save = setModelKinds, now = () => new Date().toISOString() } = {}) {
  let busy = false
  async function run(tickets, model) {
    if (busy) return { busy: true }
    const list = (Array.isArray(tickets) ? tickets : []).slice(0, MODEL_MAX)
    if (!list.length) return { ok: true, sorted: 0, asked: 0, cost: 0 }
    busy = true
    try {
      const { system, text } = intakePrompt(list)
      let reply = ''
      const { done } = generate(text, { onDelta: d => { reply += d }, turn: { system, effort: 'low', name: 'INTAKE', kind: 'intake', model, messages: MESSAGES } })
      const r = await done
      if (r.error) return { error: r.error, ...(r.cost != null ? { cost: r.cost } : {}) }
      const answers = parseIntakeReply(reply, list.map(t => t.id))
      const sorted = Object.keys(answers).length ? save(answers, now()) : 0
      return { ok: true, sorted, asked: list.length, cost: r.cost ?? null }
    } finally {
      busy = false
    }
  }
  return { run, running: () => busy }
}
