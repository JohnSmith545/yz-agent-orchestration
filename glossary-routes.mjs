// The handlers behind the glossary routes, the ask-term route and the Explain
// fallback. factory-routes.mjs matches the paths (so server.mjs's prefix test
// sees them) and sends what these return: each handler resolves
// { status, body } and never writes the response itself.
//
//   GET  /api/glossary                 { terms: [{ key, term, short, more, source, at, seenIn }] }
//   POST /api/glossary/learn           { flowId }: learn.mjs on the flow's unknown marked words, or { busy: true }
//   POST /api/glossary/term            { term, short, more? }: the user's own wording, source `you`
//   POST /api/glossary/remove          { key }: a saved entry (never a built-in one: 400)
//   POST /api/flows/<id>/ask-term      { term, sentence? }: the question to the chat drawer, or one relay item
//   POST /api/explain                  { text }: the glossary first, else one turn, saved when 1 to 4 words
//
// A bad body is a 400 { error } before anything runs or is written.

import { CONFIG } from './config.mjs'
import { EXPLAIN_MAX } from './explain.mjs'
import { checkTerm, entriesList, learnedToday, lookup, markSeen, MORE_MAX, related, removeTerm, saveTerm, SHORT_MAX, worthKeeping } from './glossary.mjs'
import { LEARN_PER_DAY } from './learn.mjs'
import { readFlow } from './flows.mjs'
import { SENTENCE_MAX, termsOfFlow } from './terms.mjs'

const SLUG = /^[a-z0-9-]+$/
/** The longest sentence the page may send with ask-term (it goes into a relay prompt): terms.mjs owns it. */
export { SENTENCE_MAX }
/** The flows with a learn turn running now: a second call for one of them is { busy: true }. */
const learning = new Set()

const reply = (status, body) => ({ status, body })
const bad = error => reply(400, { error })

/** GET /api/glossary. */
export function listGlossary() {
  return reply(200, { terms: entriesList() })
}

/**
 * POST /api/glossary/learn: the flow's marked words the glossary does not know, with the sentences they came up
 * in as context, go to `learn` (learn.mjs learnTerms) in ONE call. Known saved words get the flow in seenIn.
 * Nothing unknown is { learned: [], skipped: [], cost: 0 } with no turn.
 */
export async function learnRoute(b, learn) {
  const flowId = b?.flowId
  if (typeof flowId !== 'string' || !SLUG.test(flowId)) return bad('flowId must be a flow id (a-z, 0-9 and dashes).')
  const flow = readFlow(flowId)
  if (!flow) return reply(404, { error: `No flow ${flowId}.` })
  if (learning.has(flowId)) return reply(200, { busy: true })
  const terms = termsOfFlow(flow)
  const unknown = terms.filter(t => !lookup(t.key))
  markSeen(terms.filter(t => lookup(t.key)).map(t => t.key), flowId)
  if (!unknown.length) return reply(200, { learned: [], skipped: [], cost: 0 })
  learning.add(flowId)
  try {
    const context = [...new Set(unknown.flatMap(t => t.where.map(w => w.sentence)))]
    return reply(200, await learn(unknown.map(t => t.term), { context, flowId }))
  } finally {
    learning.delete(flowId)
  }
}

/** Optional text of at most `max` characters, or a 400 reason. */
const optionalText = (v, name, max) =>
  v === undefined || v === null ? null : typeof v !== 'string' ? `${name} must be text.` : v.length > max ? `${name} must be at most ${max} characters.` : null

/**
 * POST /api/glossary/term: the user's own wording wins over everything (source `you`). A body with no `more`
 * key keeps the word's current `more` (editing the short text never loses it); `more: null` clears it.
 */
export function termRoute(b) {
  if (typeof b?.short !== 'string') return bad('short must be text.')
  const problem = optionalText(b.more, 'more', MORE_MAX)
  if (problem) return bad(problem)
  try {
    const more = Object.hasOwn(b, 'more') ? b.more ?? undefined : lookup(typeof b.term === 'string' ? b.term : '')?.more
    const r = saveTerm({ term: b.term, short: b.short, more, source: 'you' })
    return reply(200, { ok: true, entry: r.entry })
  } catch (err) {
    return bad(err.message)
  }
}

