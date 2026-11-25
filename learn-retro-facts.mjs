// A flow's retrospective, the FACTS: what the server knows about how one flow went, gathered from the flow file
// alone, for the small model run that writes the three lines (learn-retro.mjs). The model writes from these and
// nothing else (learn-prompts.mjs RETRO_SYSTEM).
//
//   retroFacts(flow, graph, { readReport })   { title, request, agent, tickets, status, story, route, qa, security,
//                                             senior, reworks, stages, tookMs, questions, hand }
//   retroFactsText(facts)                     the model's input on stdin, in sections, capped at RETRO_FACTS_MAX
//
// Rules this file keeps:
// - PURE: no file, no config. The one read it needs, a QA report's Markdown (data/evidence/<flow>/qa-<n>-report.md),
//   is `readReport(ref)`, injected; it returns the text or null, and a report it cannot read is left out (''),
//   never guessed. Only FAILED attempts get their report: a pass says what it needs in its summary.
// - The QA attempts and their order are score.mjs verdictsOf's (whose work each tested, where a failure went back),
//   the stage times time-stages.mjs stagesOf's, the finish completed.mjs finishedAt's: the same numbers every other
//   block shows, never a second copy of the rules.
// - Every agent-written text is cut (a verdict to 600 characters, a report to 1,500, a story line to 300), and the
//   whole text to RETRO_FACTS_MAX with a closing note that says it was cut, as standup-text.mjs does. The small
//   sections come first and the questions last, so a cut only ever drops the long tail (questions, then the reports).

import { finishedAt } from './completed.mjs'
import { routeOf } from './flow-route.mjs'
import { handSteps } from './pipeline-hand.mjs'
import { FAILED, SECURITY_FAILED, SENIOR_FAILED, verdictsOf } from './score.mjs'
import { STAGES, stagesOf } from './time-stages.mjs'

