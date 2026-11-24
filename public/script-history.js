// The SCRIPT History list, the pure side (script-history-view.js draws it and talks to
// GET and DELETE /api/script/log; no DOM here, so test/script-history.test.mjs runs it in a vm).
// Needs script-text.js; uses Shell.ago (shell.js) for the short time when it is loaded.
//
//   ScriptHistory.runs(answer)        the well-formed runs of a GET /api/script/log answer, in its
//                                     order (newest first); anything else is an empty list.
//   ScriptHistory.summary(n)          the disclosure's line: "History · 12 runs".
//   ScriptHistory.row(run, { now })   one row's words: { id, when, exact, idea, kind, label, cost, sent }.
//                                     `label` is what came back: Prompt, Questions, Stopped (cancelled)
//                                     or Did not finish (failed, or an empty answer), from
//                                     ScriptText.classify. `cost` is '' when there is none.
//   ScriptHistory.restoreEvent(run)   the state machine's restore event for a run (script-state.js).
//
// Every field is text: the view sets each with textContent, never as HTML.
;(() => {
  const T = window.ScriptText
  const IDEA_MAX = 80
  const LABEL = { prompt: 'Prompt', questions: 'Questions', stopped: 'Stopped', failed: 'Did not finish' }

  const runs = answer => (Array.isArray(answer?.runs) ? answer.runs : []).filter(r => r && typeof r.id === 'string' && r.id)

  const summary = n => `History · ${n ? `${n} run${n === 1 ? '' : 's'}` : 'no runs'}`

  function kindOf(r) {
    if (r.cancelled) return 'stopped'
    if (!r.ok) return 'failed'
    const k = T.classify(r.output)
    return k === 'empty' ? 'failed' : k
  }

  function idea(text) {
    const line = String(text ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || ''
    if (!line) return '(no text)'
    return line.length > IDEA_MAX ? `${line.slice(0, IDEA_MAX - 1).trimEnd()}…` : line
  }

  /** Dollars as the spend chip says them (spend.js money): `$0.03`, `<$0.01`. '' for none. */
  function cost(usd) {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return ''
    const cents = Math.round(usd * 100)
    return cents ? `$${(cents / 100).toFixed(2)}` : '<$0.01'
  }

  function exact(iso) {
    const t = Date.parse(iso ?? '')
    if (Number.isNaN(t)) return ''
    return new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  function row(r, { now = Date.now() } = {}) {
    const kind = kindOf(r)
    const used = (Array.isArray(r.context?.used) ? r.context.used : []).filter(e => typeof e?.title === 'string' && e.title.trim())
    return {
      id: r.id,
      when: window.Shell?.ago?.(r.at, now) || '',
      exact: exact(r.at),
      idea: idea(r.text),
      kind,
      label: LABEL[kind],
      cost: cost(r.cost),
      sent: used.length ? `Sent with: ${used.map(e => e.title.trim()).join(', ')}` : '',
    }
  }

  const restoreEvent = r => ({
    type: 'restore',
    text: String(r.text ?? ''),
    output: String(r.output ?? ''),
    ok: r.ok === true,
    error: String(r.error ?? ''),
    cancelled: r.cancelled === true,
    context: r.context ?? null,
  })

  window.ScriptHistory = { runs, summary, row, restoreEvent }
})()
