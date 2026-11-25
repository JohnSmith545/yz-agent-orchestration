// What the user did with the alerts, and which were raised: data/alerts-state.json (the project's data folder).
//
//   { day: 'YYYY-MM-DD', dismissed: { <key>: { at, measure } }, snoozed: { <key>: { at, until } },
//     raised: [{ at, day, key, kind, text, flow?, agent? }] }
//
//   applyDismissals(alerts, state, now)   PURE: { shown, hidden, snoozed }: the alerts to show (a returned one marked
//                                         `returned`), how many are dismissed for today and how many snoozed
//   withDismissal(state, { key, measure, now })   PURE: the state with that alert dismissed for the day
//   withSnooze(state, { key, now })       PURE: the state with that flow alert snoozed for SNOOZE_MS
//   withRaised(state, alerts, now)        PURE: the state with each alert not yet noted today appended, or null when
//                                         there was nothing new (so the caller writes nothing)
//   readAlertState(file) / dismissAlert(file, …) / snoozeAlert(file, …) / noteRaised(file, alerts, now)   the file,
//                                         read and written atomically
//
// THE RULES
// - DISMISSED FOR THE DAY: a dismissal holds until local midnight. The next day every alert that still stands shows
//   again, and yesterday's dismissals are dropped at the next write.
// - WORSE BY HALF: a dismissed alert comes back the same day only once its measure (how long it has stood, the tokens
//   of the last hour, the history a turn re-reads, today's spend) is half as large again as when it was dismissed.
// - SNOOZED FOR A WEEK (a flow's Taking long or Waiting on you alert only): hidden for 7 days whatever it measures,
//   because a flow that is meant to stay open (a long-lived tracking flow) would otherwise get worse every hour and come
//   back. The key names the flow AND its step (stuck:<flow>:<step>), so a flow that moves on to another step is a new
//   alert and shows at once. A snooze survives the daily reset; an expired one is dropped at the next write.
// - THE RAISED LOG keeps each alert once a day (the first time it was seen), the newest RAISED_MAX, for the signals
//   feat/smart-learn reads (predict-signals.mjs). It is a log of what was SHOWN to be true, never of what was dismissed.
// - Nothing here makes a sound or a pop-up: the page draws a quiet line (public/predict-alerts.js).
// ⚠️ A missing or broken file, or one of the wrong shape (hand-edited), reads as empty: no alert is lost by it, at
// worst a dismissed one shows again. A file from before snoozes existed reads as having none.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'
import { localDay } from './token-usage.mjs'

export const ALERT_STATE_FILE = path.join(DATA_DIR, 'alerts-state.json')
export const WORSE = 1.5
export const RAISED_MAX = 500
export const SNOOZE_MS = 7 * 86_400_000

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const empty = () => ({ day: null, dismissed: {}, snoozed: {}, raised: [] })
const snoozesOf = state => (isObject(state?.snoozed) ? state.snoozed : {})
/** The snoozes still running at `now`. */
const liveSnoozes = (state, now) => Object.fromEntries(Object.entries(snoozesOf(state)).filter(([, s]) => Date.parse(s?.until) > now))

export function applyDismissals(alerts, state, now = Date.now()) {
  const today = localDay(now)
  const dismissed = state?.day === today && isObject(state.dismissed) ? state.dismissed : {}
  const snoozed = liveSnoozes(state, now)
  const shown = []
  let hidden = 0
  let quiet = 0
  for (const a of Array.isArray(alerts) ? alerts : []) {
    const d = dismissed[a.key]
    if (snoozed[a.key]) quiet++
    else if (!d) shown.push(a)
    else if (Number(a.measure) >= WORSE * Number(d.measure)) shown.push({ ...a, returned: true })
    else hidden++
  }
  return { shown, hidden, snoozed: quiet }
}

export function withDismissal(state, { key, measure, now = Date.now() }) {
  const today = localDay(now)
  const base = state?.day === today && isObject(state.dismissed) ? state.dismissed : {}
  return {
    day: today, dismissed: { ...base, [key]: { at: new Date(now).toISOString(), measure: Number(measure) || 0 } },
    snoozed: liveSnoozes(state, now), raised: Array.isArray(state?.raised) ? state.raised : [],
  }
}

export function withSnooze(state, { key, now = Date.now() }) {
  return {
    day: state?.day ?? null, dismissed: isObject(state?.dismissed) ? state.dismissed : {},
    snoozed: { ...liveSnoozes(state, now), [key]: { at: new Date(now).toISOString(), until: new Date(now + SNOOZE_MS).toISOString() } },
    raised: Array.isArray(state?.raised) ? state.raised : [],
  }
}

export function withRaised(state, alerts, now = Date.now()) {
  const today = localDay(now)
  const raised = Array.isArray(state?.raised) ? state.raised : []
  const seen = new Set(raised.filter(r => r.day === today).map(r => r.key))
  const fresh = []
  for (const a of Array.isArray(alerts) ? alerts : []) {
    if (!isText(a?.key) || seen.has(a.key)) continue
    seen.add(a.key)
    fresh.push({ at: new Date(now).toISOString(), day: today, key: a.key, kind: a.kind, text: a.text, ...(a.flow ? { flow: a.flow } : {}), ...(a.agent ? { agent: a.agent } : {}) })
  }
  if (!fresh.length) return null
  return { day: state?.day ?? null, dismissed: isObject(state?.dismissed) ? state.dismissed : {}, snoozed: snoozesOf(state), raised: [...raised, ...fresh].slice(-RAISED_MAX) }
}

export function readAlertState(file = ALERT_STATE_FILE) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObject(j) || !(j.day === null || isText(j.day)) || !isObject(j.dismissed) || !Array.isArray(j.raised)) return empty()
    return { day: j.day, dismissed: j.dismissed, snoozed: snoozesOf(j), raised: j.raised.filter(isObject) }
  } catch {
    return empty()
  }
}

const save = (file, state) => writeAtomic(file, JSON.stringify(state, null, 1))

export function dismissAlert(file, { key, measure, now = Date.now() }) {
  const next = withDismissal(readAlertState(file), { key, measure, now })
  save(file, next)
  return next
}

export function snoozeAlert(file, { key, now = Date.now() }) {
  const next = withSnooze(readAlertState(file), { key, now })
  save(file, next)
  return next
}

/** Notes the alerts not yet noted today; true when it wrote. */
export function noteRaised(file, alerts, now = Date.now()) {
  const next = withRaised(readAlertState(file), alerts, now)
  if (!next) return false
  save(file, next)
  return true
}
