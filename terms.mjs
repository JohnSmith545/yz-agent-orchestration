// Marked words: the technical words an agent puts in square brackets so the
// dashboard can explain them, as in `Checked the code for [idempotency]`.
//
// Pure functions, no data access. Used by flows.mjs (derived.terms), the
// glossary (normalise is its lookup key) and the learn route (termsOfFlow
// gives the sentences a word came up in, the context of its explanation).
//
// What counts as a marked word (findTerms):
// - the text inside ONE pair of square brackets, trimmed, 2 to 40 characters,
//   on one line;
// - NOT a markdown link or image (`[x](y)`, `![x](y)`), a reference link
//   (`[x][1]`), a checkbox (`[ ]`, `[x]`: too short anyway), or one of the kind
//   prefixes of the diagram language (`[actor]`, `[store]`, `[decision]`,
//   `[box]`, diagram-text.mjs), which agents write in the same fields.
// - `[[wiki]]` counts as `wiki`: the inner pair is the mark.

import { DIAGRAM_KINDS } from './diagram-text.mjs'

export const TERM_MIN = 2
export const TERM_MAX = 40
/** The longest context sentence kept for a seen-in entry (it goes into a learn prompt). */
export const SENTENCE_MAX = 300

const MARK = /\[([^[\]\r\n]*)\](?![([])/g
const KINDS = new Set(DIAGRAM_KINDS.map(k => k.toLowerCase()))
/**
 * What a word may hold: letters of any script, digits, spaces and . - _ + # / only, and never a dash first.
 * No quote, bracket or shell metacharacter (' " ( ) $ ` \ ; | & < >): a word goes into messages that tell an
 * agent which command to run, and a quote or a bracket could break out of the quoting around it.
 * MUST CHANGE IN LOCKSTEP with public/terms.js WORD.
 */
export const WORD = /^(?!-)[\p{L}\p{M}\p{N} ._+#/-]+$/u
/** Words whose final s is part of the word, not a plural. MUST CHANGE IN LOCKSTEP with public/terms.js. */
const KEEP_S = new Set(['alias', 'atlas', 'bias', 'bus', 'canvas', 'chaos', 'ethos', 'gas', 'kubernetes', 'lens', 'news', 'series', 'species', 'status'])
/** Words that end in e before the es of their plural, where the rule below would cut the e: `caches` -> `cache`. */
const KEEP_E = new Set(['cache', 'niche', 'headache', 'avalanche', 'moustache'])

/**
 * The singular of the last word, and singular(singular(w)) === singular(w):
 * - a stem under 4, a word in KEEP_S, or a word ending in ss, us or is stays (`status`, `class`, `analysis`);
 * - es goes only after ss, x, ch or sh (`classes`, `boxes`, `patches`, `crashes`) or when what is left is a
 *   KEEP_S word (`aliases`, `statuses`, `buses`);
 * - anything else loses its s only (`databases` -> `database`, `cases` -> `case`, `tokens` -> `token`);
 * - a number keeps its s (`1990s`).
 */
function singular(w) {
  if (w.length < 5 || KEEP_S.has(w) || /(ss|us|is)$/.test(w) || /^[0-9]+s$/.test(w)) return w
  const es = /^(.*(?:ss|x|ch|sh))es$/.exec(w)
  if (es) return KEEP_E.has(`${es[1]}e`) ? `${es[1]}e` : es[1]
  const kept = /^(.*)es$/.exec(w)
  if (kept && KEEP_S.has(kept[1])) return kept[1]
  return w.endsWith('s') ? w.slice(0, -1) : w
}

/**
 * The lookup key of a word: lower-case, edge quotes and punctuation dropped,
 * every run of spaces, hyphens and underscores one space, and the last word in
 * the singular (see singular). A capitals word with at least one letter and a
 * lower-case s is a plural of letters: `APIs` -> `api`, `MP3s` -> `mp3`, while
 * `1990s` and `10s` stay. '' for nothing. Idempotent: a key normalised again is
 * the same key, since keys are normalised a second time downstream.
 * MUST CHANGE IN LOCKSTEP with any page copy of it.
 */
export function normalise(term) {
  const caps = String(term ?? '').replace(/\b((?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,})s\b/g, '$1')
  const key = caps
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .replace(/^[\s"'“‘(\[{]+|[\s"'”’)\]}.,:;!?]+$/g, '')
    .trim()
  return key.replace(/([a-z0-9]+)$/, w => singular(w))
}

/** The marked words in `text`, in order, each once (by normalise; the first spelling kept). */
export function findTerms(text) {
  if (typeof text !== 'string' || !text.includes('[')) return []
  const out = []
  const seen = new Set()
  for (const m of text.matchAll(MARK)) {
    if (m.index > 0 && text[m.index - 1] === '!') continue // an image ![alt](src)
    const term = m[1].trim().replace(/\s+/g, ' ')
    if (term.length < TERM_MIN || term.length > TERM_MAX || KINDS.has(term.toLowerCase()) || !WORD.test(term)) continue
    const key = normalise(term)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(term)
  }
  return out
}

/** The sentence of `text` that holds `[term]`, at most SENTENCE_MAX characters, cut around the mark when longer. */
export function sentenceOf(text, term) {
  const words = String(term).trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const mark = new RegExp(`\\[\\s*${words.join('\\s+')}\\s*\\]`)
  const sentences = String(text).split(/(?<=[.!?])\s+|\r?\n+/)
  const s = (sentences.find(x => mark.test(x)) || String(text)).trim()
  if (s.length <= SENTENCE_MAX) return s
  const at = Math.max(0, s.search(mark))
  const start = Math.max(0, Math.min(at - Math.floor(SENTENCE_MAX / 2), s.length - SENTENCE_MAX))
  return s.slice(start, start + SENTENCE_MAX)
}

/** Every [field label, text] of a flow where an agent may mark a word, in reading order. */
function fieldsOf(flow) {
  const out = flow?.output && typeof flow.output === 'object' ? flow.output : {}
  const fields = []
  const add = (label, v) => typeof v === 'string' && v && fields.push([label, v])
  add('why', flow?.why) // the head shows it with chips, so its words are learned too
  for (const l of Array.isArray(out.story) ? out.story : []) {
    add(`story ${l?.id} did`, l?.did)
    add(`story ${l?.id} why`, l?.why)
  }
  add('summary', out.summary)
  add('change before', out.change?.before)
  add('change after', out.change?.after)
  for (const t of Array.isArray(out.testing) ? out.testing : []) {
    add(`testing ${t?.id} do`, t?.do)
    add(`testing ${t?.id} expect`, t?.expect)
  }
  for (const n of Array.isArray(flow?.nodes) ? flow.nodes : []) {
    for (const k of ['title', 'why', 'yes', 'no']) add(`node ${n?.id} ${k}`, n?.[k])
  }
  return fields
}

/**
 * The marked words across a flow (story did and why, the summary, test step do
 * and expect, every node title and why, an ask's yes and no), each once in the
 * order first met: [{ term, key, where: [{ field, sentence }] }]. `field` is
 * like `story s1 did`, `summary`, `testing t2 expect` or `node n5 title`.
 */
export function termsOfFlow(flow) {
  const byKey = new Map()
  for (const [field, text] of fieldsOf(flow)) {
    for (const term of findTerms(text)) {
      const key = normalise(term)
      if (!byKey.has(key)) byKey.set(key, { term, key, where: [] })
      byKey.get(key).where.push({ field, sentence: sentenceOf(text, term) })
    }
  }
  return [...byKey.values()]
}
