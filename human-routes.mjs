// The Human review routes and the by-hand step routes (factory-routes.mjs mounts them; every POST has passed its
// same-origin check there). Each handler returns { status, body } like glossary-routes.mjs.
//
//   GET  /api/human                  { items, counts: { total, ask, hand, blocked, ticket, session }, builtAt }: what waits on
//                                    the user, and why (human.mjs), newest first. The Agents page box, the rail's
//                                    count and Home's line all read this one answer.
//   POST /api/sessions/<id>/reply   { text } or { retry: true }: the user's reply to a waiting session, sent as ONE message
//                                    (session-replies.mjs); only from the dashboard page: { ok, reply }
//   POST /api/flows/<id>/hand        { step, done: true|false }: the user's tick on one by-hand step (hand-steps.mjs
//                                    applyHandTick), written through writeFlow like every page change: { ok, step }
//   POST /api/flows/<id>/request-hand  { note? ≤ 500 }: Ask the agent for steps, on the SAME relay path as Request
//                                    test steps: stamps hand.requestedAt and queues one relay line (relay.mjs
//                                    queueHandRequest), { ok, via: 'relay', requestedAt }; the chat agent's own flow:
//                                    { ok, via: 'chat', text } for the page to put in the Ask drawer, and nothing is
//                                    stamped or relayed (no paid turn starts without the user)
//   POST /api/tickets/<id>/request-hand  { note? }: Ask for steps on a TICKET marked no-code or not-codebase, or sorted no-code or needs-a-person by ticket intake (a Human
//                                    review ticket row). A live flow that carries the ticket is asked; else a new flow
//                                    is started for it (`<ticket>-by-hand`, type ask, its agent the one who marked the
//                                    ticket when that is a working agent in the pipeline, else the coordinator), then
//                                    asked the SAME way as request-hand: { ok, flowId, created, via, requestedAt | text }.
//                                    Refused in plain words: an unknown id, a ticket not marked, a deleted flow of that
//                                    id (restore it first), a finished flow of that id.
//
// ⚠️ The tickets come from every collection's stored source (factory.mjs readSource), never a refresh: a GET runs
// no turn. A source that cannot be read leaves its tickets' titles out (the row shows the id), never an error.

import { CONFIG } from './config.mjs'
import { collections, readSource } from './factory.mjs'
import { readState } from './factory-state.mjs'
import { createFlow, listFlows, readFlow, seniorHold, validateFlow, writeFlow } from './flows.mjs'
import { failedSoFar, SENIOR_MAX } from './flow-senior.mjs'
import { applyHandTick } from './hand-steps.mjs'
import { HUMAN_KINDS, HUMAN_MARKS, humanItems } from './human.mjs'
import { gateLabels, pipelineGraph } from './pipeline.mjs'
import { handText } from './relay.mjs'
import { ticketKinds } from './routing-intake-store.mjs'
import { isTrashed } from './trash.mjs'
import { newRoute } from './tools/route-cli.mjs'

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

let sessionReplies = null // the server's reply store (session-replies.mjs); null until the server sets it
let sessionName = () => null // a running session's name by id, or null when it is closed
// Sets the reply store and how to name a running session: { replies, nameOf(sessionId) }.
export function useSessionReplies({ replies, nameOf }) {
  sessionReplies = replies || null
  sessionName = typeof nameOf === 'function' ? nameOf : () => null
}

// POST /api/sessions/<id>/reply { text } or { retry: true }: the user's reply goes to that session (page only, factory-routes.mjs).
export function sessionReplyRoute(sessionId, body) {
  if (!sessionReplies) return no(503, 'Replies are not set up on this dashboard. Reply in VS Code instead.')
  const name = sessionName(sessionId)
  if (!name) return no(404, 'That session is closed or not running. Reply in VS Code instead.')
  try {
    const { record } = body?.retry === true ? sessionReplies.retry(sessionId, name) : sessionReplies.send(sessionId, name, body?.text)
    return ok({ ok: true, reply: record })
  } catch (e) {
    return no(400, e.message)
  }
}

let waitingSessions = () => [] // the server's live sessions that wait on the user (server.mjs, waiting.mjs)
// Sets where GET /api/human gets the sessions waiting on the user: a function returning [{ sessionId, label, kind, reason, at }].
export function useWaitingSessions(fn) {
  waitingSessions = typeof fn === 'function' ? fn : () => []
}

