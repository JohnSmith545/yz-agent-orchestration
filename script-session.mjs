// The live-session part of the SCRIPT context (#/script, the Context panel): the newest part of ONE running
// Claude Code session's conversation, picked by its dashboard label (Master, Agent 1 …), read fresh when the
// user presses Generate.
//
//   sessionText(records, max)   transcript records -> "User: …" and "Assistant: …" turns, newest that fit
//   readTail(file, bytes)       the last `bytes` of a transcript (they run to 100+ MB) as parsed records
//   sessionPart(label, { sessions, read })   -> { part: { title, text, keep: 'end' } } or { skipped: { title, why } }
//
// Rules this file keeps:
// - TEXT ONLY: the user's typed turns and the assistant's text parts. No tool calls, no tool results, no
//   thinking, and none of what the harness injects: system reminders, slash-command blocks, messages from other
//   sessions or subagents (isMeta, origin peer), task notices, compact summaries, side chains (subagents).
//   A user record counts only when its origin is the human (or, in older transcripts, it has none).
// - Consecutive records of one speaker are one turn (a reply streams as several records).
// - The newest turns that fit in `max` (12,000) are kept; when the newest alone is bigger, its END is kept,
//   marked "[earlier part cut]".
// - sessionPart NEVER throws: a session that is not running, a transcript that cannot be read, or one with
//   nothing said yet is skipped with a plain reason, and the run goes on without it.
// - `sessions` is injected (server.mjs: the running sessions as [{ label, state, transcript() }]), so tests
//   never read the real ~/.claude.

import { promises as fs } from 'node:fs'

import { LIMITS } from './script-context.mjs'

export const SESSION_MAX = LIMITS.sessionMax
/** How much of a transcript's end is read: enough for many turns of talk between the tool calls. */
export const TAIL_BYTES = 4 * 1024 * 1024
const CUT = '[earlier part cut] '

const INJECTED = [
  /<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g,
  /<(command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g,
  /<cross-session-message\b[^>]*>[\s\S]*?<\/cross-session-message>/g,
  /<agent-message\b[^>]*>[\s\S]*?<\/agent-message>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /^\[Request interrupted by user[^\]]*\]$/gm,
]
const clean = s => INJECTED.reduce((t, re) => t.replace(re, ''), String(s)).trim()

const textOf = content => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n\n')
}

/** One record as { role, text }, or null when it is not talk the user would call the conversation. */
function turnOf(r) {
  if (!r || typeof r !== 'object' || r.isSidechain || r.isMeta || r.isCompactSummary || r.isVisibleInTranscriptOnly) return null
  if (r.type === 'user') {
    if (r.origin && r.origin.kind !== 'human') return null
    if (Array.isArray(r.message?.content) && r.message.content.some(c => c?.type === 'tool_result')) return null
    const text = clean(textOf(r.message?.content))
    return text ? { role: 'User', text } : null
  }
  if (r.type === 'assistant' && !r.isApiErrorMessage) {
    const text = textOf(r.message?.content).trim()
    return text ? { role: 'Assistant', text } : null
  }
  return null
}

export function sessionText(records = [], max = SESSION_MAX) {
  const turns = []
  for (const r of records) {
    const t = turnOf(r)
    if (!t) continue
    const last = turns.at(-1)
    if (last?.role === t.role) last.text += `\n\n${t.text}`
    else turns.push(t)
  }
  const kept = []
  let size = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const line = `${turns[i].role}: ${turns[i].text}`
    const add = line.length + (kept.length ? 2 : 0)
    if (size + add <= max) {
      kept.unshift(line)
      size += add
      continue
    }
    if (!kept.length) {
      const head = `${turns[i].role}: ${CUT}`
      kept.unshift(head + turns[i].text.slice(-(max - head.length)))
    }
    break
  }
  return kept.join('\n\n')
}

/** The records in the last `bytes` of `file`; a first line cut by the window is dropped, a line that is not JSON skipped. */
export async function readTail(file, bytes = TAIL_BYTES) {
  const h = await fs.open(file, 'r')
  try {
    const { size } = await h.stat()
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    await h.read(buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split(/\r?\n/)
    if (start > 0) lines.shift()
    const out = []
    for (const l of lines) {
      if (!l.trim()) continue
      try {
        out.push(JSON.parse(l))
      } catch {
        /* a torn or non-JSON line */
      }
    }
    return out
  } finally {
    await h.close()
  }
}

/** The chosen session as a context part, or why it was skipped. */
export async function sessionPart(label, { sessions, read = readTail, max = SESSION_MAX } = {}) {
  const title = `Live session: ${label}`
  const skip = why => ({ skipped: { title, why } })
  let list
  try {
    list = await sessions()
  } catch {
    return skip('The running sessions could not be listed.')
  }
  const s = (Array.isArray(list) ? list : []).find(x => x?.label === label)
  if (!s) return skip(`${label} is not running now.`)
  let text
  try {
    const file = await s.transcript()
    if (!file) return skip('Its conversation could not be read.')
    text = sessionText(await read(file), max)
  } catch {
    return skip('Its conversation could not be read.')
  }
  if (!text) return skip('It has no conversation to share yet.')
  return { part: { title, text, keep: 'end' } }
}
