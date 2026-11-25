// The weekly Learn run's EVIDENCE PACK: everything the dashboard recorded about the work since the last run, in plain
// sections, for the model to read on stdin (learn-routes.mjs) and for the page's Read and Left out lines.
//
//   buildPack({ now, lastRunAt, graph, flows, rules, tokens, verdicts, rejected, readReport, lessons?, signals? })
//     -> { window: { from, to, days, widened }, text, read, left, flowIds, counts }
//
// THE WINDOW: since the last run (none yet: the last 7 days). When fewer than 5 flows finished in it, it goes back at
// least 14 days, and the pack says so: one or two flows are no pattern.
//
// THE SECTIONS, small ones first and the long ones last, each capped, the whole capped at PACK_MAX with a note that
// says where it was cut (standup-text.mjs does the same):
//   PIPELINE NUMBERS         right first time, median time, cost per job, QA failures per flow (learn-numbers.mjs),
//                            and the scorecard's four cells (score.mjs)
//   FLOWS IN THE WINDOW      each flow that finished, failed a check or got a retrospective: THE ids a proposal may
//                            name as evidence (learn-proposals.mjs drops one that names none of them)
//   REWORKS PER AGENT        the scorecard's handed and sent back
//   CURRENT RULES            each agent's specification and rules now (agent-rules.mjs)
//   OPEN VERDICTS ...        rule changes still waiting for their verdict (learn-verdicts.mjs)
//   REJECTED BEFORE          ideas the user rejected, with the reason, so the same idea is not proposed again
//   LESSONS LEARNED          only with a lessons provider (feat/smart-quality: lessons({ since }) -> [{ id, text, area, count }])
//   ALERTS AND ESTIMATES     only with a signals provider (feat/smart-predict: signals({ since }) -> [{ kind, text }])
//   RETROSPECTIVES           every flow retrospective in the window (learn-records.mjs listRetros)
//   FAILURE TEXTS            each QA, Security and Senior failure verdict in the window, with its QA report's start
//
// Rules this file keeps:
// - PURE but for its readers: every source is a function passed in, called inside its own try. A source that throws
//   is LEFT OUT and named in `left` (Left out: the token cost (it could not be read).); the pack is still built.
//   No lessons or signals provider is not a failure: there is simply no such section.
// - Every number comes from a stored record; nothing is guessed. A missing number says so in words.

import { routeOf } from './flow-route.mjs'
import { windowNumbers } from './learn-numbers.mjs'
import { listRetros } from './learn-records.mjs'
import { duration } from './learn-retro-facts.mjs'
import { DAY, FAILED, SECURITY_FAILED, SENIOR_FAILED, cellOf, scoreOf, verdictsOf } from './score.mjs'

export const PACK_MAX = 40_000
const MIN_FINISHED = 5
const WIDE_DAYS = 14
const SECTION_MAX = 12_000
const FLOW_LINES = 80
const TEXT_MAX = 400
const REPORT_MAX = 600
const STALL_MS = 7 * DAY

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const clip = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN
  return Number.isNaN(t) ? null : t
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const pct = v => `${Math.round(v * 100)}%`
const dayText = t => new Date(t).toISOString().slice(0, 10)

/** A section, its lines capped at `max` characters, with a note when lines were left out. */
function section(head, lines, max = SECTION_MAX) {
  if (!lines.length) return `${head}\n- None.`
  const out = []
  let used = head.length
  for (const l of lines) {
    if (used + l.length + 1 > max) {
      out.push(`- Cut here: ${plural(lines.length - out.length, 'more line')} left out to keep the pack short.`)
      break
    }
    out.push(l)
    used += l.length + 1
  }
  return `${head}\n${out.join('\n')}`
}

