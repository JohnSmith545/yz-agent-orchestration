// Pipeline tokens, the READING half: a running index of what every Claude Code transcript of the project spent, kept
// in data/token-index.json so the block never reads 2 GB twice. token-usage.mjs (pure) counts each record; this file
// finds the transcripts, reads only the bytes added since last time, and saves the totals.
//
//   listTranscripts({ claudeDirs, match })        the project's transcripts: [{ path, sessionId, sub, size, mtimeMs, ident }]
//   makeTokenIndex({ claudeDirs, match, file })   -> { refresh(), snapshot() }
//     refresh()    one pass over the transcripts (one at a time: a second call while one runs gets the same promise)
//     snapshot()   { files, building, progress, builtAt, lastRead }: what is ready now, never waiting on a read
//
// WHICH FILES: <claudeDir>/projects/<folder>/<session>.jsonl, a session's own transcript, and
// <claudeDir>/projects/<folder>/<session>/subagents/agent-<id>.jsonl, a subagent it started (under that session). A
// folder counts when its name holds sessionCwdMatch the way Claude Code writes a working folder (every character
// that is not a letter or digit becomes '-'), as subagents.mjs listSubagentFiles does, so a session started in a
// worktree of the repo counts too. Every claudeDir is read (the second account's sessions as well).
//
// THE INDEX, per file by path: its size, modified time and identity (inode and birth time), the byte offset read
// to, and token-usage.mjs's tally (per day and per hour per model totals, every reply it counted with what was
// counted for it, its newest replies, its title, its skipped and overlapping counts).
// - Only whole lines are read: a torn last line (the session is writing it) is left for the next refresh.
// - A file that grew is read from its offset; one that shrank, or whose identity changed, from the start.
// - A file that is gone is dropped and gives back the ids it owned; a file that met those ids as overlaps (dupOf)
//   is read again from the start, so a copy of a session in the other account's folder then counts them.
// - New files are read oldest first (by modified time), so the original of a moved session owns its history and
//   the copy counts the overlap. A later file with a LARGER copy of a reply (a fork can hold one with zero usage)
//   takes it over (token-usage.mjs tallyRecord), and the file that gave it up then lists that file in its dupOf.
// - The index is saved with writeAtomic after a pass that changed something, and every SAVE_EVERY_MS during a long
//   first build, so a restart picks up where it was. A saved index of another format or time zone (days are
//   local days) is thrown away and rebuilt.
// ⚠️ READ ONLY on the transcripts: nothing is ever written, moved or deleted under a claudeDir, and an index file
// placed under one is refused. Memory is bounded: a file is streamed in chunks, never loaded whole.

