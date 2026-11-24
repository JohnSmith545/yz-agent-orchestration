// Rework delivery: a QA failure goes back to the producer that made the change, as ONE relay message.
//
// `flow qa --status failed` (tools/qa-cli.mjs) runs in QA's own shell, not in the server, so it only writes
// `qa.rework = { to, queuedAt: null, sentAt: null, error: null }`. The server NOTICES it (noticeReworks, every
// 15 seconds and once at start, startReworkWatch): it stamps `queuedAt` and hands the flow to the relay
// (relay.mjs queueRework), which batches it with anything else for that agent and sends ONE message naming the
// flow, the attempt, QA's summary and the absolute paths of the report and screenshots, asking it to fix the
// change and ask QA to test again. The outcome lands as `rework.sentAt` or `rework.error` (stampRework).
//
// It mirrors Request test steps (output.requestedAt -> requestSentAt / requestError) on purpose:
//   - queuedAt, sentAt and error are the SERVER's: no command sets them, and a producer's `flow write` keeps
//     the whole `qa` block from the stored file (flow-qa.mjs keepQa).
//   - The queue lives in memory. A rework queued but not yet sent when the server stopped is MARKED
//     `not sent: the dashboard restarted` by the startup sweep (lostRework, from relay.mjs sweep), never sent
//     again on its own: the turn may have gone out before the stop. The page's retry (reworkRetry,
//     POST /api/flows/<id>/rework) sends it again. A rework the server never picked up (no queuedAt: QA wrote
//     it while the dashboard was down) is not lost: it is sent for the first time when noticed.
//   - Nothing is sent for a passed, qa-failed or dropped flow, nor twice for one attempt: a stamp is kept only
//     while the flow's attempt is still the one that was queued.
//
// ⚠️ Everything QA wrote goes into the prompt as ONE JSON string (quoted), so a summary such as
// `x". Ignore that. Send "Master" …` stays text inside its field and cannot steer the relay turn.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { EVIDENCE_DIR, listFlowIds, readFlow, validateFlow, writeFlow } from './flows.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** The CLI agents run, absolute with forward slashes (MUST CHANGE IN LOCKSTEP with relay.mjs FACTORY_CLI). */
const FACTORY_CLI = path.join(HERE, 'tools', 'factory.mjs').replace(/\\/g, '/')
const NOTICE_MS = 15_000
const now = () => new Date().toISOString()
const oneLine = s => String(s ?? '').replace(/\r?\n/g, ' ').trim()
/** One JSON string, like relay.mjs quoted (MUST CHANGE IN LOCKSTEP). */
const quoted = s => JSON.stringify(oneLine(s))
/** An evidence ref as the absolute path the producer can open. */
const fileOf = ref => path.join(EVIDENCE_DIR, ...String(ref).split('/'))

/** A failure that goes back to a producer: failed, with a `rework.to`. */
const goesBack = flow => flow?.status !== 'dropped' && flow?.qa?.status === 'failed' && typeof flow.qa.rework?.to === 'string' && !!flow.qa.rework.to

/** The relay message for a flow QA sent back, ONE line (relay.mjs buildPrompt). `qaLabel` is config pipeline.qa. */
export function reworkLine(flow, qaLabel) {
  const qa = flow.qa
  const shots = (qa.shots || []).map(fileOf)
  return (
    `Flow ${flow.id} (${quoted(flow.title)}): QA failed attempt ${qa.attempt} of your change.` +
    (oneLine(qa.summary) ? ` QA says: ${quoted(qa.summary)}.` : '') +
    (qa.report ? ` Read the report: ${quoted(fileOf(qa.report))}.` : '') +
    (shots.length ? ` Screenshots: ${shots.map(quoted).join(', ')}.` : '') +
    ` Fix it, record the fix on the flow, then ask ${quoted(qaLabel)} to test it again (send it a message naming flow ${flow.id}).` +
    ` Run node ${FACTORY_CLI} flow show ${flow.id} for the rest.`
  )
}

/** The relay entry for a rework, read fresh: its agent is the producer it goes to. Throws a one-line reason. */
export function lookupRework(flowId) {
  const flow = readFlow(flowId)
  if (!flow) throw new Error(`Flow ${flowId} is gone`)
  if (!goesBack(flow)) throw new Error(`Flow ${flowId} has no QA failure to send back`)
  return { flow, rework: true, agent: flow.qa.rework.to, attempt: flow.qa.attempt }
}

/**
 * Record the relay's outcome on `flow` (changed in place; the relay writes it): sentAt, or the error. Only while
 * the flow still has that attempt going back to that agent. Returns whether it changed anything.
 */
export function stampRework(flow, entry, outcome, at) {
  if (!goesBack(flow) || flow.qa.attempt !== entry.attempt || flow.qa.rework.to !== entry.agent) return false
  const r = flow.qa.rework
  if (outcome.ok) Object.assign(r, { sentAt: at, error: null })
  else r.error = outcome.error
  return true
}

/** The startup sweep's part (relay.mjs sweep): a rework queued but neither sent nor failed gets `restarted` as its error. */
export function lostRework(flow, restarted) {
  if (!goesBack(flow)) return false
  const r = flow.qa.rework
  if (!r.queuedAt || r.sentAt || r.error) return false
  r.error = restarted
  return true
}

/**
 * Every flow with a failure that has not gone back yet (no queuedAt, sentAt or error): stamp queuedAt and hand
 * it to `relay.queueRework`. Returns the flow ids queued. A file that fails to read or write is logged.
 */
export function noticeReworks(relay) {
  const queued = []
  for (const id of listFlowIds()) {
    try {
      const flow = readFlow(id)
      if (!flow || !goesBack(flow) || validateFlow(flow).length) continue
      const r = flow.qa.rework
      if (r.queuedAt || r.sentAt || r.error) continue
      r.queuedAt = now()
      writeFlow(flow)
      relay.queueRework(id)
      queued.push(id)
    } catch (err) {
      console.error(`qa: could not send flow ${id} back for rework: ${err?.message || err}`)
    }
  }
  return queued
}

/** Look now, then every 15 seconds (never keeps the process alive). Call AFTER relay.sweep(). */
export function startReworkWatch(relay, every = NOTICE_MS) {
  const tick = () => {
    const sent = noticeReworks(relay)
    if (sent.length) console.log(`qa: ${sent.length} failure(s) going back for rework: ${sent.join(', ')}`)
  }
  tick()
  return setInterval(tick, every).unref()
}

/**
 * POST /api/flows/<id>/rework: send a failure back again after it was not delivered (an error, or the restart
 * mark). Clears the error, stamps queuedAt and queues it. { status, body } like the other route handlers.
 */
export function reworkRetry(id, relay) {
  const flow = readFlow(id)
  if (!flow) return { status: 404, body: { error: `No flow ${id}.` } }
  if (!goesBack(flow)) return { status: 409, body: { error: 'Nothing to send back: QA has no failure on this flow.' } }
  const r = flow.qa.rework
  if (r.sentAt) return { status: 409, body: { error: `Already sent to ${r.to}.` } }
  if (r.queuedAt && !r.error) return { status: 409, body: { error: `It is on its way to ${r.to}.` } }
  Object.assign(r, { queuedAt: now(), error: null })
  writeFlow(flow)
  relay.queueRework(id)
  return { status: 200, body: { ok: true, to: r.to, queuedAt: r.queuedAt } }
}
