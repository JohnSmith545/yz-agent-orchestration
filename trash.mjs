// The Trash: where a flow the USER deleted waits 24 hours before it is gone for good.
//
// One entry per flow, data/trash/<id>.json = { deletedAt, flow }: the flow exactly as it was
// stored, written with writeAtomic like every other data file. The flow's evidence
// (data/evidence/<id>/) is NOT moved: it stays where the flow's refs point, so a restore is whole,
// and it is removed with the entry when the entry is purged.
//
// Rules this file keeps:
// - Expiry is decided from the STORED deletedAt (an unreadable entry: its file time), never from a
//   timer in memory, so it survives a restart: server.mjs calls purgeExpired at startup and every
//   10 minutes, and listTrash purges first. An entry exactly TRASH_MS old is expired; one
//   millisecond younger is not.
// - A restore writes the flow back EXACTLY as stored, its updatedAt included: it does not go
//   through writeFlow, which would restamp it and note a status change for Home. It is validated
//   first, and refused when a flow with that id exists again (the new one is never overwritten).
// - Only the person on the page deletes, restores or purges (trash-routes.mjs). An agent is told
//   (relay.mjs queueDeleted) and its CLI refuses a trashed flow (tools/flow-cli.mjs).
// - Every id is held to the slug rule BEFORE a path is built, and the evidence folder purge
//   resolves its path and checks it stays inside EVIDENCE_DIR.
// - Every function takes `now` (a Date or ms) so tests never wait a day.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR, EVIDENCE_DIR, FLOWS_DIR, validateFlow } from './flows.mjs'

export const TRASH_DIR = path.join(DATA_DIR, 'trash')
/** How long a deleted flow can be restored: 24 hours. */
export const TRASH_MS = 24 * 60 * 60 * 1000

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

/** True when `id` (a slug) has an entry in the Trash. Never throws: anything else is false. */
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
 * does not parse or holds no time. null when it is gone (a purge in between).
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
 * Move flow `id` to the Trash: write the entry, then remove the flow file. Its evidence stays.
 * A stale entry with the same id is replaced. Throws a plain error when there is no such flow (or
 * its file is not JSON). Returns { deletedAt, expiresAt }.
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
  return { deletedAt: iso(at), expiresAt: iso(at + TRASH_MS) }
}

/**
 * Every entry, soonest to expire first: [{ id, title, agent, status, deletedAt, expiresAt, leftMs }],
 * after purging the expired ones. An unreadable entry is listed as { id, title: id, broken: true, … }.
 */
export function listTrash({ now } = {}) {
  const at = msOf(now)
  purgeExpired({ now: at })
  const items = []
  for (const id of entryIds()) {
    const e = readEntry(id)
    if (!e) continue
    const times = { deletedAt: iso(e.deletedAt), expiresAt: iso(e.deletedAt + TRASH_MS), leftMs: e.deletedAt + TRASH_MS - at }
    if (e.broken) items.push({ id, title: id, agent: '', status: '', ...times, broken: true })
    else items.push({ id, title: String(e.flow.title || id), agent: String(e.flow.agent || ''), status: String(e.flow.status || ''), ...times })
  }
  return items.sort((a, b) => a.leftMs - b.leftMs || a.id.localeCompare(b.id))
}

/**
 * Put flow `id` back exactly as it was stored. Refuses (plain message, with a status for the route):
 * no entry (404); an expired one, which is purged (404); one that cannot be read (400); a flow with
 * that id exists again (409); a stored flow that no longer validates (400).
 */
export function restoreFromTrash(id, { now, remove: rm = remove } = {}) {
  slug(id)
  const e = readEntry(id)
  if (!e) throw refusal(`No flow ${id} in the Trash.`, 404)
  if (e.deletedAt + TRASH_MS <= msOf(now)) {
    purge(id, { remove: rm })
    throw refusal(`${id} was in the Trash for 24 hours and is gone for good.`, 404)
  }
  if (e.broken) throw refusal(`The Trash copy of ${id} cannot be read.`, 400)
  if (existsSync(flowFile(id))) throw refusal(`A flow called ${id} exists again. Delete or rename that one first.`, 409)
  const problems = e.flow.id === id ? validateFlow(e.flow) : [`the Trash copy is flow ${e.flow.id}, not ${id}`]
  if (problems.length) throw refusal(`${id} cannot be restored: ${problems.join('; ')}`, 400)
  // The same serialisation writeFlow uses, so a flow it wrote comes back byte for byte.
  writeAtomic(flowFile(id), JSON.stringify(e.flow, null, 1))
  try {
    rm(entryFile(id))
  } catch (err) {
    rmSync(flowFile(id), { force: true }) // never in both places: the flow stays in the Trash, the restore failed
    throw err
  }
  return { archived: Boolean(e.flow.archivedAt) }
}

/**
 * Delete forever: the flow's evidence folder FIRST, then the entry, so a removal that fails (a file held open)
 * leaves the entry and the next purge tries again. Safe when either is missing. ⚠️ The evidence is left alone
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
 * Purge every entry 24 hours old or older (an unreadable one by its file time). One entry that fails is logged
 * and skipped, never stopping the rest; it stays for the next sweep. Returns only the ids really purged.
 */
export function purgeExpired({ now, remove: rm = remove } = {}) {
  const at = msOf(now)
  const gone = []
  for (const id of entryIds()) {
    try {
      const e = readEntry(id)
      if (!e || e.deletedAt + TRASH_MS > at) continue
      purge(id, { remove: rm })
      gone.push(id)
    } catch (err) {
      console.error(`trash: could not purge ${id}, trying again at the next sweep: ${err?.message || err}`)
    }
  }
  return gone
}

/**
 * What every route and CLI command treats as deleted: an entry in the Trash AND no live flow file with that id
 * (a live one wins: it is a new flow, and an entry left behind is only that). Never throws.
 */
export function isTrashed(id) {
  return inTrash(id) && !existsSync(flowFile(id))
}
