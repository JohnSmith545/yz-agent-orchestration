// Replies to a waiting session: the user's answer, typed on the dashboard (Human review, or the session's own page),
// goes to that Claude Code session as ONE message on the relay's path (relay.mjs sendMessageTurn: a short headless
// turn that uses SendMessage), at once, with no batching. The outcome is kept in memory per session for the page:
//
//   { status: 'sending' | 'sent' | 'failed', text, at, sentAt?, error? }
//
// Rules this file keeps:
// - One reply at a time per session: a second one while the first is still being sent is refused.
// - The text goes into the turn as ONE JSON string (replyLine), so it can never steer the relay turn itself.
// - A failure keeps the text, so Retry sends it again without typing it twice.
// - Nothing is written to disk: a restart forgets the outcome, and the session's own transcript is the record.

import { sendMessageTurn } from './relay.mjs' // the one relay turn every dashboard message to an agent goes through

export const REPLY_MAX = 2000 // characters in one reply: a decision or a short instruction, not a document

// The message line the session gets: who it is from, and the user's text as one JSON string.
export const replyLine = text => `The user replies to your question, from the dashboard: ${JSON.stringify(String(text))}`

// The replies store: send(), retry() and get() per session id; `run` is the relay's claude turn (stubbed in tests).
export function makeSessionReplies({ run, now = () => new Date().toISOString() }) {
  const replies = new Map() // sessionId -> { status, text, at, sentAt?, error? }

  /** Deliver `text` to the session named `name`; the record is 'sending' at once and settles when the turn ends. */
  function deliver(sessionId, name, text) {
    const record = { status: 'sending', text, at: now() }
    replies.set(sessionId, record)
    const done = sendMessageTurn(run, name, [replyLine(text)]).then(outcome => {
      if (replies.get(sessionId) !== record) return // a newer reply replaced this one
      replies.set(sessionId, outcome.ok ? { status: 'sent', text, at: record.at, sentAt: now() } : { status: 'failed', text, at: record.at, error: outcome.error })
    })
    return { record: { ...record }, done }
  }

  /** Refuses in plain words what cannot be sent now. */
  function check(sessionId, name) {
    if (!String(name || '').trim()) throw new Error('That session has no name the dashboard can message.')
    if (replies.get(sessionId)?.status === 'sending') throw new Error('Your last reply is still being sent. Wait for it, then try again.')
  }

  function send(sessionId, name, text) {
    const t = String(text ?? '').trim()
    if (!t) throw new Error('Write a reply first.')
    if (t.length > REPLY_MAX) throw new Error(`A reply can be at most ${REPLY_MAX} characters.`)
    check(sessionId, name)
    return deliver(sessionId, name, t)
  }

  function retry(sessionId, name) {
    const last = replies.get(sessionId)
    if (!last?.text) throw new Error('Nothing to send again: write a reply.')
    check(sessionId, name)
    return deliver(sessionId, name, last.text)
  }

  const get = sessionId => (replies.has(sessionId) ? { ...replies.get(sessionId) } : null)

  return { send, retry, get }
}
