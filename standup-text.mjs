// The Standup creator's facts in words (standup-facts.mjs gathers them):
//
//   factsText(facts, now)   the model's input on stdin: what to write, the heading and header values, then the
//                           facts in sections, capped at FACTS_MAX characters
//   readLine(facts)         the page's quiet line: Read: 9 commits, 2 merged pull requests, 14 tickets, ticket list from 12 Nov
//   leftLine(facts)         Left out: Flows (they could not be read).   or '' when nothing was
//
// Rules this file keeps:
// - The small sections come first and COMMITS last, newest first, so a cut at FACTS_MAX only ever drops the oldest
//   commits, and the text then ends with a note that says so. The model is told what was cut and what was left out.
// - Empty sections say `- None.`, so the model has nothing to pad.
// - Times are LOCAL (the server machine's), short: Tue 24 Nov 15:02. Pure: `now` is passed in.

import { dayLabel, localDay } from './standup-window.mjs'

export const FACTS_MAX = 30_000
const CUT = '\nCut here: the facts were longer than 30,000 characters, so the oldest commits were left out.'

const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const when = iso => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'at an unknown time' : `${dayLabel(d)} ${hhmm(d)}`
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const idsPart = ids => (ids?.length ? `, tickets ${ids.join(', ')}` : '')
const section = (head, lines) => `${head}\n${lines.length ? lines.join('\n') : '- None.'}`

/** Whole days between two local calendar days. */
const daysBetween = (a, b) => Math.round((Date.parse(`${localDay(b)}T00:00:00Z`) - Date.parse(`${localDay(a)}T00:00:00Z`)) / 86_400_000)

function listAge(iso, now) {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return 'not read.'
  const n = daysBetween(d, now)
  const ago = n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`
  return `${dayLabel(d)}, ${ago}. Its states may be out of date.`
}

export function factsText(f, now = new Date()) {
  const w = f.window
  const head = [
    f.mode === 'week' ? 'Write the weekly progress.' : 'Write the daily stand-up.',
    '',
    `Heading: ${w.heading}`,
    ...(f.mode === 'week' ? [`Name: ${f.name}`, `Project: ${f.project}`, `Done dates: ${w.dates}`, `Committing dates: ${w.next}`] : []),
    `Time covered: ${when(w.from)} to ${when(w.to)}, local time`,
    `Whose work: ${f.author || 'unknown'}`,
    `Default branch: ${f.base}`,
    `Ticket list saved: ${listAge(f.ticketListAt, now)}`,
  ].join('\n')
  const parts = [
    head,
    section('TICKETS (each ticket s first line, to copy exactly as given)', f.tickets.map(t => `${t.line}${t.state ? ` | state: ${t.state}` : ''}${t.known ? '' : ' | not in the saved ticket list'}`)),
    section(`MERGED PULL REQUESTS into ${f.base} (newest first)`, f.merges.map(m => `- PR #${m.number}, branch ${m.branch}, merged ${when(m.at)}${idsPart(m.ids)}`)),
    section(`NOT MERGED YET (branches with this work that ${f.base} does not have)`, f.unmerged.map(u => `- ${u.branch}: ${plural(u.commits, 'commit')}, ${u.pushed ? 'pushed' : 'not pushed'}${idsPart(u.ids)}`)),
    section('WAITING ON SOMEONE OR SOMETHING (candidates for Blockers: keep only what needs someone else)', f.waiting.map(i => `- ${i.title}: ${i.reason}${i.tickets.length ? ` Tickets ${i.tickets.join(', ')}` : ''}`)),
    section('IN PROGRESS AND YOURS in the ticket list (candidates for What s next)', f.next.map(t => `- ${t.id} [${t.state}]`)),
    section('FLOWS TOUCHED in this time (the dashboard s records of agent work)', f.flows.map(x => `- ${x.title}: ${x.status}, agent ${x.agent || 'unknown'}, updated ${when(x.updatedAt)}${idsPart(x.tickets)}`)),
    ...(f.skipped.length ? [section('LEFT OUT', f.skipped.map(s => `- ${s.title}: ${s.why}`))] : []),
    section(`COMMITS by ${f.author}, merges left out (newest first)`, f.commits.map(c => `- ${when(c.at)}${c.branch ? ` [${c.branch}]` : ''} ${c.subject}${idsPart(c.ids)}`)),
  ]
  const whole = parts.join('\n\n')
  if (whole.length <= FACTS_MAX) return whole
  const room = whole.slice(0, FACTS_MAX - CUT.length)
  return room.slice(0, room.lastIndexOf('\n')) + CUT
}

const shortDay = iso => {
  const d = new Date(iso)
  return dayLabel(d).split(' ').slice(1).join(' ')
}

export function readLine(f) {
  const list = f.ticketListAt && !Number.isNaN(Date.parse(f.ticketListAt)) ? `ticket list from ${shortDay(f.ticketListAt)}` : 'no ticket list'
  return `Read: ${plural(f.commits.length, 'commit')}, ${plural(f.merges.length, 'merged pull request')}, ${plural(f.tickets.length, 'ticket')}, ${list}`
}

export function leftLine(f) {
  if (!f.skipped.length) return ''
  return `Left out: ${f.skipped.map(s => s.title).join(', ')} (${f.skipped.length === 1 ? 'it' : 'they'} could not be read).`
}
