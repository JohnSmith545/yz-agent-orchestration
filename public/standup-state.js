// The Standup creator's state (standup-page.js draws it). Pure: no DOM, no fetch, no clock but what events carry.
//
//   StandupState.initial()          { day, mode, busy, run, views: { daily, week }, windows, ticketListAt }
//   StandupState.reduce(state, ev)  the next state; the SAME object when the event changes nothing
//   StandupState.view(state)        what to draw for the mode shown
//   StandupState.dayLabel(date)     Tue 24 Nov, local time
//
// Events:
//   { type: 'today', today: { day, daily, week }, runs, windows, ticketListAt }   GET /api/standup/log answered
//   { type: 'mode', mode }                     the Daily | This week pill
//   { type: 'start', mode, at }                Generate pressed (`at` is the page's clock, for the Made line)
//   { type: 'facts', run, read, left, window } the stream's first line
//   { type: 'delta', run, text }               a piece of the stand-up
//   { type: 'end', run, ok, error?, runId?, cost? }
//   { type: 'show', run }                      a stand-up from the Date archive, read-only, with its date
//   { type: 'back' }                           Back to today, from an archived one
//
// Rules this file keeps:
// - "Resets every day": a view shows the stand-up of its kind made TODAY (the server's local day, `today.day`). When
//   that day changes, both views empty, except one being written. A view showing a live run or an archived one is
//   never replaced by a reload.
// - ONE stand-up is written at a time (the server answers 409 for a second): while one runs, the other view cannot
//   start one, and an archived one cannot be opened into the view being written.
// - Events carry the run number they belong to; one from an older run is dropped, so a late delta never lands.
;(() => {
  const MODES = ['daily', 'week']
  const KIND = { daily: 'Daily', week: 'This week' }
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const BUSY_HINT = 'A stand-up is being written. Wait for it to finish.'

  const blank = () => ({ output: '', error: '', read: '', left: '', runId: null, source: null, at: '', window: null, cost: null })
  const initial = () => ({ day: '', mode: 'daily', busy: null, run: 0, views: { daily: blank(), week: blank() }, windows: {}, ticketListAt: null })

  const valid = d => d instanceof Date && !Number.isNaN(d.getTime())
  const dayLabel = d => (valid(d) ? `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}` : '')
  const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

  /** A logged run as a view: what was made, when, and what it read. */
  const fromRun = (r, source) => ({
    ...blank(), output: String(r.output || ''), error: r.ok ? '' : String(r.error || ''), read: String(r.read?.line || ''), left: String(r.read?.left || ''),
    runId: r.id, source, at: String(r.at || ''), window: r.window || null, cost: typeof r.cost === 'number' ? r.cost : null,
  })

  const withView = (s, mode, v) => ({ ...s, views: { ...s.views, [mode]: v } })

  function reduce(s, ev) {
    switch (ev?.type) {
      case 'today': {
        const newDay = !!s.day && s.day !== ev.today?.day
        const views = { ...s.views }
        for (const mode of MODES) {
          const v = views[mode]
          if (s.busy === mode || ((v.source === 'live' || v.source === 'archive') && !newDay)) continue
          const id = ev.today?.[mode]
          const run = id && (ev.runs || []).find(r => r.id === id)
          views[mode] = run ? fromRun(run, 'today') : blank()
        }
        return { ...s, day: ev.today?.day || s.day, views, windows: ev.windows || s.windows, ticketListAt: ev.ticketListAt ?? s.ticketListAt }
      }
      case 'mode':
        return MODES.includes(ev.mode) && ev.mode !== s.mode ? { ...s, mode: ev.mode } : s
      case 'start': {
        if (s.busy || !MODES.includes(ev.mode)) return s
        // `before` is what the view showed: a run refused or failed before any text puts it back (QA A-2)
        const v = { ...blank(), source: 'live', at: ev.at || '', window: s.windows[ev.mode] || null, before: s.views[ev.mode] }
        return withView({ ...s, mode: ev.mode, busy: ev.mode, run: s.run + 1 }, ev.mode, v)
      }
      case 'facts':
      case 'delta':
      case 'end': {
        if (!s.busy || ev.run !== s.run) return s
        const mode = s.busy
        const v = s.views[mode]
        if (ev.type === 'facts') return withView(s, mode, { ...v, read: String(ev.read || ''), left: String(ev.left || ''), window: ev.window || v.window, started: true })
        if (ev.type === 'delta') return withView(s, mode, { ...v, output: v.output + String(ev.text ?? ''), started: true })
        const error = ev.ok ? '' : String(ev.error || 'The run stopped before it finished.')
        const { before, ...live } = v
        if (!ev.ok && !v.output) return withView({ ...s, busy: null }, mode, { ...(before || blank()), error })
        return withView({ ...s, busy: null }, mode, { ...live, error, runId: ev.runId || null, cost: typeof ev.cost === 'number' ? ev.cost : null })
      }
      case 'show': {
        const r = ev.run
        if (!r || !MODES.includes(r.mode) || s.busy === r.mode) return s
        return withView({ ...s, mode: r.mode }, r.mode, fromRun(r, 'archive'))
      }
      case 'back':
        return s.views[s.mode].source === 'archive' ? withView(s, s.mode, blank()) : s
      default:
        return s
    }
  }

  /** The line over the box: which stand-up, when it was made and what it covers. */
  function made(mode, v) {
    const at = new Date(v.at)
    // only a stand-up that has text was made: a run with nothing yet, refused or failed, made nothing (QA A-2)
    if (!v.at || !valid(at) || !v.output) return `${KIND[mode]} · not written yet today`
    const from = new Date(v.window?.from)
    const to = new Date(v.window?.to)
    const covers = !valid(from) ? '' : mode === 'daily' ? ` · Covers ${dayLabel(from)}` : ` · Covers ${dayLabel(from)}${valid(to) ? ` to ${dayLabel(to)}` : ''}`
    return `${KIND[mode]} · Made ${dayLabel(at)} ${hhmm(at)}${covers}`
  }

  function view(s) {
    const mode = s.mode
    const v = s.views[mode]
    const mine = s.busy === mode
    const busy = !!s.busy
    return {
      mode, output: v.output, busy: mine, otherBusy: busy && !mine, archived: v.source === 'archive',
      canGenerate: !busy, canCopy: !mine && !!v.output.trim(), canRetry: !busy && !!v.error,
      error: mine ? '' : v.error, read: v.read, left: v.left,
      progress: mine ? (v.started ? 'Writing…' : 'Reading your work…') : '',
      covers: s.windows[mode]?.label || '', made: made(mode, v),
      button: v.output && v.source !== 'archive' ? 'Generate again' : 'Generate',
      hint: busy && !mine ? BUSY_HINT : '',
      empty: `Press Generate to write ${mode === 'daily' ? 'today’s stand-up' : 'this week’s progress'}. It starts empty every day.`,
    }
  }

  /**
   * How long from `now` until a second after the next LOCAL midnight: when a page left open asks for today again, so
   * the new day empties both views (QA A-8). A second late, so the server's own day has surely turned too.
   */
  const msToMidnight = now => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() + 1_000

  window.StandupState = { initial, reduce, view, dayLabel, msToMidnight, KIND }
})()
