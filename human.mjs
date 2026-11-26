// Human review: everything in the pipeline that cannot go on without the user, and why, in ONE answer that the
// Agents page box, the rail's count and Home's line all read (human-routes.mjs GET /api/human).
//
// A row is one thing waiting on the user:
//   ask      an agent asked a question that has no answer yet (one row per open ask)
//   hand     work no agent can finish: a flow with by-hand steps recorded (hand-steps.mjs) that is not finished
//            (open or blocked), or an open flow for a ticket marked no-code or not-codebase, steps or not
//   blocked  a flow its agent marked blocked, with no open ask and no by-hand work to say more
//   session  a running Claude Code session stopped for the user's permission or reply (waiting.mjs standingWaits)
//   ticket   a ticket marked no-code or not-codebase (factory-state.mjs) that is not finished and no live flow covers
//            (CI/CD, cloud setup and console work mostly land here, until an agent writes the steps)
// Each row: { key, kind, flowId?, nodeId?, ticketId?, title, agent, since, reason, ask?, progress?, tickets? },
// newest first by `since`, then in the kind order above. `reason` is ONE short line in plain words.
//
// Rules this file keeps:
// - Dropped, archived and deleted flows never show (listFlows leaves the archived out; the caller passes no
//   deleted ones), and a done flow waits on no one: its work is finished.
// - A flow is never two rows for one cause: an open ask stands for a blocked flow; by-hand work stands for a
//   blocked one too; a ticket a live flow carries is that flow's row, never a ticket row as well.
// - Pure: no file and no clock, so the tests build any state.
//
//   humanItems({ flows, marks, tickets, senior })   { items, counts: { total, ask, hand, blocked, ticket } }; `senior`
//                                          is Senior's label when the pipeline has Senior (pipeline.mjs gateLabels):
//                                          a flow that waits on SENIOR (every step ticked, or sent with senior-ask,
//                                          or being reviewed) is no row at all, so it leaves the count and the page
//                                          head too (QA B-2); it comes back when Senior sends it back, saying why
//                                          `kinds` (id -> code | no-code | needs-a-person, ticket intake's SURE sorts,
//                                          routing-intake-store.mjs ticketKinds): when a ticket has one, it decides: a
//                                          ticket sorted code is no row even when marked, and one sorted no-code or
//                                          needs-a-person is a row even unmarked (`sorted` says which). A ticket with
//                                          no kind is decided by its mark, as before

import { handProgress } from './hand-steps.mjs'

/** The ticket marks that mean an agent cannot finish the work (factory-state.mjs REVIEW). */
export const HUMAN_MARKS = Object.freeze(['no-code', 'not-codebase'])
/** Ticket states that mean the work is finished (the ticket sources, factory.mjs): such a ticket waits on no one. */
export const DONE_STATES = Object.freeze(['Accepted', 'Delivered', 'Finished', 'Rejected', 'Done', 'Closed'])
const KIND_ORDER = ['session', 'ask', 'hand', 'blocked', 'ticket']
const LINE_MAX = 140
const MARK_WHY = { 'no-code': 'Marked no code yet: it needs a decision or work from you before an agent can build it.', 'not-codebase': 'Marked not codebase work: a person, console or process task.' }

