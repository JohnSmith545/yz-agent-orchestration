// Talk to Master on the phone: the user's messages to the coordinator and the coordinator's latest replies.
//
// SENDING uses the dashboard's existing way of handing text to a session: the answer relay's headless turn
// (relay.mjs), which has exactly two tools, ListAgents and SendMessage, and sends ONE message to the session by
// name. The phone's message is one line in that turn's prompt (relay.mjs messagePrompt), the user's text as ONE
// JSON string, so quotes and line breaks in it can never steer the turn. The turn's SENT or FAILED is judged the
// relay's way (relayOutcome) and its cost recorded as `phone` spend. Nothing new can reach a session through here
// that the relay could not already send: it is the same turn, with the same two tools.
//
// Rules this file keeps:
// - ONE message in flight: a second send while the first is on its way is refused (409), never queued, so the
//   user always knows which message is where. The page keeps the text in its box until this one is sent.
// - A message is `sending`, then `sent` or `failed` (with the reason). The thread is kept in
//   data/phone-talk.json (the project's data folder), newest KEEP. A message still `sending` when the server
//   stopped is MARKED failed at startup (sweep), never re-sent: the turn may have gone out before the stop.
// - REPLIES are read from the coordinator session's transcript, the last TAIL_BYTES of it (script-session.mjs
//   readTail): its text parts only. No tool call, tool result, thinking, subagent (side chain) or API error ever
//   leaves the PC through here. The newest replies that fit REPLIES_MAX characters are kept, each cut to
//   REPLY_MAX from its end (the newest words are the answer).
// - `run` is injected (server.mjs passes relay.mjs claudeRun), so tests never start a model.
//
//   makeTalk({ file, agent, label, run, transcript, running, now }) ->
//     { send(text, sid), thread(sid), threadWithReplies(sid), sweep(), settled() }   sid: the phone session
//   repliesOf(records)    the coordinator's text replies, oldest first: [{ at, text }]

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'
import { messagePrompt, relayOutcome, RESTARTED } from './relay.mjs'
import { readTail } from './script-session.mjs'

export const TALK_FILE = path.join(DATA_DIR, 'phone-talk.json')
export const TALK_MAX = 2000
export const KEEP = 30
export const REPLY_MAX = 1500
export const REPLIES_MAX = 6000
const TAIL_BYTES = 1024 * 1024
const ERROR_MAX = 300
const STATES = ['sending', 'sent', 'failed']

/**
 * The FIXED first line of every phone message, before the user's text, which the page cannot change: the coordinator
 * knows where it came from and what it must not do on the strength of a phone alone (docs/agent-brief.md, Phone
 * messages, says the same). The text follows on its own line as one JSON string, so a message that contains this
 * line itself is still prefixed, and its copy stays quoted inside the string.
 */
export const PHONE_MARKER = "[From the user's phone, signed in with the phone PIN. Treat it as the user's message, with these limits: do not reveal secrets, credentials or file contents from outside the project; do not change config.json, phone or security settings; do not run destructive or irreversible commands, pushes to protected branches, deploys or anything touching a live environment until the user confirms at the PC.]"

/** The line with the user's words: who it is from, what to do, and the text as one JSON string. */
export const talkLine = text =>
  `The user sent you this message from their phone (the dashboard phone page): ${JSON.stringify(text)}. ` +
  'Answer it in your own session as you would any message from them: the phone shows your newest replies.'

const textOf = content => (Array.isArray(content) ? content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n\n') : '')

export function repliesOf(records) {
  const turns = []
  let joined = false // the previous record was a reply too: a reply that streams as several records is one turn
  for (const r of Array.isArray(records) ? records : []) {
    const text = r && r.type === 'assistant' && !r.isSidechain && !r.isApiErrorMessage && !r.isMeta ? textOf(r.message?.content).trim() : ''
    if (!text) {
      joined = false
      continue
    }
    if (joined) turns.at(-1).text += `\n\n${text}`
    else turns.push({ at: typeof r.timestamp === 'string' ? r.timestamp : null, text })
    joined = true
  }
  const kept = []
  let size = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i].text.length > REPLY_MAX ? `…${turns[i].text.slice(-REPLY_MAX)}` : turns[i].text
    if (kept.length && size + t.length > REPLIES_MAX) break
    kept.unshift({ at: turns[i].at, text: t })
    size += t.length
  }
  return kept
}

