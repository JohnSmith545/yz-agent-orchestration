// The Switchboard converter: a `list_stories` dump becomes a ticket source
// (spec 7.6), the one shape the rest of the dashboard reads. A port of the old
// tools/import-tickets.py. Only the fields the page shows are kept; descriptions,
// epics and sprint weeks are dropped.
//
// Source = { fetchedAt, me, tickets: { ID: Ticket } }
// Ticket = { id, title, state, column, owner: 'me' | 'other' | 'none', order, labels, type, url }
//
// A converter for another tracker is one more module like this one.

/** Switchboard shows a story whose state is `None` (or empty) as Unstarted. */
const stateName = s => (!s || s === 'None' ? 'Unstarted' : s)
/** A ticket id: the page renders it, so a storyId that is not one is dropped. */
const TICKET_ID = /^[A-Z]+-\d+$/
/** Text from a dump field: a string as is, a number or boolean spelled out, anything else ''. */
const asText = v => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')

/** `stories` is the parsed dump (an array); `me` is the user's Switchboard id, for owner `me`. */
export function convert(stories, me) {
  const tickets = {}
  for (const s of stories || []) {
    const id = String(s?.storyId || '').toUpperCase()
    if (!TICKET_ID.test(id)) continue
    const owners = Array.isArray(s.ownerIds) ? s.ownerIds : []
    tickets[id] = {
      id,
      title: asText(s.title),
      state: stateName(asText(s.state)),
      column: asText(s.status),
      owner: owners.length === 0 ? 'none' : owners.includes(me) ? 'me' : 'other',
      order: s.order ?? null,
      labels: Array.isArray(s.labels) ? s.labels : [],
      type: s.storyType || '',
      url: '', // the dump has no per-story link
    }
  }
  return { fetchedAt: new Date().toISOString(), me, tickets }
}