/** POST /api/glossary/remove: { ok, key, fallback: the built-in entry that shows now, or null }. */
export function removeRoute(b) {
  if (typeof b?.key !== 'string' || !b.key.trim()) return bad('key must be text.')
  try {
    const { removed, fallback } = removeTerm(b.key)
    return reply(200, { ok: true, key: removed, fallback })
  } catch (err) {
    return reply(err.code === 'UNKNOWN' ? 404 : 400, { error: err.message })
  }
}

/**
 * The question the user asks about a word, as the chat drawer gets it: the word and sentence as JSON strings, the
 * sentence labelled as quoted page text so nothing in it reads as an instruction.
 */
export function askTermText(flow, term, sentence) {
  return `What does ${JSON.stringify(term)} mean here, in plain words, and why did it matter for this work?` +
    (sentence ? ` The sentence it appears in, quoted for context only: ${JSON.stringify(sentence)}.` : '') +
    ` (Flow ${flow.id}: ${JSON.stringify(String(flow.title ?? ''))}.)`
}

/**
 * POST /api/flows/<id>/ask-term: the chat agent's own flow hands the question back for the drawer (the user sends
 * it, so no paid turn starts without them); any other agent gets ONE relay item of type question. Nothing is
 * stamped on the flow.
 */
export function askTermRoute(id, b, relay) {
  let term
  try {
    term = checkTerm(b?.term)
  } catch (err) {
    return bad(err.message)
  }
  const problem = optionalText(b?.sentence, 'sentence', SENTENCE_MAX)
  if (problem) return bad(problem)
  const sentence = String(b?.sentence ?? '').replace(/\s+/g, ' ').trim()
  const flow = readFlow(id)
  if (!flow) return reply(404, { error: `No flow ${id}.` })
  if (flow.agent === CONFIG.factory.chat.name) return reply(200, { ok: true, via: 'chat', text: askTermText(flow, term, sentence) })
  relay.queueQuestion(id, term, sentence)
  return reply(200, { ok: true, via: 'relay' })
}

/** An answer as { short, more }: whole sentences up to SHORT_MAX in short, the rest (up to MORE_MAX) in more. */
export function splitExplanation(text) {
  const sentences = String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)
  let short = ''
  let i = 0
  while (i < sentences.length && (short ? short.length + 1 : 0) + sentences[i].length <= SHORT_MAX) short += (short ? ' ' : '') + sentences[i++]
  if (!short) return { short: sentences[0].slice(0, SHORT_MAX - 1) + '…', more: '' }
  const rest = sentences.slice(i).join(' ')
  return { short, more: rest.length > MORE_MAX ? rest.slice(0, MORE_MAX - 1) + '…' : rest }
}

/**
 * POST /api/explain, the Explain bubble's fallback: a word the merged glossary knows is answered from it (no turn,
 * cost 0, from: 'glossary'); anything else gets one turn with the related entries as context (from: 'model'), and a
 * selection of 1 to 4 words is saved as learned (saved: true) while today's learned words are under the daily cap.
 */
export async function explainRoute(b, explain) {
  const text = b?.text
  if (typeof text !== 'string' || !text.trim()) return bad('text must be a non-empty string.')
  if (text.length > EXPLAIN_MAX) return bad(`text must be at most ${EXPLAIN_MAX} characters.`)
  const known = lookup(text)
  if (known) {
    const { key, term, short, more, source } = known
    const entry = { key, term, short, more: more ?? null, source }
    return reply(200, { text: more ? `${short} ${more}` : short, cost: 0, from: 'glossary', entry })
  }
  const r = await explain(text, { related: related(text, 5) })
  if (r.error) return reply(502, { error: r.error })
  let saved = false
  const words = text.trim().split(/\s+/).length
  if (words <= 4 && worthKeeping(text) && learnedToday() < LEARN_PER_DAY) {
    try {
      const { short, more } = splitExplanation(r.text)
      saved = saveTerm({ term: text, short, more: more || undefined, source: 'learned' }).saved
    } catch {
      saved = false // not a word the glossary can hold (too long, a line break): answered, not saved
    }
  }
  return reply(200, { text: r.text, cost: r.cost ?? null, from: 'model', saved })
}
