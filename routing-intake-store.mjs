// What ticket intake keeps, in data/factory-state.json beside the review marks (factory-state.mjs updateState, so
// every write is whole and atomic), and the tickets it reads:
//
//   state.intake        { "<ID>": { kind, reason, by: you | model, at } }   the user's corrections and the model's
//                                                                          answers; the rules are worked out on read
//   state.notDuplicate  { "<A>|<B>": at }                                  pairs the user said are not duplicates
//   state.taskTypes     { "<ID>": type }                                   the user's correction of a ticket's task type
//
//   intakeTickets(cols?)              every ticket the collections show (their filter's range and extras, else the
//                                     whole source): [{ id, title, state, labels, type }], each id once
//   intakeState(state?)               { intake, notDuplicate, taskTypes } as stored
//   setKind(id, kind | null)          the user's correction (null takes it off, back to the rules or the model)
//   setModelKinds(answers, at)        the model's answers, never over a correction of the user's
//   setNotDuplicate(a, b)             remember that pair
//   setTicketType(id, type | null)    the user's task type for a ticket
//   ticketKinds()                     id -> kind, the sure sorts only (routing-intake.mjs humanKinds): Human review
//
// ⚠️ Ids are checked against /^[A-Z]+-\d+$/ before anything is read or written; a bad value throws one plain line.
// A ticket source that cannot be read leaves its tickets out, never an error.

import { collections, readSource } from './factory.mjs'
import { readState, updateState } from './factory-state.mjs'
import { humanKinds, KINDS, pairKey, sortTickets } from './routing-intake.mjs'
import { TASK_TYPES } from './routing-type.mjs'

const TICKET = /^[A-Z]+-\d+$/
const REASON_MAX = 140
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const stamp = () => new Date().toISOString()

function checkId(id) {
  if (typeof id !== 'string' || !TICKET.test(id)) throw new Error('A ticket id looks like FLA-815.')
  return id
}

/** The ids a collection shows: its filter's range and extras, or null for every ticket in its source. */
function shownIds(col) {
  const f = col?.filter
  if (!f) return null
  const ids = new Set()
  for (let n = f.range[0]; n <= f.range[1]; n++) ids.add(`${f.prefix}-${n}`)
  for (const n of f.extras || []) ids.add(`${f.prefix}-${n}`)
  return ids
}

export function intakeTickets(cols = collections()) {
  const out = new Map()
  for (const c of cols || []) {
    let src = null
    try {
      src = readSource(c.id)
    } catch {
      src = null
    }
    const shown = shownIds(c)
    for (const [id, t] of Object.entries(src?.tickets || {})) {
      if (out.has(id) || (shown && !shown.has(id))) continue
      out.set(id, { id, title: String(t?.title || ''), state: !t?.state || t.state === 'None' ? 'Unstarted' : String(t.state), labels: Array.isArray(t?.labels) ? t.labels : [], type: String(t?.type || '') })
    }
  }
  return [...out.values()]
}

export function intakeState(state = readState()) {
  return {
    intake: isObj(state.intake) ? state.intake : {},
    notDuplicate: isObj(state.notDuplicate) ? state.notDuplicate : {},
    taskTypes: isObj(state.taskTypes) ? state.taskTypes : {},
  }
}

export function setKind(id, kind, { now = stamp } = {}) {
  checkId(id)
  if (kind !== null && !KINDS.includes(kind)) throw new Error('Pick code, no code or needs a person.')
  return updateState(s => {
    s.intake = isObj(s.intake) ? s.intake : {}
    if (kind === null) delete s.intake[id]
    else s.intake[id] = { kind, reason: 'Set by you.', by: 'you', at: now() }
    return s.intake[id] || null
  })
}

/** The model's answers ({ id: { kind, reason } }), stamped `at`; an id the user corrected is left as the user set it. */
export function setModelKinds(answers, at = stamp()) {
  return updateState(s => {
    s.intake = isObj(s.intake) ? s.intake : {}
    let n = 0
    for (const [id, a] of Object.entries(answers || {})) {
      if (!TICKET.test(id) || !KINDS.includes(a?.kind) || s.intake[id]?.by === 'you') continue
      s.intake[id] = { kind: a.kind, reason: String(a.reason || '').slice(0, REASON_MAX), by: 'model', at }
      n++
    }
    return n
  })
}

export function setNotDuplicate(a, b, { now = stamp } = {}) {
  checkId(a)
  checkId(b)
  if (a === b) throw new Error('A ticket is not a duplicate of itself.')
  return updateState(s => {
    s.notDuplicate = isObj(s.notDuplicate) ? s.notDuplicate : {}
    s.notDuplicate[pairKey(a, b)] = now()
    return true
  })
}

export function setTicketType(id, type) {
  checkId(id)
  if (type !== null && !TASK_TYPES.includes(type)) throw new Error(`Pick a task type: ${TASK_TYPES.join(', ')}.`)
  return updateState(s => {
    s.taskTypes = isObj(s.taskTypes) ? s.taskTypes : {}
    if (type === null) delete s.taskTypes[id]
    else s.taskTypes[id] = type
    return type
  })
}

/** id -> kind for the sure sorts of every ticket the collections show: what the Human review list reads. Never throws. */
export function ticketKinds() {
  try {
    return humanKinds(sortTickets(intakeTickets(), intakeState().intake))
  } catch {
    return {}
  }
}