export const RETRO_FACTS_MAX = 8_000
const TEXT_MAX = 600
const REPORT_MAX = 1_500
const STORY_MAX = 300
const QUESTION_MAX = 200
const CUT = '\nCut here: the facts were longer than 8,000 characters, so the last of them were left out.'

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
/** `s` on one line, cut to `max` characters with an ellipsis. */
const clip = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}
/** A report's text, kept in lines but cut. */
const clipBlock = (s, max) => {
  const t = String(s ?? '').replace(/\r\n?/g, '\n').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

function report(ref, readReport) {
  if (!isText(ref) || typeof readReport !== 'function') return ''
  try {
    const text = readReport(ref)
    return typeof text === 'string' ? clipBlock(text, REPORT_MAX) : ''
  } catch {
    return '' // an unreadable report is left out
  }
}

/** Every QA attempt, oldest first, with its verdict text and, for a failure, its report. */
function qaOf(flow, readReport) {
  if (!isObject(flow.qa)) return []
  const raw = [...(Array.isArray(flow.qa.attempts) ? flow.qa.attempts.filter(isObject) : []), flow.qa]
  return verdictsOf(flow).map((v, i) => {
    const a = raw[i] || {}
    return {
      attempt: v.attempt, status: String(v.status || 'unknown'), agent: v.agent, backTo: v.backTo,
      text: clip(a.summary, TEXT_MAX), report: FAILED.has(v.status) ? report(a.report, readReport) : '',
    }
  })
}

function securityOf(flow) {
  if (!isObject(flow.qa)) return []
  const raw = [...(Array.isArray(flow.qa.attempts) ? flow.qa.attempts.filter(isObject) : []), flow.qa]
  return raw.flatMap((a, i) => {
    const s = a.security
    if (!isObject(s) || !(s.status === 'passed' || SECURITY_FAILED.has(s.status))) return []
    return [{ attempt: Number.isInteger(a.attempt) ? a.attempt : i + 1, status: s.status, text: clip(s.summary, TEXT_MAX) }]
  })
}

function seniorOf(flow) {
  const s = flow.senior
  if (!isObject(s)) return null
  const past = (Array.isArray(s.history) ? s.history : []).filter(h => isObject(h) && h.status === 'failed')
  const now = s.status === 'passed' || SENIOR_FAILED.has(s.status) || s.status === 'released' ? [s] : []
  return [...past, ...now].map(v => ({ status: v.status, text: clip(v.summary, TEXT_MAX) }))
}

/** What the server knows about how `flow` went. */
export function retroFacts(flow, graph, { readReport = null } = {}) {
  const labels = new Map((graph?.nodes || []).map(n => [n.id, n.label]))
  let route = []
  try {
    route = (routeOf(flow, graph)?.steps || []).map(id => labels.get(id) || id)
  } catch {
    route = []
  }
  const qa = qaOf(flow, readReport)
  const security = securityOf(flow)
  const senior = seniorOf(flow)
  const start = timeOf(flow.createdAt)
  const finish = finishedAt(flow, graph)
  let stages = []
  try {
    const s = stagesOf(flow, graph, { start, finish })
    stages = STAGES.filter(x => x.key in s.times).map(x => ({ label: x.label, ms: s.times[x.key] }))
  } catch {
    stages = []
  }
  const steps = handSteps(flow)
  const reworks = qa.filter(a => FAILED.has(a.status)).length + security.filter(s => SECURITY_FAILED.has(s.status)).length +
    (senior || []).filter(s => SENIOR_FAILED.has(s.status)).length
  return {
    title: clip(flow.title, 200),
    request: clip(flow.why, TEXT_MAX),
    agent: String(flow.agent || ''),
    tickets: Array.isArray(flow.tickets) ? flow.tickets.filter(isText) : [],
    status: String(flow.status || ''),
    story: (Array.isArray(flow.output?.story) ? flow.output.story : []).filter(isObject)
      .map(l => clip(`${l.who || 'Someone'}: ${l.did || ''}${isText(l.why) ? ` (${l.why.trim()})` : ''}`, STORY_MAX)),
    route,
    qa,
    security,
    senior,
    reworks,
    stages,
    tookMs: start !== null && finish !== null && finish >= start ? finish - start : null,
    questions: (Array.isArray(flow.nodes) ? flow.nodes : []).filter(n => isObject(n) && n.type === 'ask')
      .map(n => ({ title: clip(n.title, QUESTION_MAX), answer: n.answer == null ? null : clip(n.answer, QUESTION_MAX) })),
    hand: { steps: steps.length, done: steps.filter(s => s.done).length, items: steps.map(s => clip(s.do, QUESTION_MAX)) },
  }
}

/** 3 h 5 min, 12 min, under a minute. */
export function duration(ms) {
  if (!Number.isFinite(ms)) return 'unknown'
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'under a minute'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`
}

const section = (head, lines) => `${head}\n${lines.length ? lines.join('\n') : '- None.'}`

/** The facts as the model reads them: a head, then one section each, `- None.` for an empty one. */
export function retroFactsText(f) {
  const qaLine = a => `- Attempt ${a.attempt} on ${a.agent}'s work: ${a.status}${a.backTo ? `, sent back to ${a.backTo}` : ''}. ${a.text || '(no text)'}` +
    (a.report ? `\n  Report:\n  ${a.report.replace(/\n/g, '\n  ')}` : '')
  const parts = [
    [
      `Flow: ${f.title}`,
      `Request: ${f.request || '(not written)'}`,
      `Agent: ${f.agent || 'unknown'}${f.tickets.length ? `, tickets ${f.tickets.join(', ')}` : ''}`,
      `Status: ${f.status}`,
      `Route planned: ${f.route.length ? f.route.join(' > ') : 'unknown'}`,
      `Time from request to finish: ${duration(f.tookMs)}`,
      `Reworks (work sent back after a failed check): ${f.reworks}`,
    ].join('\n'),
    section('STORY (the agent\'s own lines)', f.story.map(l => `- ${l}`)),
    section('TIME PER STAGE', f.stages.map(s => `- ${s.label}: ${duration(s.ms)}`)),
    section('SECURITY VERDICTS', f.security.map(s => `- After QA attempt ${s.attempt}: ${s.status}. ${s.text || '(no text)'}`)),
    section('SENIOR VERDICTS', (f.senior || []).map(s => `- ${s.status}. ${s.text || '(no text)'}`)),
    section('BY-HAND STEPS FOR THE USER', f.hand.steps ? [`- ${f.hand.done} of ${f.hand.steps} done`, ...f.hand.items.map(t => `- ${t}`)] : []),
    section('QA ATTEMPTS', f.qa.map(qaLine)),
    section('QUESTIONS ASKED OF THE USER', f.questions.map(q => `- ${q.title} Answer: ${q.answer ?? 'not answered'}`)),
  ]
  const whole = parts.join('\n\n')
  if (whole.length <= RETRO_FACTS_MAX) return whole
  const room = whole.slice(0, RETRO_FACTS_MAX - CUT.length)
  return room.slice(0, Math.max(0, room.lastIndexOf('\n'))) + CUT
}