/** The waiting sessions, or none when the source fails: a broken source never breaks Human review. */
function sessionsNow() {
  try {
    return (waitingSessions() || []).map(w => {
      const reply = sessionReplies?.get(w.sessionId)
      return reply ? { ...w, reply } : w
    })
  } catch {
    return []
  }
}

export function humanGet({ now = Date.now(), kinds = ticketKinds() } = {}) {
  // `kinds`: ticket intake's sure sorts (routing-intake-store.mjs), so the Tickets list leaves out tickets sorted as code
  const { items, counts } = humanItems({ flows: listFlows().flows, marks: readState().marks, tickets: ticketsOf(), senior: gateLabels(CONFIG).senior, kinds, sessions: sessionsNow() })
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

/**
 * The user finishes a flow Senior holds WITHOUT Senior's review (POST /api/flows/<id>/senior-release, the flow page
 * only: the agent CLI has no way to write this). The record becomes released (by you) and the flow done; the scorecard
 * counts it slipped through, since nobody reviewed it (score.mjs). A flow Senior does not hold is refused.
 */
export function seniorReleaseRoute(id) {
  const flow = readFlow(id)
  if (!flow) return no(404, `No flow ${id}.`)
  if (!seniorHold(flow)) return no(400, `Senior does not hold ${id}: finish it the usual way.`)
  const at = new Date().toISOString()
  flow.senior = { status: 'released', by: 'you', at, ...(failedSoFar(flow.senior).length ? { history: failedSoFar(flow.senior).slice(-SENIOR_MAX.history) } : {}) }
  flow.status = 'done'
  const problems = validateFlow(flow)
  if (problems.length) return no(400, problems.join('\n'))
  writeFlow(flow)
  return ok({ ok: true, status: flow.status })
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

const TICKET = /^[A-Z]+-\d+$/
/** The roles that do the work of a request (never QA, Security or the planner: they check work, they do not write it). */
const WORKERS = new Set(['coordinator', 'producer', 'chat'])
const live = f => f.status === 'open' || f.status === 'blocked'

/** Who should write the steps for a ticket: the agent that marked it, when it works in the pipeline; else the coordinator. */
export function agentForTicket(mark, graph) {
  const agents = graph.nodes.filter(n => n.kind === 'agent')
  const marker = agents.find(n => n.label === mark?.by && WORKERS.has(n.role))
  return (marker || agents.find(n => n.role === 'coordinator'))?.label || 'Coordinator'
}

/** Ask for steps on a ticket with no flow of its own yet: find or start its flow, then the same request as request-hand. */
export function ticketHandRoute(ticketId, b, relay, { config = CONFIG, kinds = null } = {}) {
  if (typeof ticketId !== 'string' || !TICKET.test(ticketId)) return no(400, 'A ticket id looks like FLA-815.')
  const note = b?.note ?? ''
  if (typeof note !== 'string') return no(400, 'note must be text')
  if (note.length > NOTE_MAX) return no(400, `note must be at most ${NOTE_MAX} characters`)
  const mark = readState().marks[ticketId]
  // a ticket intake sorted as no-code or needs-a-person is a Human review row too, marked or not (human.mjs)
  const kind = (kinds || ticketKinds())[ticketId]
  const sorted = HUMAN_KINDS.includes(kind) ? kind : null
  if (!HUMAN_MARKS.includes(mark?.review) && !sorted) return no(400, `${ticketId} is not marked as work only you can do, so there is no one to ask for steps.`)
  let flow = listFlows({ ticket: ticketId }).flows.find(live)
  let created = false
  if (!flow) {
    const id = `${ticketId.toLowerCase()}-by-hand`
    if (isTrashed(id)) return no(409, `The flow for ${ticketId} was deleted. Restore it from the flow archive, then ask again.`)
    const old = readFlow(id)
    if (old && !live(old)) return no(409, `The flow for ${ticketId} is ${old.status}. Open it from the Flows page to see its steps.`)
    if (old) flow = old
    else {
      const graph = pipelineGraph(config)
      const agent = agentForTicket(mark, graph)
      const title = ticketsOf().get(ticketId)?.title || ticketId
      flow = createFlow({
        id, title, agent, tickets: [ticketId],
        why: `Work only you can do (${ticketId}, ${HUMAN_MARKS.includes(mark?.review) ? `marked ${mark.review}` : `sorted as ${sorted}`}). You asked ${agent} for the steps to do it by hand.`,
        route: newRoute('ask', agent, 'you', config),
      })
      created = true
    }
  }
  const r = handRequestRoute(flow.id, { note }, relay)
  return r.status === 200 ? ok({ ...r.body, flowId: flow.id, created }) : r
}
