// `node tools/factory.mjs context …`: what the SCRIPT Generator is told, from a shell. This is how the user
// "asks Master": they ask in chat, and Master (or any agent) adds what it knows as a note.
//
//   context add "<title>" (--text "..." | --file <path>)   a note, on, saved to data/script-context.json
//   context list                                          the brief switch, the chosen session, every note
//   context remove <id>                                   take a note away
//
// The store and its limits are script-context.mjs's (a title of 1 to 80 characters, a note of 1 to 20,000, at
// most 40 notes): the page and the CLI share one check. A --file must be a text file (no NUL bytes, valid UTF-8).
// Returns { out, code } and never prints: tools/factory.mjs prints (out to stderr when code is not 0).

import { readFileSync } from 'node:fs'

import { addNote, LIMITS, readContext, removeNote, updateContext } from '../script-context.mjs'
import { flags } from './flow-cli.mjs'

export const CONTEXT_USAGE = `usage:
  context add "<title>" (--text "..." | --file <path>)   add a note SCRIPT is told before it writes
  context list                                          what SCRIPT is told now
  context remove <id>                                   remove a note`

const fmt = n => n.toLocaleString('en-GB')

/** The text of a --file, or { error } in one line. */
function fileText(file) {
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return { error: `${file} could not be read.` }
  }
  const text = buf.toString('utf8')
  if (buf.includes(0) || text.includes('�')) return { error: `${file} is not a text file.` }
  return { text }
}

function add(f) {
  const [, title] = f._
  if (typeof title !== 'string' || !title.trim()) return { out: CONTEXT_USAGE, code: 1 }
  const hasText = typeof f.text === 'string'
  const hasFile = typeof f.file === 'string'
  if (hasText === hasFile) return { out: 'Give the note with --text "..." or --file <path>, one of them.', code: 1 }
  const got = hasFile ? fileText(f.file) : { text: f.text }
  if (got.error) return { out: got.error, code: 1 }
  if (got.text.length > LIMITS.textMax) return { out: `A note can hold at most ${fmt(LIMITS.textMax)} characters. This one has ${fmt(got.text.length)}.`, code: 1 }
  const r = updateContext(c => addNote(c, { title, text: got.text }))
  if (r.error) return { out: r.error, code: 1 }
  return { out: `Added ${r.note.id} "${r.note.title}" (${fmt(r.note.text.length)} characters). SCRIPT uses it while it is on.`, code: 0 }
}

function list() {
  const c = readContext()
  const lines = [`Orchestration brief: ${c.orchestration ? 'on' : 'off'}`, `Live session: ${c.session || 'none'}`]
  if (!c.notes.length) lines.push('No notes yet.')
  for (const n of c.notes) lines.push(`${n.id}  ${n.on ? 'on ' : 'off'}  ${fmt(n.text.length)} characters  ${n.title}`)
  return { out: lines.join('\n'), code: 0 }
}

function remove(f) {
  const id = f._[1]
  if (typeof id !== 'string' || !id) return { out: CONTEXT_USAGE, code: 1 }
  const r = updateContext(c => removeNote(c, id))
  if (r.error) return { out: r.error, code: 1 }
  return { out: `Removed ${id}.`, code: 0 }
}

/** Run `context` with its arguments (after the word `context`). */
export function runContext(argv) {
  // no boolean flags here: `--text` takes the note (in the flow commands it is a switch)
  const f = flags(argv, new Set(), new Set())
  try {
    switch (f._[0]) {
      case 'add':
        return add(f)
      case 'list':
        return list()
      case 'remove':
        return remove(f)
      default:
        return { out: CONTEXT_USAGE, code: 1 }
    }
  } catch (err) {
    return { out: err.message, code: 1 }
  }
}
