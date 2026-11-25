// The lessons library: what earlier QA, Security and Senior failures taught, as one plain sentence each, so the next
// builder reads it before it starts. data/lessons.json (the current project's data folder, like the flows):
//
//   { startedAt,                 when the library began: failures from before it are never extracted on their own
//     lessons: [{ id: L<n>, text, area, sources: [{ flow, at, gate }], count, status: active | retired,
//                 by: you | model, at }],
//     candidates: [{ id, kind: new | same, text, area, lesson?, source: { flow, at, gate }, key, at }],
//     done: { "<failure key>": { at, result: lessons | none | error, cost? } } }
//
// - A LESSON is at most 160 characters, one plain sentence in the imperative, in one area (quality-areas.mjs). `count`
//   is how many failures taught it, `sources` which ones (the newest SOURCE_MAX kept). Only ACTIVE lessons reach a
//   brief; Retire takes one out, Restore brings it back. The user can type one (by: you).
// - A CANDIDATE is what one model run proposed from one failure (quality-extract.mjs): a new lesson, or `same as <id>`
//   for a failure an existing lesson already covers. ⚠️ A model never writes a lesson by itself: every candidate
//   waits for the user, who Accepts (a new lesson, or one more count and source on the named one), Edits as they
//   accept, or Rejects. A candidate whose text is an existing lesson's is a same-as, so the library never holds a
//   duplicate.
// - `done` records each failure key a run handled, so a failure is extracted once.
// - The store functions CHANGE the store passed in and return { lesson } / { ok } / { error } (one plain sentence for
//   the page); the routes read the file, change it and write it whole through atomic-write.mjs (quality-routes.mjs).
//   A missing or broken file reads as empty; a hand-edited one keeps only what is well formed.
//
// The CONTRACT feat/smart-learn reads through an injected provider: listLessons({ since, area }).

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'
import { DEFAULT_AREAS, taskAreas } from './quality-areas.mjs'

export const LESSONS_FILE = path.join(DATA_DIR, 'lessons.json')
export const LESSON_MAX = Object.freeze({ text: 160, lessons: 300, candidates: 60, sources: 20, done: 1000, brief: 7 })
export const LESSON_STATUS = Object.freeze(['active', 'retired'])
export const GATES = Object.freeze(['qa', 'security', 'senior'])

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const fold = s => s.replace(/\s+/g, ' ').trim()
/** Two texts are the same lesson when they match without case, spaces or the closing full stop. */
const key = s => fold(String(s ?? '')).toLowerCase().replace(/[.!?]+$/, '')
const nowIso = () => new Date().toISOString()
const newCandidateId = () => `c${randomBytes(4).toString('hex')}`
/** The next free L-number: L1, L2, … (short, so a model can say `same as L3`). */
const nextLessonId = store => `L${Math.max(0, ...store.lessons.map(l => Number(/^L(\d+)$/.exec(l.id)?.[1] || 0))) + 1}`

export const emptyStore = (startedAt = nowIso()) => ({ startedAt, lessons: [], candidates: [], done: {} })

// ═══ the file ═══

const cleanSource = s => (isObject(s) && isText(s.flow) && GATES.includes(s.gate) ? { flow: s.flow, at: isTime(s.at) ? s.at : null, gate: s.gate } : null)

function cleanLesson(l) {
  if (!isObject(l) || !/^L\d+$/.test(String(l.id)) || !isText(l.text) || !isText(l.area)) return null
  return {
    id: l.id, text: fold(l.text).slice(0, LESSON_MAX.text), area: l.area,
    sources: (Array.isArray(l.sources) ? l.sources : []).map(cleanSource).filter(Boolean).slice(-LESSON_MAX.sources),
    count: Number.isInteger(l.count) && l.count >= 1 ? l.count : 1,
    status: LESSON_STATUS.includes(l.status) ? l.status : 'active',
    by: l.by === 'model' ? 'model' : 'you',
    at: isTime(l.at) ? l.at : null,
  }
}

function cleanCandidate(c) {
  if (!isObject(c) || !isText(c.id) || !['new', 'same'].includes(c.kind) || !isText(c.text)) return null
  const source = cleanSource(c.source)
  if (!source) return null
  return { id: c.id, kind: c.kind, text: fold(c.text).slice(0, LESSON_MAX.text), area: isText(c.area) ? c.area : 'general', ...(c.kind === 'same' ? { lesson: String(c.lesson) } : {}), source, key: String(c.key ?? ''), at: isTime(c.at) ? c.at : null }
}

