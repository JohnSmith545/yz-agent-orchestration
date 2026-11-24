// The Human review routes and the by-hand step routes (factory-routes.mjs mounts them; every POST has passed its
// same-origin check there). Each handler returns { status, body } like glossary-routes.mjs.
//
//   GET  /api/human                  { items, counts: { total, ask, hand, blocked, ticket }, builtAt }: what waits on
//                                    the user, and why (human.mjs), newest first. The Agents page box, the rail's
//                                    count and Home's line all read this one answer.
//   POST /api/flows/<id>/hand        { step, done: true|false }: the user's tick on one by-hand step (hand-steps.mjs
//                                    applyHandTick), written through writeFlow like every page change: { ok, step }
//   POST /api/flows/<id>/request-hand  { note? ≤ 500 }: Ask the agent for steps, on the SAME relay path as Request
//                                    test steps: stamps hand.requestedAt and queues one relay line (relay.mjs
//                                    queueHandRequest), { ok, via: 'relay', requestedAt }; the chat agent's own flow:
//                                    { ok, via: 'chat', text } for the page to put in the Ask drawer, and nothing is
//                                    stamped or relayed (no paid turn starts without the user)
//
// ⚠️ The tickets come from every collection's stored source (factory.mjs readSource), never a refresh: a GET runs
// no turn. A source that cannot be read leaves its tickets' titles out (the row shows the id), never an error.

import { CONFIG } from './config.mjs'
import { collections, readSource } from './factory.mjs'
import { readState } from './factory-state.mjs'
import { listFlows, readFlow, validateFlow, writeFlow } from './flows.mjs'
import { applyHandTick } from './hand-steps.mjs'
import { humanItems } from './human.mjs'
import { handText } from './relay.mjs'

const NOTE_MAX = 500
const ok = body => ({ status: 200, body })
const no = (status, error) => ({ status, body: { error } })

/** Every ticket's title and state across the collections' stored sources: id -> { title, state }. */
function ticketsOf() {
  const map = new Map()
  for (const c of collections()) {
    let src = null
    try {
      src = readSource(c.id)
    } catch {
      src = null
    }
    for (const [id, t] of Object.entries(src?.tickets || {})) if (!map.has(id)) map.set(id, { title: t?.title || '', state: t?.state || '' })
  }
  return map
}

export function humanGet({ now = Date.now() } = {}) {
  const { items, counts } = humanItems({ flows: listFlows().flows, marks: readState().marks, tickets: ticketsOf() })
  return ok({ items, counts, builtAt: new Date(now).toISOString() })
}

/** The user's tick on a by-hand step: re-read now, applied, validated, written. */
export function handTickRoute(id, b) {
  const flow = readFlow(id)
  if (!flow) return no(404, `No flow ${id}.`)
  if (typeof b?.step !== 'string' || !b.step) return no(400, 'step must name a by-hand step, such as h1')
  try {
    applyHandTick(flow, b.step, b.done)
  } catch (err) {
    return no(400, err.message)
  }
  const problems = validateFlow(flow)
  if (problems.length) return no(400, problems.join('\n'))
  writeFlow(flow)
  return ok({ ok: true, step: flow.hand.steps.find(s => s.id === b.step) })
}

/** Ask the agent for by-hand steps: the same relay path as Request test steps (factory-routes.mjs requestTests). */
export function handRequestRoute(id, b, relay) {
  const note = b?.note ?? ''
  if (typeof note !== 'string') return no(400, 'note must be text')
  if (note.length > NOTE_MAX) return no(400, `note must be at most ${NOTE_MAX} characters`)
  const flow = readFlow(id)
  if (!flow) return no(404, `No flow ${id}.`)
  if (flow.agent === CONFIG.factory.chat.name) return ok({ ok: true, via: 'chat', text: handText(flow, note.trim()) })
  const requestedAt = new Date().toISOString()
  // a new request clears what the relay made of the last one, like output.requestedAt
  flow.hand = { ...flow.hand, steps: Array.isArray(flow.hand?.steps) ? flow.hand.steps : [], requestedAt, requestSentAt: null, requestError: null }
  const problems = validateFlow(flow)
  if (problems.length) return no(400, problems.join('\n'))
  writeFlow(flow)
  relay.queueHandRequest(id, note.trim())
  return ok({ ok: true, via: 'relay', requestedAt })
}
