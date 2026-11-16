// The Subagents page (#/subagents): every subagent the repo's sessions
// started in a window of days, from live sessions and ended ones alike, read
// from GET /api/subagents (subagent-routes.mjs) every 15 s while the page shows.
//
//   head     Subagents · N (the cards showing)
//   bar      Builders · N | Lookups · N (Builders first; the choice is remembered in this browser) and
//            the window: Today, 2 days, 3 days, 7 days
//   cards    one per subagent, newest first: its task name and state (a dot and one word: Working, Stuck,
//            Done, Stopped, Failed), then model · session · when, its worktree and branch, its tickets, its pull
//            requests with their state, and for a finished subagent the first line of its final report
//            with Report, which unfolds the whole report (Markdown, drawn escaped) and a Copy button;
//            Flow opens the flow that tells its work, and a quiet "no story" marks a builder that is
//            done, failed, stopped or stuck with no flow, or whose flow has no story or no picture (the reason
//            is in the hover); a builder still working is never marked
// A click on a card opens that subagent's live view (#/agent/<session>/<subagent>), also when its session
// has ended. A click on a link, a button or inside an open report stays on the page.
//
//   html(view)            PURE: the bar and the cards for { data, kind, days, open, error }
//   cardHtml(h, report)   PURE: one card
//   shown(subagents, kind)  PURE: the subagents of one kind
//   open() / close()      from the shell
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const KIND_KEY = 'subagents.kind' // the last filter used, in this browser
  const POLL_MS = 15_000
  const KINDS = [['builders', 'Builders'], ['lookups', 'Lookups']]
  const DAYS = [[1, 'Today'], [2, '2 days'], [3, '3 days'], [7, '7 days']]
  // A subagent's state as the dot colour it takes (styles.css .dot), its word and what it means.
  const STATE = {
    working: ['active', 'Working', 'Not finished, and its transcript was written in the last 15 minutes'],
    stuck: ['waiting', 'Stuck', 'Not finished, and nothing was written for 15 minutes or more'],
    done: ['done', 'Done', 'Handed back its final report'],
    stopped: ['waiting', 'Stopped', 'Ended without a final report; it may need resuming'],
    failed: ['blocked', 'Failed', 'Its last reply was an error'],
  }
  const PR_STATE = { open: 'open', merged: 'merged', closed: 'closed' }
  const CHECKS = { passing: 'checks passing', failing: 'checks failing', pending: 'checks running' }
  const HELP = '<p>Every subagent the sessions in this repo started, from sessions that still run and ones that have ended, read from their transcripts.</p>' +
    '<p>A <b>builder</b> worked in a worktree or made a commit. A <b>lookup</b> only read, searched or asked.</p>' +
    '<p><b>Working</b>: not finished, and its transcript was written in the last 15 minutes. <b>Stuck</b>: not finished, and silent for 15 minutes or more. ' +
    '<b>Done</b>: it handed back a final report. <b>Stopped</b>: it ended without one and may need resuming. <b>Failed</b>: its last reply was an error.</p>' +
    '<p><b>Flow</b> opens the flow that tells the work of that subagent. <b>no story</b> marks a builder that is done, failed, stopped or stuck and recorded no flow, or whose flow has no story lines or no picture.</p>' +
    '<p>Pull request states come from GitHub, read at most once a minute. Click a card to watch that subagent live.</p>'
  const S = () => window.Shell
  const when = iso => S()?.ago?.(iso) || '' // short relative time, from the shell's one helper
  const keyOf = h => `${h.sessionId}/${h.id}`
  const hashOf = h => `#/agent/${encodeURIComponent(h.sessionId)}/${encodeURIComponent(h.id)}`

  // ═══ pure ═══

  /** The subagents of one kind: builders, or everything else. */
  const shown = (subagents, kind) => (subagents || []).filter(h => (kind === 'lookups' ? !h.builder : h.builder))

  function stateChip(state) {
    const [cls, word, hint] = STATE[state] || ['idle', state, '']
    return `<span class="dot ${esc(cls)}" title="${esc(hint)}">${esc(word)}</span>`
  }

  /** One pull request: its link (a new tab), then its state and checks when GitHub gave them. */
  function prHtml(p) {
    const state = [PR_STATE[p.state], p.draft && p.state === 'open' ? 'draft' : '', p.state === 'open' ? CHECKS[p.checks] : ''].filter(Boolean)
    const safe = /^https:\/\//.test(String(p.url || '')) ? p.url : ''
    const link = safe ? `<a class="link" href="${esc(safe)}" target="_blank" rel="noopener">PR #${esc(p.number)}</a>` : `PR #${esc(p.number)}`
    return `<span class="hp-pr${p.checks === 'failing' && p.state === 'open' ? ' is-failing' : ''}">${link}${state.length ? ` <span class="hp-pr-state">${esc(state.join(' · '))}</span>` : ''}</span>`
  }

  /** A report as HTML: Markdown through the chat's renderer (which escapes everything), plain escaped text without it. */
  const reportBody = text => (window.FactoryChat?.md ? window.FactoryChat.md(text) : `<pre>${esc(text)}</pre>`)

  /** The unfolded report of a card: `report` is { loading }, { error } or { text }. */
  function reportHtml(report) {
    if (report.loading) return '<div class="hp-report"><p class="small">Reading the report…</p></div>'
    if (report.error) return `<div class="hp-report"><p class="small warn">${esc(report.error)}</p></div>`
    return `<div class="hp-report"><div class="hp-report-head"><span class="small">Final report</span><button type="button" class="link" data-hp-copy>Copy</button></div>` +
      `<div class="fc-msg ai hp-md">${reportBody(report.text)}</div></div>`
  }

  /** One card. `report` is the card's unfolded report state, or nothing while it is folded. */
  function cardHtml(h, report) {
    const key = keyOf(h)
    const session = h.parent?.live ? h.parent.label : 'ended session'
    const meta = [h.model, session, when(h.updatedAt)].filter(Boolean).map(esc).join(' · ')
    const where = [
      h.worktree ? `<span class="hp-tree" title="Worktree">${esc(h.worktree)}</span>` : '',
      h.branch ? `<span class="branch" title="Branch">${esc(h.branch)}</span>` : '',
    ].join('')
    const tickets = (h.tickets || []).map(id => `<span class="id">${esc(id)}</span>`).join(' ')
    const prs = (h.prs || []).map(prHtml).join('')
    const line = h.hasReport ? h.reportLine : h.state === 'failed' || h.state === 'stopped' ? h.lastText : ''
    // Report, then the flow that tells this work (opens it on the Flows page), then what a builder still owes its reader.
    const acts = [
      h.hasReport ? `<button type="button" class="link" data-hp-report="${esc(key)}" aria-expanded="${report ? 'true' : 'false'}">${report ? 'Hide report' : 'Report'}</button>` : '',
      h.flow ? `<button type="button" class="link" data-hp-flow="${esc(h.flow.id)}" title="${esc(h.flow.title)}">Flow</button>` : '',
      h.noStory && h.state !== 'working' ? `<span class="hp-nostory" title="${esc(h.noStory)}">no story</span>` : '',
    ].join('')
    return `<article class="card hp-card" tabindex="0" role="link" data-hp-open="${esc(hashOf(h))}" data-hp-key="${esc(key)}" aria-label="Watch ${esc(h.description)} live">
      <div class="hp-top"><h3 class="hp-name" title="${esc(h.description)}">${esc(h.description)}</h3>${stateChip(h.state)}</div>
      <p class="hp-meta">${meta}</p>
      ${where ? `<p class="hp-where">${where}</p>` : ''}
      ${tickets ? `<p class="hp-ids ids">${tickets}</p>` : ''}
      ${prs ? `<p class="hp-prs">${prs}</p>` : ''}
      ${line ? `<p class="hp-line${h.hasReport ? '' : ' is-last'}">${esc(line)}</p>` : ''}
      ${acts ? `<div class="hp-acts">${acts}</div>` : ''}
      ${report ? reportHtml(report) : ''}
    </article>`
  }

  /** How the window reads in a sentence: today, or the last N days. */
  const windowWords = days => (days > 1 ? `in the last ${days} days` : 'today')

  function barHtml({ data, kind, days }) {
    const counts = data?.counts || {}
    const seg = KINDS.map(([v, l]) => `<button type="button" data-hp-kind="${v}" aria-pressed="${v === kind}">${l} · ${Number(counts[v]) || 0}</button>`).join('')
    const pick = DAYS.map(([v, l]) => `<option value="${v}"${v === days ? ' selected' : ''}>${l}</option>`).join('')
    return `<div class="hp-bar"><div class="ob-seg" role="group" aria-label="Show">${seg}</div>` +
      `<label class="hp-days small">Window <select data-hp-days aria-label="Window">${pick}</select></label></div>`
  }

  /** The whole page for a view: { data, kind, days, open: Map of card key -> report state, error }. */
  function html(view) {
    const { data, kind = 'builders', days = 1, open, error } = view || {}
    if (!data) return `<div class="hp-page">${error ? `<div class="banner">${esc(error)}</div>` : '<p class="empty">Loading…</p>'}</div>`
    const list = shown(data.subagents, kind)
    const none = (data.subagents || []).length
      ? `No ${kind === 'lookups' ? 'lookups' : 'builders'} ${windowWords(days)}.`
      : `No subagents ${windowWords(days)}. They show here when a session starts a subagent.`
    return `<div class="hp-page">${error ? `<div class="banner">${esc(error)}</div>` : ''}${barHtml({ data, kind, days })}` +
      (list.length ? `<div class="hp-grid">${list.map(h => cardHtml(h, open?.get(keyOf(h)))).join('')}</div>` : `<p class="empty">${none}</p>`) + '</div>'
  }

  /** The filter this browser used last; Builders when there is none or storage is closed. */
  function storedKind(storage) {
    try {
      return storage?.getItem(KIND_KEY) === 'lookups' ? 'lookups' : 'builders'
    } catch {
      return 'builders'
    }
  }
  function storeKind(storage, kind) {
    try {
      storage?.setItem(KIND_KEY, kind)
    } catch {
      /* storage is closed: the choice lasts until the page reloads */
    }
  }

  // ═══ pure: Home's strip ═══

  const STRIP_RUNNING = 6 // rows for subagents still running
  const STRIP_FINISHED = 4 // rows for the latest finished ones
  const isRunning = h => h.state === 'working' || h.state === 'stuck'

  /** How many subagents have not finished: the number in the strip's head. */
  const running = subagents => (subagents || []).filter(isRunning).length

  /** The strip's rows: the subagents still running (six at most), then the latest four finished. The list comes newest first. */
  function stripRows(subagents) {
    const all = subagents || []
    return [...all.filter(isRunning).slice(0, STRIP_RUNNING), ...all.filter(h => !isRunning(h)).slice(0, STRIP_FINISHED)]
  }

  /** Home's strip for a /api/subagents answer: one link per row to that subagent live; '' when there is no subagent today. */
  function stripHtml(data) {
    const rows = stripRows(data?.subagents)
    if (!rows.length) return ''
    const more = running(data.subagents) - STRIP_RUNNING
    const row = h => {
      const pr = (h.prs || [])[0]
      const prText = pr ? `PR #${pr.number}${PR_STATE[pr.state] ? ` ${PR_STATE[pr.state]}` : ''}` : ''
      return `<a class="hp-row" href="${esc(hashOf(h))}">${stateChip(h.state)}<span class="hp-row-name">${esc(h.description)}</span>` +
        `${prText ? `<span class="hp-row-pr">${esc(prText)}</span>` : ''}<span class="hp-row-meta">${[h.model, when(h.updatedAt)].filter(Boolean).map(esc).join(' · ')}</span></a>`
    }
    return rows.map(row).join('') + (more > 0 ? `<p class="hp-row-more small">and ${more} more running</p>` : '')
  }

  const api = { html, cardHtml, shown, prHtml, storedKind, storeKind, stripRows, stripHtml, running, open() {}, close() {}, KIND_KEY }
  window.SubagentsPage = api
  if (!window.document) return

  // ═══ the page ═══

  const doc = window.document
  /** This browser's storage, or nothing when the browser refuses it. */
  const storage = () => {
    try {
      return window.localStorage
    } catch {
      return null
    }
  }
  const view = { data: null, kind: storedKind(storage()), days: 1, open: new Map(), error: '' }
  let box = null
  let showing = false
  let timer = 0
  let drawn = ''
  let entered = false

  function render() {
    if (!box || !showing) return
    const next = html(view)
    // A poll that changed nothing leaves the page alone: no flicker, and an open report keeps its scroll.
    if (next !== drawn) {
      box.innerHTML = next
      drawn = next
      if (view.data && !entered) {
        entered = true
        const grid = box.querySelector('.hp-grid')
        if (grid) window.Motion?.enterList(grid)
      }
    }
    S().setTitle('Subagents', 'subagents', view.data ? shown(view.data.subagents, view.kind).length : undefined)
    if (view.data) S().setStatus(`updated ${when(view.data.at) || 'now'}`, HELP)
  }

  async function load(force) {
    const days = view.days
    try {
      const r = await fetch(`/api/subagents?days=${days}${force ? '&refresh=1' : ''}`)
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error || 'Could not read the subagents. Try again.')
      if (days !== view.days) return // the window changed while this one loaded
      view.data = body
      view.error = ''
    } catch (e) {
      // A message the server sent on purpose is safe to show; anything else gets the plain line.
      view.error = /^[A-Z][^<>{}]{0,120}$/.test(e?.message || '') ? e.message : 'Could not read the subagents. Try again.'
      if (!view.data) S().setStatus('<span class="warn">Could not load</span>')
    }
    render()
  }

  /** Unfolds or folds one card's report; the text is fetched once, then kept while the page lives. */
  async function toggleReport(key) {
    if (view.open.has(key)) {
      view.open.delete(key)
      return render()
    }
    const [session, sub] = key.split('/')
    view.open.set(key, { loading: true })
    render()
    let state
    try {
      const r = await fetch(`/api/subagents/report?session=${encodeURIComponent(session)}&sub=${encodeURIComponent(sub)}`)
      const body = await r.json()
      state = r.ok && body.report ? { text: body.report } : { error: 'Could not read that report. Try again.' }
    } catch {
      state = { error: 'Could not read that report. Try again.' }
    }
    if (view.open.has(key)) view.open.set(key, state)
    render()
  }

  async function copyReport(button) {
    const key = button.closest('[data-hp-key]')?.dataset.hpKey
    const text = view.open.get(key)?.text
    if (!text) return
    try {
      await window.navigator.clipboard.writeText(text)
      button.textContent = 'Copied'
    } catch {
      button.textContent = 'Select the text and press Ctrl+C'
    }
  }

  function mount() {
    box = doc.getElementById('subagentsView')
    box.addEventListener('click', e => {
      const t = e.target
      const kind = t.closest('[data-hp-kind]')?.dataset.hpKind
      if (kind) {
        view.kind = kind
        storeKind(storage(), kind)
        return render()
      }
      const report = t.closest('[data-hp-report]')
      if (report) return toggleReport(report.dataset.hpReport)
      const copy = t.closest('[data-hp-copy]')
      if (copy) return copyReport(copy)
      const flow = t.closest('[data-hp-flow]')
      if (flow) return window.FlowsView?.gotoFlow ? window.FlowsView.gotoFlow(flow.dataset.hpFlow) : S().go('#/flows')
      // A link, a control or an open report keeps the click; anywhere else on the card opens the live view.
      if (t.closest('a, button, select, label, .hp-report')) return
      const card = t.closest('[data-hp-open]')
      if (card) S().go(card.dataset.hpOpen)
    })
    box.addEventListener('change', e => {
      const pick = e.target.closest('[data-hp-days]')
      if (!pick) return
      view.days = Number(pick.value) || 1
      view.data = null
      entered = false
      render()
      load(false)
    })
    box.addEventListener('keydown', e => {
      if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.matches?.('[data-hp-open]')) return
      e.preventDefault()
      S().go(e.target.dataset.hpOpen)
    })
    // The header's Refresh reads the subagents again while this page shows.
    doc.getElementById('refresh')?.addEventListener('click', () => showing && load(true))
  }

  // ═══ Home's strip ═══
  // Today's subagents on Home (#homeSubagentsZone in index.html): how many still run in the head, then the
  // rows. Polled every 30 s, only while Home shows; the zone hides while there is no subagent today.

  const STRIP_MS = 30_000
  let stripTimer = 0
  let stripDrawn = ''

  async function loadStrip() {
    const zone = doc.getElementById('homeSubagentsZone')
    if (!zone) return
    let data = null
    try {
      const r = await fetch('/api/subagents?days=1')
      if (r.ok) data = await r.json()
    } catch {
      return // the next poll tries again; the strip keeps what it showed
    }
    if (!data) return
    const next = stripHtml(data)
    zone.hidden = !next
    if (next !== stripDrawn) {
      doc.getElementById('homeSubagents').innerHTML = next
      stripDrawn = next
    }
    const count = doc.getElementById('subagentsCount')
    if (window.Motion?.countUp) window.Motion.countUp(count, running(data.subagents))
    else count.textContent = String(running(data.subagents))
  }
  function mountStrip() {
    clearInterval(stripTimer)
    loadStrip()
    stripTimer = setInterval(loadStrip, STRIP_MS)
  }
  function unmountStrip() {
    clearInterval(stripTimer)
  }
  S().onRoute(r => (r.view === 'home' ? mountStrip() : unmountStrip()))

  api.open = () => {
    showing = true
    if (!box) mount()
    drawn = ''
    render()
    if (!view.data) S().setStatus('Loading…')
    load(false)
    clearInterval(timer)
    timer = setInterval(() => load(false), POLL_MS)
  }
  api.close = () => {
    showing = false
    clearInterval(timer)
  }
})()