/** Each failure verdict on `flow` in the window: QA (with its report), Security, Senior. */
function failuresOf(flow, inWindow, readReport) {
  const out = []
  const raw = isObject(flow.qa) ? [...(Array.isArray(flow.qa.attempts) ? flow.qa.attempts.filter(isObject) : []), flow.qa] : []
  verdictsOf(flow).forEach((v, i) => {
    const a = raw[i] || {}
    if (FAILED.has(v.status) && inWindow(v.at)) {
      let report = ''
      try {
        report = isText(a.report) && readReport ? clip(readReport(a.report) || '', REPORT_MAX) : ''
      } catch {
        report = ''
      }
      out.push(`- ${flow.id}, QA attempt ${v.attempt} on ${v.agent}'s work: ${clip(a.summary, TEXT_MAX) || '(no text)'}${report ? ` Report: ${report}` : ''}`)
    }
    const s = a.security
    if (isObject(s) && SECURITY_FAILED.has(s.status) && inWindow(timeOf(s.at))) out.push(`- ${flow.id}, Security after attempt ${v.attempt}: ${clip(s.summary, TEXT_MAX) || '(no text)'}`)
  })
  const sr = flow.senior
  if (isObject(sr)) {
    const all = [...(Array.isArray(sr.history) ? sr.history.filter(h => isObject(h) && h.status === 'failed') : []), ...(SENIOR_FAILED.has(sr.status) ? [sr] : [])]
    for (const v of all) if (inWindow(timeOf(v.at))) out.push(`- ${flow.id}, Senior: ${clip(v.summary, TEXT_MAX) || '(no text)'}`)
  }
  return out
}

