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
// - A delivered message carries `deliveredAt`, so the page can say the coordinator is working from then on.
// - REPLIES are read from the coordinator session's transcript, the last TAIL_BYTES of it (script-session.mjs
//   readTail): its text parts only. No tool call, tool result, thinking, subagent (side chain) or API error ever
//   leaves the PC through here. Each reply is cut to REPLY_MAX from its end (the newest words are the answer).
//   The transcript is read again only when its size or time changed (the page polls every 5 s while it waits).
// - ONE THREAD FOR EVERY SIGNED-IN PHONE (the chat, 2026-11-26): every phone session is the user behind the same
//   PIN, so each sees the last KEEP messages from any of them, and under each the coordinator replies written after
//   it and no later than the next one (matchReplies). A reply written at or before the oldest kept message is never
//   shown, so the coordinator's work from before the first phone message stays on the PC. Which session sent a
//   message (sid) is kept in the file and never returned. Each exchange keeps its newest replies that fit
//   EXCHANGE_MAX characters. ⚠️ It used to be one thread per phone session (a39d9c2); the user asked for the history
//   to survive a new sign-in. ⚠️ Replies older than the transcript's last TAIL_BYTES, or in a coordinator session
//   that has since been replaced by a new one, are not found: the message stays, with no reply under it.
// - `run` is injected (server.mjs passes relay.mjs claudeRun), so tests never start a model.
// - A failed message says WHY IN PLAIN WORDS (plainReason): the dashboard could not start a model run on this PC,
//   the coordinator has no session open, the PC is busy, or could not deliver it. ⚠️ The raw reason (spawn ENOENT,
//   an exit code, a FAILED line) goes to the server log only and never to the page (QA, 2026-11-26: a message
//   said Not delivered: ENOENT). An old raw reason already in the file is put in plain words when it is shown.
//
//   makeTalk({ file, agent, label, run, transcript, running, now, readRecords, log }) ->
//     { send(text, sid), thread(), threadWithReplies(), sweep(), settled() }   sid: the phone session that sends
//   repliesOf(records)               the coordinator's text replies, oldest first: [{ at, text }]
//   matchReplies(messages, replies)  each message with the replies that followed it: [{ ...message, replies }]

import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'
import { messagePrompt, relayOutcome, RESTARTED } from './relay.mjs'
import { readTail } from './script-session.mjs'

export const TALK_FILE = path.join(DATA_DIR, 'phone-talk.json')
export const TALK_MAX = 2000
export const KEEP = 30
export const REPLY_MAX = 1500
/** One exchange (a message and the replies after it) keeps its newest replies that fit, so a busy hour stays light. */
export const EXCHANGE_MAX = 6000
const TAIL_BYTES = 2 * 1024 * 1024
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

/** The plain words a failed message may show; `noSession` is built with the coordinator's label. */
export const REASONS = Object.freeze({
  start: 'The dashboard could not start a model run on this PC.',
  busy: 'The PC is busy. Try again in a moment.',
  restarted: 'The dashboard restarted before it went. Try again.',
  other: 'Could not deliver it. Try again.',
})
const noSession = label => `${label} has no session open. Open it on the PC, then send again.`

/** A raw relay or spawn reason in plain words. A reason that is already plain is returned as it is. */
export function plainReason(raw, label) {
  const s = String(raw ?? '')
  if (Object.values(REASONS).includes(s) || s === noSession(label)) return s
  if (/ENOENT|EACCES|EPERM|no claude binary|failed to start|not recognized as an internal|cannot find/i.test(s)) return REASONS.start
  if (/no session|no agent|not running|has no session|session (is )?closed|no such session/i.test(s)) return noSession(label)
  if (/restarted/i.test(s)) return REASONS.restarted
  if (/timed out|timeout|busy|overloaded|rate.?limit|\b429\b|\b529\b|EBUSY|ETIMEDOUT|try again later/i.test(s)) return REASONS.busy
  return REASONS.other
}

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
  return turns.map(t => ({ at: t.at, text: t.text.length > REPLY_MAX ? `…${t.text.slice(-REPLY_MAX)}` : t.text }))
}

/**
 * Each message (oldest first) with the replies written AFTER it and no later than the next message, the newest that
 * fit EXCHANGE_MAX (always at least the newest one). A reply at or before the first message, or with no readable
 * time, belongs to none and is dropped: that is the line that keeps the coordinator's other work off the phone.
 */
