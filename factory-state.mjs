// The Factory's own records: review marks, and the chat session id with the
// mode it started in and its running cost total (chat.mjs).
// Decisions to the user moved to flows (flows.mjs, tools/flow-cli.mjs).
//
// One JSON file, data/factory-state.json (git-ignored with the rest of data/),
// shared by the server and tools/factory.mjs, so an agent can set a review mark
// from its shell and the page shows it on the next poll. Writes go through
// writeAtomic (atomic-write.mjs), so a reader never sees half a file.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAtomic } from './atomic-write.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Data root, as in flows.mjs: tests point FACTORY_DATA_DIR at a temp folder before importing. */
export const DATA_DIR = process.env.FACTORY_DATA_DIR || path.join(HERE, 'data')
export const STATE_FILE = path.join(DATA_DIR, 'factory-state.json')

/** Review marks a ticket can carry. `reviewed` also has a verdict. */
export const REVIEW = ['reviewed', 'needs-review', 'no-code', 'not-codebase']
/** Verdicts of a code review. */
export const VERDICT = ['now', 'check', 'docfix', 'notyet']

const EMPTY = { marks: {}, chat: { sessionId: '', mode: '', costTotal: 0 } }

export function readState() {
  if (!existsSync(STATE_FILE)) return structuredClone(EMPTY)
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return { ...structuredClone(EMPTY), ...s, chat: { ...EMPTY.chat, ...(s.chat || {}) } }
  } catch {
    return structuredClone(EMPTY)
  }
}

export function writeState(state) {
  writeAtomic(STATE_FILE, JSON.stringify(state, null, 1))
}

/** Read, change, write. `fn` gets the state and returns what the caller should get back. */
export function updateState(fn) {
  const state = readState()
  const out = fn(state)
  writeState(state)
  return out
}

/** Set one ticket's review mark. Throws on a bad value, so the CLI and the API share one check. */
export function setMark(state, id, { review, verdict, note, by }) {
  id = String(id || '').toUpperCase()
  if (!/^[A-Z]+-\d+$/.test(id)) throw new Error(`Not a ticket id: ${id}`)
  const prev = state.marks[id] || {}
  const next = { ...prev, at: new Date().toISOString(), by: by || prev.by || 'you' }
  if (review !== undefined) {
    if (!REVIEW.includes(review)) throw new Error(`review must be one of ${REVIEW.join(', ')}`)
    next.review = review
    if (review !== 'reviewed') delete next.verdict
  }
  if (verdict !== undefined && verdict !== '') {
    if (!VERDICT.includes(verdict)) throw new Error(`verdict must be one of ${VERDICT.join(', ')}`)
    next.review = 'reviewed'
    next.verdict = verdict
  }
  if (note !== undefined) next.note = String(note).slice(0, 2000)
  state.marks[id] = next
  return next
}
