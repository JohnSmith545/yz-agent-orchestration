// A flow's retrospective, the TEXT: the three lines the model writes (parseRetro) and the shape kept on the flow as
// `flow.retro` (validateRetro, which flows.mjs validateFlow calls).
//
//   flow.retro = { at, right, wrong, next, cost, source }
//     at       when it was written (ISO)
//     right    what went right, one plain line of 1 to 200 characters
//     wrong    what went wrong (Nothing went wrong. is a line too)
//     next     what to do differently next time
//     cost     what the run cost in USD, or null when the run gave none
//     source   'completed' (written when the user marked the flow Completed) or 'button' (Write the retrospective)
//
// Rules this file keeps:
// - PURE, and it imports nothing: flows.mjs imports it, so it may not import flows.mjs back.
// - The server checks the model's answer, never trusts it: all three lines or an error; a line over 200 characters
//   is cut at a word with an ellipsis (kept, not dropped: the rest of it is still true).
// - The retrospective is the SERVER'S, like a QA verdict is QA's: only learn-retro.mjs writes it, and an agent's
//   rewrite of the flow keeps the stored one (flows.mjs mergeKeepingAnswers). An agent may read it (`flow show`).

export const RETRO_LINE_MAX = 200
export const RETRO_SOURCES = Object.freeze(['completed', 'button'])
export const RETRO_KEYS = Object.freeze(['right', 'wrong', 'next'])
const MISSING = 'The model did not write the three lines (Right, Wrong, Next).'
/** MUST CHANGE IN LOCKSTEP with flows.mjs ISO_TIME. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
const isTime = v => typeof v === 'string' && ISO_TIME.test(v) && !Number.isNaN(Date.parse(v))
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** `s` on one line within `max` characters: cut at the last word that fits, with an ellipsis. */
export function fitLine(s, max = RETRO_LINE_MAX) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** A line's label, with bullets, bold and a colon or dash after it forgiven: `**Right:**`, `- Next -`, `Wrong:`. */
const LINE = /^[\s>*_#-]*(right|wrong|next)\b[\s*_]*[:\-–][\s*_]*(.*)$/i

/** The model's answer as { right, wrong, next }, or { error } when any of the three is missing or empty. */
export function parseRetro(text) {
  const out = {}
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = LINE.exec(raw)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = fitLine(m[2].replace(/[*_]+$/g, ''))
    if (!(key in out) && value) out[key] = value
  }
  return RETRO_KEYS.every(k => out[k]) ? { right: out.right, wrong: out.wrong, next: out.next } : { error: MISSING }
}

/** The problems with a stored `retro`, one line each; [] when it is well formed. */
export function validateRetro(r) {
  if (!isObject(r)) return ['retro must be a JSON object']
  const problems = []
  if (!isTime(r.at)) problems.push('retro at must be a time')
  for (const key of RETRO_KEYS) {
    if (typeof r[key] !== 'string' || !r[key].trim() || r[key].length > RETRO_LINE_MAX) problems.push(`retro ${key} must be text of 1 to ${RETRO_LINE_MAX} characters`)
  }
  if (!(r.cost === null || (typeof r.cost === 'number' && Number.isFinite(r.cost) && r.cost >= 0))) problems.push('retro cost must be a number of dollars or null')
  if (!RETRO_SOURCES.includes(r.source)) problems.push(`retro source must be one of ${RETRO_SOURCES.join(', ')}`)
  return problems
}

/** An agent's rewrite keeps the stored retrospective, and can neither add nor drop one (flows.mjs mergeKeepingAnswers). */
export function keepRetro(incoming, existing) {
  if (isObject(existing?.retro)) incoming.retro = existing.retro
  else delete incoming.retro
}
