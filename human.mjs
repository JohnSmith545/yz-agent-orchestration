// Human review: everything in the pipeline that cannot go on without the user, and why, in ONE answer that the
// Agents page box, the rail's count and Home's line all read (human-routes.mjs GET /api/human).
//
// A row is one thing waiting on the user:
//   ask      an agent asked a question that has no answer yet (one row per open ask)
//   hand     work no agent can finish: a flow with by-hand steps recorded (hand-steps.mjs) that is not finished
//            (open or blocked), or an open flow for a ticket marked no-code or not-codebase, steps or not
//   blocked  a flow its agent marked blocked, with no open ask and no by-hand work to say more
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
//                                          by-hand work then says Senior reviews it once every step is done, and a
//                                          flow Senior sent back says why

import { handProgress } from './hand-steps.mjs'

/** The ticket marks that mean an agent cannot finish the work (factory-state.mjs REVIEW). */
export const HUMAN_MARKS = Object.freeze(['no-code', 'not-codebase'])
/** Ticket states that mean the work is finished (the ticket sources, factory.mjs): such a ticket waits on no one. */
export const DONE_STATES = Object.freeze(['Accepted', 'Delivered', 'Finished', 'Rejected', 'Done', 'Closed'])
const KIND_ORDER = ['ask', 'hand', 'blocked', 'ticket']
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
  if (total && done === total) return senior ? `All ${total} steps are done by you: ${senior} reviews them next.` : `All ${total} steps are done by you: mark the flow done.`
  if (total) return line(`${done} of ${total} done. Next: ${steps.find(s => !s.done)?.do || ''}`)
  if (f.hand?.requestedAt) return f.hand.requestError ? 'Steps asked for, but the request was not sent: ask again.' : 'Steps asked for: waiting on the agent to write them.'
  return line(`Work only you can do (${marked.join(', ')}), with no steps yet: ask the agent for them.`)
}

/** Why a blocked flow waits, in one line: its first blocked step, else the flow's own reason. */
function blockedReason(f) {
  const stuck = (f.nodes || []).find(n => n.status === 'blocked' && isText(n.title))
  if (stuck) return line(`Blocked at: ${stuck.title}`)
  return isText(f.why) ? line(`Blocked. ${f.why}`) : 'The agent marked this flow blocked.'
}

export function humanItems({ flows = [], marks = {}, tickets = new Map(), senior = null } = {}) {
  const items = []
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
    const t = tickets.get(id)
    if (t && DONE_STATES.includes(t.state)) continue
    items.push({
      key: `ticket:${id}`, kind: 'ticket', ticketId: id, title: String(t?.title || id), agent: mark.by && mark.by !== 'you' ? String(mark.by) : '',
      since: mark.at || '', reason: line(isText(mark.note) ? mark.note : MARK_WHY[mark.review]), mark: mark.review,
    })
  }
  items.sort((a, b) => String(b.since).localeCompare(String(a.since)) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.key.localeCompare(b.key))
  const counts = { total: items.length, ask: 0, hand: 0, blocked: 0, ticket: 0 }
  for (const i of items) counts[i.kind]++
  return { items, counts }
}
