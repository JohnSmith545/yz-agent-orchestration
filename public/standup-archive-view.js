// The Standup creator's Date archive, the DOM side (the words come from standup-archive.js; the files are the
// server's, standup-archive.mjs). Under the box: every day a stand-up was saved, newest first, grouped by month,
// each day with its Daily and Week entries and their first line. A date box jumps to one day; the Ticket box lists
// every day a ticket came up, with its title, link and the lines about it.
//
//   StandupArchiveView.create(section, { onShow(run) }) → { refresh(), openDay(day, { show }), findTicket(id) }
//     onShow   an entry was picked: show that stand-up read-only. Returns false when refused (one of its kind is
//              being written), and the archive says why.
//     refresh  read GET /api/standup/days again and redraw the month list
//     openDay  GET /api/standup/day/<day> into the panel; with `show`, the day's newest good stand-up goes in the box
//     findTicket  GET /api/standup/ticket/<id> into the panel
//
// Rules it keeps:
// - ⚠️ Everything from the server is text: textContent only. A ticket link is used only when it is http(s).
// - A failed or missing answer is a quiet line, never a broken page. The day and the id are checked here AND on the
//   server before any path is built.
;(() => {
  if (!window.document) return
  const A = () => window.StandupArchive
  const REFUSED = 'Wait for this stand-up to finish first.'

  function create(section, { onShow = () => true } = {}) {
    const doc = section.ownerDocument
    const $ = id => doc.getElementById(id)
    const count = $('suArCount')
    const list = $('suArList')
    const panel = $('suArPanel')
    const note = $('suArNote')
    const dayBox = $('suDay')
    const ticketBox = $('suTicket')

    const make = (tag, cls, text) => {
      const e = doc.createElement(tag)
      if (cls) e.className = cls
      if (text != null) e.textContent = text
      return e
    }

    async function get(path) {
      try {
        const res = await window.fetch(path, { cache: 'no-store' })
        return res.ok ? await res.json() : null
      } catch {
        return null
      }
    }

    /** Fetch one day in full and show the run `id` from it (or its newest good one). */
    async function show(day, id) {
      const j = await get(`/api/standup/day/${encodeURIComponent(day)}`)
      const runs = Array.isArray(j?.runs) ? j.runs : []
      const run = id ? runs.find(r => r.id === id) : runs.find(r => r.ok) || runs[0]
      if (!run) return (note.textContent = A().nothing(day)), false
      const ok = onShow(run) !== false
      note.textContent = ok ? '' : REFUSED
      return ok
    }

    /** One entry button: Daily or Week, then its first line. */
    function entryEl(day, e) {
      const b = make('button', `su-ar-entry${e.failed ? ' su-ar-failed' : ''}`)
      b.type = 'button'
      b.append(make('span', 'su-ar-kind', e.failed ? `${e.meta || e.kind} · did not finish` : e.meta || e.kind), make('span', 'su-ar-first', e.first || '(empty)'))
      b.setAttribute('aria-label', `${e.meta || e.kind}, ${A().dayName(day)}: ${e.first}`)
      b.addEventListener('click', () => show(day, e.id))
      return b
    }

    function dayEl(d) {
      const li = make('li', 'su-ar-day')
      li.dataset.day = d.day
      li.append(make('span', 'su-ar-date', d.label))
      const entries = make('div', 'su-ar-entries')
      entries.append(...d.entries.map(e => entryEl(d.day, e)))
      li.append(entries)
      return li
    }

    async function refresh() {
      const j = await get('/api/standup/days')
      const days = Array.isArray(j?.days) ? j.days : []
      count.textContent = j ? A().summary(days).replace(/^Date archive · /, '') : ''
      if (!j) return list.replaceChildren(make('p', 'small faint su-ar-empty', 'The archive could not be read just now.'))
      if (!days.length) return list.replaceChildren(make('p', 'small faint su-ar-empty', 'No stand-ups saved yet. Each one you generate is kept here, one file a day.'))
      const months = A().months(days)
      list.replaceChildren(...months.map(m => {
        const box = make('div', 'su-ar-month')
        box.append(make('h3', 'su-ar-mh', m.label))
        const ul = make('ul', 'su-ar-days')
        ul.append(...m.days.map(dayEl))
        box.append(ul)
        return box
      }))
    }

    function openPanel(title, body) {
      const head = make('div', 'su-ar-ph')
      head.append(make('h3', 'su-ar-pt', ''))
      head.firstChild.append(...(Array.isArray(title) ? title : [title]))
      const close = make('button', 'link su-ar-close', 'Show every day')
      close.type = 'button'
      close.addEventListener('click', () => {
        panel.hidden = true
        list.hidden = false
        close.blur()
        dayBox.focus({ preventScroll: true })
      })
      head.append(close)
      panel.replaceChildren(head, ...body)
      panel.hidden = false
      list.hidden = true
    }

    async function openDay(raw, { show: alsoShow = false } = {}) {
      const day = A().dayQuery(raw)
      if (!day) return (note.textContent = 'A day looks like 2026-11-25.')
      note.textContent = ''
      dayBox.value = day
      const j = await get(`/api/standup/day/${encodeURIComponent(day)}`)
      const runs = Array.isArray(j?.runs) ? j.runs : []
      const entries = A().months([{ day, runs: runs.map(r => ({ id: r.id, mode: r.mode, ok: r.ok, at: r.at, window: r.window, first: firstOf(r) })) }])[0]?.days[0]?.entries || []
      const body = entries.length ? [entriesBox(day, entries)] : [make('p', 'small faint su-ar-empty', A().nothing(day))]
      openPanel(A().dayName(day), body)
      if (alsoShow && runs.length) {
        const run = runs.find(r => r.ok) || runs[0]
        if (onShow(run) === false) note.textContent = REFUSED
      }
    }

    const entriesBox = (day, entries) => {
      const box = make('div', 'su-ar-entries')
      box.append(...entries.map(e => entryEl(day, e)))
      return box
    }

    /** The line a day's run shows in a list: as the server's index says it (standup-archive.mjs firstLine). */
    const HEADER = /^(Stand up,|Name:|Project:|This week — done:|Done .*:$)/
    function firstOf(r) {
      const lines = String(r.output || '').split('\n').map(l => l.trim()).filter(Boolean)
      return lines.find(l => !HEADER.test(l)) || lines[0] || r.error || ''
    }

    async function findTicket(raw) {
      const id = A().ticketQuery(raw)
      if (!id) return (note.textContent = 'A ticket id looks like FLA-886.')
      note.textContent = ''
      ticketBox.value = id
      const j = await get(`/api/standup/ticket/${encodeURIComponent(id)}`)
      if (!j) return (note.textContent = 'The ticket log could not be read just now.')
      const title = [make('span', 'su-ar-id', id)]
      if (j.title) title.push(make('span', 'su-ar-ttl', `: ${j.title}`))
      const body = []
      if (/^https?:\/\//.test(j.link || '')) {
        const a = make('a', 'link su-ar-link', j.link)
        a.href = j.link
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        const p = make('p', 'small su-ar-linkline')
        p.append(a)
        body.push(p)
      }
      const days = Array.isArray(j.days) ? j.days : []
      if (!days.length) body.push(make('p', 'small faint su-ar-empty', A().ticketNone(id)))
      else {
        const ul = make('ul', 'su-ar-days')
        for (const d of days) {
          const li = make('li', 'su-ar-day')
          li.append(make('span', 'su-ar-date', A().dayName(d.day)))
          const box = make('div', 'su-ar-entries')
          for (const e of d.entries || []) {
            const b = make('button', 'su-ar-entry su-ar-hit')
            b.type = 'button'
            b.setAttribute('aria-label', `Show the ${e.mode === 'week' ? 'Week' : 'Daily'} stand-up of ${A().dayName(d.day)}`)
            b.append(make('span', 'su-ar-kind', e.mode === 'week' ? 'Week' : 'Daily'), make('span', 'su-ar-lines', (e.lines || []).join('\n') || '(named in the facts only)'))
            b.addEventListener('click', () => show(d.day, e.id))
            box.append(b)
          }
          li.append(box)
          ul.append(li)
        }
        body.push(ul)
      }
      openPanel(title, body)
    }

    dayBox.addEventListener('change', () => dayBox.value && openDay(dayBox.value))
    $('suTicketForm').addEventListener('submit', e => {
      e.preventDefault()
      findTicket(ticketBox.value)
    })

    return { refresh, openDay, findTicket }
  }

  window.StandupArchiveView = { create }
})()
