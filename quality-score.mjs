// The self-checked count beside Correctness on the scorecard (score-routes.mjs adds it to GET /api/score): the same
// right-first-time measure (score.mjs scoreOf correctness), worked out twice, for the flows whose producer recorded a
// self-check before QA (quality-selfcheck.mjs) and for the flows with none, so the user can see whether the self-check
// saves rework. Under TRUST_MIN judged flows on a side the page says Too few to trust (public/quality-score.js), never
// a confident number. Pure: no file, no config.

import { scoreOf } from './score.mjs'

export const TRUST_MIN = 5
const hasSelfCheck = f => !!f?.selfcheck && typeof f.selfcheck === 'object' && Array.isArray(f.selfcheck.items)

/** { with, without, min }: each { right, judged, value, trust } over the same window as the scorecard. */
export function selfCheckSplit(flows, graph, { now = Date.now(), days = 30 } = {}) {
  const list = Array.isArray(flows) ? flows : []
  const side = part => {
    const c = scoreOf(part, graph, { now, days }).correctness
    return { right: c.right, judged: c.judged, value: c.value, trust: c.judged >= TRUST_MIN }
  }
  return { with: side(list.filter(hasSelfCheck)), without: side(list.filter(f => !hasSelfCheck(f))), min: TRUST_MIN }
}
