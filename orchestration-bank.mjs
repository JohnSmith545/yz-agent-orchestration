// The Orchestration bank: saved orchestration styles (orchestration-parts.mjs) that any project can switch to.
//
//   <data root>/orchestration-bank.json
//     { seeded, entries: [{ id, name, savedAt, from: { id, name }, snapshot: { parts } }], used: { <project id>: { id, name } } }
//
// Rules this file keeps:
// - ONE file for every project, under the data ROOT (data/ or FACTORY_DATA_DIR), never a project's own folder:
//   a style saved on one project is there to be used on another. Written whole through atomic-write.mjs.
// - The store functions are PURE (a bank in, a new bank out, or { error } with one plain sentence for the page);
//   readBank and writeBank take the file, so tests never touch the real one.
// - Limits, refused with a sentence and never cut: a name of 1 to 60 characters on one line and not one the bank
//   already has (case-insensitive), at most 50 entries, at most 256 KB per entry.
// - Seeding: the first time the bank is read with nothing in it, the current style is saved under the project's
//   name and the date (seedIfEmpty), and `seeded` is set. It never happens again, even after that entry is
//   deleted: the user asked for the style to be copied once, not for one to reappear.
// - `used` remembers, per project, the entry it last switched to (or started from), with its name at the time,
//   so the Project menu can still say it after the entry is deleted (usedBy marks it `removed`).
// - Entry ids are `o` and 8 hex digits (ENTRY_ID), checked by every route before anything else.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { summaryOf } from './style-words.mjs'
import { DATA_ROOT, PROJECT_ID } from './project-store.mjs'

export const BANK_FILE = path.join(DATA_ROOT, 'orchestration-bank.json')
export const BANK_LIMITS = Object.freeze({ name: 60, entries: 50, entryBytes: 256 * 1024 })
export const ENTRY_ID = /^o[0-9a-f]{8}$/

const NOT_THERE = 'That orchestration is not in the bank.'
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const newEntryId = () => `o${randomBytes(4).toString('hex')}`
const now = () => new Date().toISOString()

export const emptyBank = () => ({ seeded: false, entries: [], used: {} })

function cleanEntry(e) {
  if (!isObj(e) || typeof e.id !== 'string' || !ENTRY_ID.test(e.id)) return null
  const name = typeof e.name === 'string' ? e.name.trim() : ''
  if (!name || !isObj(e.snapshot) || !isObj(e.snapshot.parts)) return null
  const from = isObj(e.from) && typeof e.from.id === 'string' ? { id: e.from.id, name: String(e.from.name ?? e.from.id) } : { id: '', name: '' }
  return { id: e.id, name: name.slice(0, BANK_LIMITS.name), savedAt: isTime(e.savedAt) ? e.savedAt : null, from, snapshot: e.snapshot }
}

export function cleanBank(raw) {
  const seen = new Set()
  const entries = (Array.isArray(raw?.entries) ? raw.entries : []).map(cleanEntry).filter(e => e && !seen.has(e.id) && seen.add(e.id))
  const used = {}
  for (const [pid, u] of Object.entries(isObj(raw?.used) ? raw.used : {})) {
    if (PROJECT_ID.test(pid) && isObj(u) && typeof u.id === 'string' && ENTRY_ID.test(u.id)) used[pid] = { id: u.id, name: String(u.name ?? '') }
  }
  return { seeded: raw?.seeded === true, entries: entries.slice(0, BANK_LIMITS.entries), used }
}

export function readBank(file = BANK_FILE) {
  if (!existsSync(file)) return emptyBank()
  try {
    return cleanBank(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyBank()
  }
}

export function writeBank(bank, file = BANK_FILE) {
  writeAtomic(file, `${JSON.stringify(cleanBank(bank), null, 1)}\n`)
}

/** `{ name }` trimmed, or `{ error }`. `taken` is the bank, to refuse a name it has (`self`: the entry being renamed). */
export function checkName(name, taken = null, self = null) {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) return { error: 'Give the orchestration a name.' }
  if (/[\r\n]/.test(n)) return { error: 'Keep the name on one line.' }
  if (n.length > BANK_LIMITS.name) return { error: `That name is too long. Keep it to ${BANK_LIMITS.name} characters.` }
  if (taken?.entries.some(e => e.id !== self && e.name.toLowerCase() === n.toLowerCase())) return { error: `There is already an orchestration called ${n}.` }
  return { name: n }
}

function sized(entry) {
  return Buffer.byteLength(JSON.stringify(entry)) > BANK_LIMITS.entryBytes ? { error: `This orchestration is too large to save (over ${BANK_LIMITS.entryBytes / 1024} KB).` } : null
}