export function matchReplies(messages, replies) {
  const list = Array.isArray(messages) ? messages : []
  const starts = list.map(m => Date.parse(m?.at))
  const groups = list.map(() => [])
  for (const r of Array.isArray(replies) ? replies : []) {
    const t = Date.parse(r?.at)
    if (Number.isNaN(t)) continue
    let k = -1
    for (let i = 0; i < starts.length; i++) if (t > starts[i]) k = i
    if (k >= 0) groups[k].push({ at: r.at, text: String(r.text ?? '') })
  }
  return list.map((m, i) => {
    const kept = []
    let size = 0
    for (let j = groups[i].length - 1; j >= 0; j--) {
      const r = groups[i][j]
      if (kept.length && size + r.text.length > EXCHANGE_MAX) break
      kept.unshift(r)
      size += r.text.length
    }
    return { ...m, replies: kept }
  })
}

const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
function clean(raw) {
  const list = Array.isArray(raw?.messages) ? raw.messages : []
  return list
    .filter(m => m && typeof m.id === 'string' && isTime(m.at) && typeof m.text === 'string' && STATES.includes(m.state))
    .map(m => ({
      id: m.id, at: m.at, sid: typeof m.sid === 'string' ? m.sid : '', text: m.text.slice(0, TALK_MAX), state: m.state,
      ...(typeof m.error === 'string' ? { error: m.error.slice(0, ERROR_MAX) } : {}),
      ...(m.state === 'sent' && isTime(m.deliveredAt) ? { deliveredAt: m.deliveredAt } : {}),
    }))
    .slice(-KEEP)
}

export function makeTalk({ file = TALK_FILE, agent, label, run, transcript, running = async () => true, now = () => new Date(), readRecords = readTail, log = m => console.error(m) }) {
  let busy = null // the delivery promise while one is on its way
  let seq = 0
  let cache = { key: '', replies: [] } // the transcript's replies, read again only when the file changed

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
      // no paid turn for a coordinator with no session open: it could only fail (QA, 2026-11-26); the page puts the
      // text back in the box, so Send again is the user's own press once the session is open
      if (!(await isRunning())) throw new Error(noSession(label))
      outcome = relayOutcome(await run(messagePrompt(agent, [PHONE_MARKER, talkLine(message.text)])), 'phone')
    } catch (err) {
      outcome = { ok: false, error: String(err?.message || err).slice(0, ERROR_MAX) }
    }
    // the raw reason for the PC's log; the phone gets plain words
    if (!outcome.ok) log(`phone: a message to ${label} was not delivered: ${String(outcome.error || 'no reason given').slice(0, ERROR_MAX)}`)
    try {
      update(message.id, outcome.ok ? { state: 'sent', deliveredAt: now().toISOString() } : { state: 'failed', error: plainReason(outcome.error, label) })
    } catch (err) {
      console.error(`phone: could not record a message outcome: ${err?.message || err}`)
    }
  }

  /** `sid` is the phone session that sends it (phone-server.mjs): kept in the file, never shown. */
  async function send(text, sid = '') {
    if (typeof text !== 'string' || !text.trim()) return { status: 400, body: { error: 'Type a message first.' } }
    if (text.length > TALK_MAX) return { status: 400, body: { error: `A message is at most ${TALK_MAX} characters.` } }
    if (busy) return { status: 409, body: { error: `Your last message is still on its way to ${label}. Send this one once it has gone.` } }
    const at = now()
    const message = { id: `m${at.getTime().toString(36)}${(seq++).toString(36)}`, at: at.toISOString(), sid: String(sid), text: text.trim(), state: 'sending' }
    write([...read(), message])
    busy = deliver(message).finally(() => { busy = null })
    return { status: 202, body: { ok: true, message: shown(message) } }
  }

  /** A message as a phone sees it: never which session sent it. */
  const shown = ({ sid, ...m }) => (typeof m.error === 'string' ? { ...m, error: plainReason(m.error, label) } : m)
  const thread = () => ({ label, busy: !!busy, messages: read().map(shown) })

  /** The coordinator's text replies from the transcript's tail; the same answer while the file has not changed. */
  async function replies() {
    try {
      const f = await transcript()
      if (!f) return []
      const st = await stat(f)
      const key = `${f}\0${st.size}\0${st.mtimeMs}`
      if (cache.key !== key) cache = { key, replies: repliesOf(await readRecords(f, TAIL_BYTES)) }
      return cache.replies
    } catch {
      return [] // not running, no transcript yet, or unreadable: the page says so quietly
    }
  }

  /**
   * The one thread every phone sees: the last KEEP messages from any phone session, each with the coordinator
   * replies written after it (matchReplies), and the PC's time (the page judges its 10 minute wait by it, not by
   * the phone's own clock). No message yet: no transcript is even read.
   */
  async function threadWithReplies() {
    const all = thread()
    const messages = all.messages.length ? matchReplies(all.messages, await replies()) : []
    return { ...all, messages, running: await isRunning(), now: now().toISOString() }
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
