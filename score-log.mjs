// The orchestration log: ONE timeline of what happened to every flow, built from what the flow files really hold,
// each event marked with the scorecard cell (score.mjs) it put a count in, so a reader can see which events each
// score was counted from.
//
//   orchestrationLog(flows, graph, { now, days, stallDays, extra }) -> [{ at, kind, flow: { id, title } | null,
//                                                                         agent, text, cell }], newest first
//
// THE KINDS, each dated by a time the flow file stores, never a guessed one:
//   started   the flow was created (createdAt)
//   route     its route was planned or changed (route.at, and each route.history entry's at)
//   handed    work handed to QA: a QA attempt started (that attempt's startedAt)
//   passed, failed   each verdict, earlier attempts included (the attempt's at); a failure says who it went back to
//   pushed    QA pushed the commit it tested (pushedAt)
//   done      finished with no QA record: delivered with no code changes, or slipped through with code (updatedAt:
//             the file holds no time of its own for the status change, and the scorecard counts it at this time)
//   dropped   dropped (updatedAt, for the same reason)
//   stopped   QA stopped the flow: it will not reach the Output (the final verdict's time). New beside the verdict:
//             a stopped flow puts TWO counts in, its last failure (caught) and the flow itself (missed)
//   stalled   on its way with no update for stallDays (updatedAt + stallDays, as the scorecard counts it)
//   rule      from `extra` only (another store's rule changes), merged by time
// LEFT OUT: push-refused. The file keeps the refusal's text (qa.pushError) but no time for it, so it is never shown.
// An attempt with no startedAt has no `handed` event; a verdict with no `at` has no event and no count.
//
// THE CELL, delivered | caught | missed | slipped | null, sits on the SAME event that puts the count in that cell:
// every failure verdict is a catch, and the flow cells come from score.mjs cellOf (its kind and time), never a second
// copy of the rules. So summing the cells of the events in a window gives exactly scoreOf's counts for that window
// (test/score-log.test.mjs checks this on fixtures and on the real flows). An `extra` event never carries a cell.
//
// `text` is one plain sentence with agent labels only: no ids, no file names. Ties in time keep the order things
// happen in (a verdict before the stop it causes), newest first. ⚠️ PURE like score.mjs: no file, no git, no config.

import { DAY, FAILED, cellOf, verdictsOf, windowOf } from './score.mjs'

export const LOG_KINDS = Object.freeze(['started', 'route', 'handed', 'passed', 'failed', 'pushed', 'done', 'dropped', 'stopped', 'stalled', 'rule'])
export const LOG_CELLS = Object.freeze(['delivered', 'caught', 'missed', 'slipped'])

const ROUTE_WORD = { build: 'a code change', review: 'a code review', ask: 'a question' }
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
/** 'A', 'A and B', 'A, B and C'. */
const listed = words => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`)

/** The route events of a flow: the earliest planned, each later one a change. */
function routeEvents(flow, labels, add) {
  const r = flow.route
  if (!isObject(r)) return
  const all = [...(Array.isArray(r.history) ? r.history.filter(isObject) : []), r]
  all.forEach((x, i) => {
    const at = timeOf(x.at)
    if (at === null) return
    const by = isText(x.by) ? x.by : 'An agent'
    const what = ROUTE_WORD[x.type] || 'a request'
    const through = (Array.isArray(x.steps) ? x.steps : []).filter(s => s !== 'request' && s !== 'outcome').map(s => labels.get(s) || s)
    const via = through.length ? `, through ${listed(through)}` : ''
    add(at, 'route', by, i === 0 ? `${by} planned this as ${what}${via}.` : `${by} changed the plan to ${what}${via}.`)
  })
}

/** Every event of one flow, oldest first (by generation, which sorting keeps for ties). */
function flowEvents(flow, graph, now, stallMs, labels, qaLabel, push) {
  const ref = { id: flow.id, title: isText(flow.title) ? flow.title : flow.id }
  const owner = isText(flow.agent) ? flow.agent : null
  const add = (at, kind, agent, text, cell = null) => push({ at, kind, flow: ref, agent, text, cell })
  const started = timeOf(flow.createdAt)
  if (started !== null) add(started, 'started', owner, owner ? `${owner} started this.` : 'This was started.')
  routeEvents(flow, labels, add)

  const { cell, kind, time } = cellOf(flow, graph, now, stallMs)
  const verdicts = verdictsOf(flow)
  verdicts.forEach((v, i) => {
    const qa = v.by || qaLabel
    if (v.startedAt !== null) add(v.startedAt, 'handed', v.agent, i === 0 ? `${v.agent} handed this to QA.` : `${v.agent} handed this to QA again, for attempt ${v.attempt}.`)
    if (v.at !== null && FAILED.has(v.status)) add(v.at, 'failed', qa, v.backTo ? `${qa} failed this and sent it back to ${v.backTo}.` : `${qa} failed this.`, 'caught')
    if (v.at !== null && v.status === 'passed') {
      const final = i === verdicts.length - 1 && kind === 'passed'
      add(v.at, 'passed', qa, v.attempt > 1 ? `${qa} passed this on attempt ${v.attempt}.` : `${qa} passed this.`, final ? cell : null)
    }
    if (v.pushedAt !== null) add(v.pushedAt, 'pushed', qa, `${qa} pushed the change it tested.`)
  })

  // the flow's own cell event (a pass already carries its cell above)
  if (time === null || kind === null || kind === 'passed') return
  const qa = verdicts.at(-1)?.by || qaLabel
  const TEXT = {
    done: cell === 'slipped' ? 'This finished with code changes that QA never tested.' : 'This finished with no code changes.',
    dropped: 'This was dropped.',
    stopped: `${qa} stopped this, so it will not reach the Output.`,
    stalled: `This had no update for ${Math.round(stallMs / DAY)} days.`,
  }
  add(time, kind, kind === 'stopped' ? qa : owner, TEXT[kind], cell)
}

/** The log over the last `days` days (null: all time) up to `now`, newest first. */
export function orchestrationLog(flows, graph, { now = Date.now(), days = 30, stallDays = 7, extra = [] } = {}) {
  const win = windowOf(now, days, stallDays)
  const stallMs = stallDays * DAY
  const labels = new Map((graph?.nodes || []).map(n => [n.id, n.label]))
  const qaLabel = (graph?.nodes || []).find(n => n.role === 'qa')?.label || 'QA'
  const out = []
  let seq = 0
  const push = e => {
    if (win.has(e.at)) out.push({ ...e, seq: seq++ })
  }
  for (const flow of Array.isArray(flows) ? flows : []) {
    if (!isObject(flow) || !isText(flow.id)) continue
    flowEvents(flow, graph, now, stallMs, labels, qaLabel, push)
  }
  for (const e of Array.isArray(extra) ? extra : []) {
    if (!isObject(e)) continue
    const at = timeOf(e.at)
    if (at === null) continue
    push({ at, kind: isText(e.kind) ? e.kind : 'rule', flow: isObject(e.flow) ? e.flow : null, agent: isText(e.agent) ? e.agent : null, text: isText(e.text) ? e.text : '', cell: null })
  }
  return out
    .sort((a, b) => b.at - a.at || b.seq - a.seq)
    .map(({ seq: _, at, ...e }) => ({ at: new Date(at).toISOString(), kind: e.kind, flow: e.flow, agent: e.agent, text: e.text, cell: e.cell }))
}
