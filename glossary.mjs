// The glossary that learns: the shipped word list (public/glossary.json, read
// once) merged with the words saved since (data/glossary.json, git-ignored).
//
// The saved file is { "<key>": { term, short, more?, source, at, seenIn } }:
// - key: normalise(term) (terms.mjs), so `Tokens` and `token` are one entry;
// - source: `learned` (a Haiku turn explained it, learn.mjs or the Explain
//   bubble), `agent` (an agent defined it with `factory.mjs term`) or `you`
//   (the user wrote it on the page);
// - seenIn: the flows the word came up in, each once, the 20 most recent.
//
// Rules this file keeps:
// - A saved entry wins over a shipped one with the same key (readGlossary).
// - Precedence on write: you > agent > learned. A lower source never
//   overwrites a higher one, so the user's own wording wins over everything
//   and a learned guess never replaces an agent's definition (saveTerm).
// - The shipped words are the dashboard's own (verified, claimed, unproven…):
//   an agent or a learning turn may not shadow one; only the user may.
// - A word holds letters, digits, spaces and . - _ + # / only, never a dash
//   first (terms.mjs WORD): no quote, bracket or shell metacharacter (checkTerm).
// - Only saved entries can be removed; removing one that shadows a shipped
//   entry brings the shipped one back (removeTerm).
// - Writes go through writeAtomic (temp file + rename). The file follows
//   FACTORY_DATA_DIR like every other data file, so tests never touch data/.
// - A missing or broken saved file reads as empty: the shipped list still answers.

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'
import { sayShorter } from './flow-story.mjs'
import { normalise, TERM_MAX, TERM_MIN, WORD } from './terms.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SHIPPED_FILE = path.join(HERE, 'public', 'glossary.json')
export const GLOSSARY_FILE = path.join(DATA_DIR, 'glossary.json')
export const SHORT_MAX = 300
export const MORE_MAX = 600
export const SEEN_MAX = 20
/** What a saved entry's source may be, lowest first: a source never overwrites a higher one. */
export const SOURCES = Object.freeze(['learned', 'agent', 'you'])
const SLUG = /^[a-z0-9-]+$/

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

// ═══ Reading ═══

let shipped = null
/** The shipped list keyed by normalised word, each { term, short, more?, source: 'built-in' }. Read once. */
function readShipped() {
  if (shipped) return shipped
  shipped = {}
  try {
    const raw = JSON.parse(readFileSync(SHIPPED_FILE, 'utf8'))
    for (const [term, e] of Object.entries(isObject(raw) ? raw : {})) {
      if (!isObject(e) || typeof e.short !== 'string') continue
      const entry = { term, short: e.short, source: 'built-in' }
      if (typeof e.more === 'string') entry.more = e.more
      shipped[normalise(term)] = entry
    }
  } catch (err) {
    console.error(`glossary: could not read the shipped list: ${err.message}`)
  }
  return shipped
}

let cache = { mtimeMs: -1, size: -1, data: {} }
/** The saved entries, re-read only when the file changed (listFlows derives terms for every flow on each poll). */
export function readLearned() {
  let st
  try {
    st = statSync(GLOSSARY_FILE)
  } catch {
    // no file: the same empty map every time while it stays missing, so readGlossary keeps its merge
    if (cache.mtimeMs !== -1 || cache.size !== -1) cache = { mtimeMs: -1, size: -1, data: {} }
    return cache.data
  }
  if (st.mtimeMs === cache.mtimeMs && st.size === cache.size) return cache.data
  let data = {}
  try {
    const raw = JSON.parse(readFileSync(GLOSSARY_FILE, 'utf8'))
    if (isObject(raw)) for (const [k, e] of Object.entries(raw)) if (isObject(e) && typeof e.short === 'string') data[k] = e
  } catch (err) {
    console.error(`glossary: ${GLOSSARY_FILE} is not valid JSON, read as empty: ${err.message}`)
    data = {}
  }
  cache = { mtimeMs: st.mtimeMs, size: st.size, data }
  return data
}

