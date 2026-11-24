// Deleted flows: where a flow the USER deleted waits in the flow archive (its Deleted group) until the user
// restores it or chooses Delete for good. Nothing leaves by a timer: there is no expiry and no sweep.
//
// One entry per flow, data/trash/<id>.json = { deletedAt, flow }: the flow exactly as it was
// stored, written with writeAtomic like every other data file. The folder keeps its old name, so an entry an
// earlier version wrote (when this was a 24-hour Trash) is read as it is: no migration ever moves a file. The
// flow's evidence (data/evidence/<id>/) is NOT moved: it stays where the flow's refs point, so a restore is
// whole, and it is removed only by Delete for good (purge).
//
// Rules this file keeps:
// - A restore writes the flow back EXACTLY as stored, its updatedAt included: it does not go
//   through writeFlow, which would restamp it and note a status change for Home. It is validated
//   first, and refused when a flow with that id exists again (the new one is never overwritten).
// - Only the person on the page deletes, restores or deletes for good (trash-routes.mjs). An agent is
//   told (relay.mjs queueDeleted) and its CLI refuses a deleted flow (tools/flow-cli.mjs).
// - Every id is held to the slug rule BEFORE a path is built, and the evidence folder removal
//   resolves its path and checks it stays inside EVIDENCE_DIR.
// - `now` (a Date or ms) is taken where a time is stamped, so tests never depend on the clock.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR, EVIDENCE_DIR, FLOWS_DIR, validateFlow } from './flows.mjs'

export const TRASH_DIR = path.join(DATA_DIR, 'trash')

const SLUG = /^[a-z0-9-]+$/
const entryFile = id => path.join(TRASH_DIR, `${id}.json`)
const flowFile = id => path.join(FLOWS_DIR, `${id}.json`)
const iso = ms => new Date(ms).toISOString()
/** `now` as ms: a Date, a number, or absent (the clock). */
const msOf = now => (now == null ? Date.now() : now instanceof Date ? now.getTime() : Number(now))
/** An Error the routes answer with its own status (factory-routes.mjs reads `e.status`). */
const refusal = (message, status) => Object.assign(new Error(message), { status })
/** Removes a file or folder; ⚠️ on Windows a reader holding it open makes rm fail for a moment, so it retries (recursive is what enables that). */
const remove = p => rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })

function slug(id) {
  if (typeof id !== 'string' || !SLUG.test(id)) throw refusal('Flow id must match /^[a-z0-9-]+$/.', 400)
  return id
}

/** True when `id` (a slug) has an entry among the deleted flows. Never throws: anything else is false. */
export function inTrash(id) {
  return typeof id === 'string' && SLUG.test(id) && existsSync(entryFile(id))
}

/** The ids with an entry, sorted. */
function entryIds() {
  if (!existsSync(TRASH_DIR)) return []
  return readdirSync(TRASH_DIR).filter(f => f.endsWith('.json') && SLUG.test(f.slice(0, -5))).map(f => f.slice(0, -5)).sort()
}

/**
 * One entry, read: { deletedAt (ms), flow } or { broken: true, deletedAt (the file time) } when it
 * does not parse or holds no time. null when it is gone (a Delete for good in between).
 */
function readEntry(id) {
  let mtime
  try {
    mtime = statSync(entryFile(id)).mtimeMs
  } catch {
    return null
  }
  try {
    const e = JSON.parse(readFileSync(entryFile(id), 'utf8'))
    const at = Date.parse(e?.deletedAt)
    if (Number.isNaN(at) || !e.flow || typeof e.flow !== 'object') return { broken: true, deletedAt: mtime }
    return { deletedAt: at, flow: e.flow }
  } catch {
    return { broken: true, deletedAt: mtime }
  }
}

/**
 * Move flow `id` to the deleted flows: write the entry, then remove the flow file. Its evidence stays.
 * A stale entry with the same id is replaced. Throws a plain error when there is no such flow (or
 * its file is not JSON). Returns { deletedAt }.
 */
