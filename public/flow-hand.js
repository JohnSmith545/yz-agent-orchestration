// "Do this by hand": an opened flow's by-hand steps as a checklist near the top, above the views (flows.js puts it
// in its own slot, so it shows on Output, Explain, Status and Process alike). The steps are what an agent wrote with
// `flow hand-step` (hand-steps.mjs) for work no agent can do; the ticks are the user's, saved on the flow
// (POST /api/flows/<id>/hand), so they survive a reload and an agent's rewrite.
//
//   Do this by hand · 2 of 5 done                                   [Mark the flow done]   (once every step is ticked)
//   Senior sent this back. The token went to prod, not dev.          (a failed Senior review, flow-senior.mjs)
//   [x] 1  Add the deploy secret
//          Why: the deploy job reads it
//          Where: GitHub › Settings › Secrets and variables › Actions
//          ┌ FIREBASE_TOKEN ──────────┐ Copy
//          You should see: FIREBASE_TOKEN is listed
//
// A flow that needs the user (Human review lists it as by-hand work: a ticket marked no-code or not-codebase, or a
// request already made) but has no steps gets an honest empty state with ONE button, Ask the agent for steps, on the
// same relay path as Request test steps (POST request-hand). The page never invents a step. An archived or deleted
// flow shows its steps with the ticks fixed and no buttons (archive.css, flows.js).
// With Senior on the pipeline (pipeline.senior) a flow whose steps are all ticked waits at Senior (its progress says
// so): instead of Mark the flow done the head says Senior reviews it next (the server refuses done until Senior
// passed it: flow-senior.mjs seniorHolds). A flow Senior sent back shows its verdict at the top, and each step it
// named to redo says Do again. While Senior holds the flow (flow-senior.mjs, status due, asked, reviewing or failed)
// the head offers Finish without Senior: the user's ONE way to lift the hold besides Senior's pass (no agent command
// can). It asks once more inline, then posts POST /api/flows/<id>/senior-release; the scorecard counts such a flow
// slipped through. A refused tick, finish or release is said inline under the head (QA B-7: no native alert).
//
//   html(f, { needs, readonly, now, releasing, refused })   PURE: the block, or '' when there is nothing to show;
//                                       releasing: the inline question before a release; refused: the last refusal
//   fill(el, f, opts)                   draw into the slot, only when the markup changed, keeping the focus
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const enc = encodeURIComponent
  const FRESH_MS = 30 * 60_000 // a request reads as asked this long, like the test steps' request (flow-output.js)

  // ═══ pure ═══

  /** How the request for steps reads: not sent (with why), asked 3m while fresh, else nothing. */
  function asked(hand, now) {
    const t = Date.parse(hand?.requestedAt || '')
    if (!Number.isFinite(t)) return null
    if (hand.requestError) return { text: 'Not sent', why: hand.requestError }
    if (now - t > FRESH_MS) return null
    return { text: `Asked ${window.Shell?.ago(hand.requestedAt, now) || ''}`.trim(), why: '' }
  }

  /** Senior's failed verdict, when the work was sent back to the user (flow-senior.mjs). */
  const redoOf = f => (f?.senior?.status === 'failed' ? f.senior : null)
  /** Senior's step when it is the flow's current one (flow-route.mjs progress): the flow waits at Senior. */
  const atSenior = f => (Array.isArray(f?.progress) ? f.progress : []).find(s => s.state === 'current' && s.role === 'senior') || null

  function step(f, s, i, readonly) {
    const id = esc(s.id)
    const done = !!s.done
    const again = !done && (redoOf(f)?.redo || []).includes(s.id) ? '<span class="fh-again">Do again</span>' : ''
    const field = (label, v) => (v ? `<p class="fh-field"><span class="fh-k">${label}</span> ${esc(v)}</p>` : '')
    const copy = s.copy
      ? `<div class="fh-copy"><pre class="fh-copy-v" id="fh-copy-${id}">${esc(s.copy)}</pre><button type="button" class="fh-copy-b" data-hand-copy="${id}" aria-describedby="fh-copy-${id}">Copy</button></div>`
      : ''
    return `<li class="fh-step${done ? ' is-done' : ''}" data-hand-step="${id}">` +
      `<input type="checkbox" class="fh-tick" id="fh-tick-${id}" data-hand-tick="${id}"${done ? ' checked' : ''}${readonly ? ' disabled' : ''}>` +
      `<div class="fh-body"><label class="fh-do" for="fh-tick-${id}"><span class="fh-n">${i + 1}</span>${esc(s.do)}${again}</label>` +
      field('Why:', s.why) + field('Where:', s.where) + copy +
      `<p class="fh-field fh-expect"><span class="fh-k">You should see:</span> ${esc(s.expect)}</p></div></li>`
  }

  /** Senior holds the flow, and the user may still finish it without Senior's review (human-routes.mjs). */
  const holds = (f, readonly) => {
    if (readonly || f?.status === 'done' || f?.status === 'dropped' || (f?.qa && typeof f.qa === 'object')) return false
    if (['due', 'asked', 'reviewing', 'failed'].includes(f?.senior?.status)) return true
    // a flow written before the hold was recorded: it has steps and its route plans Senior (flow-route.mjs)
    return !f?.senior && (f?.hand?.steps || []).length > 0 && (f?.progress || []).some(s => s.role === 'senior')
  }
  /** The release control: a quiet link, then the inline question that posts it. */
  const releaseHtml = releasing => (releasing
    ? '<p class="fh-release-ask" role="alert">Finish it with no Senior review? It counts as slipped through on the scorecard. ' +
      '<button type="button" class="primary" data-hand-release-yes>Finish</button> <button type="button" class="link" data-hand-release-no>Cancel</button></p>'
    : '')
  const releaseLink = '<button type="button" class="link fh-release" data-hand-release>Finish without Senior</button>'

  function html(f, { needs = false, readonly = false, now = Date.now(), releasing = false, refused = '' } = {}) {
    const steps = Array.isArray(f?.hand?.steps) ? f.hand.steps : []
    const req = asked(f?.hand, now)
    const held = holds(f, readonly)
    if (!steps.length && !needs && !f?.hand?.requestedAt && !held) return ''
    const head = n => `<div class="fh-head"><h3 class="fh-h" id="fh-h-${esc(f.id)}" tabindex="-1">Do this by hand${n}</h3>`
    const notes = (held ? releaseHtml(releasing) : '') + (refused ? `<p class="fh-refused" role="alert">${esc(refused)}</p>` : '')
    if (!steps.length) {
      const state = req ? `<span class="fh-asked${req.why ? ' is-bad' : ''}"${req.why ? ` title="${esc(req.why)}"` : ''}>${esc(req.text)}</span>` : ''
      return `<section class="fh fh-empty" aria-labelledby="fh-h-${esc(f.id)}">${head('')}${held && !releasing ? releaseLink : ''}</div>${notes}` +
        '<p class="fh-none">This is work only you can do, and the agent has not written the steps yet.</p>' +
        `<div class="fh-acts"><button type="button" class="primary" data-hand-ask>Ask the agent for steps</button>${state}</div></section>`
    }
    const done = steps.filter(s => s.done).length
    const all = done === steps.length
    const senior = atSenior(f)
    const finish = all && f.status !== 'done' && f.status !== 'dropped' && !readonly
      ? senior ? `<span class="fh-next">${esc(senior.label || 'Senior')} reviews it next: send ${esc(senior.label || 'Senior')} a message naming flow ${esc(f.id)}.</span>` : '<button type="button" class="primary" data-hand-done>Mark the flow done</button>' : ''
    const back = redoOf(f)
    const redo = back ? `<p class="fh-redo" role="note"><b>${esc(back.by || 'Senior')} sent this back.</b> ${esc(back.summary || 'Do the unticked steps again.')}</p>` : ''
    return `<section class="fh${all ? ' is-all' : ''}" aria-labelledby="fh-h-${esc(f.id)}">${head(` <span class="faint">· ${done} of ${steps.length} done</span>`)}${finish}${held && !releasing ? releaseLink : ''}</div>` +
      `${notes}${redo}<ol class="fh-steps">${steps.map((s, i) => step(f, s, i, readonly)).join('')}</ol></section>`
  }

  // ═══ the slot ═══

  const shown = new WeakMap() // el -> { flow, html, opts }
  const bound = new WeakSet()
  const asides = new WeakMap() // el -> { flowId, releasing, refused }: the inline question and the last refusal

  function fill(el, f, opts = {}) {
    if (!el) return
    bind(el)
    const side = asides.get(el)
    const mine = side && side.flowId === f?.id ? side : { flowId: f?.id, releasing: false, refused: '' }
    asides.set(el, mine)
    const markup = f ? html(f, { ...opts, releasing: mine.releasing, refused: mine.refused }) : ''
    const prev = shown.get(el)
    shown.set(el, { flow: f, html: markup, opts })
    if (prev?.html === markup) return
    const a = el.ownerDocument?.activeElement
    const keep = a && el.contains(a) ? [...a.attributes].find(x => /^data-hand-/.test(x.name)) : null
    el.innerHTML = markup
    el.hidden = !markup
    if (keep) el.querySelector(`[${keep.name}${keep.value ? `="${CSS.escape(keep.value)}"` : ''}]`)?.focus()
  }

  async function call(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      return { ok: r.ok, j: await r.json().catch(() => ({})), status: r.status }
    } catch (e) {
      return { ok: false, j: { error: e?.message || String(e) }, status: 0 }
    }
  }
  /** Say a refusal inline under the head (or clear it with ''), and draw the block again. */
  const aside = (el, change) => {
    const s = shown.get(el)
    Object.assign(asides.get(el) || {}, change)
    if (s?.flow) fill(el, s.flow, s.opts)
  }
  const refusal = r => r.j?.error || `Failed (${r.status})`
  const reload = () => {
    window.FlowsView?.load()
    window.HumanReview?.refresh()
  }

  function bind(el) {
    if (bound.has(el)) return
    bound.add(el)
    el.addEventListener('change', async e => {
      const box = e.target.closest?.('[data-hand-tick]')
      const f = shown.get(el)?.flow
      if (!box || !f || box.disabled) return
      const r = await call(`/api/flows/${enc(f.id)}/hand`, { step: box.dataset.handTick, done: box.checked })
      if (!r.ok) box.checked = !box.checked
      aside(el, { refused: r.ok ? '' : refusal(r) })
      reload()
    })
    el.addEventListener('click', async e => {
      const f = shown.get(el)?.flow
      if (!f) return
      const copy = e.target.closest('[data-hand-copy]')
      if (copy) {
        const v = f.hand?.steps?.find(s => s.id === copy.dataset.handCopy)?.copy || ''
        try {
          await navigator.clipboard.writeText(v)
          copy.textContent = 'Copied'
        } catch {
          // no clipboard (an insecure page, a denied permission): select the value, so Ctrl C copies it
          const pre = el.querySelector(`#fh-copy-${CSS.escape(copy.dataset.handCopy)}`)
          if (pre) window.getSelection?.().selectAllChildren(pre)
          copy.textContent = 'Selected: press Ctrl C'
        }
        return setTimeout(() => { copy.textContent = 'Copy' }, 2000)
      }
      if (e.target.closest('[data-hand-done]')) {
        const r = await call(`/api/flows/${enc(f.id)}/status`, { status: 'done' })
        aside(el, { refused: r.ok ? '' : refusal(r) })
        return reload()
      }
      if (e.target.closest('[data-hand-release]')) return aside(el, { releasing: true, refused: '' })
      if (e.target.closest('[data-hand-release-no]')) return aside(el, { releasing: false })
      if (e.target.closest('[data-hand-release-yes]')) {
        const r = await call(`/api/flows/${enc(f.id)}/senior-release`)
        aside(el, { releasing: false, refused: r.ok ? '' : refusal(r) })
        return reload()
      }
      const ask = e.target.closest('[data-hand-ask]')
      if (ask) {
        ask.disabled = true
        const r = await call(`/api/flows/${enc(f.id)}/request-hand`)
        ask.disabled = false
        if (!r.ok) return aside(el, { refused: refusal(r) })
        if (r.j?.via === 'chat') window.FactoryChat?.prefill(r.j.text)
        reload()
      }
    })
  }

  window.FlowHand = { html, fill }
})()
