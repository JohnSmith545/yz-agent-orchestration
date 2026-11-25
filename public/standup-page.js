// The Standup creator (#/generators?tool=standup), the second tool on the Generators page (generators.js switches to
// it). One Opus run (POST /api/standup/generate, standup-routes.mjs) writes the stand-up the user sends every day,
// from their git work, the saved ticket list and the flows: Daily (Stand up | Blockers | What's next) or This week
// (their weekly template). Every stand-up is kept in the Date archive under the box (standup-archive-view.js).
//
// This file is the markup and the DOM glue. What to draw comes from StandupState (standup-state.js), the stream from
// StandupStream (standup-stream.js), the pills' keyboard from Generators.wirePills, Copy from ScriptCopy.
//
// - ⚠️ Model text is NEVER HTML: the box gets textContent, so a stand-up that holds <b> shows <b>. Copy copies
//   exactly that text, nothing added: the date is in it only where the format has one (the heading, the Done dates).
// - "Resets every day": each view shows today's stand-up of its kind (the server's local day), so a reload keeps it;
//   on a new day both start empty, and nothing runs until Generate is pressed.
// - Leaving the page or the tool does not stop a run: the section is only hidden. Closing the tab cuts the stream,
//   and the server then kills the model process.
// - #/generators?tool=standup&day=YYYY-MM-DD opens that day in the archive and shows its stand-up; &ticket=FLA-886
//   lists the days that ticket appeared (links for the user, and for screenshots).
//
//   window.StandupPage = { open(section, query), markup() }
;(() => {
  const S = () => window.StandupState
  const COPIED_MS = 1500

  function markup() {
    return `<div class="su-wrap">
  <p class="sc-lede small su-lede">Writes the stand-up you send each day from your git work, the saved ticket list and the flows, ready to paste into Slack or Google Chat.</p>
  <div class="su-bar">
    <div class="gen-switch su-modes" id="suModes" role="radiogroup" aria-label="Which stand-up">
      <button type="button" role="radio" data-mode="daily" aria-checked="true" tabindex="0">Daily</button><button type="button" role="radio" data-mode="week" aria-checked="false" tabindex="-1">This week</button>
    </div>
    <span class="small su-covers" id="suCovers"></span>
  </div>
  <div class="su-head">
    <span class="small su-made" id="suMade"></span>
    <span class="small faint su-progress" id="suProgress" aria-live="polite"></span>
    <span class="small su-copied" id="suCopied" role="status"></span>
    <button type="button" id="suCopy" disabled>Copy</button>
  </div>
  <div class="su-out" id="suOut" tabindex="0" role="region" aria-label="Your stand-up" aria-busy="false" data-empty=""></div>
  <div class="sc-foot su-foot">
    <button type="button" class="primary" id="suGo">Generate</button>
    <button type="button" class="link" id="suBack" hidden>Back to today</button>
    <span class="small sc-hint" id="suHint" aria-live="polite"></span>
  </div>
  <p class="small faint su-read" id="suRead" hidden></p>
  <div class="sc-error" id="suError" role="alert" hidden><i class="sc-mark" aria-hidden="true"></i><span id="suErrorText"></span><button type="button" id="suRetry">Retry</button></div>
  <section class="su-archive" id="suArchive" aria-labelledby="suArchiveHead">
    <div class="su-ar-top">
      <h2 class="su-ar-h" id="suArchiveHead">Date archive</h2>
      <span class="small faint" id="suArCount"></span>
    </div>
    <div class="su-ar-tools">
      <span class="su-ar-field"><label for="suDay" class="small">Go to a day</label><input type="date" id="suDay"></span>
      <form class="su-ar-field" id="suTicketForm" role="search"><label for="suTicket" class="small">Ticket</label><input type="search" id="suTicket" placeholder="FLA-886" autocomplete="off" spellcheck="false"><button type="submit">Find</button></form>
      <span class="small sc-hint su-ar-note" id="suArNote" aria-live="polite"></span>
    </div>
    <div class="su-ar-panel" id="suArPanel" hidden></div>
    <div class="su-ar-list" id="suArList"></div>
  </section>
</div>`
  }

  if (!window.document) {
    window.StandupPage = { open() {}, markup }
    return
  }

  const doc = window.document
  let els = null
  let state = null
  let controller = null
  let archive = null
  let copiedTimer = 0
  let drawn = null
  let home = null // the section this tool is drawn in (generators.js #standupView)

  function mount(section) {
    home = section
    section.innerHTML = markup()
    const $ = id => doc.getElementById(id)
    els = {
      modes: $('suModes'), covers: $('suCovers'), made: $('suMade'), progress: $('suProgress'), copied: $('suCopied'), copy: $('suCopy'),
      out: $('suOut'), go: $('suGo'), back: $('suBack'), hint: $('suHint'), read: $('suRead'), error: $('suError'), errorText: $('suErrorText'), retry: $('suRetry'),
    }
    state = S().initial()
    window.Generators.wirePills(els.modes, b => dispatch({ type: 'mode', mode: b.dataset.mode }))
    els.go.addEventListener('click', onGenerate)
    els.retry.addEventListener('click', onGenerate)
    els.copy.addEventListener('click', onCopy)
    els.back.addEventListener('click', () => {
      dispatch({ type: 'back' })
      refresh()
    })
    archive = window.StandupArchiveView.create($('suArchive'), { onShow })
    // "Resets every day" holds for a page left open too (QA A-8): today is asked for again when the tab comes back,
    // just after local midnight, and before each Generate (onGenerate).
    doc.addEventListener('visibilitychange', () => doc.visibilityState === 'visible' && refresh())
    setTimeout(atMidnight, S().msToMidnight(new Date()))
    paint()
  }

  function atMidnight() {
    refresh()
    setTimeout(atMidnight, S().msToMidnight(new Date()))
  }

  function dispatch(ev) {
    const before = state
    state = S().reduce(state, ev)
    if (state !== before) paint()
  }

  function paint() {
    const v = S().view(state)
    for (const b of els.modes.querySelectorAll('[role="radio"]')) {
      const on = b.dataset.mode === v.mode
      b.setAttribute('aria-checked', String(on))
      b.tabIndex = on ? 0 : -1
    }
    els.covers.textContent = v.covers
    els.made.textContent = v.made
    els.made.classList.toggle('su-archived', v.archived)
    els.progress.textContent = v.progress
    const key = `${v.mode}\u0000${v.output}`
    if (drawn !== key) {
      const box = els.out
      const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 24
      box.textContent = v.output // ⚠️ text only, never HTML
      if (pinned && v.busy) box.scrollTop = box.scrollHeight // follow the stream unless the user scrolled up
      drawn = key
    }
    els.out.dataset.empty = v.empty
    els.out.setAttribute('aria-busy', String(v.busy))
    els.copy.disabled = !v.canCopy
    els.go.textContent = v.button
    els.go.disabled = !v.canGenerate
    els.hint.textContent = v.hint
    els.back.hidden = !v.archived
    const read = [v.read, v.left].filter(Boolean)
    els.read.hidden = !read.length
    els.read.replaceChildren(...read.map(t => Object.assign(doc.createElement('span'), { textContent: t })))
    els.error.hidden = !v.error
    els.errorText.textContent = v.error
    els.retry.hidden = !v.canRetry
  }

  /** The status chip and its ? help: the cost, what it reads, and how old the ticket list is. */
  function status() {
    const at = state.ticketListAt ? new Date(state.ticketListAt) : null
    const ok = at && !Number.isNaN(at.getTime())
    const days = ok ? Math.max(0, Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000)) : 0
    const old = !ok ? 'There is no saved ticket list, so titles come from your commits and flows.'
      : `The saved ticket list is from <b>${S().dayLabel(at)}</b>${days > 1 ? `, ${days} days old` : days === 1 ? ', a day old' : ', today'}: its states can be out of date. Refresh it on the Tickets page.`
    window.Shell.setStatus(`Opus 5.5 · medium effort${ok ? ` · tickets from ${S().dayLabel(at)}` : ''}`,
      '<p>Each <b>Generate</b> is one Claude Code run on Opus 5.5 at medium effort, with no tools and none of your settings, about 11 cents a run (measured). It is billed to your Claude account and counted in <b>Spend today</b> as Standup creator.</p>' +
      '<p>It reads your git work (your commits on every branch, the pull requests merged into dev with your work, and your branches not merged yet), the saved ticket list and the dashboard’s flows and what waits on you. Nothing is sent to Switchboard. ' + old + '</p>' +
      '<p><b>Daily</b> covers the last working day until now; <b>This week</b> the last seven days. Both start empty each day. Every stand-up is kept in the <b>Date archive</b> under the box, one file a day in <code>data/standup/</code>; find a day with the date box, or every day a ticket came up with the Ticket box.</p>')
  }

  async function refresh() {
    let j = null
    try {
      const res = await window.fetch('/api/standup/log', { cache: 'no-store' })
      if (res.ok) j = await res.json()
    } catch {
      j = null
    }
    if (j && j.today) dispatch({ type: 'today', today: j.today, runs: Array.isArray(j.runs) ? j.runs : [], windows: j.windows || {}, ticketListAt: j.ticketListAt ?? null })
    // now with the ticket list's date; ⚠️ only while this tool shows: a refresh from the tab coming back or from
    // midnight must not write over another page's status chip
    if (home && !home.closest('[hidden]')) status()
    archive.refresh()
  }

  async function onGenerate() {
    if (!S().view(state).canGenerate) return
    await refresh() // a new day empties the other view first; this run is today's either way
    const v = S().view(state)
    if (!v.canGenerate) return
    clearTimeout(copiedTimer)
    els.copied.textContent = ''
    const ctl = new AbortController()
    controller = ctl
    dispatch({ type: 'start', mode: v.mode, at: new Date().toISOString() })
    const run = state.run
    els.out.scrollTop = 0
    const out = await window.StandupStream.generate(v.mode, {
      signal: ctl.signal,
      onFacts: f => dispatch({ type: 'facts', run, read: f.read, left: f.left, window: f.window }),
      onDelta: t => dispatch({ type: 'delta', run, text: t }),
    })
    if (controller === ctl) controller = null
    dispatch({ type: 'end', run, ok: out.type === 'done', error: out.error, runId: out.run, cost: out.cost })
    window.Spend?.refresh?.() // the rail's spend chip shows this run's cost
    archive.refresh()
  }

  /** A stand-up from the archive: shown read-only with its date. Refused (false) while one of its kind is written. */
  function onShow(run) {
    if (S().reduce(state, { type: 'show', run }) === state) return false
    dispatch({ type: 'show', run })
    els.out.scrollTop = 0
    els.out.scrollIntoView?.({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    els.out.focus({ preventScroll: true })
    return true
  }

  async function onCopy() {
    const v = S().view(state)
    if (!v.canCopy) return
    const ok = await window.ScriptCopy.copy(v.output) // the stand-up exactly as shown, nothing added
    clearTimeout(copiedTimer)
    els.copied.textContent = ok ? 'Copied' : 'Could not copy. Select the text instead.'
    copiedTimer = setTimeout(() => (els.copied.textContent = ''), COPIED_MS)
  }

  async function open(section, query = {}) {
    if (!els) mount(section)
    status()
    await refresh()
    if (query.day) archive.openDay(query.day, { show: true })
    else if (query.ticket) archive.findTicket(query.ticket)
  }

  window.StandupPage = { open, markup }
})()
