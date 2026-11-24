// The change records behind Home's Since you were away card (spec F2,
// since.mjs). Three small files under data/, each written through writeAtomic:
//
//   levels.json              { ticketId: level }    the current level map, every
//                            collection's tickets merged (orchestration.mjs, each build)
//   levels-prev.json         { ticketId: { level, at } }   the level a ticket LEFT and when
//   flows-prev.json          { flowId: { status, at } }    the status a flow LEFT and when
//                            (flows.mjs writeFlow, the one writer of flow files)
//   sources/<id>.prev.json   { fetchedAt, tickets: { ID: { state, at } } }   the state a
//                            ticket LEFT on its source and when (factory.mjs refreshSource)
//
// ⚠️ WHY A NOTE PER CHANGE AND NOT A COPY OF THE LAST BUILD: the orchestration
// grid rebuilds every 45 s while the Tickets page polls, and a source refreshes
// every 20 minutes. A plain copy of the previous build would forget an
// overnight change a minute after it happened, so the morning card would
// never show it. Instead each change is noted with the value it left and the
// time it was seen, and the note stays until the next change of that same
// ticket or flow (or 30 days). The card then asks: which notes are newer than
// the last time you looked, and is the value still different?
//
// The current project's data folder, from project-store.mjs like flows.mjs and
// factory-state.mjs (tests point FACTORY_DATA_DIR at a temp folder before
// importing). It imports nothing from the flow store, because flows.mjs imports it.
// A record write never throws to its caller: a flow write or a build must not
// fail because the digest could not take a note.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './project-store.mjs'

const LEVELS_FILE = path.join(DATA_DIR, 'levels.json')
const LEVELS_PREV_FILE = path.join(DATA_DIR, 'levels-prev.json')
const FLOWS_PREV_FILE = path.join(DATA_DIR, 'flows-prev.json')
const sourcePrevFile = id => path.join(DATA_DIR, 'sources', `${id}.prev.json`)
/** A note older than this is dropped on the next write: no card looks back that far. */
const KEEP_MS = 30 * 86400_000
const SOURCE_ID = /^[a-z0-9-]+$/i

/** A JSON object from `file`, or `{}` when it is missing, broken or not an object. */
function readMap(file) {
  try {
    if (!existsSync(file)) return {}
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}
function write(file, value) {
  try {
    writeAtomic(file, JSON.stringify(value, null, 1))
  } catch (e) {
    console.error(`since: could not write ${path.basename(file)}: ${e.message}`)
  }
}

/**
 * Pure: `prev` with a note `{ [field]: before[k], at }` for every key whose
 * value differs between `before` and `after`. A key `before` never had is
 * NOT a change (a new ticket or flow), and notes older than KEEP_MS from `at`
 * are dropped. A key whose value comes BACK to the value its note holds drops
 * that note: the change undid itself (a flow open, then done, then open again),
 * so the card must not read it as news ("is open"). Returns `{ prev, changed }`.
 */
export function notePrev(prev, before, after, field, at) {
  const out = {}
  const cutoff = Date.parse(at) - KEEP_MS
  let changed = false
  for (const [k, v] of Object.entries(prev || {})) {
    if (Date.parse(v?.at) >= cutoff) out[k] = v
    else changed = true
  }
  for (const [k, v] of Object.entries(after || {})) {
    if (!Object.hasOwn(before || {}, k) || before[k] === v) continue
    if (Object.hasOwn(out, k) && out[k]?.[field] === v) {
      delete out[k]
      changed = true
      continue
    }
    out[k] = { [field]: before[k], at }
    changed = true
  }
  return { prev: out, changed }
}

// ═══ levels (orchestration.mjs) ═══

export const readLevels = () => readMap(LEVELS_FILE)
export const readLevelsPrev = () => readMap(LEVELS_PREV_FILE)

/**
 * After an orchestration build: note every ticket whose level changed since
 * the previous build, then merge `levels` ({ ticketId: level or null }) into
 * levels.json. Merged, not replaced: a build covers one collection, and the
 * next build of another must not forget these tickets. The first build ever
 * (no levels.json) notes nothing, so the card never opens on every ticket.
 */
export function recordLevels(levels, at = new Date().toISOString()) {
  const before = readLevels()
  const { prev, changed } = notePrev(readLevelsPrev(), before, levels, 'level', at)
  if (changed) write(LEVELS_PREV_FILE, prev)
  if (Object.entries(levels).some(([k, v]) => before[k] !== v)) write(LEVELS_FILE, { ...before, ...levels })
}

// ═══ flows (flows.mjs writeFlow) ═══

export const readFlowsPrev = () => readMap(FLOWS_PREV_FILE)

/** A flow's status went from `before` to `after` (writeFlow calls this only when they differ). */
export function recordFlowStatus(id, before, after, at = new Date().toISOString()) {
  const { prev, changed } = notePrev(readFlowsPrev(), { [id]: before }, { [id]: after }, 'status', at)
  if (changed) write(FLOWS_PREV_FILE, prev)
}

// ═══ ticket sources (factory.mjs refreshSource) ═══

/** `{ fetchedAt, tickets }` from sources/<id>.prev.json, or null when there is none. */
export function readSourcePrev(id) {
  if (!SOURCE_ID.test(String(id || ''))) return null
  const file = sourcePrevFile(id)
  if (!existsSync(file)) return null
  const v = readMap(file)
  return { fetchedAt: v.fetchedAt ?? null, tickets: v.tickets && typeof v.tickets === 'object' ? v.tickets : {} }
}

/**
 * A refresh replaced source `id`: `before` and `after` are the parsed files
 * (`{ fetchedAt, tickets: { ID: { state } } }`). Notes every ticket whose
 * state changed; `fetchedAt` is the replaced file's.
 */
export function recordSource(id, before, after, at = new Date().toISOString()) {
  if (!before || !after || !SOURCE_ID.test(String(id || ''))) return
  const states = src => Object.fromEntries(Object.entries(src.tickets || {}).map(([k, t]) => [k, t?.state ?? '']))
  const { prev } = notePrev(readSourcePrev(id)?.tickets, states(before), states(after), 'state', at)
  write(sourcePrevFile(id), { fetchedAt: before.fetchedAt ?? null, tickets: prev })
}