let merged = { learned: null, map: {} }
/**
 * Shipped plus saved, keyed by normalised word; a saved entry wins on the same key. Built once per change of
 * the saved file (readLearned hands back the same object until then): the list route asks for every marked
 * word of every flow on each 15 s poll. Callers must not change the map.
 */
export function readGlossary() {
  const learned = readLearned()
  if (merged.learned !== learned) merged = { learned, map: { ...readShipped(), ...learned } }
  return merged.map
}

/** The entry for `term` (any spelling), with its key, or null. */
export function lookup(term) {
  const key = normalise(term)
  if (!key) return null
  const g = readGlossary()
  return Object.hasOwn(g, key) ? { key, ...g[key] } : null
}

/**
 * Every merged entry for GET /api/glossary, sorted by key:
 * [{ key, term, short, more: string|null, source, at: string|null, seenIn: [] }].
 */
export function entriesList() {
  return Object.entries(readGlossary())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, e]) => ({ key, term: e.term || key, short: e.short, more: e.more ?? null, source: e.source || 'learned', at: e.at ?? null, seenIn: Array.isArray(e.seenIn) ? e.seenIn : [] }))
}

// ═══ Related entries: the retrieval step behind learn.mjs and the explain route ═══

const STOP = new Set('the a an and or of to in on for with is are be it this that as by at from into its was were can not no so than then when what which who why how you your their them they he she we our out up do does did has have had will would should could may might also more most some any all each one two only just very but if about over after before such these those there here'.split(' '))
/** The content words of `text`, each normalised, no stop words, at least 3 letters. */
const wordsOf = text => new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w)).map(w => normalise(w)))

/**
 * The n entries nearest `text` by shared words, nearest first: a word shared
 * with an entry's key counts 3, one shared with its explanation counts 1.
 * Never the entry for `text` itself; nothing that shares no word. Ties keep
 * key order. [{ key, term, short }].
 */
export function related(text, n = 5) {
  const want = wordsOf(text)
  const self = normalise(text)
  if (!want.size || n <= 0) return []
  const scored = []
  for (const [key, e] of Object.entries(readGlossary())) {
    if (key === self) continue
    let score = 0
    const keyWords = wordsOf(key)
    const shortWords = wordsOf(e.short)
    for (const w of want) score += (keyWords.has(w) ? 3 : 0) + (shortWords.has(w) ? 1 : 0)
    if (score > 0) scored.push({ score, key, term: e.term || key, short: e.short })
  }
  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  return scored.slice(0, n).map(({ key, term, short }) => ({ key, term, short }))
}

// ═══ Writing ═══

const sameLocalDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** How many `learned` entries were saved on the local calendar day of `now` (learn.mjs's daily cap). */
export function learnedToday(now = new Date()) {
  let n = 0
  for (const e of Object.values(readLearned())) {
    const t = new Date(e.at)
    if (e.source === 'learned' && !Number.isNaN(t.getTime()) && sameLocalDay(t, now)) n++
  }
  return n
}

/** Throws a plain one-line reason when `term` is not a word the glossary can hold. */
export function checkTerm(term) {
  const t = typeof term === 'string' ? term.trim() : ''
  if (t.length < TERM_MIN || t.length > TERM_MAX || /[\r\n]/.test(t) || !normalise(t)) {
    throw new Error(`the word must be ${TERM_MIN} to ${TERM_MAX} characters on one line`)
  }
  const word = t.replace(/\s+/g, ' ')
  if (word.startsWith('-')) throw new Error('the word may not start with a dash')
  if (!WORD.test(word)) throw new Error('the word may hold only letters, digits, spaces and . - _ + # /')
  return word
}

const COMMON = new Set([...STOP, 'ready', 'done', 'good', 'make', 'made', 'need', 'want', 'like', 'thing', 'things', 'really', 'still', 'already', 'well', 'much', 'many', 'used', 'using', 'just', 'here', 'there', 'okay'])
/** A selection worth keeping as a learned word: it holds a word of 4 or more letters that is not a common one. */
export function worthKeeping(text) {
  return String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).some(w => w.length >= 4 && !COMMON.has(w))
}

