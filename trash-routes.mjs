// The flow archive routes (factory-routes.mjs mounts them; every POST has passed its same-origin check there).
// Each handler returns { status, body } like glossary-routes.mjs.
//
// The archive has two groups, and nothing ever leaves either by a timer:
//   Archived   live flows the user put away (`archivedAt`, the user's field, flows.mjs)
//   Deleted    flows the user deleted, kept whole in data/trash/<id>.json (trash.mjs) until Delete for good
//
//   GET  /api/archive              { archived: [{ id, title, agent, status, tickets, archivedAt, completedAt? }], deleted: [{ id,
//                                  title, agent, status, tickets, deletedAt, broken? }] }, each the newest first
//   POST /api/flows/<id>/archive   { archived: true|false }: sets or clears archivedAt; a COMPLETED flow (completed.mjs) is
//                                  not unarchived here (409): Uncomplete takes the mark and the archive off together
//   POST /api/flows/<id>/delete    { confirm?: true }: an open or blocked flow without confirm is 200
//                                  { ok: false, needsConfirm, message } and nothing changes (a question, not an
//                                  error: the browser logs no failed request); otherwise the flow moves to the
//                                  archive's Deleted group, { ok, deletedAt }
//   POST /api/trash/<id>/restore   { ok, archived } or the plain refusal (404 unknown, 409 the id is taken); a stop
//                                  line not sent yet is cancelled
//   POST /api/trash/<id>/purge     { ok }: Delete for good, the entry and the flow's evidence
//   GET  /api/flows/<id> on a deleted id: the flow as it was stored, with `deletedAt`, for the read-only view
//   Any other flow route on a deleted id: 404 `<id> was deleted: it is in the flow archive.`
//
// ⚠️ Delete never leaves an agent writing into a flow that is gone without being told: whatever the
// relay still has queued for the flow is dropped, and when the flow was open or blocked its agent
// gets ONE line to stop (relay.mjs queueDeleted), unless that agent is the chat agent (the same rule
// as Request test steps: no paid turn starts without the user). Its CLI then refuses the flow
// (tools/flow-cli.mjs). Only these routes archive or delete: no agent command does.

import { CONFIG } from './config.mjs'
import { withRoute } from './flow-route.mjs'
import { derive, listFlows, readFlow, validateFlow, writeFlow } from './flows.mjs'
import { pipelineGraph } from './pipeline.mjs'
import { inTrash, isTrashed, listTrash, moveToTrash, purge, readTrashed, restoreFromTrash } from './trash.mjs'

const ok = body => ({ status: 200, body })
const no = (status, error) => ({ status, body: { error } })
/** A flow the page can still act on: open or blocked means its agent may be at work on it. */
const live = flow => flow.status === 'open' || flow.status === 'blocked'

/** Archive or unarchive: the user's own field, written through writeFlow like every page change. */
export function archiveRoute(id, b) {
  if (typeof b?.archived !== 'boolean') return no(400, 'archived must be true or false')
  const flow = readFlow(id)
  if (!flow) return no(404, `No flow ${id}.`)
  if (!b.archived && flow.completedAt) return no(409, 'This flow is completed. Take the mark off with Uncomplete in the flow archive.')
  if (b.archived) flow.archivedAt = new Date().toISOString()
  else delete flow.archivedAt
  writeFlow(flow)
  return ok({ ok: true, archivedAt: flow.archivedAt ?? null })
}

/** Delete: ask first for a flow its agent may be working on; then drop its queue, tell its agent once, move it to Deleted. */
export function deleteRoute(id, b, relay) {
  const flow = readFlow(id)
  if (!flow) return no(404, `No flow ${id}.`)
  const working = live(flow)
  if (working && b?.confirm !== true) {
    return ok({ ok: false, needsConfirm: true, message: `${flow.agent} may still be working on this. Delete it anyway?` })
  }
  const { deletedAt } = moveToTrash(id)
  relay.drop(id)
  if (working && flow.agent !== CONFIG.factory.chat.name) relay.queueDeleted(id, flow.title, flow.agent)
  return ok({ ok: true, deletedAt })
}

/** One archived flow as the archive lists it: what tells it apart, and when it was put away. */
const archivedRow = f => ({ id: f.id, title: f.title, agent: f.agent, status: f.status, tickets: f.tickets || [], archivedAt: f.archivedAt, ...(f.completedAt ? { completedAt: f.completedAt } : {}) })

/** Both groups of the flow archive, each the newest first. ⚠️ A Deleted group that cannot be read leaves it empty with `deletedError`, never a failed page. */
export function archiveList() {
  const archived = listFlows({ archived: true }).flows.map(archivedRow).sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)))
  try {
    return ok({ archived, deleted: listTrash() })
  } catch (err) {
    return ok({ archived, deleted: [], deletedError: `The deleted flows could not be read: ${err?.message || err}` })
  }
}

/**
 * Restore: trash.mjs refuses with the status the page shows (404, 409, 400). Once back, a stop line the relay has
 * not sent yet is cancelled (the toast's Undo comes well inside its 30 s wait): the agent is never told to stop a
 * flow that is back. One already sent cannot be taken back. `archived` says where it went: a flow archived when it
 * was deleted comes back archived, and the page says Restored to Archived.
 */
export function restoreRoute(id, relay) {
  const { archived } = restoreFromTrash(id)
  relay.drop(id)
  return ok({ ok: true, archived })
}

export function purgeRoute(id) {
  if (!inTrash(id)) return no(404, `No deleted flow ${id} in the archive.`)
  purge(id)
  return ok({ ok: true })
}

/**
 * What a flow route answers for an id (a slug, checked by the caller) that was deleted; null when it was not, or a
 * flow has that id again. `read` (a plain GET of the flow): the flow as stored, with derived, its route and
 * `deletedAt`, so the page opens it read-only. Anything else: 404 `<id> was deleted: it is in the flow archive.`
 */
export function trashedFlow(id, read = false) {
  if (!isTrashed(id)) return null
  const flow = read ? readTrashed(id) : null
  if (!flow) return no(404, `${id} was deleted: it is in the flow archive.`)
  const problems = validateFlow(flow)
  if (problems.length) return no(400, problems.join('\n'))
  return ok({ ...flow, derived: derive(flow), ...withRoute(flow, pipelineGraph(CONFIG)) })
}
