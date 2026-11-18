// The Archive and Trash routes (factory-routes.mjs mounts them; every POST has passed its same-origin
// check there). Each handler returns { status, body } like glossary-routes.mjs.
//
//   POST /api/flows/<id>/archive   { archived: true|false }: sets or clears archivedAt (the user's, flows.mjs)
//   POST /api/flows/<id>/delete    { confirm?: true }: an open or blocked flow without confirm is 409
//                                  { needsConfirm, message } and nothing changes; otherwise the flow
//                                  moves to the Trash (trash.mjs), { ok, deletedAt, expiresAt }
//   GET  /api/trash                { items }: listTrash, the expired ones purged first
//   POST /api/trash/<id>/restore   { ok, archived } or the plain refusal (404 unknown or expired, 409 the id is taken); a stop line not sent yet is cancelled
//   POST /api/trash/<id>/purge     { ok }: Delete forever, the entry and the flow's evidence
//
// ⚠️ Delete never leaves an agent writing into a flow that is gone without being told: whatever the
// relay still has queued for the flow is dropped, and when the flow was open or blocked its agent
// gets ONE line to stop (relay.mjs queueDeleted), unless that agent is the chat agent (the same rule
// as Request test steps: no paid turn starts without the user). Its CLI then refuses the flow
// (tools/flow-cli.mjs). Only these routes archive or delete: no agent command does.

import { CONFIG } from './config.mjs'
import { readFlow, writeFlow } from './flows.mjs'
import { inTrash, isTrashed, listTrash, moveToTrash, purge, restoreFromTrash } from './trash.mjs'

const ok = body => ({ status: 200, body })
const no = (status, error) => ({ status, body: { error } })
/** A flow the page can still act on: open or blocked means its agent may be at work on it. */
const live = flow => flow.status === 'open' || flow.status === 'blocked'

/** Archive or unarchive: the user's own field, written through writeFlow like every page change. */
export function archiveRoute(id, b) {
  if (typeof b?.archived !== 'boolean') return no(400, 'archived must be true or false')
  const flow = readFlow(id)
  if (!flow) return no(404, `No flow ${id}.`)
  if (b.archived) flow.archivedAt = new Date().toISOString()
  else delete flow.archivedAt
  writeFlow(flow)
  return ok({ ok: true, archivedAt: flow.archivedAt ?? null })
}

/** Delete: ask first for a flow its agent may be working on; then drop its queue, tell its agent once, move it to the Trash. */
export function deleteRoute(id, b, relay) {
  const flow = readFlow(id)
  if (!flow) return no(404, `No flow ${id}.`)
  const working = live(flow)
  if (working && b?.confirm !== true) {
    return { status: 409, body: { needsConfirm: true, message: `${flow.agent} may still be working on this. Delete it anyway?` } }
  }
  const { deletedAt, expiresAt } = moveToTrash(id)
  relay.drop(id)
  if (working && flow.agent !== CONFIG.factory.chat.name) relay.queueDeleted(id, flow.title, flow.agent)
  return ok({ ok: true, deletedAt, expiresAt })
}

export const trashList = () => ok({ items: listTrash() })

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
  if (!inTrash(id)) return no(404, `No flow ${id} in the Trash.`)
  purge(id)
  return ok({ ok: true })
}

/**
 * What every flow route answers for an id (a slug, checked by the caller) that is in the Trash: 404 with
 * `<id> is in the Trash.`, so the page can offer Restore. null when it is not, or a flow has that id again.
 */
export const trashedFlow = id => (isTrashed(id) ? no(404, `${id} is in the Trash.`) : null)