const isText = v => typeof v === 'string' && v.trim() !== ''
/** One line, cut at a word with … past LINE_MAX. */
function line(s, max = LINE_MAX) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[,;:.]$/, '')}…`
}
const latest = times => times.filter(isText).sort().pop() || ''
const live = f => f.status === 'open' || f.status === 'blocked'

/** Why a flow's by-hand work waits on the user, in one line. */
function handReason(f, marked, senior) {
  const steps = Array.isArray(f.hand?.steps) ? f.hand.steps : []
  const { done, total } = handProgress(f)
  if (senior && f.senior?.status === 'failed' && done < total) return line(`${senior} sent it back: ${f.senior.summary || 'do the unticked steps again'}`)
  if (total && done === total) return `All ${total} steps are done by you: mark the flow done.`
  if (total) return line(`${done} of ${total} done. Next: ${steps.find(s => !s.done)?.do || ''}`)
  if (f.hand?.requestedAt) return f.hand.requestError ? 'Steps asked for, but the request was not sent: ask again.' : 'Steps asked for: waiting on the agent to write them.'
  return line(`Work only you can do (${marked.join(', ')}), with no steps yet: ask the agent for them.`)
}

/** Whether a flow waits on Senior, not on the user (pipeline-hand.mjs handStage puts it at Senior): no row for it. */
function atSenior(f, senior) {
  if (!senior || (f.qa && typeof f.qa === 'object')) return false
  const s = f.senior && typeof f.senior === 'object' ? f.senior : null
  if (['passed', 'senior-failed', 'released'].includes(s?.status)) return false
  if (s?.status === 'asked' || s?.status === 'reviewing') return true
  const { done, total } = handProgress(f)
  return total > 0 && done === total
}

/** Why a blocked flow waits, in one line: its first blocked step, else the flow's own reason. */
function blockedReason(f) {
  const stuck = (f.nodes || []).find(n => n.status === 'blocked' && isText(n.title))
  if (stuck) return line(`Blocked at: ${stuck.title}`)
  return isText(f.why) ? line(`Blocked. ${f.why}`) : 'The agent marked this flow blocked.'
}

/** Ticket intake's sorts that mean a person does the work (routing-intake.mjs KINDS); `code` means an agent builds it. */
export const HUMAN_KINDS = Object.freeze(['no-code', 'needs-a-person'])
const KIND_WHY = { 'no-code': 'Sorted as no-code work: a console, a setting or a check a person does.', 'needs-a-person': 'Sorted as needing a person: a decision or an act only you can take.' }

/** Ticket rows for tickets intake sorted as no-code or needs-a-person that carry no human mark (those are rows already). */
function sortedTicketRows({ kinds, marks, tickets, covered }) {
  const rows = []
  for (const [id, kind] of Object.entries(kinds || {})) {
    if (!HUMAN_KINDS.includes(kind) || covered.has(id) || HUMAN_MARKS.includes(marks?.[id]?.review)) continue
    const t = tickets.get(id)
    if (!t || DONE_STATES.includes(t.state)) continue
    rows.push({ key: `ticket:${id}`, kind: 'ticket', ticketId: id, title: String(t.title || id), agent: '', since: '', reason: KIND_WHY[kind], sorted: kind })
  }
  return rows
}

export function humanItems({ flows = [], marks = {}, tickets = new Map(), senior = null, kinds = null, sessions = [] } = {}) {
  const items = []
  // a session stopped for the user's permission or reply (waiting.mjs standingWaits)
  for (const w of sessions) {
    const label = String(w.label || 'A session')
    items.push({ key: `session:${w.sessionId}`, kind: 'session', sessionId: String(w.sessionId), title: label, agent: label, since: w.at || '', reason: line(w.kind === 'question' ? `Asked you: ${w.reason || 'a question'}` : w.reason || 'Needs your permission to go on.'), wait: w.kind === 'question' ? 'question' : 'permission', ...(w.reply ? { reply: w.reply } : {}) })
  }
  const covered = new Set() // tickets a live (not dropped) flow carries: that flow speaks for them
  const humanMark = id => HUMAN_MARKS.includes(marks?.[id]?.review)
  for (const f of flows) {
    if (!f || f.status === 'dropped' || f.archivedAt || f.deletedAt) continue
    const ids = Array.isArray(f.tickets) ? f.tickets : []
    for (const t of ids) covered.add(t)
    if (!live(f)) continue
    const base = { flowId: f.id, title: String(f.title || f.id), agent: String(f.agent || ''), tickets: ids }
    const waiting = f.derived?.waiting || (f.nodes || []).filter(n => n.type === 'ask' && n.answer == null).map(n => n.id)
    for (const id of waiting) {
      const n = (f.nodes || []).find(x => x.id === id)
      if (!n) continue
      items.push({
        key: `ask:${f.id}:${id}`, kind: 'ask', ...base, nodeId: id, since: n.at || f.updatedAt || '',
        reason: line(f.derived?.reasons?.[id]?.text || n.why || `Part of ${f.title}`),
        ask: { title: String(n.title || ''), kind: n.kind === 'text' ? 'text' : 'yesno', yes: n.yes || '', no: n.no || '' },
      })
    }
    const marked = ids.filter(humanMark)
    if (atSenior(f, senior)) continue // it waits on Senior now, not on you (its asks above still count)
    const steps = Array.isArray(f.hand?.steps) ? f.hand.steps : []
    const isHand = steps.length > 0 || !!f.hand?.requestedAt || marked.length > 0
    if (isHand) {
      items.push({
        key: `hand:${f.id}`, kind: 'hand', ...base, since: latest([...steps.map(s => s.at), f.hand?.requestedAt]) || f.updatedAt || '',
        reason: handReason(f, marked, senior), progress: handProgress(f),
      })
    } else if (f.status === 'blocked' && !waiting.length) {
      items.push({ key: `blocked:${f.id}`, kind: 'blocked', ...base, since: f.updatedAt || '', reason: blockedReason(f) })
    }
  }
  for (const [id, mark] of Object.entries(marks || {})) {
    if (!HUMAN_MARKS.includes(mark?.review) || covered.has(id)) continue
    if (kinds?.[id] && !HUMAN_KINDS.includes(kinds[id])) continue // ticket intake sorted it as code: an agent builds it
    const t = tickets.get(id)
    if (t && DONE_STATES.includes(t.state)) continue
    items.push({
      key: `ticket:${id}`, kind: 'ticket', ticketId: id, title: String(t?.title || id), agent: mark.by && mark.by !== 'you' ? String(mark.by) : '',
      since: mark.at || '', reason: line(isText(mark.note) ? mark.note : MARK_WHY[mark.review]), mark: mark.review,
    })
  }
  items.push(...sortedTicketRows({ kinds, marks, tickets, covered }))
  items.sort((a, b) => String(b.since).localeCompare(String(a.since)) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.key.localeCompare(b.key))
  const counts = { total: items.length, ask: 0, hand: 0, blocked: 0, ticket: 0, session: 0 }
  for (const i of items) counts[i.kind]++
  return { items, counts }
}