export function moveToTrash(id, { now } = {}) {
  slug(id)
  const file = flowFile(id)
  if (!existsSync(file)) throw refusal(`No flow ${id}.`, 404)
  let flow
  try {
    flow = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw refusal(`Flow ${id} is not valid JSON: ${err.message}`, 400)
  }
  const at = msOf(now)
  writeAtomic(entryFile(id), JSON.stringify({ deletedAt: iso(at), flow }, null, 1))
  try {
    remove(file)
  } catch (err) {
    rmSync(entryFile(id), { force: true }) // never both: the flow stays live, the delete failed
    throw err
  }
  return { deletedAt: iso(at) }
}

/**
 * Every entry, the most recently deleted first: [{ id, title, agent, status, tickets, deletedAt }]. An unreadable
 * entry is listed as { id, title: id, agent: '', status: '', tickets: [], deletedAt (its file time), broken: true }.
 * Reads only: nothing is ever removed here.
 */
export function listTrash() {
  const items = []
  for (const id of entryIds()) {
    const e = readEntry(id)
    if (!e) continue
    if (e.broken) items.push({ id, title: id, agent: '', status: '', tickets: [], deletedAt: iso(e.deletedAt), broken: true })
    else {
      const f = e.flow
      const tickets = Array.isArray(f.tickets) ? f.tickets.filter(t => typeof t === 'string') : []
      items.push({ id, title: String(f.title || id), agent: String(f.agent || ''), status: String(f.status || ''), tickets, deletedAt: iso(e.deletedAt) })
    }
  }
  return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.id.localeCompare(b.id))
}

/**
 * The deleted flow `id` as it was stored, with `deletedAt` (an ISO time) added, for the page's read-only view; null
 * when there is no readable entry, or a live flow has that id again (isTrashed). Never throws for a bad id.
 */
export function readTrashed(id) {
  if (!isTrashed(id)) return null
  const e = readEntry(id)
  if (!e || e.broken) return null
  return { ...e.flow, deletedAt: iso(e.deletedAt) }
}

/**
 * Put flow `id` back exactly as it was stored. Refuses (plain message, with a status for the route):
 * no entry (404); one that cannot be read (400); a flow with that id exists again (409); a stored flow
 * that no longer validates (400).
 */
export function restoreFromTrash(id, { remove: rm = remove } = {}) {
  slug(id)
  const e = readEntry(id)
  if (!e) throw refusal(`No deleted flow ${id} in the archive.`, 404)
  if (e.broken) throw refusal(`The archived copy of ${id} cannot be read.`, 400)
  if (existsSync(flowFile(id))) throw refusal(`A flow called ${id} exists again. Delete or rename that one first.`, 409)
  const problems = e.flow.id === id ? validateFlow(e.flow) : [`the archived copy is flow ${e.flow.id}, not ${id}`]
  if (problems.length) throw refusal(`${id} cannot be restored: ${problems.join('; ')}`, 400)
  // The same serialisation writeFlow uses, so a flow it wrote comes back byte for byte.
  writeAtomic(flowFile(id), JSON.stringify(e.flow, null, 1))
  try {
    rm(entryFile(id))
  } catch (err) {
    rmSync(flowFile(id), { force: true }) // never in both places: the flow stays deleted, the restore failed
    throw err
  }
  return { archived: Boolean(e.flow.archivedAt) }
}

/**
 * Delete for good: the flow's evidence folder FIRST, then the entry, so a removal that fails (a file held open)
 * leaves the entry and the next try starts again. Safe when either is missing. ⚠️ The evidence is left alone
 * when a live flow has that id again: those screenshots are the new flow's. `remove` is for tests only.
 */
export function purge(id, { remove: rm = remove } = {}) {
  slug(id)
  if (!existsSync(flowFile(id))) {
    const root = path.resolve(EVIDENCE_DIR)
    const dir = path.resolve(root, id)
    if (!dir.startsWith(root + path.sep)) throw refusal('Outside the evidence folder.', 400)
    rm(dir)
  }
  rm(entryFile(id))
}

/**
 * What every route and CLI command treats as deleted: an entry AND no live flow file with that id (a live one
 * wins: it is a new flow, and an entry left behind is only that). Never throws.
 */
export function isTrashed(id) {
  return inTrash(id) && !existsSync(flowFile(id))
}
