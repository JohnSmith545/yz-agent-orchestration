// Sessions waiting on the user: a Claude Code Notification hook (tools/waiting-hook.mjs) records each session that
// stopped for the user's permission or reply, and the server shows the waits that still stand.
//
// data/waiting/<sessionId>.json (in DATA_ROOT, shared by every project), ONE file per session, so two hooks writing at
// the same moment never overwrite each other's wait:
//   { kind: 'permission' | 'question', reason, at: ISO time, size, transcript, cwd }
// `size` is the transcript's size in bytes when the hook ran. A wait stands while nothing the session did since
// then shows it moved on: `resumedIn` reads the bytes past `size` for a real user line (a typed reply, a message, or
// the tool result that follows an approved or denied permission) or a new reply of the session's own. Hook notes and meta lines written while it waits do not
// count. So no second hook is needed to clear a wait.
//
// Rules this file keeps:
// - An idle prompt is a wait only when the session's last reply ends with a question mark (the chat's rule,
//   chat.mjs lastExchange): a session that finished its work and went idle is not waiting on anyone.
// - Pure except readWaits / writeWaits / tailFrom, so the tests build any state.

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, rmSync } from 'node:fs' // the small reads and writes the hook and server do
import path from 'node:path'
import { writeAtomic } from './atomic-write.mjs' // a reader never sees half a file
import { DATA_ROOT } from './project-store.mjs' // data/ (or FACTORY_DATA_DIR), shared by every project