import { createReadStream, promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { newTally, tallyRecord } from './token-usage.mjs'

// 2: a reply keeps what was counted for it (tally.counted), so a larger copy can take it over
// 3: per hour totals and each file's newest replies (tally.hours, tally.recent), for Predict and warn (predict-*.mjs)
export const INDEX_VERSION = 3
const SAVE_EVERY_MS = 20_000
const MARKS = [Buffer.from('"type":"assistant"'), Buffer.from('"type":"custom-title"')]
const NL = 0x0a

/** A folder name the way Claude Code writes one for a working folder: every non-alphanumeric becomes '-'. */
const folderKey = s => String(s || '').replace(/[^A-Za-z0-9]/g, '-').toLowerCase()
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'

async function entries(dir) {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

async function statOf(file) {
  try {
    const st = await fs.stat(file, { bigint: true })
    if (!st.isFile()) return null
    return { size: Number(st.size), mtimeMs: Number(st.mtimeMs), ident: `${st.ino}-${st.birthtimeNs}` }
  } catch {
    return null
  }
}

/** Every transcript of the project in `claudeDirs`, with its size, modified time and identity. */
export async function listTranscripts({ claudeDirs = [], match = '' } = {}) {
  const want = folderKey(match)
  const out = []
  for (const claudeDir of claudeDirs) {
    const projects = path.join(claudeDir, 'projects')
    for (const folder of await entries(projects)) {
      if (!folderKey(folder).includes(want)) continue
      const dir = path.join(projects, folder)
      for (const name of await entries(dir)) {
        if (name.endsWith('.jsonl')) {
          const st = await statOf(path.join(dir, name))
          if (st) out.push({ path: path.join(dir, name), sessionId: name.slice(0, -'.jsonl'.length), sub: false, ...st })
          continue
        }
        const subs = path.join(dir, name, 'subagents')
        for (const sub of await entries(subs)) {
          if (!sub.startsWith('agent-') || !sub.endsWith('.jsonl')) continue
          const st = await statOf(path.join(subs, sub))
          if (st) out.push({ path: path.join(subs, sub), sessionId: name, sub: true, ...st })
        }
      }
    }
  }
  return out
}

/** Reads `file` from `entry.offset` up to `size`, whole lines only, into `entry.tally`. Returns the bytes taken. */
async function readInto(entry, file, size, owners, tallyOf, onBytes) {
  if (size <= entry.offset) return 0
  let rest = Buffer.alloc(0)
  let taken = 0
  const stream = createReadStream(file, { start: entry.offset, end: size - 1, highWaterMark: 1 << 20 })
  for await (const chunk of stream) {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk
    let start = 0
    for (let nl = buf.indexOf(NL, start); nl !== -1; nl = buf.indexOf(NL, start)) {
      const line = buf.subarray(start, nl)
      start = nl + 1
      if (!MARKS.some(m => line.includes(m))) continue
      let rec
      try {
        rec = JSON.parse(line.toString('utf8'))
      } catch {
        continue // a hand-made or broken line: not a record
      }
      tallyRecord(entry.tally, rec, { self: file, owners, tallyOf })
    }
    taken += start
    rest = buf.subarray(start)
    onBytes(chunk.length)
  }
  entry.offset += taken
  return taken
}

/** The index file as { files } when it is this format and time zone, else an empty one. */
function loadIndex(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (j?.version === INDEX_VERSION && j.timeZone === timeZone() && j.files && typeof j.files === 'object') return j.files
  } catch {
    /* no index yet, or a broken one: build it again */
  }
  return {}
}

export function makeTokenIndex({ claudeDirs = [], match = '', file, now = () => Date.now() } = {}) {
  const resolved = path.resolve(file)
  for (const dir of claudeDirs) {
    const rel = path.relative(path.resolve(dir), resolved)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('The token index must not be kept among the transcripts.')
  }
  let files = null // path -> { sessionId, sub, size, mtimeMs, ident, offset, tally }
  let owners = new Map()
  let running = null
  let complete = false
  let builtAt = null
  let progress = { done: 0, total: 0 }
  let lastRead = { bytes: 0, ms: 0, files: 0 }

  function load() {
    files = loadIndex(resolved)
    owners = new Map()
    for (const [p, e] of Object.entries(files)) for (const id of Object.keys(e.tally?.counted || {})) owners.set(id, p)
    complete = Object.keys(files).length > 0
  }

  /** Forgets what `p` counted and gives its ids back; the files that met them as overlaps start again too. */
  function reset(p, drop, done = new Set()) {
    const e = files[p]
    if (!e || done.has(p)) return
    done.add(p)
    for (const id of Object.keys(e.tally.counted)) if (owners.get(id) === p) owners.delete(id)
    if (drop) delete files[p]
    else {
      e.offset = 0
      e.tally = newTally()
    }
    for (const [q, other] of Object.entries(files)) if (q !== p && other.tally.dupOf.includes(p)) reset(q, false, done)
  }

  function save() {
    writeAtomic(resolved, JSON.stringify({ version: INDEX_VERSION, timeZone: timeZone(), savedAt: new Date(now()).toISOString(), files }))
  }

  async function pass() {
    if (files === null) load()
    const started = now()
    const listed = await listTranscripts({ claudeDirs, match })
    const seen = new Set(listed.map(f => f.path))
    let changed = false
    for (const p of Object.keys(files)) {
      if (!seen.has(p)) {
        reset(p, true)
        changed = true
      }
    }
    for (const f of listed) {
      const e = files[f.path]
      if (e && (e.ident !== f.ident || f.size < e.offset)) {
        reset(f.path, false)
        changed = true
      }
    }
    // oldest first, so the original of a copied history owns it
    const todo = listed.filter(f => f.size > (files[f.path]?.offset ?? 0)).sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path))
    progress = { done: 0, total: todo.reduce((t, f) => t + f.size - (files[f.path]?.offset ?? 0), 0) }
    let bytes = 0
    let savedAt = now()
    for (const f of todo) {
      const e = (files[f.path] ||= { sessionId: f.sessionId, sub: f.sub, size: 0, mtimeMs: 0, ident: f.ident, offset: 0, tally: newTally() })
      try {
        bytes += await readInto(e, f.path, f.size, owners, q => files[q]?.tally ?? null, n => (progress.done += n))
      } catch {
        continue // gone or locked between the listing and the read: the next pass tries again
      }
      Object.assign(e, { size: f.size, mtimeMs: f.mtimeMs, ident: f.ident })
      changed = true
      if (!complete && now() - savedAt > SAVE_EVERY_MS) {
        save()
        savedAt = now()
      }
    }
    for (const f of listed) if (files[f.path]) files[f.path].mtimeMs = f.mtimeMs
    if (changed) save()
    complete = true
    builtAt = new Date(now()).toISOString()
    progress = { done: progress.total, total: progress.total }
    lastRead = { bytes, ms: now() - started, files: todo.length }
  }

  return {
    refresh() {
      if (!running) running = pass().finally(() => (running = null))
      return running
    },
    snapshot() {
      if (files === null) load()
      return {
        files: Object.entries(files).map(([p, e]) => ({
          path: p, sessionId: e.sessionId, sub: e.sub, mtimeMs: e.mtimeMs, title: e.tally.title, days: e.tally.days,
          skipped: e.tally.skipped, dupes: e.tally.dupes, special: e.tally.special,
          hours: e.tally.hours || {}, recent: e.tally.recent || [], // Predict and warn (predict-*.mjs)
        })),
        building: !complete,
        progress: complete ? 1 : progress.total ? Math.min(progress.done / progress.total, 0.99) : 0,
        builtAt,
        lastRead,
      }
    },
  }
}
