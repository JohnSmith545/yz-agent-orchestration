// The three quality blocks a flow may carry, checked on every write (flows.mjs validateFlow calls validateQuality) and
// kept across an agent's `flow write` (mergeKeepingAnswers calls keepQuality):
//
//   flow.selfcheck = { at, by, items: [{ lesson, text, ok, note }] }
//       the producer's answers to its checklist before QA (quality-selfcheck.mjs, `flow self-check`); `lesson` is the
//       item's id: a core check (tests-first, …) or a lesson id (L3); `note` says what is missing when ok is false
//   flow.critic = { at, verdict: ok | concerns, points: [≤ 5], cost, plan? }
//       the second opinion on the planner's plan (quality-critic.mjs); `plan` the plan file it read, so auto runs once
//       per plan; `cost` the run's dollars (null when the CLI gave none)
//   flow.risk = { level: low | medium | high, reasons, needs, at?, basis? }
//       the risk label (quality-risk.mjs); `basis` what it was worked out from (the flow's updatedAt and the files),
//       so the server works it out again only when the flow moved
//
// ⚠️ Each is written only by its own command or the server (the self-check by `flow self-check`, the critic and the
// risk by tools/quality-cli.mjs and quality-watch.mjs): an agent's `flow write` takes all three from the STORED file,
// like `qa` (flow-qa.mjs keepQa), so a producer can neither drop a self-check nor forge a clean critique. Pure: no file.

import { LEVELS, NEEDS } from './quality-risk.mjs'

export const QUALITY_KEYS = Object.freeze(['selfcheck', 'critic', 'risk'])
export const QUALITY_MAX = Object.freeze({ items: 40, note: 300, text: 300, points: 5, point: 400, reasons: 12, reason: 200 })
export const CRITIC_VERDICTS = Object.freeze(['ok', 'concerns'])

/** MUST CHANGE IN LOCKSTEP with flows.mjs AGENT_LABEL. */
const LABEL = /^[A-Za-z0-9 ._-]{1,40}$/
const ITEM_ID = /^[A-Za-z0-9-]{1,40}$/
const isTime = v => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const bounded = (v, max) => isText(v) && v.length <= max

function selfcheckProblems(s) {
  if (!isObject(s)) return ['selfcheck must be a JSON object']
  const p = []
  if (!isTime(s.at)) p.push('selfcheck at must be a time')
  if (!(typeof s.by === 'string' && LABEL.test(s.by))) p.push('selfcheck by must be the label of the agent that answered it')
  if (!Array.isArray(s.items)) return [...p, 'selfcheck items must be a list']
  if (s.items.length > QUALITY_MAX.items) p.push(`selfcheck items has ${s.items.length}, at most ${QUALITY_MAX.items}`)
  s.items.forEach((it, i) => {
    const at = `selfcheck items #${i + 1}`
    if (!isObject(it)) return p.push(`${at} must be a JSON object`)
    if (!(typeof it.lesson === 'string' && ITEM_ID.test(it.lesson))) p.push(`${at} lesson must be the id of a check or a lesson`)
    if (it.text !== undefined && !bounded(it.text, QUALITY_MAX.text)) p.push(`${at} text must be text of at most ${QUALITY_MAX.text} characters`)
    if (typeof it.ok !== 'boolean') p.push(`${at} ok must be true or false`)
    if (it.note != null && !(typeof it.note === 'string' && it.note.length <= QUALITY_MAX.note)) p.push(`${at} note must be text of at most ${QUALITY_MAX.note} characters`)
    if (it.ok === false && !isText(it.note)) p.push(`${at} answered no needs a note`)
  })
  return p
}

function criticProblems(c) {
  if (!isObject(c)) return ['critic must be a JSON object']
  const p = []
  if (!isTime(c.at)) p.push('critic at must be a time')
  if (!CRITIC_VERDICTS.includes(c.verdict)) p.push(`critic verdict must be ${CRITIC_VERDICTS.join(' or ')}`)
  if (!Array.isArray(c.points)) p.push('critic points must be a list')
  else {
    if (c.points.length > QUALITY_MAX.points) p.push(`critic points has ${c.points.length}, at most ${QUALITY_MAX.points}`)
    if (!c.points.every(x => bounded(x, QUALITY_MAX.point))) p.push(`critic points must each be text of at most ${QUALITY_MAX.point} characters`)
  }
  if (c.cost != null && !(typeof c.cost === 'number' && Number.isFinite(c.cost) && c.cost >= 0)) p.push('critic cost must be null or a number of dollars')
  if (c.plan != null && !bounded(c.plan, 260)) p.push('critic plan must be the plan file it read')
  return p
}

function riskProblems(r) {
  if (!isObject(r)) return ['risk must be a JSON object']
  const p = []
  if (!LEVELS.includes(r.level)) p.push(`risk level must be ${LEVELS.join(', ')}`)
  if (!(Array.isArray(r.reasons) && r.reasons.length <= QUALITY_MAX.reasons && r.reasons.every(x => bounded(x, QUALITY_MAX.reason)))) p.push(`risk reasons must be a list of at most ${QUALITY_MAX.reasons} short sentences`)
  if (!(Array.isArray(r.needs) && r.needs.every(n => NEEDS.includes(n)))) p.push(`risk needs must be a list of ${NEEDS.join(', ')}`)
  if (r.at != null && !isTime(r.at)) p.push('risk at must be a time')
  if (r.basis != null && !bounded(r.basis, 2000)) p.push('risk basis must be short text')
  return p
}

/** The problems of a flow's quality blocks, one line each; [] when they are fine or absent. */
export function validateQuality(flow) {
  return [
    ...(flow?.selfcheck !== undefined ? selfcheckProblems(flow.selfcheck) : []),
    ...(flow?.critic !== undefined ? criticProblems(flow.critic) : []),
    ...(flow?.risk !== undefined ? riskProblems(flow.risk) : []),
  ]
}

/** For `flow write` (mergeKeepingAnswers): the three blocks only ever come from the stored file. Returns `incoming`. */
export function keepQuality(incoming, existing) {
  for (const key of QUALITY_KEYS) {
    if (existing?.[key] !== undefined) incoming[key] = existing[key]
    else delete incoming[key]
  }
  return incoming
}