/** Anything read from the file as a store; what is not well formed is left out. */
export function cleanStore(raw) {
  const s = emptyStore(isTime(raw?.startedAt) ? raw.startedAt : nowIso())
  s.lessons = (Array.isArray(raw?.lessons) ? raw.lessons : []).map(cleanLesson).filter(Boolean).slice(0, LESSON_MAX.lessons)
  s.candidates = (Array.isArray(raw?.candidates) ? raw.candidates : []).map(cleanCandidate).filter(Boolean).slice(-LESSON_MAX.candidates)
  const done = Object.entries(isObject(raw?.done) ? raw.done : {}).filter(([, v]) => isObject(v) && isTime(v.at)).slice(-LESSON_MAX.done)
  s.done = Object.fromEntries(done.map(([k, v]) => [k, { at: v.at, result: ['lessons', 'none', 'error'].includes(v.result) ? v.result : 'none', ...(typeof v.cost === 'number' ? { cost: v.cost } : {}) }]))
  return s
}

/** The library; a missing file is a new one that starts now, a broken one reads as empty. */
export function readLessons(file = LESSONS_FILE) {
  if (!existsSync(file)) return emptyStore()
  try {
    return cleanStore(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyStore()
  }
}

export function writeLessons(store, file = LESSONS_FILE) {
  writeAtomic(file, JSON.stringify(cleanStore(store), null, 1))
}

// ═══ one lesson ═══

/**
 * A lesson's text and area checked: { text, area } (spaces folded) or { error }, one plain sentence. At most 160
 * characters, one sentence (no line break, no second sentence), in one of `areas`.
 */
export function checkLesson({ text, area } = {}, areas = DEFAULT_AREAS) {
  if (typeof text !== 'string') return { error: 'The lesson must be text.' }
  const t = fold(text)
  if (!t) return { error: 'Write the lesson first: one plain sentence.' }
  if (t.length > LESSON_MAX.text) return { error: `Keep a lesson to ${LESSON_MAX.text} characters.` }
  if (/[\r\n]/.test(text) || /[.!?]\s+\S/.test(t)) return { error: 'Keep a lesson to one sentence.' }
  if (!areas.includes(area)) return { error: `Pick an area: ${areas.join(', ')}.` }
  return { text: t, area }
}

const findLesson = (store, id) => store.lessons.find(l => l.id === id) || null
const sameText = (store, text) => store.lessons.find(l => key(l.text) === key(text)) || null

/** A lesson the user typed (or accepted): active at once, count 1. */
export function addLesson(store, { text, area, by = 'you', source = null } = {}, { areas = DEFAULT_AREAS, now = nowIso, newId = null } = {}) {
  const c = checkLesson({ text, area }, areas)
  if (c.error) return c
  if (sameText(store, c.text)) return { error: 'That lesson is already in the library.' }
  if (store.lessons.length >= LESSON_MAX.lessons) return { error: `The library holds ${LESSON_MAX.lessons} lessons at most. Retire some first.` }
  const src = cleanSource(source)
  const lesson = { id: newId ? newId() : nextLessonId(store), text: c.text, area: c.area, sources: src ? [src] : [], count: 1, status: 'active', by: by === 'model' ? 'model' : 'you', at: now() }
  store.lessons.push(lesson)
  return { lesson }
}

/** Retire or restore (status active) a lesson. */
export function setStatus(store, id, status) {
  if (!LESSON_STATUS.includes(status)) return { error: 'A lesson is active or retired.' }
  const l = findLesson(store, id)
  if (!l) return { error: `No lesson ${id}.` }
  l.status = status
  return { ok: true, lesson: l }
}

// ═══ candidates ═══

/**
 * The candidates one run proposed from one failure (`failure`: { key, flow, at, gate }), added to the store and
 * returned. `items` are the parsed lines (quality-extract.mjs parseExtraction): { kind: 'new', text, area } or
 * { kind: 'same', id }. A new one whose text is a lesson's becomes a same-as; a same-as naming no lesson, a bad text,
 * and a repeat of a waiting candidate are dropped.
 */
export function addCandidates(store, failure, items, { areas = DEFAULT_AREAS, now = nowIso, newId = newCandidateId } = {}) {
  const source = cleanSource(failure)
  if (!source) return []
  const made = []
  for (const it of Array.isArray(items) ? items : []) {
    let c = null
    if (it?.kind === 'same') {
      const l = findLesson(store, it.id)
      if (l) c = { kind: 'same', text: l.text, area: l.area, lesson: l.id }
    } else if (it?.kind === 'new') {
      const checked = checkLesson({ text: it.text, area: areas.includes(it.area) ? it.area : 'general' }, areas)
      if (checked.error) continue
      const l = sameText(store, checked.text)
      c = l ? { kind: 'same', text: l.text, area: l.area, lesson: l.id } : { kind: 'new', ...checked }
    }
    if (!c) continue
    const repeat = store.candidates.concat(made).some(x => x.kind === c.kind && (c.kind === 'same' ? x.lesson === c.lesson && x.key === String(failure.key ?? '') : key(x.text) === key(c.text)))
    if (repeat) continue
    made.push({ id: newId(), ...c, source, key: String(failure.key ?? ''), at: now() })
  }
  store.candidates.push(...made)
  store.candidates = store.candidates.slice(-LESSON_MAX.candidates)
  return made
}

const takeCandidate = (store, id) => {
  const i = store.candidates.findIndex(c => c.id === id)
  return i < 0 ? null : store.candidates.splice(i, 1)[0]
}

/** One more count and source on lesson `l`. */
function raise(l, source) {
  l.count += 1
  if (source && !l.sources.some(s => s.flow === source.flow && s.gate === source.gate && s.at === source.at)) l.sources = [...l.sources, source].slice(-LESSON_MAX.sources)
  return l
}

/**
 * The user accepts a candidate, with their edits ({ text?, area? }): a same-as raises its lesson; a new one becomes
 * an active lesson (by: model), or, when its text is a lesson's already, raises that one. A refused edit leaves the
 * candidate waiting.
 */
export function acceptCandidate(store, id, edits = {}, opts = {}) {
  const c = store.candidates.find(x => x.id === id)
  if (!c) return { error: `No candidate ${id}: it may have been answered already.` }
  if (c.kind === 'same') {
    const l = findLesson(store, c.lesson)
    if (!l) return { error: `Lesson ${c.lesson} is no longer in the library. Reject this one.` }
    takeCandidate(store, id)
    return { lesson: raise(l, c.source) }
  }
  const checked = checkLesson({ text: edits.text ?? c.text, area: edits.area ?? c.area }, opts.areas || DEFAULT_AREAS)
  if (checked.error) return checked
  const l = sameText(store, checked.text)
  if (l) {
    takeCandidate(store, id)
    return { lesson: raise(l, c.source) }
  }
  const r = addLesson(store, { ...checked, by: 'model', source: c.source }, opts)
  if (!r.error) takeCandidate(store, id)
  return r
}

export function rejectCandidate(store, id) {
  return takeCandidate(store, id) ? { ok: true } : { error: `No candidate ${id}: it may have been answered already.` }
}

// ═══ reading ═══

/** The newest of a lesson's own time and its sources' times. */
const lastSeen = l => [l.at, ...l.sources.map(s => s.at)].filter(isTime).sort().at(-1) || null

/**
 * Every lesson (active and retired), most hit first, as plain copies; `since` keeps the ones made or taught again at
 * or after that time, `area` one area. Reads the file unless a store is given. THE CONTRACT feat/smart-learn reads.
 */
export function listLessons({ since, area } = {}, file = LESSONS_FILE, store = null) {
  const s = store || readLessons(file)
  const from = since ? Date.parse(since) : NaN
  return s.lessons
    .filter(l => !area || l.area === area)
    .filter(l => Number.isNaN(from) || (lastSeen(l) && Date.parse(lastSeen(l)) >= from))
    .sort((a, b) => b.count - a.count || String(b.at).localeCompare(String(a.at)))
    .map(l => ({ ...l, sources: l.sources.map(x => ({ ...x })) }))
}

/**
 * The ACTIVE lessons for one task, at most `max` (7): first those in an area the task touches (quality-areas.mjs
 * taskAreas: its title and text, its tickets' labels, the files named in its plan or touched by its change), most hit
 * first, then `general` ones, most hit first. Each is { id, text, area, count, why }: why it was picked.
 */
export function lessonsFor(task = {}, { store = readLessons(), areas = DEFAULT_AREAS, max = LESSON_MAX.brief } = {}) {
  const touched = taskAreas({ title: task.title, text: task.text, labels: task.labels, files: task.files }, areas)
  const active = store.lessons.filter(l => l.status === 'active')
  const byHits = (a, b) => b.count - a.count || String(b.at).localeCompare(String(a.at))
  const seen = n => `seen ${n} time${n === 1 ? '' : 's'}`
  const matched = active.filter(l => touched.has(l.area)).sort(byHits).map(l => ({ l, why: `${touched.get(l.area)}; ${seen(l.count)}` }))
  const general = active.filter(l => l.area === 'general').sort(byHits).map(l => ({ l, why: `fits any task; ${seen(l.count)}` }))
  return [...matched, ...general].slice(0, max).map(({ l, why }) => ({ id: l.id, text: l.text, area: l.area, count: l.count, why }))
}

/** What an agent is shown after its rules, or '' when nothing was picked. */
export function lessonsBlock(picked) {
  if (!Array.isArray(picked) || !picked.length) return ''
  return [
    'Lessons from earlier work (from past QA, Security and Senior findings; picked by the area of this task):',
    ...picked.map((l, i) => `${i + 1}. ${l.text} (${l.area}: ${l.why}) [${l.id}]`),
  ].join('\n')
}
