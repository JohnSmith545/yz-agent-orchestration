// The Pull requests list on the page, the pure half (the DOM half is prlist.js): a list that fades into fog.
// Every pull request an agent opened for a flow and that is still open, newest first (GET /api/prs,
// prlist-items.mjs), drawn as plain text with no numbers and no bullets:
//
//   Pull requests  ?
//   Dark mode for the settings page, with the system theme as the default   acme/shop #12
//   Agent 1 · opened 2h · ● checks passing · ready for you to merge · Open the flow
//   Retry the wearables sync when Garmin answers 4…      (a little smaller, shorter, fainter)
//    Club leaderboards load in one requ…                  (smaller, shorter, fainter again)
//     Fix the onboarding step tha…
//      Alerts post to a Goo…
//      and 2 more
//
// ═══ THE FOG ═══ Each place down the list is one step of FOG: the type a little smaller, less of the title shown
// (cut with an ellipsis), the text fainter (opacity 1, 0.62, 0.38, 0.22, 0.12), and a mask that thins the text out
// towards the end of the line (prlist.css). A mask fades to transparent, so the fog is always the page's own
// background showing through, in light and dark alike, never a fixed colour. Hover or keyboard focus brings an item
// into full view. The fog is VISUAL ONLY: each link holds the whole title (the CSS cuts it, a screen reader reads it
// all, and it is in the link's title too), the list is a plain <ul> in order, and nothing is aria-hidden.
// ⚠️ FOG MUST CHANGE IN LOCKSTEP with the [data-fog] rules in prlist.css (test/prlist-view.test.mjs checks both).
//
// ═══ THE MOVE UP ═══ When the first leaves (merged, closed or Completed), it fades up and out while the rest slide
// up one place, each growing to its new step, over MOVE_MS; a new pull request arrives at the top with a short
// fade in. change() and motionPlan() say what moves; prlist.js does it. Reduced motion: no slide, no fade.
//
//   FOG, fogStep(i), plan(items, { open, max }), blockHtml(data, { open, now, where }), metaWords(item, now),
//   change(prevKeys, nextKeys), motionPlan(prevKeys, nextKeys, { reduced }), scaleFrom(fromIndex, toIndex), HELP
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const MAX = 5
  const MOVE_MS = 400

  /** The steps, first to last: opacity, type size (px) and how much of the title shows (ch, 0 for all of it). */
  const FOG = Object.freeze([
    Object.freeze({ opacity: 1, size: 15, ch: 0 }),
    Object.freeze({ opacity: 0.62, size: 14, ch: 58 }),
    Object.freeze({ opacity: 0.38, size: 13.5, ch: 44 }),
    Object.freeze({ opacity: 0.22, size: 13, ch: 32 }),
    Object.freeze({ opacity: 0.12, size: 12.5, ch: 22 }),
  ])
  const fogStep = i => FOG[Math.max(0, Math.min(Number(i) || 0, FOG.length - 1))]

  const HELP = '<p>Every pull request an agent opened for a flow and that is still open on GitHub, the newest first. ' +
    'Click a title to open it on GitHub, or Open the flow for the work behind it.</p>' +
    '<p>The newest is clear; each one under it is a little smaller and fades further, so the eye lands on the one to look at now. ' +
    'Point at a faded one, or reach it with the keyboard, and it comes back into full view.</p>' +
    '<p>A pull request leaves the list when it is merged or closed on GitHub (within about a minute), or when you mark its flow <b>Completed</b>. ' +
    'The next one then moves up.</p>'

  /** How long ago, short (`now`, `3m`, `2h`, `5d`): Shell.ago, the one relative-time helper every page uses. */
  const since = (iso, now) => window.Shell?.ago?.(iso, now) || ''

  /** `u` when it is a plain https link, else null: only those are drawn as links (and it is escaped all the same). */
  const safeUrl = u => (/^https:\/\/[^\s"'<>\\]+$/i.test(String(u ?? '')) ? String(u) : null)

  /** What shows: the first `max` (all when the more line is opened), and how many more there are. */
  function plan(items, { open = false, max = MAX } = {}) {
    const list = Array.isArray(items) ? items : []
    return open ? { shown: list, more: 0 } : { shown: list.slice(0, max), more: Math.max(0, list.length - max) }
  }

  const CHECKS = { passing: 'checks passing', failing: 'checks failing', running: 'checks running', none: 'no checks' }
  const NEEDS = { review: 'waiting for your review', merge: 'ready for you to merge' }

  /** The small line's words: agent, when it opened, draft, checks, then what it needs of you (or that it is the last known state). */
  function metaWords(item, now = Date.now()) {
    const words = []
    if (item?.agent) words.push(String(item.agent))
    const when = since(item?.openedAt, now)
    if (when) words.push(`opened ${when}`)
    if (item?.draft) words.push('draft')
    if (CHECKS[item?.checks]) words.push(CHECKS[item.checks])
    if (NEEDS[item?.needs]) words.push(NEEDS[item.needs])
    if (item?.stale) words.push('last known state')
    return words
  }
  /** The checks word drawn as the page's own state dot (styles.css .dot): green, red, the accent breathing, grey. */
  const DOT = { 'checks passing': 'yes', 'checks failing': 'blocked', 'checks running': 'testing', 'no checks': 'idle' }
  const wordHtml = w => (DOT[w] ? `<span class="dot ${DOT[w]}">${esc(w)}</span>` : Object.values(NEEDS).includes(w) ? `<span class="prl-needs">${esc(w)}</span>` : `<span>${esc(w)}</span>`)

  function itemHtml(item, i, now) {
    const url = safeUrl(item.url)
    const title = String(item.title || item.label || 'Pull request')
    const name = url
      ? `<a class="prl-title" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(title)}</a>`
      : `<span class="prl-title" title="${esc(title)}">${esc(title)}</span>`
    // the link names its flow for a screen reader: five `Open the flow` in a row would say nothing apart
    const flowLink = item.flow?.id ? `<a class="link prl-flow" href="#/flows?flow=${encodeURIComponent(item.flow.id)}" aria-label="Open the flow: ${esc(item.flow.title || title)}">Open the flow</a>` : ''
    // each word group carries the dot after it, so a line on a narrow screen ends with one and never starts with one
    const list = metaWords(item, now)
    const words = list.map((w, n) => `<span class="prl-w">${wordHtml(w)}${n < list.length - 1 ? '<span class="prl-sep">·</span>' : ''}</span>`).join('')
    const step = Math.min(i, FOG.length - 1)
    return `<li class="prl-item${item.needs ? ' is-needs' : ''}" data-fog="${step}" data-prl-key="${esc(item.key || item.url || '')}">` +
      `<div class="prl-line">${name}${item.label ? `<span class="prl-tag">${esc(item.label)}</span>` : ''}</div>` +
      `<div class="prl-meta"><span class="prl-words">${words}</span>${flowLink}</div></li>`
  }

  /** The whole block, or '' when there is nothing to show (then the slot hides). `where` keeps the ids apart. */
  function blockHtml(data, { open = false, now = Date.now(), where = 'agents' } = {}) {
    const items = Array.isArray(data?.items) ? data.items : []
    if (!items.length) return ''
    const { shown, more } = plan(items, { open })
    const head = `prlHead-${esc(where)}`
    const toggle = more
      ? `<button type="button" class="prl-more" data-prl-more aria-expanded="false">and ${more} more</button>`
      : items.length > MAX ? '<button type="button" class="prl-more" data-prl-more aria-expanded="true">Show fewer</button>' : ''
    const last = since(data.checkedAt, now)
    const note = data.problem ? `<p class="prl-note" role="status">${esc(data.problem)}${last ? ` <span class="prl-sep">·</span> last read ${last}` : ''}</p>` : ''
    return `<section class="prl" aria-labelledby="${head}">` +
      `<div class="prl-head"><h2 class="prl-h" id="${head}">Pull requests</h2><button type="button" class="help" aria-label="About the pull request list">?</button></div>` +
      `<ul class="prl-list">${shown.map((it, i) => itemHtml(it, i, now)).join('')}</ul>${toggle}${note}</section>`
  }

  /** What changed between two lists of keys: who left, who entered, and each kept one's place before and after. */
  function change(prevKeys, nextKeys) {
    const prev = Array.isArray(prevKeys) ? prevKeys : []
    const next = Array.isArray(nextKeys) ? nextKeys : []
    return {
      left: prev.filter(k => !next.includes(k)),
      entered: next.filter(k => !prev.includes(k)),
      kept: next.filter(k => prev.includes(k)).map(key => ({ key, from: prev.indexOf(key), to: next.indexOf(key) })),
    }
  }

  /** How to go from one list to the next: `redraw` (reduced motion, the first draw, nothing moved) or `animate`. */
  function motionPlan(prevKeys, nextKeys, { reduced = false } = {}) {
    const c = change(prevKeys, nextKeys)
    const moved = c.left.length || c.entered.length || c.kept.some(k => k.from !== k.to)
    if (reduced || !(prevKeys || []).length || !moved) return { mode: 'redraw', ...c }
    return { mode: 'animate', ms: MOVE_MS, ...c }
  }

  /** The scale a kept item starts from so it seems to grow (or shrink) from its old step to its new one. */
  const scaleFrom = (from, to) => fogStep(from).size / fogStep(to).size

  window.PrListView = { FOG, fogStep, plan, blockHtml, metaWords, change, motionPlan, scaleFrom, HELP, MOVE_MS }
})()
