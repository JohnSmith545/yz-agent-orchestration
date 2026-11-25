// A flow's retrospective, the RUN: three plain lines (what went right, what went wrong, what to do differently)
// written by ONE small model run from the facts the server gathered (learn-retro-facts.mjs), kept on the flow as
// `flow.retro` (learn-retro-text.mjs). The weekly Learn run reads these instead of raw logs (learn-pack.mjs).
//
//   makeRetros({ generate, graph, settings, now, readReport })  -> { write(id, source), completed(id), busy(), idle() }
//     write(id, 'button' | 'completed')   one retrospective now: { status, body } as the routes answer it
//                                         200 { ok, retro } | 400 not finished or dropped | 403 switched off
//                                         | 404 no flow | 409 one is being written | 502 { error, cost? } the run failed
//     completed(id)                       the user marked `id` Completed (factory-routes.mjs onCompleted): queue one,
//                                         when learn.autoRetro is on and the flow has none yet
//     busy() / idle()                     whether one is running or queued; a promise for the queue to empty (tests)
//
// Rules this file keeps:
// - ONE run at a time. Completed on several flows at once (Mark all completed) queues them, run one after another;
//   the button while the queue runs is a 409 with a plain sentence. The queue holds at most QUEUE_MAX flows.
// - The run is script.mjs's clean run with the retro turn: learn.retroModel (Sonnet by default) at LOW effort, the
//   fixed RETRO_SYSTEM prompt, session name RETRO, spend kind `retro` (recorded once by script.mjs, failed runs too).
// - Never for a dropped flow, never for one still on its way: a finished flow (completed.mjs isFinished) or one the
//   user marked Completed. learn.enabled false runs nothing at all (403); learn.autoRetro false stops only the
//   automatic one.
// - The flow is RE-READ after the run and written with its updatedAt kept (flows.mjs writeFlow { stamp: false }): a
//   retrospective is no change to the work, so the scorecard, Pipeline time and the Log count it as before.
// - The automatic one never rewrites a retrospective the flow already has; the button does (the user asked).
// - generate, the graph, the settings and the clock are injected, so tests never spawn Claude.

import { isFinished } from './completed.mjs'
import { readFlow as storeRead, writeFlow as storeWrite } from './flows.mjs'
import { RETRO_SYSTEM } from './learn-prompts.mjs'
import { retroFacts, retroFactsText } from './learn-retro-facts.mjs'
import { parseRetro } from './learn-retro-text.mjs'
import { generate as realGenerate } from './script.mjs'

const QUEUE_MAX = 50
const BUSY = 'A retrospective is already being written. Wait for it to finish, then try again.'
const OFF = 'Retrospectives are switched off (learn.enabled is false in config.json).'

/** The retrospective's model turn: the small model at low effort, its own prompt, session name and spend kind. */
export const retroTurn = model => ({
  system: RETRO_SYSTEM, effort: 'low', name: 'RETRO', kind: 'retro', model,
  messages: { refusal: 'The model chose not to write this retrospective.' },
})

/** Why `flow` gets no retrospective, one plain sentence, or ''. */
export function retroRefusal(flow, graph) {
  if (!flow || typeof flow !== 'object') return 'There is no such flow.'
  if (flow.status === 'dropped') return 'A dropped flow gets no retrospective.'
  if (flow.completedAt || isFinished(flow, graph)) return ''
  return `Only a finished flow gets a retrospective: ${flow.status === 'blocked' ? 'it is blocked' : 'it is still on its way'}.`
}

/** One run, its text gathered: { ok, text, cost } or { error, cost }. Never rejects. */
async function runOnce(generate, input, turn) {
  let text = ''
  try {
    const run = generate(input, { turn, onDelta: t => (text += String(t)) })
    const out = await run.done
    const cost = typeof out?.cost === 'number' ? out.cost : null
    return out?.ok ? { ok: true, text, cost } : { error: out?.error || 'The model run stopped before it finished.', cost }
  } catch {
    return { error: 'The model run could not start. Try again in a moment.', cost: null }
  }
}

const answer = (status, body) => ({ status, body })

export function makeRetros({
  generate = realGenerate, graph, settings, now = () => new Date(), readReport = null,
  readFlow = storeRead, writeFlow = storeWrite, log = console.error,
} = {}) {
  let running = false
  const queue = []

  async function run(id, source) {
    const g = graph()
    const flow = readFlow(id)
    if (!flow) return answer(404, { error: `No flow ${id}.` })
    const refused = retroRefusal(flow, g)
    if (refused) return answer(400, { error: refused })
    const out = await runOnce(generate, retroFactsText(retroFacts(flow, g, { readReport })), retroTurn(settings().retroModel))
    if (!out.ok) return answer(502, { error: out.error, cost: out.cost })
    const lines = parseRetro(out.text)
    if (lines.error) return answer(502, { error: lines.error, cost: out.cost })
    const retro = { at: now().toISOString(), ...lines, cost: out.cost, source }
    const fresh = readFlow(id) // re-read: the flow may have moved while the model wrote
    if (!fresh) return answer(404, { error: `No flow ${id}.` })
    fresh.retro = retro
    writeFlow(fresh, { stamp: false })
    return answer(200, { ok: true, retro })
  }

  async function drain() {
    while (queue.length) {
      const id = queue.shift()
      try {
        const flow = readFlow(id)
        if (!flow || flow.retro) continue // written meanwhile, by the button: the automatic one never rewrites
        const r = await run(id, 'completed')
        if (r.status !== 200) log(`learn: no retrospective for ${id}: ${r.body.error}`)
      } catch (err) {
        log(`learn: no retrospective for ${id}: ${err?.message || err}`)
      }
    }
    running = false
  }

  /** Start the queue when it holds a flow and nothing runs: after a Completed, and after the button's run. */
  function kick() {
    if (running || !queue.length) return
    running = true
    setImmediate(drain)
  }

  return {
    async write(id, source = 'button') {
      if (!settings().enabled) return answer(403, { error: OFF })
      if (running) return answer(409, { error: BUSY })
      running = true
      try {
        return await run(id, source)
      } finally {
        running = false
        kick() // a Completed that came meanwhile waited in the queue
      }
    },
    completed(id) {
      const s = settings()
      if (!s.enabled || !s.autoRetro || queue.includes(id) || queue.length >= QUEUE_MAX) return
      let flow
      try {
        flow = readFlow(id)
      } catch {
        flow = null
      }
      if (!flow || flow.retro) return
      queue.push(id)
      kick()
    },
    busy: () => running,
    idle: async () => {
      while (running || queue.length) await new Promise(r => setTimeout(r, 5))
    },
  }
}
