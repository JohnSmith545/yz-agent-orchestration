// Sessions waiting on the user: a Claude Code Notification hook (tools/waiting-hook.mjs) records each session that
// stopped for the user's permission or reply, and the server shows the waits that still stand.
//
// data/waiting.json (in DATA_ROOT, one file for every project, keyed by session id):
//   { "<sessionId>": { kind: 'permission' | 'question', reason, at: ISO time, size, transcript, cwd } }
// `size` is the transcript's size in bytes when the hook ran. A wait stands while nothing the session did since
// then shows it moved on: `resumedIn` reads the bytes past `size` for a real user line (a typed reply, or the tool
// result that follows an approved or denied permission). Hook notes and meta lines written while it waits do not
// count. So no second hook is needed to clear a wait.
//
// Rules this file keeps:
// - An idle prompt is a wait only when the session's last reply ends with a question mark (the chat's rule,
//   chat.mjs lastExchange): a session that finished its work and went idle is not waiting on anyone.
// - Pure except readWaits / writeWaits / tailFrom, so the tests build any state.

import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs' // the small reads the hook and server do
import path from 'node:path'
import { writeAtomic } from './atomic-write.mjs' // a reader never sees half a file
import { DATA_ROOT } from './project-store.mjs' // data/ (or FACTORY_DATA_DIR), shared by every project

export const WAITING_FILE = path.join(DATA_ROOT, 'waiting.json') // every session's recorded wait
export const KEEP_DAYS = 7 // a wait older than this is dropped the next time the hook writes
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
  const type = input?.notification_type
  const message = String(input?.message || '')
  const asks = /\?\s*$/.test(String(lastReply || ''))
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

// Whether the transcript bytes written after a wait show the session moved on.
export const resumedIn = tail => lines(tail).some(isRealUser)

// The entries with this session's wait recorded (replacing its last one) and week-old ones dropped.
export function recordWait(entries, input, wait, { size, now = Date.now() }) {
  const cutoff = now - KEEP_DAYS * 86_400_000
  const kept = Object.fromEntries(Object.entries(entries || {}).filter(([id, e]) => id !== input.session_id && Date.parse(e?.at) >= cutoff))
  kept[input.session_id] = { ...wait, at: new Date(now).toISOString(), size, transcript: input.transcript_path || '', cwd: input.cwd || '' }
  return kept
}

/** The recorded waits; {} when there is no file or it cannot be read. */
export function readWaits(file = WAITING_FILE) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

export const writeWaits = (entries, file = WAITING_FILE) => writeAtomic(file, JSON.stringify(entries, null, 2)) // saves every wait at once

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