/** `seenIn` with `flowId` moved to the end, each flow once, the SEEN_MAX most recent. */
const withSeen = (seenIn, flowId) => {
  const list = (Array.isArray(seenIn) ? seenIn : []).filter(f => f !== flowId)
  if (flowId) list.push(flowId)
  return list.slice(-SEEN_MAX)
}

/** Write the saved entries, and remember them as read, so this process never reads its own write stale. */
function writeLearned(data) {
  writeAtomic(GLOSSARY_FILE, JSON.stringify(data, null, 1))
  try {
    const st = statSync(GLOSSARY_FILE)
    cache = { mtimeMs: st.mtimeMs, size: st.size, data }
  } catch {
    cache = { mtimeMs: -1, size: -1, data: {} }
  }
}

/**
 * Save one entry. Throws a plain reason on a bad word, explanation, source or
 * flow id. Returns { saved: true, entry } or, when a higher source already
 * holds the word, { saved: false, reason, entry: the kept one } (never throws for that).
 */
export function saveTerm({ term, short, more, source, flowId } = {}) {
  const word = checkTerm(term)
  if (!SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(', ')}`)
  const s = typeof short === 'string' ? short.trim() : ''
  if (!s) throw new Error('the explanation must be non-empty text')
  if (s.length > SHORT_MAX) throw new Error(sayShorter(SHORT_MAX, s.length))
  if (more !== undefined && more !== null && typeof more !== 'string') throw new Error('more must be text')
  const m = typeof more === 'string' ? more.trim() : ''
  if (m.length > MORE_MAX) throw new Error(`more: ${sayShorter(MORE_MAX, m.length)}`)
  if (flowId !== undefined && flowId !== null && !(typeof flowId === 'string' && SLUG.test(flowId))) throw new Error('flow must be a flow id (a-z, 0-9 and dashes)')

  const key = normalise(word)
  // the dashboard's own words (verified, claimed, unproven…) are part of how it tells proof apart: an agent or a
  // learning turn may not redefine them; only the user may put one their way
  if (source !== 'you' && Object.hasOwn(readShipped(), key)) {
    return { saved: false, reason: `${key} is a built-in word: only the user can reword it`, entry: { key, ...readShipped()[key] } }
  }
  const data = { ...readLearned() }
  const old = data[key]
  if (old && SOURCES.indexOf(old.source) > SOURCES.indexOf(source)) {
    const reason = old.source === 'you' ? `the user wrote their own explanation of ${key}` : `an agent already defined ${key}`
    return { saved: false, reason, entry: { key, ...old } }
  }
  const entry = { term: word, short: s }
  if (m) entry.more = m
  Object.assign(entry, { source, at: new Date().toISOString(), seenIn: withSeen(old?.seenIn, flowId || null) })
  data[key] = entry
  writeLearned(data)
  return { saved: true, entry: { key, ...entry } }
}

/** Add `flowId` to the seenIn of each saved entry among `terms` (built-in ones have none). Writes only on a change. */
export function markSeen(terms, flowId) {
  if (!flowId) return
  const data = { ...readLearned() }
  let changed = false
  for (const key of new Set((terms || []).map(normalise))) {
    const e = data[key]
    if (!e || (Array.isArray(e.seenIn) && e.seenIn.at(-1) === flowId)) continue
    data[key] = { ...e, seenIn: withSeen(e.seenIn, flowId) }
    changed = true
  }
  if (changed) writeLearned(data)
}

/**
 * Remove a saved entry. Returns { removed: key, fallback: the shipped entry that
 * shows now, or null }. Throws when the key is only built-in, or unknown.
 */
export function removeTerm(term) {
  const key = normalise(term)
  const data = { ...readLearned() }
  if (!Object.hasOwn(data, key)) {
    const err = new Error(Object.hasOwn(readShipped(), key) ? `${key} is built-in and cannot be removed` : `there is no saved entry for ${key || 'that'}`)
    err.code = Object.hasOwn(readShipped(), key) ? 'BUILT_IN' : 'UNKNOWN'
    throw err
  }
  delete data[key]
  writeLearned(data)
  const base = readShipped()[key]
  return { removed: key, fallback: base ? { ...base } : null }
}
