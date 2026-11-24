// By-hand steps: work no agent can do, written out for the user as a checklist (CI/CD, cloud setup, a console
// setting, a human decision). An agent records them with `flow hand-step` (tools/hand-cli.mjs) and stops; the user
// does each one and ticks it off on the flow's page (public/flow-hand.js). Kept on the flow as `hand`:
//
//   hand: {
//     steps: [{ id: 'h1',                     a slug, h1, h2 … by default
//               do: 'Add the secret',         what to do, one line (HAND_MAX.do)
//               why?: 'The deploy reads it',  why, one line (HAND_MAX.why)
//               where?: 'GitHub › Settings › Secrets › Actions'   the exact place: a path, a page or a click path
//               copy?: 'FIREBASE_TOKEN=…',    a value to paste, shown in a block with a Copy button; may be several lines
//               expect: 'The secret is listed',   what the user should see when it worked, one line
//               at: '<time>',                 when the agent recorded it
//               done: null | { by: 'you', at }  THE USER'S tick: never an agent's }],
//     requestedAt?, requestSentAt?, requestError?   the user's Ask the agent for steps, and what the relay made of it
//   }
//
// Rules this file keeps:
// - `done` is the user's, like a step's `verified` (flows.mjs): only applyHandTick sets it, and keepHand takes it from
//   the stored file only, so an agent's rewrite can never tick a step. A tick stays only while what the step asks
//   (do, where, copy, expect) is unchanged: a step the agent rewrote is a new thing to do, and waits again.
// - The request fields are the server's, like output.requestedAt: only the stored file's survive a rewrite.
// - Every limit is refused with a plain sentence an agent can act on (validateHand, the CLI).
// Pure: no file access. flows.mjs validates `hand` on every write and calls keepHand from mergeKeepingAnswers.

import { sayShorter } from './flow-story.mjs'

export const HAND_MAX = Object.freeze({ steps: 20, do: 200, why: 160, where: 300, copy: 2000, expect: 200 })
/** The fields of a step the agent writes; `done` is the user's. */
export const HAND_FIELDS = Object.freeze(['do', 'why', 'where', 'copy', 'expect'])
/** What a step ASKS: a change to any of these is a new thing to do, so the user's tick goes. */
const ASKS = ['do', 'where', 'copy', 'expect']
/** The request fields the server writes (the request route, then the relay's outcome: relay.mjs). */
export const HAND_SERVER = Object.freeze(['requestedAt', 'requestSentAt', 'requestError'])
const SLUG = /^[a-z0-9-]+$/

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''

/**
 * One field's problem, or ''. `need`: it must be there. One line unless `lines` (the copy value).
 */
export function fieldProblem(key, v, { need = false } = {}) {
  if (v === undefined) return need ? `${key} must say ${key === 'do' ? 'what to do' : 'what the user should see when it worked'}` : ''
  if (typeof v !== 'string' || (need && !v.trim())) return `${key} must be text`
  if (key !== 'copy' && /[\r\n]/.test(v)) return `${key} must be one line`
  if (v.length > HAND_MAX[key]) return `${key}: ${sayShorter(HAND_MAX[key], v.length)}`
  return ''
}

/** Every problem with a flow's `hand`, one line each; [] when it is valid. */
export function validateHand(hand) {
  if (!isObject(hand)) return ['hand must be a JSON object']
  const problems = []
  if (!Array.isArray(hand.steps)) return ['hand.steps must be a list']
  if (hand.steps.length > HAND_MAX.steps) return [`hand has ${hand.steps.length} steps, at most ${HAND_MAX.steps}: split the work, or say the rest in fewer steps`]
  const ids = new Set()
  hand.steps.forEach((s, i) => {
    let at = `hand step #${i + 1}`
    if (!isObject(s)) return problems.push(`${at} must be a JSON object`)
    if (typeof s.id !== 'string' || !SLUG.test(s.id)) problems.push(`${at} id must match /^[a-z0-9-]+$/`)
    else if (ids.has(s.id)) problems.push(`duplicate hand step id ${s.id}`)
    else { ids.add(s.id); at = `hand step ${s.id}:` }
    for (const key of HAND_FIELDS) {
      const p = fieldProblem(key, s[key], { need: key === 'do' || key === 'expect' })
      if (p) problems.push(`${at} ${p}`)
    }
    if (s.at !== undefined && !isText(s.at)) problems.push(`${at} at must be a time`)
    if (s.done != null && !(isObject(s.done) && s.done.by === 'you' && isText(s.done.at))) problems.push(`${at} done must be null or { by: "you", at }`)
  })
  for (const key of ['requestedAt', 'requestSentAt']) if (hand[key] != null && !isText(hand[key])) problems.push(`hand.${key} must be null or a time`)
  if (hand.requestError != null && !(isText(hand.requestError) && hand.requestError.length <= 300)) problems.push('hand.requestError must be null or text of at most 300 characters')
  return problems
}

