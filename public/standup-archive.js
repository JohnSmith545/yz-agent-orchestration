// The words of the Standup creator's Date archive (standup-archive-view.js draws them). Pure: no DOM, no fetch.
// The archive itself is the server's (standup-archive.mjs: one file a day under data/standup/).
//
//   StandupArchive.months(days)     GET /api/standup/days → [{ key, label: 'November 2026', days: [{ day, label: 'Wed 25 Nov',
//                                   entries: [{ id, mode, kind: 'Daily' | 'Week', meta, first, failed }] }] }], newest first
//                                   meta: Daily · 10:28 · covers Tue 24 Nov
//   StandupArchive.dayName(day)     2026-11-25 → Wed 25 Nov 2026 ('' for anything that is not a day)
//   StandupArchive.summary(days)    Date archive · 12 days
//   StandupArchive.nothing(day)     the line for a day with no stand-up
//   StandupArchive.dayQuery(s)      a real YYYY-MM-DD, or ''
//   StandupArchive.ticketQuery(s)   FLA-886 from ' fla-886 ', or '' (the server checks it again)
//   StandupArchive.ticketNone(id)   the line for a ticket no stand-up mentions
//
// ⚠️ A day string is read as a LOCAL date (new Date(y, m - 1, d)), never Date.parse: '2026-11-25' alone parses as
// UTC midnight, which is the 24th in a time zone west of London.
;(() => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

  function dateOf(day) {
    const m = typeof day === 'string' ? DAY.exec(day) : null
    if (!m) return null
    const d = new Date(+m[1], +m[2] - 1, +m[3])
    return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null
  }
  const short = d => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
  const dayName = day => {
    const d = dateOf(day)
    return d ? `${short(d)} ${d.getFullYear()}` : ''
  }
  const dayQuery = s => (dateOf(String(s || '').trim()) ? String(s).trim() : '')
  const ticketQuery = s => {
    const t = String(s || '').trim().toUpperCase()
    return /^[A-Z][A-Z0-9]{0,19}-\d{1,7}$/.test(t) ? t : ''
  }

  /** A stand-up's first line as a list shows it: no leading bullet, no trailing — link (the stand-up keeps both). */
  const listLine = s => String(s || '').replace(/^-\s+/, '').replace(/\s+—\s+https?:\/\/\S+$/, '')

  const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const valid = d => d instanceof Date && !Number.isNaN(d.getTime())
  /** An entry's kind, the local time it was made and what it covers: Daily · 10:28 · covers Tue 24 Nov (QA A-3). */
  function metaOf(r) {
    const kind = r.mode === 'week' ? 'Week' : 'Daily'
    const at = new Date(r.at)
    const from = new Date(r.window?.from)
    const to = new Date(r.window?.to)
    if (!valid(at) || !valid(from)) return kind
    const covers = r.mode === 'week' && valid(to) ? `${short(from)} to ${short(to)}` : short(from)
    return `${kind} · ${hhmm(at)} · covers ${covers}`
  }

  function months(days) {
    const out = []
    for (const d of Array.isArray(days) ? days : []) {
      const date = dateOf(d?.day)
      if (!date) continue
      const key = d.day.slice(0, 7)
      let m = out.find(x => x.key === key)
      if (!m) out.push((m = { key, label: `${LONG[date.getMonth()]} ${date.getFullYear()}`, days: [] }))
      m.days.push({
        day: d.day, label: short(date),
        entries: (Array.isArray(d.runs) ? d.runs : []).map(r => ({ id: r.id, mode: r.mode, kind: r.mode === 'week' ? 'Week' : 'Daily', meta: metaOf(r), first: listLine(r.first), failed: r.ok !== true })),
      })
    }
    out.sort((a, b) => b.key.localeCompare(a.key))
    for (const m of out) m.days.sort((a, b) => b.day.localeCompare(a.day))
    return out
  }

  const summary = days => {
    const n = Array.isArray(days) ? days.length : 0
    return `Date archive · ${n} day${n === 1 ? '' : 's'}`
  }
  const nothing = day => `Nothing was saved on ${dayName(day) || day}.`
  const ticketNone = id => `No stand-up mentions ${id} yet.`

  window.StandupArchive = { months, dayName, summary, nothing, dayQuery, ticketQuery, ticketNone, dateOf }
})()
