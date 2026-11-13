// Before and after: how the work changed what the user sees, kept in a flow's
// agent-owned `output` (flows.mjs validates it on every write):
//   - a result shot may say `when: 'before' | 'after'` (absent = after);
//   - `change = { before, after, at }`: ONE plain sentence each, in the story
//     voice, at most 140 characters, one line (marked words allowed);
//   - `diagramBefore`: how it worked before, the shape and limits of `diagram`.
// The page pairs before and after shots, compares them, and shows the change
// as one strip (public/flow-compare.js). Pure: no file access.

import { sayShorter } from './flow-story.mjs'

export const CHANGE_MAX = 140
export const WHEN = Object.freeze(['before', 'after'])

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** The problems of `out.result[].when` and `out.change`, in plain words. */
export function validateChange(out) {
  const problems = []
  ;(Array.isArray(out.result) ? out.result : []).forEach((r, i) => {
    if (isObject(r) && r.when !== undefined && !WHEN.includes(r.when)) problems.push(`output.result #${i + 1} when must be before or after`)
  })
  if (out.change === undefined) return problems
  if (!isObject(out.change)) return [...problems, 'output.change must be a JSON object']
  const line = (key, says) => {
    const v = out.change[key]
    if (typeof v !== 'string' || !v.trim()) return problems.push(`output.change ${key} must say ${says}`)
    if (/[\r\n]/.test(v)) return problems.push(`output.change ${key} must be one line`)
    if (v.length > CHANGE_MAX) problems.push(`output.change: ${key}: ${sayShorter(CHANGE_MAX, v.length)}`)
  }
  line('before', 'how it was')
  line('after', 'how it is now')
  if (out.change.at !== undefined && !(typeof out.change.at === 'string' && out.change.at.trim())) problems.push('output.change at must be a time')
  return problems
}

/** Is there anything to show as before: a before shot, a change line or a diagram of how it was? */
export function hasBefore(out = {}) {
  return (out.result || []).some(r => r?.when === 'before') || !!out.change || (out.diagramBefore?.nodes?.length || 0) > 0
}
