// The SCRIPT page as a pure state machine (script-page.js paints what it says; no DOM
// here, so test/script-state.test.mjs runs it in a vm). Needs script-text.js first.
//
//   ScriptState.initial()               idle, nothing written
//   ScriptState.reduce(state, event)    the next state for one event:
//       { type: 'start', text, followUp? }   a request went out (`text` is kept for Retry); it
//                                            gets a new `run` id
//       { type: 'context', used, skipped, run? }   what the Context panel sent with the run
//       { type: 'delta', text, run? }        a piece of the answer arrived
//       { type: 'end', ok, error?, run? }    the stream's final line
//       { type: 'reset' }                    Restart: back to idle and empty, from any phase
//       { type: 'restore', text, output, ok, error?, cancelled?, context? }   a run from History,
//                                            shown finished; refused while a run is going
//       { type: 'ask' } / { type: 'unask' }  open or close the questions pop-up (questions only);
//                                            a run that ends on questions opens it by itself
//   ScriptState.justCompleted(a, b)     true on the ONE transition where the completion moment
//                                       happens (the letters settle, the box glows, the pop)
//   ScriptState.view(state)             what to draw: { lit, current, thinking, code, canCopy, busy,
//                                       showAnswers, button, error, incomplete, canRetry,
//                                       canRestart, asking, progress, context }
//
// Phases: idle → running → prompt | questions | error, and reset → idle from any of them. The
// completion moment can come while still running (Tone, then the closing fence) or at a good end
// (all six seen); never on the questions path, a failure or a reset.
//
// ⚠️ Run ids: Restart aborts the fetch, but the aborted stream still resolves (as a cut or an
// error) a moment later. Each event carries the `run` it belongs to, and an event from any other
// run is dropped, so a stopped run never shows an error, pops, or paints late text, even into the
// next run. An event with no `run` is taken as the current run's (the tests use that).
;(() => {
  const T = window.ScriptText
  const EMPTY = 'The model gave no answer. Try again.'

  const STOPPED = 'This run was stopped before it finished.'
  const initial = () => ({
    phase: 'idle', output: '', error: '', completed: false, request: '', followUp: false, questions: '', run: 0, context: null,
    restored: false, asking: false,
  })

  /** Keep only well-formed entries: a non-empty title (text, never HTML) and an optional reason. */
  const titled = list => (Array.isArray(list) ? list : []).filter(e => e && typeof e.title === 'string' && e.title.trim())
  const contextOf = ev => ({
    used: titled(ev.used).map(e => ({ title: e.title.trim(), chars: Number(e.chars) || 0 })),
    skipped: titled(ev.skipped).map(e => ({ title: e.title.trim(), why: typeof e.why === 'string' ? e.why.trim() : '' })),
  })

  function reduce(s, ev) {
    if (ev?.type === 'reset') return { ...initial(), run: s.run + 1 } // a new id: the stopped run's events no longer match
    if (ev?.type === 'start') {
      return {
        ...s, phase: 'running', output: '', error: '', completed: false, request: String(ev.text ?? ''), followUp: ev.followUp === true,
        run: s.run + 1, context: null, restored: false, asking: false,
      }
    }
    if (ev?.type === 'restore') return s.phase === 'running' ? s : restore(s, ev)
    if (ev?.type === 'ask') return s.phase === 'questions' ? { ...s, asking: true } : s
    if (ev?.type === 'unask') return s.asking ? { ...s, asking: false } : s
    if (s.phase !== 'running') return s // a late delta or end from a run that is already over
    if (ev?.run != null && ev.run !== s.run) return s // from a run that was stopped
    if (ev?.type === 'context') return { ...s, context: contextOf(ev) }
    if (ev?.type === 'delta') {
      const output = s.output + String(ev.text ?? '')
      return { ...s, output, completed: s.completed || T.finished(output) }
    }
    if (ev?.type === 'end') {
      if (!ev.ok) return { ...s, phase: 'error', error: String(ev.error || 'The run stopped before it finished.') }
      const kind = T.classify(s.output)
      if (kind === 'empty') return { ...s, phase: 'error', error: EMPTY }
      if (kind === 'questions') return { ...s, phase: 'questions', questions: s.output, asking: true }
      return { ...s, phase: 'prompt', followUp: false, completed: s.completed || T.finished(s.output, true) }
    }
    return s
  }

  /**
   * A run from History, shown as it finished: a prompt is complete (letters lit, Copy on), questions
   * open the answers box but NOT the pop-up, a failed or stopped run shows its calm line and Retry.
   * `restored` keeps the completion moment (settle, glow, pop) for live runs only.
   */
  function restore(s, ev) {
    const output = String(ev.output ?? '')
    const base = { ...initial(), run: s.run + 1, request: String(ev.text ?? ''), output, restored: true, context: ev.context ? contextOf(ev.context) : null }
    if (ev.cancelled) return { ...base, phase: 'error', error: STOPPED }
    if (!ev.ok) return { ...base, phase: 'error', error: String(ev.error || 'The run stopped before it finished.') }
    const kind = T.classify(output)
    if (kind === 'empty') return { ...base, phase: 'error', error: EMPTY }
    if (kind === 'questions') return { ...base, phase: 'questions', questions: output }
    return { ...base, phase: 'prompt', completed: true }
  }

  const justCompleted = (a, b) => Boolean(b?.completed && !a?.completed && !b.restored)

  /** The quiet line under the output: what was sent, and what was left out and why. */
  function contextLine(c) {
    if (!c || (!c.used.length && !c.skipped.length)) return null
    return {
      sent: c.used.length ? `Sent with: ${c.used.map(e => e.title).join(', ')}` : '',
      left: c.skipped.length ? `Left out: ${c.skipped.map(e => (e.why ? `${e.title} (${e.why})` : e.title)).join(', ')}` : '',
    }
  }

  function view(s) {
    const busy = s.phase === 'running'
    const thinking = busy && !s.output.trim()
    const block = s.phase === 'questions' ? null : T.codeBlock(s.output)
    const lit = block ? T.sectionsStarted(s.output) : []
    const showAnswers = s.phase === 'questions' || (s.followUp && (busy || s.phase === 'error'))
    const progress = s.phase === 'idle' ? ''
      : s.phase === 'questions' ? 'Questions first'
      : thinking ? 'Thinking…'
      : lit.length === T.SECTIONS.length ? `All ${lit.length} sections`
      : lit.length ? `${lit.length} of ${T.SECTIONS.length} sections`
      : busy ? 'Writing…' : ''
    return {
      lit,
      current: busy && !s.completed && lit.length ? lit.at(-1) : null,
      thinking,
      code: block ? block.code : null,
      canCopy: Boolean(block),
      busy,
      showAnswers,
      button: busy ? 'Generating…' : showAnswers ? 'Generate again' : 'Generate',
      error: s.phase === 'error' ? s.error : '',
      incomplete: s.phase === 'error' && Boolean(s.output.trim()),
      canRetry: s.phase === 'error' && Boolean(s.request),
      canRestart: s.phase !== 'idle',
      asking: s.phase === 'questions' && s.asking,
      progress,
      context: contextLine(s.context),
    }
  }

  window.ScriptState = { initial, reduce, justCompleted, view }
})()
