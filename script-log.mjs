// The SCRIPT run log (#/script, the page's History list): the newest 50 runs, in data/script-log.json.
//
//   { runs: [{ id, at, ms, text, output, ok, error, cancelled, cost,
//              context: { used: [{ title, chars }], skipped: [{ title, why }] } }] }   newest first
//
// Rules this file keeps:
// - `text` is the user's OWN text as posted, never the composed input. The context is kept as titles, sizes and
//   reasons only, never its text: entryOf copies those three fields and nothing else.
// - `output` is the model's text as streamed, capped at 40,000 characters; `cost` is a number or null; `error`
//   is the plain message of a failed or stopped run, else null.
// - The path follows FACTORY_DATA_DIR (factory-state.mjs DATA_DIR), so tests never write data/. Writes go through
//   writeAtomic. A missing file or one that is not JSON reads as no runs; an entry of the wrong shape (a hand
//   edit) is left out and the rest still read.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'

export const LOG_FILE = path.join(DATA_DIR, 'script-log.json')
export const LOG_LIMITS = Object.freeze({ runsMax: 50, outputMax: 40_000 })
const ID = /^r-[a-z0-9]{1,40}$/

/** A short id, roughly time ordered, safe in a URL path. */
export const newRunId = () => `r-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`

const str = (v, max = 2_000) => (typeof v === 'string' ? v.slice(0, max) : '')
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** One run as stored: exactly the agreed fields, the output capped, the context reduced to titles and sizes. */
export function entryOf(r = {}) {
  const ctx = isObject(r.context) ? r.context : {}
  return {
    id: String(r.id),
    at: String(r.at),
    ms: Number.isFinite(r.ms) ? Math.max(0, Math.round(r.ms)) : 0,
    text: str(r.text, 64_000),
    output: str(r.output, LOG_LIMITS.outputMax),
    ok: r.ok === true,
    error: typeof r.error === 'string' && r.error ? r.error.slice(0, 1_000) : null,
    cancelled: r.cancelled === true,
    cost: typeof r.cost === 'number' && Number.isFinite(r.cost) ? r.cost : null,
    context: {
      used: (Array.isArray(ctx.used) ? ctx.used : []).filter(isObject).map(u => ({ title: str(u.title, 200), chars: Number(u.chars) || 0 })),
      skipped: (Array.isArray(ctx.skipped) ? ctx.skipped : []).filter(isObject).map(s => ({ title: str(s.title, 200), why: str(s.why, 500) })),
    },
  }
}

const valid = e => isObject(e) && typeof e.id === 'string' && ID.test(e.id) && typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at))
  && typeof e.text === 'string' && typeof e.output === 'string' && typeof e.ok === 'boolean' && typeof e.cancelled === 'boolean' && isObject(e.context)

/** The runs, newest first; [] when there are none or the file is broken. */
export function readLog(file = LOG_FILE) {
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(raw?.runs) ? raw.runs.filter(valid).map(entryOf) : []
  } catch {
    return []
  }
}

const writeLog = (runs, file) => writeAtomic(file, JSON.stringify({ runs }, null, 1))

/** Add one run at the top, keeping the newest 50. Throws when the file cannot be written (the caller catches). */
export function appendRun(run, file = LOG_FILE) {
  const e = entryOf(run)
  if (!valid(e)) throw new Error('Not a run log entry.')
  writeLog([e, ...readLog(file).filter(r => r.id !== e.id)].slice(0, LOG_LIMITS.runsMax), file)
  return e
}

/** Remove one run. { ok } or { error, status: 404 }. */
export function removeRun(id, file = LOG_FILE) {
  const runs = readLog(file)
  const left = runs.filter(r => r.id !== id)
  if (left.length === runs.length) return { error: 'That run is not in the log any more.', status: 404 }
  writeLog(left, file)
  return { ok: true }
}

/** Remove every run. */
export function clearLog(file = LOG_FILE) {
  const removed = readLog(file).length
  writeLog([], file)
  return { ok: true, removed }
}
