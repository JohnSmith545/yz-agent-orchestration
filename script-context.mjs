// What the SCRIPT Generator is told before it writes (#/script, the Context panel): ONE JSON file,
// data/script-context.json, shared by the server (script-context-routes.mjs) and the agents' CLI
// (`node tools/factory.mjs context …`, tools/context-cli.mjs).
//
//   { orchestration: boolean,   the dashboard's own brief of the orchestration (script-brief.mjs), on or off
//     session: string | null,    the dashboard label of ONE running session whose latest talk is attached
//     notes: [{ id, title, text, on, addedAt, updatedAt }] }   the user's own notes, each with its switch
//
// Rules this file keeps:
// - The path follows FACTORY_DATA_DIR (through factory-state.mjs's DATA_DIR), so tests never write data/.
// - A missing file, a file that is not JSON, or one the validator rejects reads as the defaults: the page and
//   the run never fail over it. Every write is validated first and goes through writeAtomic, so a bad shape
//   never replaces a good file and a reader never sees half a file.
// - The changes (addNote, editNote, removeNote, setOptions) are PURE on a context object and answer
//   { note } / { ok } or { error, status } with a plain sentence; updateContext writes only a change that
//   was accepted.
// - Limits: a title of 1 to 80 characters on one line, a note of 1 to 20,000, at most 40 notes.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'

export const CONTEXT_FILE = path.join(DATA_DIR, 'script-context.json')
/** The sizes everything else reads: the store, the brief, the session tail and the composed total. */
export const LIMITS = Object.freeze({ titleMax: 80, textMax: 20_000, notesMax: 40, totalMax: 60_000, briefMax: 8_000, sessionMax: 12_000 })
/** MUST CHANGE IN LOCKSTEP with flows.mjs AGENT_LABEL: a session is chosen by its dashboard label. */
export const LABEL = /^[A-Za-z0-9 ._-]{1,40}$/
const ID = /^[a-z0-9-]{1,40}$/

export const defaults = () => ({ orchestration: true, session: null, notes: [] })

const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const fmt = n => n.toLocaleString('en-GB')

/** A title as stored: whitespace runs (line breaks too) become one space, trimmed. */
const oneLine = s => s.replace(/\s+/g, ' ').trim()

/** '' when `title` (already one line) can be stored, else why not. */
export function checkTitle(title) {
  if (typeof title !== 'string' || !title) return 'Give the note a title.'
  if (title.length > LIMITS.titleMax) return `Keep the title to ${LIMITS.titleMax} characters.`
  return ''
}

/** '' when `text` can be stored, else why not. */
export function checkNoteText(text) {
  if (typeof text !== 'string' || !text.trim()) return 'The note needs some text.'
  if (text.length > LIMITS.textMax) return `A note can hold at most ${fmt(LIMITS.textMax)} characters. This one has ${fmt(text.length)}.`
  return ''
}

/** Every problem with a stored context, one line each; [] when it is fine. */
export function validateContext(c) {
  if (!isObject(c)) return ['the context must be a JSON object']
  const problems = []
  if (typeof c.orchestration !== 'boolean') problems.push('orchestration must be true or false')
  if (c.session !== null && !(typeof c.session === 'string' && LABEL.test(c.session))) problems.push('session must be null or a dashboard label')
  if (!Array.isArray(c.notes)) return [...problems, 'notes must be a list']
  if (c.notes.length > LIMITS.notesMax) problems.push(`at most ${LIMITS.notesMax} notes`)
  const seen = new Set()
  c.notes.forEach((note, i) => {
    const at = `note #${i + 1}`
    if (!isObject(note)) return problems.push(`${at} must be a JSON object`)
    if (typeof note.id !== 'string' || !ID.test(note.id)) problems.push(`${at} id must match /^[a-z0-9-]{1,40}$/`)
    else if (seen.has(note.id)) problems.push(`${at} id ${note.id} is there twice`)
    seen.add(note.id)
    if (typeof note.title !== 'string' || checkTitle(note.title) || note.title !== oneLine(note.title)) problems.push(`${at} title must be one line of 1 to ${LIMITS.titleMax} characters`)
    if (checkNoteText(note.text)) problems.push(`${at} text must be 1 to ${LIMITS.textMax} characters`)
    if (typeof note.on !== 'boolean') problems.push(`${at} on must be true or false`)
    if (!isTime(note.addedAt) || !isTime(note.updatedAt)) problems.push(`${at} addedAt and updatedAt must be times`)
  })
  return problems
}