/** A new entry at the end of the bank: `{ bank, entry }` or `{ error }`. */
export function addEntry(bank, { name, from, snapshot }, { now: at = now, newId = newEntryId } = {}) {
  const b = cleanBank(bank)
  const checked = checkName(name, b)
  if (checked.error) return checked
  if (b.entries.length >= BANK_LIMITS.entries) return { error: `The bank is full: it keeps ${BANK_LIMITS.entries} orchestrations. Delete one first.` }
  let id = newId()
  while (b.entries.some(e => e.id === id)) id = newId()
  const entry = { id, name: checked.name, savedAt: at(), from: { id: String(from?.id ?? ''), name: String(from?.name ?? '') }, snapshot: structuredClone(snapshot) }
  const big = sized(entry)
  if (big) return big
  return { bank: { ...b, entries: [...b.entries, entry] }, entry }
}

export function renameEntry(bank, id, name) {
  const b = cleanBank(bank)
  const i = b.entries.findIndex(e => e.id === id)
  if (i < 0) return { error: NOT_THERE }
  const checked = checkName(name, b, id)
  if (checked.error) return checked
  const entry = { ...b.entries[i], name: checked.name }
  const entries = [...b.entries]
  entries[i] = entry
  // the projects that use it keep its NEW name, so it still reads right once the entry is gone
  const used = Object.fromEntries(Object.entries(b.used).map(([pid, u]) => [pid, u.id === id ? { id, name: entry.name } : u]))
  return { bank: { ...b, entries, used }, entry }
}

/** `<name> (copy)`, then `(copy 2)` …, cut so it fits the name limit. */
function copyName(bank, name) {
  for (let k = 1; ; k++) {
    const tail = k === 1 ? ' (copy)' : ` (copy ${k})`
    const n = `${name.slice(0, BANK_LIMITS.name - tail.length)}${tail}`
    if (!bank.entries.some(e => e.name.toLowerCase() === n.toLowerCase())) return n
  }
}

export function duplicateEntry(bank, id, deps = {}) {
  const b = cleanBank(bank)
  const e = b.entries.find(x => x.id === id)
  if (!e) return { error: NOT_THERE }
  return addEntry(b, { name: copyName(b, e.name), from: e.from, snapshot: e.snapshot }, deps)
}

export function deleteEntry(bank, id) {
  const b = cleanBank(bank)
  if (!b.entries.some(e => e.id === id)) return { error: NOT_THERE }
  return { bank: { ...b, entries: b.entries.filter(e => e.id !== id) } }
}

export function markUsed(bank, projectId, entry) {
  const b = cleanBank(bank)
  return { ...b, used: { ...b.used, [projectId]: { id: entry.id, name: entry.name } } }
}

/** `{ id, name }` of the entry `projectId` last used (its name NOW), `removed: true` when it left the bank; null when none. */
export function usedBy(bank, projectId) {
  const u = cleanBank(bank).used[projectId]
  if (!u) return null
  const e = bank.entries.find(x => x.id === u.id)
  return e ? { id: e.id, name: e.name } : { id: u.id, name: u.name, removed: true }
}

/** The first read of an empty, never-seeded bank saves `make()` once: `{ bank, entry }` (entry null when nothing was saved). */
export function seedIfEmpty(bank, make, deps = {}) {
  const b = cleanBank(bank)
  if (b.seeded || b.entries.length) return { bank: b, entry: null }
  const r = addEntry(b, make(), deps)
  if (r.error) return { bank: b, entry: null, error: r.error }
  return { bank: { ...r.bank, seeded: true }, entry: r.entry }
}

/** The page's list: newest first, each with its summary line and never the whole snapshot. */
export function listEntries(bank) {
  return cleanBank(bank).entries
    .map((e, i) => ({ id: e.id, name: e.name, savedAt: e.savedAt, from: e.from, summary: summaryOf(e.snapshot), i }))
    .sort((a, b) => (Date.parse(b.savedAt || 0) || 0) - (Date.parse(a.savedAt || 0) || 0) || b.i - a.i)
    .map(({ i, ...e }) => e)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = n => String(n).padStart(2, '0')

/** `Flinki v2, 25 Nov 2026` (local date), with ` 09:05` when `time`; cut to the name limit from the project's side. */
export function datedName(projectName, date = new Date(), { time = false } = {}) {
  const when = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}${time ? ` ${two(date.getHours())}:${two(date.getMinutes())}` : ''}`
  const tail = `, ${when}`
  return `${String(projectName ?? '').trim().slice(0, BANK_LIMITS.name - tail.length)}${tail}`
}

/** `name`, or `name (2)`, `(3)` … when the bank has it already. */
export function uniqueName(bank, name) {
  const taken = n => bank.entries.some(e => e.name.toLowerCase() === n.toLowerCase())
  if (!taken(name)) return name
  for (let k = 2; ; k++) {
    const tail = ` (${k})`
    const n = `${name.slice(0, BANK_LIMITS.name - tail.length)}${tail}`
    if (!taken(n)) return n
  }
}
