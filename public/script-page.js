// The Prompt generator, the first tool on the Generators page (#/generators). The user writes a rough idea; one Opus run
// (POST /api/script/generate, script-routes.mjs) streams back a ready-to-paste prompt
// in six labelled sections, Situation, Character, Request, Intent, Presentation, Tone
// (the SCRIPT method), using the brainstorming skill when it is installed (script.mjs).
//
// ⚠️ The page was called SCRIPT until 2026-11-25. Only the words the user reads changed: the
// file names, the window.Script* names, the /api/script/ routes and the data files keep the old
// word on purpose. Renaming them would touch files other work is in, and the saved History
// (data/script-log.json) and Context (data/script-context.json) must keep opening. The address
// is #/brainstorming, and #/script still lands here (shell.js resolve).
//
// This file is the DOM glue only. What to draw comes from ScriptState (script-state.js),
// the text rules from ScriptText (script-text.js), the answer's parts from ScriptRender
// (script-render.js), drawn by ScriptView (script-view.js), the stream from ScriptStream
// (script-stream.js), the pop from ScriptSound (script-sound.js), Copy from ScriptCopy
// (script-copy.js), the questions pop-up from ScriptAsk (script-ask.js) and the History list
// from ScriptHistoryView (script-history-view.js).
//
// - ⚠️ Model text is NEVER HTML: ScriptView builds the output from text nodes, and the Sent with
//   line is text too. Only markup() and the fixed mute icons go in as HTML.
// - The letters light from the streamed text itself (ScriptText.sectionsStarted), never a
//   timer: a lit letter pops once, the one being written keeps a soft ring, and while the model
//   thinks (no text yet) they ripple. The completion moment (ScriptState.justCompleted) settles
//   the letters, glows the box once and plays the pop, unless muted. Under reduced motion the
//   CSS fades instead.
// - The AudioContext is made or resumed in the Generate click, a user gesture, so the
//   browser lets the pop play when it comes, seconds later.
// - Restart aborts the run's fetch (the server then kills the model process), resets the state
//   and empties both boxes, with Undo for UNDO_MS. The stopped run's late events carry its old
//   run id, so the state drops them: no error, no pop, no late text.
// - Leaving the page does NOT stop a run: the section is only hidden, the run finishes and
//   is there when you come back. Closing the tab cuts the stream, and the server then
//   kills the model process.
// - The Context panel (script-context.js, another file) is optional: an empty aside for it, and
//   ScriptContext.create on mount when it is loaded.
// - Questions: a run that ends on them opens the pop-up over Your thoughts (ScriptState
//   `asking`). Later keeps what was typed in Your answers, and Show the questions opens it again.
// - History: a row brings its run back as a finished state (ScriptState restore), with no
//   completion moment, no pops and no pop-up. It is refreshed after every run ends.
//
//   window.ScriptPage = { open(), close(), markup() }   markup() is ScriptMarkup.html() (script-markup.js)
;(() => {
  const T = () => window.ScriptText
  const St = () => window.ScriptState
  const MAX = window.ScriptMarkup.MAX
  const COPIED_MS = 1500
  const MOMENT_MS = 1000 // longer than the settle (370 ms) and the glow (900 ms)
  const POP_MS = 320 // a little longer than the pop (260 ms)
  const UNDO_MS = 6000
  const M = window.ScriptMarkup
  const { ICON, MUTE_LABEL } = M
  const markup = () => M.html()

  if (!window.document) {
    window.ScriptPage = { open() {}, close() {}, markup }
    return
  }

  const doc = window.document
  const store = () => {
    try {
      return window.localStorage
    } catch {
      return null
    }
  }
  let els = null
  let state = null
  let output = null // the ScriptView drawing #scriptOut
  let audio = null
  let controller = null // the running fetch's AbortController, for Restart
  let copiedTimer = 0
  let momentTimer = 0
  let undoTimer = 0
  let undoSaved = null
  let drawn = ''
  let sentDrawn = 'null'
  let ask = null // the questions pop-up (script-ask.js)
  let history = null // the History list (script-history-view.js)

  function mount() {
    const view = doc.getElementById('scriptView')
    view.innerHTML = markup()
    const $ = id => doc.getElementById(id)
    els = {
      input: $('scriptInput'), answersBox: $('scriptAnswersBox'), answers: $('scriptAnswers'), go: $('scriptGo'), hint: $('scriptHint'),
      restart: $('scriptRestart'), undo: $('scriptUndo'), undoBtn: $('scriptUndoBtn'),
      letters: $('scriptLetters'), mute: $('scriptMute'), progress: $('scriptProgress'), copied: $('scriptCopied'), copy: $('scriptCopy'),
      out: $('scriptOut'), error: $('scriptError'), errorText: $('scriptErrorText'), retry: $('scriptRetry'), sent: $('scriptSent'),
      askOpen: $('scriptAskOpen'),
    }
    state = St().initial()
    output = window.ScriptView.create(els.out)
    ask = window.ScriptAsk.create($('scriptInBox'), {
      onSubmit: answers => {
        els.answers.value = answers
        dispatch({ type: 'unask' })
        onGenerate() // exactly what Generate again sends with these answers
      },
      onLater: answers => {
        if (answers) els.answers.value = answers // nothing typed is lost
        dispatch({ type: 'unask' })
      },
    })
    els.askOpen.addEventListener('click', () => dispatch({ type: 'ask' }))
    history = window.ScriptHistoryView.create($('scriptHistory'), { onRestore })
    history.refresh()
    els.go.addEventListener('click', onGenerate)
    els.restart.addEventListener('click', onRestart)
    els.undoBtn.addEventListener('click', onUndo)
    els.retry.addEventListener('click', () => state.request && send(state.request, state.followUp))
    els.copy.addEventListener('click', onCopy)
    els.mute.addEventListener('click', () => paintMute(!window.ScriptSound.isMuted(store()), true))
    for (const box of [els.input, els.answers]) {
      box.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault()
          onGenerate()
        }
      })
      box.addEventListener('input', () => {
        els.hint.textContent = ''
        hideUndo() // typing again: the old text is not coming back over the new
        paintRestart(St().view(state))
      })
    }
    paintMute(window.ScriptSound.isMuted(store()), false)
    paint()
    try {
      window.ScriptContext?.create(doc.getElementById('scriptContext'), { page: view.querySelector('.sc-page') })
    } catch {
      /* the Context panel is optional: the page works without it */
    }
  }

  function paintMute(muted, save) {
    if (save) window.ScriptSound.setMuted(store(), muted)
    const label = muted ? MUTE_LABEL.on : MUTE_LABEL.off
    els.mute.setAttribute('aria-pressed', String(muted))
    els.mute.setAttribute('aria-label', label)
    els.mute.title = label
    els.mute.innerHTML = muted ? ICON.muted : ICON.sound // a fixed icon, never model text
  }

  function paint() {
    const v = St().view(state)
    const key = `${v.busy}\u0000${state.output}`
    if (drawn !== key) {
      const box = els.out
      const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 24
      if (state.output) output.render(window.ScriptRender.parts(state.output, { live: v.busy }), { live: v.busy })
      else output.clear()
      drawn = key
      if (pinned && v.busy) box.scrollTop = box.scrollHeight // follow the stream unless the user scrolled up
    }
    els.out.setAttribute('aria-busy', String(v.busy))
    els.out.classList.toggle('sc-incomplete', v.incomplete)
    paintLetters(v)
    els.progress.textContent = v.incomplete ? 'Incomplete' : v.progress
    els.copy.disabled = !v.canCopy
    els.answersBox.hidden = !v.showAnswers
    els.go.textContent = v.button
    els.go.disabled = v.busy
    els.error.hidden = !v.error
    els.errorText.textContent = v.error
    els.retry.hidden = !v.canRetry
    paintSent(v.context)
    paintRestart(v)
    els.askOpen.hidden = !(state.phase === 'questions' && !v.asking)
    if (v.asking) ask.open(state.questions)
    else ask.close()
  }

  /** Lit letters, the one being written (its ring), a pop for each that just lit, the thinking wave. */
  function paintLetters(v) {
    els.letters.classList.toggle('sc-thinking', v.thinking)
    for (const el of els.letters.querySelectorAll('.sc-letter')) {
      const s = el.dataset.section
      const on = v.lit.includes(s)
      if (on && !el.classList.contains('on') && !state.restored) pop(el) // a restore lights them quietly
      if (!on) el.classList.remove('sc-pop')
      el.classList.toggle('on', on)
      el.classList.toggle('now', v.current === s)
    }
    els.letters.setAttribute('aria-label', `Sections started: ${v.lit.length ? v.lit.join(', ') : 'none'}`)
  }

  function pop(el) {
    el.classList.remove('sc-pop')
    void el.offsetWidth // restart the animation if the letter pops again soon
    el.classList.add('sc-pop')
    setTimeout(() => el.classList.remove('sc-pop'), POP_MS)
  }

  /** The quiet line under the output: what the Context panel sent with this run. Text only. */
  function paintSent(c) {
    const key = JSON.stringify(c)
    if (key === sentDrawn) return
    sentDrawn = key
    els.sent.hidden = !c
    els.sent.textContent = ''
    for (const line of c ? [c.sent, c.left].filter(Boolean) : []) {
      const span = doc.createElement('span')
      span.textContent = line
      els.sent.appendChild(span)
    }
  }

  function paintRestart(v) {
    els.restart.disabled = !(v.canRestart || els.input.value || els.answers.value)
  }

  function dispatch(ev) {
    const before = state
    state = St().reduce(state, ev)
    if (state === before) return // a late event from a stopped run: nothing to draw
    paint()
    if (St().justCompleted(before, state)) moment()
  }

  /** The completion moment: the letters settle, the box glows once, the pop plays unless muted. */
  function moment() {
    clearTimeout(momentTimer)
    els.letters.classList.remove('sc-settle')
    els.out.classList.remove('sc-glow')
    void els.out.offsetWidth // restart the animations if a second moment comes quickly
    els.letters.classList.add('sc-settle')
    els.out.classList.add('sc-glow')
    momentTimer = setTimeout(endMoment, MOMENT_MS)
    if (!window.ScriptSound.isMuted(store())) window.ScriptSound.play(audio)
  }

  function endMoment() {
    clearTimeout(momentTimer)
    els.letters.classList.remove('sc-settle')
    els.out.classList.remove('sc-glow')
  }

  function hint(msg, focus) {
    els.hint.textContent = msg
    focus?.focus()
  }

  function onGenerate() {
    if (St().view(state).busy) return
    audio = window.ScriptSound.ensureContext() // inside the click: the browser allows audio from here on
    const original = els.input.value
    if (!original.trim()) return hint('Write a few words first.', els.input)
    let text = original
    let followUp = false
    if (St().view(state).showAnswers) {
      if (!els.answers.value.trim()) return hint('Answer the questions first.', els.answers)
      text = T().followUp(original, state.questions, els.answers.value, state.askedBy) // a second round keeps the first's answers
      followUp = true
    }
    if (text.length > MAX) return hint(`That is over ${MAX} characters with the answers. Shorten it a little.`, followUp ? els.answers : els.input)
    send(text, followUp)
  }

  async function send(text, followUp) {
    els.hint.textContent = ''
    els.copied.textContent = ''
    hideUndo()
    audio = audio || window.ScriptSound.ensureContext()
    const ctl = new AbortController()
    controller = ctl
    dispatch({ type: 'start', text, followUp })
    const run = state.run
    els.out.scrollTop = 0
    const out = await window.ScriptStream.generate(text, {
      signal: ctl.signal,
      onDelta: t => dispatch({ type: 'delta', text: t, run }),
      onContext: c => dispatch({ type: 'context', ...c, run }),
    })
    if (controller === ctl) controller = null
    dispatch({ type: 'end', ok: out.type === 'done', error: out.error, run })
    window.Spend?.refresh?.() // the rail's spend chip shows this run's cost
    history.refresh(out.run) // the server logged it, stopped runs too
  }

  /** A History row: bring that run back, finished. Refused (false) while a run is going. */
  function onRestore(run) {
    if (St().view(state).busy) return false
    endMoment()
    hideUndo()
    ask.forget()
    els.hint.textContent = ''
    els.copied.textContent = ''
    els.input.value = String(run.text ?? '')
    els.answers.value = ''
    dispatch(window.ScriptHistory.restoreEvent(run))
    els.out.scrollTop = 0
    return true
  }

  /** Start the page over: stop any run, empty both boxes and the output, offer Undo for the text. */
  function onRestart() {
    const saved = { thoughts: els.input.value, answers: els.answers.value }
    controller?.abort() // the server sees the request close and kills the model process
    controller = null
    endMoment()
    clearTimeout(copiedTimer)
    els.copied.textContent = ''
    els.hint.textContent = ''
    els.input.value = ''
    els.answers.value = ''
    ask.forget()
    dispatch({ type: 'reset' }) // closes the questions pop-up too
    els.out.scrollTop = 0
    if (saved.thoughts.trim() || saved.answers.trim()) showUndo(saved)
    els.input.focus()
  }

  function showUndo(saved) {
    clearTimeout(undoTimer)
    undoSaved = saved
    els.undo.hidden = false
    undoTimer = setTimeout(hideUndo, UNDO_MS)
  }

  function hideUndo() {
    clearTimeout(undoTimer)
    undoSaved = null
    if (els) els.undo.hidden = true
  }

  /** Undo puts the typed text back, not the output. The questions went with the output, so any
   *  answers come back under the thoughts, in the one box that is still showing. */
  function onUndo() {
    const s = undoSaved
    hideUndo()
    if (!s) return
    els.input.value = s.answers.trim() ? `${s.thoughts.replace(/\s+$/, '')}\n\n${s.answers}` : s.thoughts
    paintRestart(St().view(state))
    els.input.focus()
    els.input.setSelectionRange(els.input.value.length, els.input.value.length)
  }

  async function onCopy() {
    const code = St().view(state).code
    if (code == null) return
    const ok = await window.ScriptCopy.copy(code) // only the prompt inside the block
    clearTimeout(copiedTimer)
    els.copied.textContent = ok ? 'Copied' : 'Could not copy. Select the text instead.'
    copiedTimer = setTimeout(() => (els.copied.textContent = ''), COPIED_MS)
  }

  /**
   * The page opens as Generators (#/generators): the tool switch (generators.js) shows the Prompt generator, which is
   * this file, unless the address asks for the Standup creator. `query` is the route's (?tool=standup&day=...).
   */
  function open(query = {}) {
    if (!els) mount()
    window.Shell.setTitle('Generators', 'script')
    if (window.Generators?.open) window.Generators.open(doc.getElementById('scriptView'), query, { prompt: openPrompt })
    else openPrompt()
  }

  /** The Prompt generator shown: its status and help, and the focus in Your thoughts. */
  function openPrompt() {
    window.Shell.setStatus('Opus 5.5 · high effort',
      '<p>Generators has two tools: switch with the pills at the top. This is the <b>Prompt generator</b>; the <b>Standup creator</b> writes your stand-up.</p>' +
      '<p>Each <b>Generate</b> is one Claude Code run on Opus 5.5 at high effort, with no tools and none of your settings, CLAUDE.md or memory. It uses the brainstorming skill when it is installed. It is billed to your Claude account and counted in <b>Spend today</b>.</p>' +
      '<p>One run goes at a time. When the model asks questions first, answer them in the pop-up and press <b>Answer and generate</b>. <b>Restart</b> stops a run and starts the page over. <b>History</b>, under the boxes, brings back an earlier run.</p>')
    if (state.phase === 'idle') els.input.focus({ preventScroll: true })
  }

  function close() {
    // Nothing to stop: a run keeps going while another page shows, and is here on return.
  }

  window.ScriptPage = { open, close, markup }
})()