/** The stored context, or the defaults when there is none or it is broken. */
export function readContext(file = CONTEXT_FILE) {
  if (!existsSync(file)) return defaults()
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'))
    return validateContext(c).length ? defaults() : c
  } catch {
    return defaults()
  }
}

/** Write a context; throws on one the validator rejects, so the file keeps its last good shape. */
export function writeContext(c, file = CONTEXT_FILE) {
  const problems = validateContext(c)
  if (problems.length) throw new Error(`Not saved: ${problems.join('; ')}`)
  writeAtomic(file, JSON.stringify(c, null, 1))
}

/** Read, change, write. `fn` gets the context and answers a change result; one with `error` writes nothing. */
export function updateContext(fn, file = CONTEXT_FILE) {
  const c = readContext(file)
  const out = fn(c)
  if (!out?.error) writeContext(c, file)
  return out
}

/** A short random id that is safe in a URL path. */
export const newId = () => `n-${randomBytes(6).toString('hex')}`

const refuse = (error, status = 400) => ({ error, status })

/** Add a note, on. { note } or { error, status }. */
export function addNote(c, { title, text } = {}, { now = new Date().toISOString(), id = newId() } = {}) {
  if (typeof title !== 'string') return refuse('Give the note a title.')
  const t = oneLine(title)
  const why = checkTitle(t) || checkNoteText(text)
  if (why) return refuse(why)
  if (c.notes.length >= LIMITS.notesMax) return refuse(`You can keep at most ${LIMITS.notesMax} notes. Remove one first.`)
  const note = { id, title: t, text, on: true, addedAt: now, updatedAt: now }
  c.notes.push(note)
  return { note }
}

/** Change a note's title, text or switch. { note } or { error, status } (404 for an unknown id). */
export function editNote(c, id, patch = {}, { now = new Date().toISOString() } = {}) {
  const note = c.notes.find(x => x.id === id)
  if (!note) return refuse('That note is gone. It may have been removed.', 404)
  const has = k => isObject(patch) && Object.hasOwn(patch, k)
  if (!has('title') && !has('text') && !has('on')) return refuse('Nothing to change. Send a title, a text or on.')
  const next = { ...note }
  if (has('title')) {
    if (typeof patch.title !== 'string') return refuse('Give the note a title.')
    next.title = oneLine(patch.title)
    const why = checkTitle(next.title)
    if (why) return refuse(why)
  }
  if (has('text')) {
    const why = checkNoteText(patch.text)
    if (why) return refuse(why)
    next.text = patch.text
  }
  if (has('on')) {
    if (typeof patch.on !== 'boolean') return refuse('on must be true or false.')
    next.on = patch.on
  }
  next.updatedAt = now
  Object.assign(note, next)
  return { note }
}

/** Remove a note. { ok } or { error, status: 404 }. */
export function removeNote(c, id) {
  const i = c.notes.findIndex(x => x.id === id)
  if (i < 0) return refuse('That note is gone. It may have been removed.', 404)
  c.notes.splice(i, 1)
  return { ok: true }
}

/** Turn the orchestration brief on or off, and choose a session by label (null for none). */
export function setOptions(c, body = {}) {
  const has = k => isObject(body) && Object.hasOwn(body, k)
  if (!has('orchestration') && !has('session')) return refuse('Nothing to change. Send orchestration or session.')
  if (has('orchestration') && typeof body.orchestration !== 'boolean') return refuse('orchestration must be true or false.')
  if (has('session') && body.session !== null && !(typeof body.session === 'string' && LABEL.test(body.session))) return refuse('Choose a session by its name, or none.')
  if (has('orchestration')) c.orchestration = body.orchestration
  if (has('session')) c.session = body.session
  return { ok: true }
}