/** Whether `next` asks the same thing as `prev` (do, where, copy and expect unchanged): then the user's tick stays. */
export const sameAsk = (prev, next) => !!prev && ASKS.every(k => (prev[k] ?? '') === (next[k] ?? ''))

/**
 * For mergeKeepingAnswers (flows.mjs), the UNTRUSTED path: an agent rewrites the whole flow. A rewrite with no
 * `hand` keeps the stored one whole; otherwise each step's `done` comes from the stored step with the same id while
 * it asks the same thing (sameAsk), else null, and the request fields come from the stored file only.
 */
export function keepHand(incoming, existing) {
  const stored = isObject(existing?.hand) ? existing.hand : undefined
  if (incoming.hand === undefined) {
    if (stored !== undefined) incoming.hand = stored
    return incoming
  }
  if (!isObject(incoming.hand)) return incoming // validateFlow reports it
  const before = new Map((Array.isArray(stored?.steps) ? stored.steps : []).filter(isObject).map(s => [s.id, s]))
  for (const s of Array.isArray(incoming.hand.steps) ? incoming.hand.steps : []) {
    if (!isObject(s)) continue
    const old = before.get(s.id)
    s.done = sameAsk(old, s) ? old.done ?? null : null
  }
  for (const key of HAND_SERVER) {
    if (stored?.[key] != null) incoming.hand[key] = stored[key]
    else delete incoming.hand[key]
  }
  return incoming
}

/** The user's tick on a by-hand step (on: true or false). Nothing else ever sets `done`. Throws a plain sentence. */
export function applyHandTick(flow, stepId, on, now = new Date().toISOString()) {
  if (typeof on !== 'boolean') throw new Error('done must be true or false')
  const step = (flow.hand?.steps || []).find(s => s.id === stepId)
  if (!step) throw new Error(`Flow ${flow.id} has no by-hand step ${stepId}`)
  step.done = on ? { by: 'you', at: now } : null
  return step
}

/** { done, total } of a flow's by-hand steps. */
export function handProgress(flow) {
  const steps = Array.isArray(flow?.hand?.steps) ? flow.hand.steps : []
  return { done: steps.filter(s => s?.done).length, total: steps.length }
}

/**
 * The relay's line for the user's Ask the agent for steps (relay.mjs, the same path as Request test steps):
 * what to record and how, and that the agent must not do the work itself. `quoted` turns a field into ONE JSON
 * string, so a title or note can never steer the turn; `cli` is the absolute factory command.
 */
export function handRequestText(flow, note, { quoted, cli }) {
  const id = flow.id
  return `Flow ${id} (${quoted(flow.title)}): the user asks for step-by-step instructions for the part only they can do ` +
    '(a human decision, CI/CD, cloud setup, a console setting). Do NOT do that work yourself. Record each step, in order, with ' +
    `\`flow hand-step ${id} "<do this>" --expect "<what they should see>" --where "<the exact path, page or click path>"\`, ` +
    'adding --copy "<the value to paste>" when there is one and --why "<one line>" when it helps; then stop.' +
    (String(note ?? '').trim() ? ` Their note: ${quoted(note)}.` : '') +
    ` Run node ${cli} flow show ${id} for the rest.`
}