export const WAITING_DIR = path.join(DATA_ROOT, 'waiting') // one file per session's recorded wait
export const KEEP_DAYS = 7 // a wait older than this is dropped the next time the hook writes
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/ // a session id used as a file name: never a path
// a reply that ends with a question, a bold, quoted or bracketed one too ('**Ship it?**', 'Ship it?")')
const ASKS = /\?[\s*_`"')\]]*$/
const REASON_MAX = 140 // one line on a card or a Human review row
const TAIL_MAX = 256 * 1024 // how much of a transcript's end is read

/** One line, cut at a word with … past `max`. */
function oneLine(s, max = REASON_MAX) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  return (cut.lastIndexOf(' ') > max / 2 ? cut.slice(0, cut.lastIndexOf(' ')) : cut) + '…'
}

/** The last non-empty line of a reply: the question itself, not the paragraphs before it. */
const lastLine = text => String(text || '').trim().split(/\n+/).filter(l => l.trim()).pop() || ''

// Which notification means the session waits on the user, and why, in one line; null when it does not.
export function waitKind(input, lastReply) {
  const event = input?.hook_event_name
  // The VS Code extension sends no Notification: a permission dialog fires PermissionRequest, a finished reply Stop.
  if (event === 'PermissionRequest') return { kind: 'permission', reason: input.tool_name ? `Needs your OK to use ${input.tool_name}` : 'Needs your OK to go on' }
  if (event === 'Stop') {
    const reply = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : String(lastReply || '')
    return ASKS.test(reply) ? { kind: 'question', reason: oneLine(lastLine(reply)) } : null
  }
  const type = input?.notification_type
  const message = String(input?.message || '')
  const asks = ASKS.test(String(lastReply || ''))
  const question = () => (asks ? { kind: 'question', reason: oneLine(lastLine(lastReply)) } : null)
  if (type === 'permission_prompt') return { kind: 'permission', reason: oneLine(message) }
  if (type === 'idle_prompt') return question()
  if (type === 'elicitation_dialog') return { kind: 'question', reason: oneLine(message) }
  if (type) return null
  // older Claude Code sends no notification_type: the message says which
  if (/permission/i.test(message)) return { kind: 'permission', reason: oneLine(message) }
  if (/waiting for your input/i.test(message)) return question()
  return null
}

/** Each whole JSON line of a transcript slice; a broken or partial line is skipped. */
function lines(text) {
  const out = []
  for (const l of String(text || '').split('\n')) {
    if (!l.trim()) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      /* a partial line still being written */
    }
  }
  return out
}

/** A line the user (or a tool result) wrote, not a hook note or a meta line. */
const isRealUser = o => o?.type === 'user' && !o.isMeta

// The newest assistant text in a transcript slice, or '' when the user wrote after it.
export function lastReplyText(tail) {
  const all = lines(tail)
  for (let i = all.length - 1; i >= 0; i--) {
    const o = all[i]
    if (isRealUser(o)) return ''
    if (o?.type !== 'assistant') continue
    const content = o.message?.content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c?.type === 'text').map(c => c.text).join('\n') : ''
    if (text.trim()) return text
  }
  return ''
}

// Whether the transcript bytes written after a wait show the session moved on. A permission wait ends only on a user
// line (the tool result after Approve or Deny): later blocks of the same assistant message can land after the hook ran.
export const resumedIn = (tail, kind = 'question') => lines(tail).some(o => isRealUser(o) || (kind !== 'permission' && o?.type === 'assistant'))

// The session's wait to save, or null when `prev` is the same wait and still stands (keep its time: no second alert).
export function nextWait(prev, input, wait, { size, now = Date.now(), prevResumed = true }) {
  const same = prev && !prevResumed && prev.kind === wait.kind && prev.reason === wait.reason && prev.transcript === (input.transcript_path || '')
  if (same) return null
  return { ...wait, at: new Date(now).toISOString(), size, transcript: input.transcript_path || '', cwd: input.cwd || '' }
}

// The waits that still stand for these live sessions, newest first: [{ sessionId, label, kind, reason, at }].
// readTail(file, size) gives the transcript text written after the hook ran, or null when it cannot be read.
export function standingWaits(entries, sessions, readTail) {
  const out = []
  for (const s of sessions || []) {
    const e = entries?.[s.sessionId]
    if (!e || !e.transcript) continue
    const tail = readTail(e.transcript, Number(e.size) || 0)
    if (tail == null || resumedIn(tail, e.kind)) continue
    out.push({ sessionId: s.sessionId, label: s.label, kind: e.kind, reason: e.reason || '', at: e.at || '' })
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

/** The transcript text past `size` (what the session wrote since the hook ran), or null when unreadable. */
export const tailAfter = (file, size) => tailFrom(file, size)?.text ?? null

/** The recorded waits by session id; {} when there are none. A file that cannot be read is left out. */
export function readWaits(dir = WAITING_DIR) {
  let names = []
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.json') && SAFE_ID.test(n.slice(0, -5)))
  } catch {
    return {}
  }
  const out = {}
  for (const n of names) {
    try {
      const v = JSON.parse(readFileSync(path.join(dir, n), 'utf8'))
      if (v && typeof v === 'object' && !Array.isArray(v)) out[n.slice(0, -5)] = v
    } catch {
      /* mid-write or broken: skip it this round */
    }
  }
  return out
}

/** Saves one session's wait in its own file; false (and nothing written) for an id that is not a plain id. */
export function writeWait(sessionId, entry, dir = WAITING_DIR) {
  if (!SAFE_ID.test(String(sessionId))) return false
  writeAtomic(path.join(dir, `${sessionId}.json`), JSON.stringify(entry, null, 2))
  return true
}

/** Deletes the waits older than KEEP_DAYS. */
export function pruneWaits(dir = WAITING_DIR, now = Date.now()) {
  const cutoff = now - KEEP_DAYS * 86_400_000
  for (const [id, e] of Object.entries(readWaits(dir))) if (!(Date.parse(e?.at) >= cutoff)) rmSync(path.join(dir, `${id}.json`), { force: true })
}

/** A file's bytes from `start` to its end (at most the newest `max`), and its size; null when unreadable. */
export function tailFrom(file, start = 0, max = TAIL_MAX) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const from = Math.max(start, size - max, 0)
    const buf = Buffer.alloc(Math.max(0, size - from))
    readSync(fd, buf, 0, buf.length, from)
    return { text: buf.toString('utf8'), size }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
