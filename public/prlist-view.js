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
// ═══ THE MOVE UP ═══ When the first leaves (merged, closed or Completed), it fades up and out in LEAVE_MS, and only
// then do the rest slide up one place, each growing to its new step: the whole move takes MOVE_MS. ⚠️ The rest wait
// for the leave on purpose: rising while the old one still shows drew its title across the new first one (QA,
// 2026-11-26). An item that ENTERS (a new pull request at the top, or the one behind `and N more` that moves up into
// the 5th row) fades in only once every kept item has arrived (enterAt, then ENTER_MS): ⚠️ entering at once drew it
// in the very row the old 5th item was still leaving, and the titles overprinted, plainly so with that row hovered
// or focused (QA, frame by frame, 2026-11-26). The fade is opacity only, so it never slides into the row above.
// frameAt() says where each item is and how visible at any moment of the move, so the tests can walk it frame by
// frame and check that no two visible items ever overlap. change() and motionPlan() say what moves; prlist.js does
// it with the same numbers. Reduced motion: no slide, no fade.
//
//   FOG, fogStep(i), plan(items, { open, max }), blockHtml(data, { open, now, where }), metaWords(item, now),
//   change(prevKeys, nextKeys), motionPlan(prevKeys, nextKeys, { reduced }), scaleFrom(fromIndex, toIndex), HELP,
//   frameAt(plan, before, after, t, { focus })
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const MAX = 5
  const MOVE_MS = 420
  const LEAVE_MS = 140
  const ENTER_MS = 200

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
    // ms: the whole move; leaveMs: the fade of the one that left; delay: how long the rest wait before they rise;
    // metaAt and metaMs: when and how fast the NEW first item's small line fades in. It waits for the second half of
    // the rise: drawn at once, it lay across the item under it while both still stood at their old places.
    const delay = c.left.length ? LEAVE_MS : 0
    const half = Math.round((MOVE_MS - delay) / 2)
    // enterAt and enterMs: an item that enters waits until the kept ones have all arrived (or, when none moves, until
    // the leaving copy is gone), then fades in; endMs: when the whole move is over (prlist.js cleans up then)
    const anyMoves = c.kept.some(k => k.from !== k.to)
    const enterAt = c.entered.length ? (anyMoves ? MOVE_MS : delay) : 0
    const enterMs = c.entered.length ? ENTER_MS : 0
    return {
      mode: 'animate', ms: MOVE_MS, leaveMs: LEAVE_MS, delay, metaAt: delay + half, metaMs: MOVE_MS - delay - half,
      enterAt, enterMs, endMs: Math.max(MOVE_MS, enterAt + enterMs), ...c,
    }
  }

  /** The scale a kept item starts from so it seems to grow (or shrink) from its old step to its new one. */
  const scaleFrom = (from, to) => fogStep(from).size / fogStep(to).size

  /** The page's easing (prlist.css --prl-ease, cubic-bezier(.2, .7, .2, 1)): progress for a share of the time. */
  function ease(x) {
    if (x <= 0) return 0
    if (x >= 1) return 1
    const curve = (a, b, s) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3
    let lo = 0
    let hi = 1
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (curve(0.2, 0.2, mid) < x) lo = mid
      else hi = mid
    }
    return curve(0.7, 1, (lo + hi) / 2)
  }
  const lerp = (a, b, q) => a + (b - a) * q

  /**
   * Where every item is, and how visible, `t` ms into a move: [{ key, top, bottom, opacity }], from the rows before
   * and after ({ key: { top, height, fog } }). The leaving copy fades and lifts in leaveMs; a kept item waits `delay`
   * and then eases from its old row to its new one; an entering item is invisible until enterAt and fades in over
   * enterMs. `focus` is an item under the pointer or the keyboard: it is shown in full (opacity 1) while visible.
   */
  function frameAt(p, before, after, t, { focus } = {}) {
    const seen = (key, o) => (key === focus && o > 0 ? 1 : o)
    const out = []
    // the leaving copy lifts a little only from the FIRST row (nothing above it); lower down it fades where it is,
    // since lifting would carry it into the row above (prlist.css .prl-ghost.is-top)
    const firstTop = Math.min(...Object.values(before).map(r => r.top))
    for (const key of p.left || []) {
      const b = before[key]
      if (!b) continue
      const q = Math.min(1, t / p.leaveMs)
      const top = b.top - (b.top === firstTop ? 6 * q : 0)
      out.push({ key, top, bottom: top + b.height, opacity: t >= p.leaveMs ? 0 : seen(key, fogStep(b.fog).opacity * (1 - q)) })
    }
    for (const k of p.kept || []) {
      const b = before[k.key]
      const a = after[k.key]
      if (!a || !b) continue
      const q = t <= p.delay ? 0 : ease((t - p.delay) / (p.ms - p.delay))
      const top = lerp(b.top, a.top, q)
      out.push({ key: k.key, top, bottom: top + lerp(b.height, a.height, q), opacity: seen(k.key, lerp(fogStep(b.fog).opacity, fogStep(a.fog).opacity, q)) })
    }
    for (const key of p.entered || []) {
      const a = after[key]
      if (!a) continue
      const q = t < p.enterAt ? 0 : Math.min(1, (t - p.enterAt) / (p.enterMs || 1))
      out.push({ key, top: a.top, bottom: a.top + a.height, opacity: q > 0 ? seen(key, fogStep(a.fog).opacity * q) : 0 })
    }
    return out
  }

  window.PrListView = { FOG, fogStep, plan, blockHtml, metaWords, change, motionPlan, scaleFrom, frameAt, HELP, MOVE_MS }
})()
