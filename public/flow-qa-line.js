// Where QA stands on a flow, said the same way everywhere: the opened flow's head
// line (flow-head.js), the Explain tab's QA slide (flow-explain-view.js) and the
// QA page (qa-view.js). A state is a dot and a few words; green and red only for
// passed and failed (qa.css), so colour is never the only signal.
//
//   QA passed        qa.status passed
//   QA failed        failed (sent back to its producer) or qa-failed (stopped at QA)
//   QA testing       testing
//   waiting for QA   pending, or done and it changed code but QA has no record yet
//   (nothing)        no QA record and still working, or a flow that changed no code
//
// When QA failed, the rework line says what became of sending it back
// (qa-rework.mjs): `Sent back to Agent 3 · sent`, `· sending…`, `· not delivered`
// with Retry (POST /api/flows/<id>/rework), or, for qa-failed, that nothing was
// sent and you decide. No relative time in it: the head redraws its sub only
// when the markup changes (flow-head.js), so a ticking minute would close the ⋯ menu.
//
//   codeProducing(flow)   PURE: MUST CHANGE IN LOCKSTEP with pipeline.mjs isCodeProducing
//   state(flow)           PURE: { key: passed|failed|testing|waiting, word } or null
//   mark(flow, word?)     the dot and the word, '' for none (markOf(state, word?) for a state in hand)
//   rework(flow)          PURE: { to, state: sent|sending|failed|stopped, error } or null
//   reworkHtml(flow)      the rework line, '' for none (reworkLineOf(rework, flowId) for one in hand)
//   retry(flowId)         POST the rework again: { ok, error }
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const list = v => (Array.isArray(v) ? v : [])

  function codeProducing(flow) {
    if (list(flow?.nodes).some(n => list(n?.evidence).some(e => e?.kind === 'commit' || e?.kind === 'diff'))) return true
    const out = flow?.output
    if (list(out?.changes).some(c => c?.kind === 'commit' || c?.kind === 'diff')) return true
    return !!out?.merge && typeof out.merge === 'object'
  }

  const WORDS = { passed: 'QA passed', failed: 'QA failed', testing: 'QA testing', waiting: 'waiting for QA' }
  const KEY = { passed: 'passed', failed: 'failed', 'qa-failed': 'failed', testing: 'testing', pending: 'waiting' }

  function state(flow) {
    if (!flow || flow.status === 'dropped') return null
    const qa = flow.qa && typeof flow.qa === 'object' ? flow.qa : null
    const key = qa ? KEY[qa.status] : flow.status === 'done' && codeProducing(flow) ? 'waiting' : null
    return key ? { key, word: WORDS[key] } : null
  }

  /** The dot and the word for a state(); `word` replaces the word (the QA page says Passed). */
  const markOf = (s, word) => (s ? `<span class="dot qa-dot qa-${esc(s.key)}" data-qa-state="${esc(s.key)}">${esc(word || s.word)}</span>` : '')
  const mark = (flow, word) => markOf(state(flow), word)

  function rework(flow) {
    const qa = flow?.qa
    if (!qa || typeof qa !== 'object') return null
    if (qa.status === 'qa-failed') return { to: '', state: 'stopped', error: null }
    if (qa.status !== 'failed') return null
    const r = qa.rework && typeof qa.rework === 'object' ? qa.rework : null
    if (!r?.to) return { to: '', state: 'stopped', error: null }
    return { to: String(r.to), state: r.sentAt ? 'sent' : r.error ? 'failed' : 'sending', error: r.error ? String(r.error) : null }
  }

  /** The line for a rework(), with Retry for flow `flowId`. */
  function reworkLineOf(r, flowId) {
    if (!r) return ''
    if (r.state === 'stopped') return '<p class="small qa-rework">Not sent back: QA stopped here. You decide what happens next.</p>'
    const how = r.state === 'sent' ? 'sent'
      : r.state === 'sending' ? 'sending…'
      : `<span class="qa-undelivered" title="${esc(r.error)}">not delivered</span> <button type="button" class="link" data-qa-retry="${esc(flowId)}">Retry</button>` +
        '<span class="warn" data-qa-retry-error hidden></span>'
    return `<p class="small qa-rework">Sent back to <b>${esc(r.to)}</b> · ${how}</p>`
  }
  const reworkHtml = flow => reworkLineOf(rework(flow), flow?.id)

  async function retry(flowId) {
    try {
      const r = await fetch(`/api/flows/${encodeURIComponent(flowId)}/rework`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const j = await r.json().catch(() => ({}))
      return r.ok ? { ok: true, error: null } : { ok: false, error: String(j.error || `Failed (${r.status})`) }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  }

  // Retry, wherever the line is drawn: one delegated listener, then every page that shows it reads again.
  if (window.document?.addEventListener) {
    document.addEventListener('click', async e => {
      const b = e.target.closest?.('[data-qa-retry]')
      if (!b || b.disabled) return
      b.disabled = true
      const r = await retry(b.dataset.qaRetry)
      b.disabled = false
      const said = b.parentElement?.querySelector('[data-qa-retry-error]')
      if (said) { said.hidden = r.ok; said.textContent = r.ok ? '' : ` ${r.error}` }
      if (r.ok) { window.FlowsView?.load(); window.QaPage?.update() }
    })
  }

  window.FlowQa = { codeProducing, state, mark, markOf, rework, reworkHtml, reworkLineOf, retry }
})()
