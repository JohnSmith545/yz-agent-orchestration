// What the user sets for each agent in its window on the Agents page (public/agent-window.js), beside its
// specification and rules (agent-rules.mjs): the model and effort the user wants it on, and the text files and notes
// it is given. Saved through agent-settings-routes.mjs and PRINTED to the agent wherever its rules are printed
// (tools/rules-cli.mjs: `flow new`, `flow qa-start`, `flow security-start`, `flow plan-start`, `flow rules`).
//
//   data/agent-settings.json      { agents: { "<label>": { model, effort, files: [{ id, title, kind: file|note, name,
//                                 text, on, addedAt }], updatedAt } } }
//   data/agent-settings-log.jsonl one line per saved change: { at, label, text }, the text one plain sentence for the
//                                 window's Changes list, newest last, the newest LOG_KEEP kept
//
// ⚠️ THE DASHBOARD CANNOT SWITCH A SESSION THAT IS OPEN IN THE EDITOR. The model and effort are a wish: saved, printed
// to the agent, used for the subagents it starts, and the user switches the session itself. The planner and Security
// (pipeline.mjs) always run on Opus at high effort (FIXED): nothing is saved for them, and their print says so every
// time. The chat agent's model is config.json's (factory.chat.model): read only here.
//
// Rules this file keeps:
// - The checks and the changes are PURE on a store (checkModel, checkFile, applyModel, addFile, setFileOn,
//   removeFile, settingsBlock): a change returns { store, text } with a NEW store (the one passed in is never
//   changed) and the change as one plain sentence, null when nothing changed; or { error } with the sentence to show.
// - Reads and writes take the file as an argument (tests never touch data/), follow FACTORY_DATA_DIR through
//   factory-state.mjs, and write whole through atomic-write.mjs. A missing or broken file reads as empty; a
//   hand-edited one keeps only what is well formed (an unknown model or effort reads as none).
// - Text only: a file is read as text in the browser, and a NUL character means it was not text; the server
//   refuses it too. Limits per agent: 20 files and notes, 20,000 characters each, 60,000 in all; the print is cut
//   at PRINT_MAX with a visible [cut: N more characters] line.
// - The log is append-only like agent-rules.mjs's and never throws: the save already happened.
//
// FOR THE ORCHESTRATION BANK (another page snapshots every per-agent store): readAgentSettings(file?) returns the
// whole store, cleaned; writeAgentSettings(store, file?) writes one back whole, cleaned. Nothing else is needed.

import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'

export const SETTINGS_FILE = path.join(DATA_DIR, 'agent-settings.json')
export const SETTINGS_LOG = path.join(DATA_DIR, 'agent-settings-log.jsonl')
export const LOG_KEEP = 500
/** The current Claude models, in the order the window offers them. */
export const MODELS = Object.freeze([
  Object.freeze({ id: 'claude-fable-5-2', name: 'Fable 5.2' }),
  Object.freeze({ id: 'claude-opus-5-5', name: 'Opus 5.5' }),
  Object.freeze({ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }),
  Object.freeze({ id: 'claude-haiku-5-5', name: 'Haiku 5.5' }),
])
export const EFFORTS = Object.freeze(['low', 'medium', 'high'])
/** What the planner and Security always run on. */
export const FIXED = Object.freeze({ model: 'claude-opus-5-5', effort: 'high' })
export const FIXED_ROLES = Object.freeze(['planner', 'security'])
/** Per agent: each file or note at most `chars`, at most `files` of them, `total` characters in all; a title of 1 to `title`. */
export const FILE_LIMITS = Object.freeze({ chars: 20_000, files: 20, total: 60_000, title: 100 })
/** The longest print an agent is given (settingsBlock). */
export const PRINT_MAX = 60_000
const NL = '\n'

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
/** 20000 -> "20,000", the same in every locale. */
const num = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const oneLine = s => String(s).replace(/\s+/g, ' ').trim()
const modelName = id => MODELS.find(m => m.id === id)?.name || id
const newFileId = () => `f${randomBytes(4).toString('hex')}`
const stamp = () => new Date().toISOString()