export function buildPack({ now = Date.now(), lastRunAt = null, graph, flows, rules, tokens, verdicts, rejected, readReport = null, lessons = null, signals = null }) {
  const left = []
  const read = (title, fn, fallback) => {
    try {
      return fn()
    } catch {
      left.push(title)
      return fallback
    }
  }
  const list = read('the flows', () => (flows() || []).filter(f => isObject(f) && isText(f.id)), [])

  // the window: since the last run, else 7 days; at least 14 when fewer than 5 finished
  const last = timeOf(lastRunAt)
  let from = last !== null && last < now ? last : now - 7 * DAY
  const finishedSince = t => list.filter(f => {
    const c = cellOf(f, graph, now, STALL_MS)
    return c.cell === 'delivered' && c.time >= t && c.time <= now
  }).length
  let widened = false
  if (finishedSince(from) < MIN_FINISHED && from > now - WIDE_DAYS * DAY) {
    from = now - WIDE_DAYS * DAY
    widened = true
  }
  const inWindow = t => t !== null && t >= from && t <= now

  const usd = read('the token cost', () => {
    const v = tokens({ from, to: now })?.usd
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }, null)
  const n = windowNumbers({ flows: list, graph, from, to: now, tokens: () => ({ usd }) })
  const score = scoreOf(list, graph, { now, days: (now - from) / DAY })

  // the flows of the window: finished in it, failed a check in it, or given a retrospective in it
  const retros = read('the retrospectives', () => listRetros({ since: from, readFlows: () => list }).filter(r => Date.parse(r.at) <= now), [])
  const failures = read('the failure texts', () => list.flatMap(f => failuresOf(f, inWindow, readReport)), [])
  const ids = new Set()
  const flowLines = []
  for (const f of list) {
    const c = cellOf(f, graph, now, STALL_MS)
    const decided = c.cell !== null && inWindow(c.time)
    const failed = failures.some(l => l.startsWith(`- ${f.id}, `))
    const retro = retros.some(r => r.flowId === f.id)
    if (!decided && !failed && !retro) continue
    ids.add(f.id)
    let route = ''
    try {
      route = (routeOf(f, graph)?.type) || ''
    } catch {
      route = ''
    }
    flowLines.push(`- ${f.id}: ${clip(f.title, 120)} | agent ${f.agent || 'unknown'}${route ? ` | ${route}` : ''} | ${decided ? (c.cell === 'missed' ? `missed (${c.why})` : c.cell === 'slipped' ? 'slipped through' : c.cell) : 'on its way'}`)
  }

  const head = [
    `Evidence pack, from ${dayText(from)} to ${dayText(now)} (${Math.round((now - from) / DAY)} days).`,
    ...(widened ? [`The window was widened to ${WIDE_DAYS} days because fewer than ${MIN_FINISHED} flows finished since the last run.`] : []),
  ].join('\n')
  const numbers = section('PIPELINE NUMBERS (from the dashboard\'s own records)', [
    `- Finished flows: ${n.finished}`,
    `- Right first time: ${n.rightFirstTime.value === null ? 'no flow judged' : `${pct(n.rightFirstTime.value)} (${n.rightFirstTime.right} of ${n.rightFirstTime.judged} judged)`}`,
    `- Median time per job: ${n.medianMs.value === null ? 'none finished' : duration(n.medianMs.value)}`,
    `- Estimated cost per job at API prices: ${n.costPerJob.value === null ? 'not known' : `$${n.costPerJob.value.toFixed(2)} ($${n.costPerJob.usd.toFixed(2)} over ${plural(n.costPerJob.jobs, 'job')})`}`,
    `- QA failures per finished flow: ${n.qaFailures.value === null ? 'none finished' : `${n.qaFailures.value.toFixed(1)} (${n.qaFailures.failures} in ${n.qaFailures.flows})`}`,
    `- Score cells: delivered ${score.counts.delivered}, caught ${score.counts.caught}, missed ${score.counts.missed}, slipped through ${score.counts.slipped}`,
  ])
  const reworks = section('REWORKS PER AGENT (QA attempts handed, failures sent back)', score.agents.map(a => `- ${a.label}: handed ${a.handed}, sent back ${a.sentBack}, right first time ${a.firstTime}`))

  const store = read('the current rules', () => rules(), null)
  const agentLabels = (graph?.nodes || []).filter(x => x.kind === 'agent').map(x => x.label)
  const ruleLines = store === null ? null : agentLabels.map(label => {
    const e = store?.agents?.[label]
    const rs = (e?.rules || []).map((r, i) => `${i + 1}. ${typeof r === 'string' ? r : r.text}`)
    return `- ${label}: ${rs.length ? rs.join(' ') : 'no rules.'}${isText(e?.spec) ? `\n  Specification: ${clip(e.spec, 600)}` : ''}`
  })
  const open = read('the open verdicts', () => (verdicts() || []).filter(v => v.state === 'waiting'), [])
  const verdictLines = open.map(v => `- ${v.label}${v.added?.length ? ` got: ${v.added.join(' ')}` : ''}${v.removed?.length ? ` lost: ${v.removed.join(' ')}` : ''} on ${dayText(Date.parse(v.at))}; verdict due ${dayText(Date.parse(v.dueAt))}`)
  const no = read('the rejected ideas', () => rejected() || [], [])
  const rejectedLines = no.map(r => `- ${r.target}: ${clip(r.rule, 300)}${isText(r.reason) ? ` Reason: ${clip(r.reason, 300)}` : ''}`)
  const lessonList = typeof lessons === 'function' ? read('the lessons', () => lessons({ since: from }) || [], []) : null
  const signalList = typeof signals === 'function' ? read('the alerts', () => signals({ since: from }) || [], []) : null

  const parts = [
    head,
    numbers,
    section('FLOWS IN THE WINDOW (the only ids a proposal may name as evidence)', flowLines.slice(0, FLOW_LINES).concat(flowLines.length > FLOW_LINES ? [`- Cut here: ${flowLines.length - FLOW_LINES} more flows left out.`] : [])),
    reworks,
    ...(ruleLines ? [section('CURRENT RULES', ruleLines, 10_000)] : []),
    section('OPEN VERDICTS ON EARLIER RULE CHANGES', verdictLines, 4_000),
    section('REJECTED BEFORE (do not propose these again)', rejectedLines, 4_000),
    ...(lessonList ? [section('LESSONS LEARNED', lessonList.map(l => `- [${l.area || 'general'}] ${clip(l.text, 300)} (seen ${l.count ?? 1} times)`), 4_000)] : []),
    ...(signalList ? [section('ALERTS AND ESTIMATES', signalList.map(s => `- ${s.kind}: ${clip(s.text, 300)}`), 4_000)] : []),
    section('RETROSPECTIVES (one per finished flow, written by the dashboard)', retros.map(r => `- ${r.flowId} (${clip(r.title, 120)}): Right: ${r.right} | Wrong: ${r.wrong} | Next: ${r.next}`)),
    section('FAILURE TEXTS (QA, Security and Senior)', failures),
  ]
  let text = parts.join('\n\n')
  if (text.length > PACK_MAX) {
    const cut = '\nCut here: the pack was longer than 40,000 characters, so the last of it was left out.'
    const room = text.slice(0, PACK_MAX - cut.length)
    text = room.slice(0, room.lastIndexOf('\n')) + cut
  }
  const readLine = `Read: ${plural(n.finished, 'finished flow')}, ${plural(retros.length, 'retrospective')}, ${plural(failures.length, 'failure text')}, ${plural(open.length, 'open verdict')}` +
    `${lessonList ? `, ${plural(lessonList.length, 'lesson')}` : ''}${signalList ? `, ${plural(signalList.length, 'alert')}` : ''}`
  return {
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days: Math.round((now - from) / DAY), widened },
    text,
    read: readLine,
    left: left.length ? `Left out: ${left.join(', ')} (${left.length === 1 ? 'it' : 'they'} could not be read).` : '',
    flowIds: ids,
    counts: { finished: n.finished, retros: retros.length, failures: failures.length, verdicts: open.length },
  }
}