const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
function clean(raw) {
  const list = Array.isArray(raw?.messages) ? raw.messages : []
  return list
    .filter(m => m && typeof m.id === 'string' && isTime(m.at) && typeof m.text === 'string' && STATES.includes(m.state))
    .map(m => ({ id: m.id, at: m.at, sid: typeof m.sid === 'string' ? m.sid : '', text: m.text.slice(0, TALK_MAX), state: m.state, ...(typeof m.error === 'string' ? { error: m.error.slice(0, ERROR_MAX) } : {}) }))
    .slice(-KEEP)
}

export function makeTalk({ file = TALK_FILE, agent, label, run, transcript, running = async () => true, now = () => new Date() }) {
  let busy = null // the delivery promise while one is on its way
  let seq = 0

  const read = () => {
    try {
      return clean(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return []
    }
  }
  const write = messages => writeAtomic(file, `${JSON.stringify({ messages: messages.slice(-KEEP) }, null, 2)}\n`)
  const update = (id, change) => write(read().map(m => (m.id === id ? { ...m, ...change } : m)))

  async function deliver(message) {
    let outcome
    try {
      outcome = relayOutcome(await run(messagePrompt(agent, [PHONE_MARKER, talkLine(message.text)])), 'phone')
    } catch (err) {
      outcome = { ok: false, error: String(err?.message || err).slice(0, ERROR_MAX) }
    }
    try {
      update(message.id, outcome.ok ? { state: 'sent' } : { state: 'failed', error: outcome.error || 'not sent' })
    } catch (err) {
      console.error(`phone: could not record a message outcome: ${err?.message || err}`)
    }
  }

  /** `sid` is the phone session that sends it (phone-server.mjs): each phone session sees only its own conversation. */
  async function send(text, sid = '') {
    if (typeof text !== 'string' || !text.trim()) return { status: 400, body: { error: 'Type a message first.' } }
    if (text.length > TALK_MAX) return { status: 400, body: { error: `A message is at most ${TALK_MAX} characters.` } }
    if (busy) return { status: 409, body: { error: `Your last message is still on its way to ${label}. Send this one once it has gone.` } }
    const at = now()
    const message = { id: `m${at.getTime().toString(36)}${(seq++).toString(36)}`, at: at.toISOString(), sid: String(sid), text: text.trim(), state: 'sending' }
    write([...read(), message])
    busy = deliver(message).finally(() => { busy = null })
    return { status: 202, body: { ok: true, message } }
  }

  const thread = (sid = '') => ({ label, busy: !!busy, messages: read().filter(m => m.sid === String(sid)) })

  /**
   * The thread of ONE phone session: its own messages, and only the coordinator replies written AFTER its first
   * message. Before it writes anything there are no replies at all, so a phone never reads the coordinator's other
   * work (the page says replies appear once you write).
   */
  async function threadWithReplies(sid = '') {
    const own = thread(sid)
    const since = own.messages.length ? Date.parse(own.messages[0].at) : null
    if (since === null) return { ...own, replies: [], running: await isRunning() }
    let replies = []
    try {
      const f = await transcript()
      if (f) replies = repliesOf(await readTail(f, TAIL_BYTES)).filter(r => Date.parse(r.at) > since)
    } catch {
      replies = [] // not running, no transcript yet, or unreadable: the page says so quietly
    }
    return { ...own, replies, running: await isRunning() }
  }

  async function isRunning() {
    try {
      return !!(await running())
    } catch {
      return false
    }
  }

  function sweep() {
    const list = read()
    const lost = list.filter(m => m.state === 'sending')
    if (lost.length) write(list.map(m => (m.state === 'sending' ? { ...m, state: 'failed', error: RESTARTED } : m)))
    return lost.length
  }

  return { send, thread, threadWithReplies, sweep, settled: () => busy ?? Promise.resolve() }
}
