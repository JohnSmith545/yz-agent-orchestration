// Reminders (spec F5): at a local time on the days it names, the page raises a sticky
// toast and a desktop alert, once a day. There are none by default; config.example.json
// shows one (17:55 on weekdays, "Wrap up: commit or park your work.").
//
// The list comes from config.json through /api/pulse (validated in config.mjs), which
// notify.js already polls: it dispatches a `pulse` event on the document with each
// pulse, so this file needs no route and no fetch of its own.
//
// Once a day: a fired reminder is marked under `reminder.<YYYY-MM-DD>.<HH:MM>` in
// localStorage, so a reload the same day stays quiet; an in-memory Set keeps the same
// promise for this page's life when storage throws. The date is in the key, so a page
// left open overnight fires again the next day, and only from that day's HH:MM on:
// `due` looks at the current local day only, never back at yesterday's.
//
// The rule is pure (window.Reminders.due) and tested in test/reminders.test.mjs, which
// loads this file with no document: everything after it touches the page.
(() => {
  // ═══ the rule: no DOM ═══

  const DAYS = ['weekdays', 'daily']
  /** A real time of day, HH:MM from 00:00 to 23:59: the same literal as REMINDER_TIME in config.mjs (a page script cannot import it). */
  const REMINDER_TIME = /^([01]\d|2[0-3]):[0-5]\d$/
  const pad = n => String(n).padStart(2, '0')
  /** The local calendar day of `d` as YYYY-MM-DD (not toISOString, which is UTC). */
  const dayOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  /** Same shape config.mjs keeps: a malformed entry never fires, whoever built the list. */
  const valid = r => r != null && typeof r === 'object' && typeof r.at === 'string' && REMINDER_TIME.test(r.at) &&
    DAYS.includes(r.days) && typeof r.text === 'string' && r.text.trim() !== ''

  /**
   * The entries due at `now` (a Date, read in local time), each with its `key`:
   * the `days` rule holds today (weekdays = Monday to Friday), today's HH:MM has been reached
   * (HH:MM strings compare in time order), and `reminder.<today>.<at>` is not in `seen`
   * (a Set or an array of keys; never changed, a copy is used). Two entries with the same `at`
   * share one key, so only the first is returned. A list that is not an array is empty.
   */
  function due(list, now, seen) {
    if (!Array.isArray(list)) return []
    const done = new Set(seen || [])
    const today = dayOf(now)
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
    const weekday = now.getDay() >= 1 && now.getDay() <= 5
    return list
      .filter(valid)
      .filter(r => r.days === 'daily' || weekday)
      .filter(r => time >= r.at)
      .map(r => ({ at: r.at, days: r.days, text: r.text, key: `reminder.${today}.${r.at}` }))
      .filter(r => {
        // one entry per key: config.mjs already drops a repeated time; this guards a hand-built list
        if (done.has(r.key)) return false
        done.add(r.key)
        return true
      })
  }

  let started = false // start() runs once per page
  window.Reminders = { due, start }
  if (!window.document) return
  start()

  // ═══ the page ═══

  function start() {
    if (started || !window.document) return // once per page: a second call would add a second listener and interval
    started = true
    const POLL_MS = 60_000
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    const fired = new Set() // this page life, so a throwing storage still fires once
    let list = null // the last list a pulse carried; null until the first one

    // reaching window.localStorage can itself throw (blocked site data, a sandboxed frame)
    const marked = key => { try { return window.localStorage.getItem(key) != null } catch { return false } }
    const mark = (key, at) => { try { window.localStorage.setItem(key, at) } catch {} }

    function check() {
      if (!list) return
      const now = new Date()
      for (const r of due(list, now, fired)) {
        fired.add(r.key)
        if (marked(r.key)) continue // fired already today, before a reload
        mark(r.key, now.toISOString())
        window.Notifier?.toast(`<b>Reminder</b> · ${esc(r.text)}`, { kind: 'reminder', sticky: true })
        window.Notifier?.desktop?.('Reminder', r.text)
      }
    }

    document.addEventListener('pulse', e => {
      const next = e.detail?.reminders
      if (!Array.isArray(next)) return
      const firstList = list == null
      list = next
      if (firstList) check() // the page just opened: a reminder already due shows now, not a minute later
    })
    check()
    setInterval(check, POLL_MS)
  }
})()
