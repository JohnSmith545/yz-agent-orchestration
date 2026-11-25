// The four numbers a rule change is judged by (learn-verdicts.mjs), over ONE window with both ends fixed:
//
//   windowNumbers({ flows, graph, from, to, tokens })   from and to in ms ->
//     { from, to (ISO), finished,
//       rightFirstTime { value, right, judged }   the scorecard's correctness (score.mjs): of the flows given a final
//                                                 verdict in the window, those passed with no failure in their history
//       medianMs       { value, flows }           Pipeline time's time per job (time-stats.mjs): a finished flow's
//                                                 createdAt to the time the scorecard counts its delivery, the median
//       costPerJob     { value, usd, jobs }       Pipeline tokens' estimate (token-usage.mjs) for the window, divided by
//                                                 the jobs finished in it (a ticket at its last finish, else one flow)
//       qaFailures     { value, failures, flows } QA failure verdicts on the flows finished in the window, per flow }
//
// THE RULES
// - FINISHED is the scorecard's delivered cell (score.mjs cellOf), as Pipeline time counts it, so the three blocks and
//   this one never disagree on what finished. But both ends are FIXED here: those blocks count from a start up to
//   now, and a rule change is judged on the 14 days before it and the 14 days after, so a flow that finished after
//   `to` is left out. Each flow is judged as it stood at `to` (cellOf with now = to), and one whose deciding moment
//   is later is not in the window at all, whatever it holds now.
// - Exact times, not whole local days: Pipeline time's bars are per local day, a verdict is per moment.
// - The cost is `tokens({ from, to })` -> { usd }: the wiring passes the token index (Pipeline tokens' estimate at API
//   prices, whole local days, as that block counts them). No reader, one that throws, or no price: usd null, and the
//   cost is left out of the verdict. Never a guess.
// - A number with nothing under it is null, never a 0 that reads as a result.
// ⚠️ PURE like score.mjs: no file, no clock, no config.

import { DAY, FAILED, cellOf, scoreOf, verdictsOf } from './score.mjs'

const STALL_DAYS = 7
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
const median = list => {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function costOf(tokens, from, to) {
  if (typeof tokens !== 'function') return null
  try {
    const usd = tokens({ from, to })?.usd
    return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : null
  } catch {
    return null
  }
}

export function windowNumbers({ flows, graph, from, to, tokens = null }) {
  const stallMs = STALL_DAYS * DAY
  const list = (Array.isArray(flows) ? flows : []).filter(f => isObject(f) && isText(f.id))
  // each flow as it stood at `to`: one decided later is not in this window at all
  const cells = new Map(list.map(f => [f, cellOf(f, graph, to, stallMs)]))
  const kept = list.filter(f => {
    const t = cells.get(f).time
    return t === null || t <= to
  })
  const score = scoreOf(kept, graph, { now: to, days: (to - from) / DAY, stallDays: STALL_DAYS })

  const done = kept.filter(f => cells.get(f).cell === 'delivered' && cells.get(f).time >= from)
  const took = []
  const tickets = new Map()
  let otherJobs = 0
  let failures = 0
  for (const f of done.sort((a, b) => cells.get(a).time - cells.get(b).time)) {
    const start = timeOf(f.createdAt)
    const finish = cells.get(f).time
    if (start !== null && finish >= start) took.push(finish - start)
    const ids = Array.isArray(f.tickets) ? f.tickets.filter(isText) : []
    if (!ids.length) otherJobs++
    for (const id of ids) tickets.set(id, f)
    failures += verdictsOf(f).filter(v => FAILED.has(v.status)).length
  }
  const jobs = tickets.size + otherJobs
  const usd = costOf(tokens, from, to)
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    finished: done.length,
    rightFirstTime: { value: score.correctness.value, right: score.correctness.right, judged: score.correctness.judged },
    medianMs: { value: median(took), flows: took.length },
    costPerJob: { value: usd !== null && jobs > 0 ? usd / jobs : null, usd, jobs },
    qaFailures: { value: done.length ? failures / done.length : null, failures, flows: done.length },
  }
}