// ═══ the store ═══

const emptyEntry = () => ({ model: null, effort: null, files: [], updatedAt: null })

function cleanFile(f) {
  if (!isObj(f) || typeof f.id !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(f.id)) return null
  if (typeof f.title !== 'string' || !oneLine(f.title) || typeof f.text !== 'string' || !f.text) return null
  return {
    id: f.id, title: oneLine(f.title).slice(0, FILE_LIMITS.title), kind: f.kind === 'file' ? 'file' : 'note',
    name: typeof f.name === 'string' && f.name.trim() ? oneLine(f.name).slice(0, 200) : null,
    text: f.text.slice(0, FILE_LIMITS.chars), on: f.on !== false, addedAt: isTime(f.addedAt) ? f.addedAt : null,
  }
}

function cleanEntry(e) {
  if (!isObj(e)) return null
  return {
    model: MODELS.some(m => m.id === e.model) ? e.model : null,
    effort: EFFORTS.includes(e.effort) ? e.effort : null,
    files: (Array.isArray(e.files) ? e.files : []).map(cleanFile).filter(Boolean).slice(0, FILE_LIMITS.files),
    updatedAt: isTime(e.updatedAt) ? e.updatedAt : null,
  }
}

/** Anything read from the file as a store; what is not well formed is left out. */
export function cleanSettings(raw) {
  const agents = {}
  for (const [label, e] of Object.entries(isObj(raw?.agents) ? raw.agents : {})) {
    const entry = cleanEntry(e)
    if (entry) agents[label] = entry
  }
  return { agents }
}

