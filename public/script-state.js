// The SCRIPT page as a pure state machine (script-page.js paints what it says; no DOM
// here, so test/script-state.test.mjs runs it in a vm). Needs script-text.js first.
//
//   ScriptState.initial()               idle, nothing written
//   ScriptState.reduce(state, event)    the next state for one event:
//       { type: 'start', text, followUp? }   a request went out (`text` is kept for Retry)
//       { type: 'delta', text }              a piece of the answer arrived
//       { type: 'end', ok, error? }          the stream's final line
//   ScriptState.justCompleted(a, b)     true on the ONE transition where the completion moment
//                                       happens (the letters settle, the box glows, the pop)
//   ScriptState.view(state)             what to draw: { lit, code, canCopy, busy, showAnswers,
//                                       button, error, incomplete, canRetry, progress }
//
// Phases: idle → running → prompt | questions | error. The completion moment can come while
// still running (Tone, then the closing fence) or at a good end (all six seen); never on the
// questions path or a failure.
;(() => {
  const T = window.ScriptText
  const EMPTY = 'The model gave no answer. Try again.'

  const initial = () => ({ phase: 'idle', output: '', error: '', completed: false, request: '', followUp: false, questions: '' })

  function reduce(s, ev) {
    if (ev?.type === 'start') {
      return { ...s, phase: 'running', output: '', error: '', completed: false, request: String(ev.text ?? ''), followUp: ev.followUp === true }
    }
    if (s.phase !== 'running') return s // a late delta or end from a run that is already over
    if (ev?.type === 'delta') {
      const output = s.output + String(ev.text ?? '')
      return { ...s, output, completed: s.completed || T.finished(output) }
    }
    if (ev?.type === 'end') {
      if (!ev.ok) return { ...s, phase: 'error', error: String(ev.error || 'The run stopped before it finished.') }
      const kind = T.classify(s.output)
      if (kind === 'empty') return { ...s, phase: 'error', error: EMPTY }
      if (kind === 'questions') return { ...s, phase: 'questions', questions: s.output }
      return { ...s, phase: 'prompt', followUp: false, completed: s.completed || T.finished(s.output, true) }
    }
    return s
  }

  const justCompleted = (a, b) => Boolean(b?.completed && !a?.completed)

  function view(s) {
    const busy = s.phase === 'running'
    const block = s.phase === 'questions' ? null : T.codeBlock(s.output)
    const lit = block ? T.sectionsStarted(s.output) : []
    const showAnswers = s.phase === 'questions' || (s.followUp && (busy || s.phase === 'error'))
    const progress = s.phase === 'idle' || s.phase === 'questions' ? ''
      : lit.length === T.SECTIONS.length ? `All ${lit.length} sections`
      : lit.length ? `${lit.length} of ${T.SECTIONS.length} sections`
      : busy ? 'Writing…' : ''
    return {
      lit,
      code: block ? block.code : null,
      canCopy: Boolean(block),
      busy,
      showAnswers,
      button: busy ? 'Generating…' : showAnswers ? 'Generate again' : 'Generate',
      error: s.phase === 'error' ? s.error : '',
      incomplete: s.phase === 'error' && Boolean(s.output.trim()),
      canRetry: s.phase === 'error' && Boolean(s.request),
      progress,
    }
  }

  window.ScriptState = { initial, reduce, justCompleted, view }
})()
