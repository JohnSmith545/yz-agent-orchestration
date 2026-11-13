// The Send bar, the last block of a flow's Output (flow-output.js): when the
// agent has recorded the pull request its work becomes (`flow pr`), you review
// the Output above, and this is where you send it. Nothing is sent but by this
// button and your send PIN, and the server sends only what you reviewed
// (pr-routes.mjs: the same commit and the same text, or it refuses).
//
//   not sent   feature/dark-mode → dev · 8 commits · ready            [Send to dev]
//              (blocked: the word, each reason on its own line, the button off;
//               off: the branch and the plain reason, no button)
//   review     the title · 8 commits · 4 files, the body (md, in a scroll box), the
//              commits (5, then the rest folded), the warnings, what the click does,
//              [Send PIN] [Open pull request] Cancel
//   sent       PR #12 open · checks passing · updated 2m      (merged: Merged into dev)
//   failed     the plain reason and [Try again] (which reopens the review: the PIN again);
//              pushed but no pull request: `Pushed, no pull request yet`
//
// The facts come from GET /api/flows/<id>/pr (at most every 30 s while the flow is on
// show; the server caches them 20 s), with the head commit and the digest of the text
// the POST sends back; an open pull request's state and checks from POST …/pr/refresh,
// at most once a minute. Both are kept here in memory, per flow. The PIN is read from
// its field at the click, sent once, and the field emptied: it is never kept here.
// ⚠️ Everything is escaped; the body goes only through FlowDrawer.md; a link is drawn
// only when it is https (and, for a pull request found by gh, on the same host as the
// one stored).
//
//   html(c)                  the block, or '' (c is flow-output.js's render context)
//   sig(id)                  what this bar shows beyond the flow, for flow-output.js's redraw check
//   update(flow, redraw)     load the facts or refresh the pull request when due
//   bind(root, flowOf, redraw)   the clicks (flow-output.js bind)
//   state(id)                the in-memory state of one flow's bar (the tests set it)
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const FACTS_MS = 30_000
  const REFRESH_MS = 60_000
  const LISTED = 5
  const dot = '<span class="sd-dot" aria-hidden="true">·</span>'
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

  const states = new Map()
  /** flow id -> { facts, digest, factsAt, loading, loadError, review, sending, error } */
  const state = id => {
    if (!states.has(id)) states.set(id, {})
    return states.get(id)
  }

  /** `u` as a link only when it is https (and on the host of `like`, when given); else null. */
  function safeUrl(u, like) {
    try {
      const x = new URL(String(u))
      if (x.protocol !== 'https:') return null
      if (like && new URL(String(like)).host !== x.host) return null
      return x.href
    } catch { return null }
  }
  const link = (url, label) => (url ? `<a class="sd-pr" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : `<span class="sd-pr">${esc(label)}</span>`)

  /** What the bar is about: 'none', 'sent' (a pull request stands for the record) or 'send'. */
  function kind(flow) {
    const out = flow.output || {}
    const ready = !!flow.derived?.output?.merge?.ready
    if (out.pr?.url && !ready) return 'sent'
    return out.merge && ready ? 'send' : 'none'
  }

  // ═══ markup ═══

  function sent(flow) {
    const { merge, pr } = flow.output
    const url = safeUrl(pr.url)
    const when = window.Shell.ago(pr.checkedAt || pr.openedAt)
    const updated = when ? `${dot}<span class="sd-faint">updated ${esc(when)}</span>` : ''
    if (pr.state === 'merged') return `<div class="sd-row">${link(url, `Merged into ${merge?.base || 'the base'}`)}${updated}</div>`
    if (pr.state === 'closed') return `<div class="sd-row">${link(url, `PR #${pr.number} closed`)}${updated}</div>`
    const checks = pr.checks === 'none' ? 'no checks' : `checks ${pr.checks || 'pending'}`
    return `<div class="sd-row">${link(url, `PR #${pr.number} open`)}${dot}<span class="sd-checks ck-${esc(pr.checks || 'pending')}">${esc(checks)}</span>${updated}</div>`
  }

  function review(flow, s, error) {
    // what the facts GET returned, the text its digest covers; the poll's copy may be newer than what is reviewed
    const merge = s.merge || flow.output.merge
    const f = s.facts
    const commit = x => `<li class="sd-commit"><code>${esc(String(x.sha).slice(0, 7))}</code> ${esc(x.subject)}</li>`
    const shown = f.commits.slice(0, LISTED)
    const rest = f.commits.slice(LISTED)
    return '<div class="sd-review" role="group" aria-label="Review the pull request">' +
      `<div class="sd-title-row"><h4 class="sd-title">${esc(merge.title)}</h4>` +
      `<span class="sd-faint">· ${plural(f.ahead, 'commit')} · ${plural(f.files, 'file')}</span></div>` +
      `<div class="sd-body sb-md">${window.FlowDrawer.md(merge.body)}</div>` +
      `<ol class="sd-commits">${shown.map(commit).join('')}</ol>` +
      (rest.length ? `<details class="sd-more"><summary>${plural(rest.length, 'more commit')}</summary><ol class="sd-commits">${rest.map(commit).join('')}</ol></details>` : '') +
      (f.warnings.length ? `<ul class="sd-warn">${f.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '') +
      `<p class="sd-note">This pushes <code>${esc(merge.head)}</code> to <code>${esc(f.remote)}</code> and opens a pull request into <code>${esc(merge.base)}</code>. It does not merge anything.</p>` +
      (error ? `<p class="sd-error">${esc(error)}</p>` : '') +
      '<div class="sd-acts"><input type="password" class="sd-pin" data-send-pin name="pin" autocomplete="new-password" placeholder="Send PIN" aria-label="Send PIN">' +
      `<button type="button" class="primary" data-send-go${s.sending ? ' disabled>Sending…' : '>Open pull request'}</button>` +
      `${s.sending ? '' : '<button type="button" class="link" data-send-cancel>Cancel</button>'}</div></div>`
  }

  function send(flow, s) {
    const { merge, pr } = flow.output
    const f = s.facts
    const error = s.error || pr?.error || ''
    const head = `<span class="sd-branch"><code>${esc(merge.head)}</code> → <code>${esc(merge.base)}</code></span>`
    // off (turned off, or no send PIN): set on the Settings page, not in a terminal
    if (f?.off) return `<div class="sd-row">${head}${dot}<span class="sd-faint">Sending is off</span>${dot}<a class="link" href="#/settings">Open Settings</a></div>`
    const open = f?.existingPr?.state === 'open' ? f.existingPr : null
    if (open) {
      const others = f.blockers.filter(b => !/already open/.test(b))
      return `<div class="sd-row">${head}${dot}${link(safeUrl(open.url, pr?.url), `PR #${open.number} is already open`)}</div>` +
        (others.length ? `<ul class="sd-blockers">${others.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : '')
    }
    const blocked = !!f?.blockers.length
    const reviewing = s.review && f && !blocked
    const word = !f ? (s.loadError ? '<span class="sd-state warn">could not check</span>' : '<span class="sd-faint">checking…</span>')
      : blocked ? '<span class="sd-state warn">blocked</span>'
      : pr?.pushed && !s.error ? '<span class="sd-state warn">Pushed, no pull request yet</span>'
      // a wrong PIN or a stale review is said inside the review: nothing was tried yet
      : error && !reviewing ? '<span class="sd-state warn">not sent</span>'
      : '<span class="sd-state ok">ready</span>'
    // while reviewing, the count is said once, beside the title
    const count = f && !reviewing ? `${dot}<span>${plural(f.ahead, 'commit')}</span>` : ''
    // a failure reopens the review: the PIN is typed again for every try
    const button = reviewing ? ''
      : error && f && !blocked ? '<button type="button" class="primary sd-go" data-send-open>Try again</button>'
      : `<button type="button" class="primary sd-go" data-send-open${!f || blocked ? ' disabled' : ''}>Send to ${esc(merge.base)}</button>`
    return `<div class="sd-row">${head}${count}${dot}${word}${button}</div>` +
      (blocked ? `<ul class="sd-blockers">${f.blockers.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : '') +
      (s.loadError && !f ? `<p class="sd-error">${esc(s.loadError)}</p>` : '') +
      (error && !reviewing ? `<p class="sd-error">${esc(error)}</p>` : '') +
      (reviewing ? review(flow, s, s.error) : '')
  }

  function html(c) {
    const { flow } = c
    const k = kind(flow)
    if (k === 'none') return ''
    const s = state(flow.id)
    return `<section class="ob ob-send" aria-label="Send" ${c.keyed('send', [k, flow.output.merge, flow.output.pr, sig(flow.id)])}>` +
      (k === 'sent' ? sent(flow) : send(flow, s)) + '</section>'
  }

  const sig = id => {
    const s = state(id)
    // NOT `loading`: a reload that ends with the same facts must not redraw the bar (and empty a PIN being typed)
    return JSON.stringify([s.facts, s.digest, s.merge, s.loadError, !!s.review, !!s.sending, s.error])
  }

  // ═══ loading ═══

  async function json(url, opts) {
    const r = await fetch(url, opts)
    const j = await r.json().catch(() => ({}))
    return { r, j }
  }

  /** GET the facts, the digest and the text they cover; `redraw()` once they land. */
  function load(flow, redraw) {
    const s = state(flow.id)
    s.loading = true
    s.factsAt = Date.now()
    return json(`/api/flows/${encodeURIComponent(flow.id)}/pr`).then(({ r, j }) => {
      if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
      Object.assign(s, { facts: j.facts || null, digest: j.digest || null, merge: j.merge || null, loadError: null })
      // an open pull request found for this branch was adopted: the flow carries it on the next poll
      if (j.pr?.url && !j.ready) window.FlowsView?.load()
    }).catch(e => { s.loadError = `Could not check: ${e.message}` }).finally(() => { s.loading = false; redraw() })
  }

  /**
   * Load the facts or refresh an open pull request when they are due; `redraw()` draws the bar again.
   * ⚠️ Never while the review is open: a reload there could empty a PIN being typed, or quietly move the
   * commit being approved. The review loads them once, when it opens (bind).
   */
  function update(flow, redraw) {
    const k = kind(flow)
    const s = state(flow.id)
    const now = Date.now()
    const base = `/api/flows/${encodeURIComponent(flow.id)}/pr`
    if (k === 'send' && !s.review && !s.loading && !s.sending && (!s.factsAt || now - s.factsAt > FACTS_MS)) void load(flow, redraw)
    const pr = flow.output?.pr
    if (k === 'sent' && pr.state === 'open' && now - (s.refreshedAt || 0) > REFRESH_MS) {
      s.refreshedAt = now
      void json(`${base}/refresh`, { method: 'POST' }).then(({ r }) => { if (r.ok) window.FlowsView?.load() }).catch(() => {})
    }
  }

  /** POST the send with the PIN and what was reviewed; on success the flow carries the pull request at once. */
  async function go(root, flow, redraw) {
    const s = state(flow.id)
    const merge = s.merge || flow.output?.merge
    if (!merge || s.sending || !s.facts) return
    const field = root.querySelector('[data-send-pin]')
    const pin = field?.value || ''
    if (field) field.value = ''
    if (!pin) { s.error = 'Type your send PIN.'; return redraw() }
    s.sending = true
    s.error = null
    redraw()
    try {
      const { r, j } = await json(`/api/flows/${encodeURIComponent(flow.id)}/pr`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin, confirm: { head: merge.head, sha: s.facts.sha, digest: s.digest } }),
      })
      if (!r.ok) {
        if (j.changed) Object.assign(s, { facts: null, factsAt: 0 }) // load what is there now, to review again
        if (r.status === 502) {
          // what the server stored (pr-routes.mjs failedRecord), at once: Pushed, no pull request yet, or the refusal
          const old = flow.output?.pr
          const previous = old?.url ? { ...old } : old?.previous
          flow.output = { ...flow.output, pr: { error: j.error, ...(j.pushed ? { pushed: true } : {}), ...(previous ? { previous } : {}) } }
          Object.assign(s, { error: null, review: false, factsAt: 0 })
          return
        }
        // a wrong PIN or a stale review stays in the review; anything else closes it
        const stay = r.status === 403 || r.status === 429 || j.changed
        Object.assign(s, { error: j.busy ? 'A send is already running for this flow.' : j.error || `Failed (${r.status})`, review: stay && !!s.review })
        if (j.changed && s.review) void load(flow, redraw) // review again what is there now
        return
      }
      flow.output = { ...flow.output, pr: j.pr }
      flow.derived = { ...flow.derived, output: { ...flow.derived?.output, merge: { ready: false } } }
      Object.assign(s, { review: false, facts: null, factsAt: 0, error: null, refreshedAt: Date.now() })
      window.FlowsView?.load()
    } catch (e) {
      Object.assign(s, { error: e.message, review: false, factsAt: 0 })
    } finally {
      s.sending = false
      redraw()
    }
  }

  const bound = new WeakSet()
  function bind(root, flowOf, redraw) {
    if (bound.has(root)) return
    bound.add(root)
    root.addEventListener('click', e => {
      const t = e.target
      const flow = flowOf()
      if (!flow || !t.closest) return
      const s = state(flow.id)
      if (t.closest('[data-send-open]')) {
        // the review opens on fresh facts: the commit and the text it approves are the latest
        Object.assign(s, { review: true, error: null })
        redraw()
        return load(flow, redraw)
      }
      if (t.closest('[data-send-cancel]')) { s.review = false; s.error = null; return redraw() }
      if (t.closest('[data-send-go]')) return go(root, flow, redraw)
    })
    // Enter in the PIN field sends, like the button
    root.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !e.target?.matches?.('[data-send-pin]')) return
      const flow = flowOf()
      if (flow) { e.preventDefault(); void go(root, flow, redraw) }
    })
  }

  window.FlowSend = { html, sig, update, bind, state }
})()