/** The whole store (the Orchestration bank snapshots it): { agents: { label: entry } }, empty when missing or broken. */
export function readAgentSettings(file = SETTINGS_FILE) {
  if (!existsSync(file)) return { agents: {} }
  try {
    return cleanSettings(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { agents: {} }
  }
}

/** Write a whole store (the Orchestration bank restores one with it), cleaned, atomically. */
export function writeAgentSettings(store, file = SETTINGS_FILE) {
  writeAtomic(file, JSON.stringify(cleanSettings(store), null, 1))
}

/** One agent's entry, or the empty one. */
export const entryOf = (store, label) => cleanEntry(store?.agents?.[label]) || emptyEntry()

const withEntry = (store, label, entry) => ({ agents: { ...cleanSettings(store).agents, [label]: entry } })

// ═══ the model and effort ═══

/** A PUT body { model?, effort? } (null clears one) checked for an agent of `role`: { model?, effort? } or { error }. */
export function checkModel(b, role) {
  if (FIXED_ROLES.includes(role)) return { error: 'This agent always runs on Opus at high effort. Its model cannot be changed.' }
  if (role === 'chat') return { error: 'The chat agent runs on the model in config.json (factory.chat.model). It cannot be changed here.' }
  const out = {}
  if (isObj(b) && b.model !== undefined) {
    if (b.model !== null && !MODELS.some(m => m.id === b.model)) return { error: 'Pick one of the listed models.' }
    out.model = b.model
  }
  if (isObj(b) && b.effort !== undefined) {
    if (b.effort !== null && !EFFORTS.includes(b.effort)) return { error: 'Pick low, medium or high effort.' }
    out.effort = b.effort
  }
  if (!('model' in out) && !('effort' in out)) return { error: 'Nothing to save. Send a model or an effort.' }
  return out
}

/** The store with `label`'s checked model change applied, and the change in one sentence (null for none). */
export function applyModel(store, label, change, { now = stamp } = {}) {
  const old = entryOf(store, label)
  const next = { ...old, files: old.files.map(f => ({ ...f })) }
  if (change.model !== undefined) next.model = change.model
  if (change.effort !== undefined) next.effort = change.effort
  const model = next.model !== old.model
  const effort = next.effort !== old.effort
  if (!model && !effort) return { store: cleanSettings(store), text: null }
  next.updatedAt = now()
  let text
  if (model && !next.model) text = `${label} no longer has a model chosen.`
  else if (effort && !next.effort && !model) text = `${label} no longer has an effort chosen.`
  else if (model && effort && next.effort) text = `${label} is to run on ${modelName(next.model)} at ${next.effort} effort.`
  else text = model ? `${label} is to run on ${modelName(next.model)}.` : `${label} is to run at ${next.effort} effort.`
  return { store: withEntry(store, label, next), text }
}

// ═══ files and notes ═══

/**
 * A POST body { title, text, kind: file|note, name? } checked against `entry` (the agent's saved one): the cleaned
 * { title, text, kind, name } or { error }, one plain sentence.
 */
export function checkFile(b, entry) {
  if (!isObj(b) || !['file', 'note'].includes(b.kind)) return { error: 'Add a text file or a note.' }
  const title = typeof b.title === 'string' ? oneLine(b.title) : ''
  if (!title) return { error: 'Give it a title.' }
  if (title.length > FILE_LIMITS.title) return { error: `The title is too long. Keep it to ${FILE_LIMITS.title} characters.` }
  if (typeof b.text !== 'string') return { error: b.kind === 'file' ? 'That file could not be read as text.' : 'The note must be text.' }
  const text = b.text.replace(/\r\n?/g, '\n')
  if (text.includes('\u0000')) return { error: 'That file is not text, so it cannot be added. Add a text file such as .md or .txt.' }
  if (!text.trim()) return { error: b.kind === 'file' ? 'That file is empty.' : 'The note is empty. Write something first.' }
  if (text.length > FILE_LIMITS.chars) return { error: `That is too long. Keep each file or note to ${num(FILE_LIMITS.chars)} characters.` }
  const files = entry?.files || []
  if (files.length >= FILE_LIMITS.files) return { error: `That is the most this agent can have: ${FILE_LIMITS.files} files and notes. Remove one first.` }
  const used = files.reduce((n, f) => n + f.text.length, 0)
  if (used + text.length > FILE_LIMITS.total) return { error: `That would take this agent past ${num(FILE_LIMITS.total)} characters in all. Remove or shorten another file first.` }
  const name = b.kind === 'file' && typeof b.name === 'string' && b.name.trim() ? oneLine(b.name).slice(0, 200) : null
  return { title, text, kind: b.kind, name }
}

const what = f => `the ${f.kind} ${f.title}`

/** The store with a checked file or note added, switched on; the sentence says so. */
export function addFile(store, label, item, { now = stamp, newId = newFileId } = {}) {
  const old = entryOf(store, label)
  const at = now()
  const file = { id: newId(), title: item.title, kind: item.kind, name: item.name ?? null, text: item.text, on: true, addedAt: at }
  return { store: withEntry(store, label, { ...old, files: [...old.files, file], updatedAt: at }), text: `${label} was given ${what(file)}.`, file }
}

/** The store with file `id` switched on or off; null text when it already was. */
export function setFileOn(store, label, id, on, { now = stamp } = {}) {
  const old = entryOf(store, label)
  const f = old.files.find(x => x.id === id)
  if (!f) return { error: `There is no such file or note for ${label}.` }
  if (f.on === !!on) return { store: cleanSettings(store), text: null }
  const files = old.files.map(x => (x.id === id ? { ...x, on: !!on } : x))
  return { store: withEntry(store, label, { ...old, files, updatedAt: now() }), text: `The ${f.kind} ${f.title} of ${label} was switched ${on ? 'on' : 'off'}.` }
}

/** The store without file `id`. */
export function removeFile(store, label, id, { now = stamp } = {}) {
  const old = entryOf(store, label)
  const f = old.files.find(x => x.id === id)
  if (!f) return { error: `There is no such file or note for ${label}.` }
  return { store: withEntry(store, label, { ...old, files: old.files.filter(x => x.id !== id), updatedAt: now() }), text: `The ${f.kind} ${f.title} was removed from ${label}.` }
}

/** What the window shows of an agent: everything but the texts, which can be long, with their sizes and the totals. */
export function entryView(entry, role) {
  const fixed = FIXED_ROLES.includes(role)
  const files = entry.files.map(({ text, ...f }) => ({ ...f, chars: text.length }))
  return {
    model: fixed ? FIXED.model : entry.model, effort: fixed ? FIXED.effort : entry.effort, fixed,
    files, chars: files.reduce((n, f) => n + f.chars, 0), updatedAt: entry.updatedAt,
  }
}

// ═══ the print ═══

/** The model line of the print, or '' when nothing is chosen. */
function modelLine(entry, role) {
  if (FIXED_ROLES.includes(role)) return `You always run on ${modelName(FIXED.model)} (${FIXED.model}) at high effort, and so do the subagents you start. If this session runs on another model, tell the user so they can switch it in the editor.`
  if (role === 'chat') return ''
  const on = entry.model ? `on ${modelName(entry.model)} (${entry.model})` : ''
  const at = entry.effort ? `at ${entry.effort} effort` : ''
  if (!on && !at) return ''
  const sub = entry.model ? ': start your subagents on that model; the user switches this session in the editor.' : '.'
  return `The user wants you ${[on, at].filter(Boolean).join(' ')}${sub}`
}

/**
 * What `label` (of graph role `role`) is shown with its rules, as plain text, or '' when it has nothing: a head line,
 * the model line, then each switched-on file or note under its title. Past PRINT_MAX it is cut, with a last line
 * `[cut: N more characters]`.
 */
export function settingsBlock(store, label, role) {
  const entry = entryOf(store, label)
  const line = modelLine(entry, role)
  const files = entry.files.filter(f => f.on).map(f => `${f.kind === 'file' ? 'File' : 'Note'}: ${f.title}${f.name ? ` (${f.name})` : ''}\n${f.text}`)
  if (!line && !files.length) return ''
  const full = [`Settings for ${label}, set by the user on the dashboard:${line ? `\n${line}` : ''}`, ...files].join('\n\n')
  return full.length > PRINT_MAX ? `${full.slice(0, PRINT_MAX)}\n[cut: ${num(full.length - PRINT_MAX)} more characters]` : full
}

// ═══ the change log ═══

/** One line on the log, cut to the newest `keep`. Returns whether it was written; never throws. */
export function appendSettingsLog(line, file = SETTINGS_LOG, keep = LOG_KEEP) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(line) + NL)
    const lines = readFileSync(file, 'utf8').split(NL).filter(Boolean)
    if (lines.length > keep) writeAtomic(file, lines.slice(-keep).join(NL) + NL)
    return true
  } catch (err) {
    console.error(`agent settings: could not log a change for ${line?.label}: ${err?.message || err}`)
    return false
  }
}

/** The log's lines, oldest first; a torn or hand-made line is skipped. */
export function readSettingsLog(file = SETTINGS_LOG) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const raw of text.split(NL)) {
    if (!raw.trim()) continue
    try {
      const l = JSON.parse(raw)
      if (isObj(l) && isTime(l.at) && typeof l.label === 'string' && typeof l.text === 'string' && l.text) out.push({ at: l.at, label: l.label, text: l.text })
    } catch {
      // a torn line: the rest still reads
    }
  }
  return out
}

/** `label`'s last `n` changes, newest first, as { at, text }. */
export function settingsChangesOf(lines, label, n = 10) {
  return (Array.isArray(lines) ? lines : []).filter(l => l?.label === label)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, n).map(l => ({ at: l.at, text: l.text }))
}
