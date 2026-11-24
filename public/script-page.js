// The SCRIPT Generator page (#/script). The user writes a rough idea; one Opus run
// (POST /api/script/generate, script-routes.mjs) streams back a ready-to-paste prompt
// in six labelled sections, Situation, Character, Request, Intent, Presentation, Tone.
//
// This file is the DOM glue only. What to draw comes from ScriptState (script-state.js),
// the text rules from ScriptText (script-text.js), the stream from ScriptStream
// (script-stream.js) and the pop from ScriptSound (script-sound.js).
//
// - ⚠️ Model text is NEVER HTML: the output box only ever gets textContent.
// - The letters light from the streamed text itself (ScriptText.sectionsStarted), never a
//   timer. The completion moment (ScriptState.justCompleted) settles the letters, glows the
//   box once and plays the pop, unless muted. Under reduced motion the CSS fades instead.
// - The AudioContext is made or resumed in the Generate click, a user gesture, so the
//   browser lets the pop play when it comes, seconds later.
// - Leaving the page does NOT stop a run: the section is only hidden, the run finishes and
//   is there when you come back. Closing the tab cuts the stream, and the server then
//   kills the model process.
//
//   window.ScriptPage = { open(), close(), markup() }   markup() is the static HTML (tests)
;(() => {
  const T = () => window.ScriptText
  const St = () => window.ScriptState
  const MAX = 8000
  const COPIED_MS = 1500
  const MOMENT_MS = 1000 // longer than the settle (340 ms) and the glow (900 ms)
  const IS_MAC = /Mac|iPhone|iPad/.test(window.navigator?.platform || window.navigator?.userAgent || '')
  const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`
  const SPEAKER = '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z"/>'
  const ICON = {
    sound: svg(`${SPEAKER}<path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>`),
    muted: svg(`${SPEAKER}<path d="m16 9.5 5 5M21 9.5l-5 5"/>`),
  }
  const LETTERS = [['Situation', 'S'], ['Character', 'C'], ['Request', 'R'], ['Intent', 'I'], ['Presentation', 'P'], ['Tone', 'T']]
  const MUTE_LABEL = { off: 'Mute the completion sound', on: 'Turn the completion sound back on' }

  function markup() {
    const letters = LETTERS.map(([s, l]) => `<span class="sc-letter" data-section="${s}" title="${s}">${l}</span>`).join('')
    return `<div class="sc-page">
  <p class="sc-lede small">Write a rough idea. It comes back as a prompt in six labelled parts, ready to paste into any AI. Nothing is done with the task itself.</p>
  <div class="sc-grid">
    <div class="sc-col">
      <label for="scriptInput" class="sc-label">Your thoughts</label>
      <textarea id="scriptInput" class="sc-text" maxlength="${MAX}" rows="12" spellcheck="true" placeholder="What do you want an AI to do? Who is it for, and why?"></textarea>
      <div class="sc-answers" id="scriptAnswersBox" hidden>
        <label for="scriptAnswers" class="sc-label">Your answers</label>
        <textarea id="scriptAnswers" class="sc-text sc-text-short" rows="5" placeholder="Answer the questions on the right, in your own words."></textarea>
      </div>
      <div class="sc-actions">
        <button type="button" class="primary" id="scriptGo">Generate</button>
        <span class="small faint" id="scriptKeys">${IS_MAC ? '⌘' : 'Ctrl'}+Enter</span>
        <span class="small faint sc-hint" id="scriptHint" aria-live="polite"></span>
      </div>
    </div>
    <div class="sc-col">
      <div class="sc-head">
        <div class="sc-letters" id="scriptLetters" role="group" aria-label="Sections started: none">${letters}</div>
        <button type="button" class="sc-mute" id="scriptMute" aria-pressed="false" aria-label="${MUTE_LABEL.off}" title="${MUTE_LABEL.off}">
          ${ICON.sound}
        </button>
        <span class="small faint sc-progress" id="scriptProgress" aria-live="polite"></span>
        <span class="small sc-copied" id="scriptCopied" role="status"></span>
        <button type="button" id="scriptCopy" disabled>Copy</button>
      </div>
      <pre class="sc-out" id="scriptOut" tabindex="0" aria-label="Your prompt" aria-busy="false" data-empty="Your prompt appears here."></pre>
      <div class="sc-error" id="scriptError" role="alert" hidden><i class="sc-mark" aria-hidden="true"></i><span id="scriptErrorText"></span><button type="button" id="scriptRetry">Retry</button></div>
    </div>
  </div>
</div>`
  }

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
  let audio = null
  let copiedTimer = 0
  let momentTimer = 0
  let drawn = ''

  function mount() {
    const view = doc.getElementById('scriptView')
    view.innerHTML = markup()
    const $ = id => doc.getElementById(id)
    els = {
      input: $('scriptInput'), answersBox: $('scriptAnswersBox'), answers: $('scriptAnswers'), go: $('scriptGo'), hint: $('scriptHint'),
      letters: $('scriptLetters'), mute: $('scriptMute'), progress: $('scriptProgress'), copied: $('scriptCopied'), copy: $('scriptCopy'),
      out: $('scriptOut'), error: $('scriptError'), errorText: $('scriptErrorText'), retry: $('scriptRetry'),
    }
    state = St().initial()
    els.go.addEventListener('click', onGenerate)
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
      box.addEventListener('input', () => (els.hint.textContent = ''))
    }
    paintMute(window.ScriptSound.isMuted(store()), false)
    paint()
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
    if (drawn !== state.output) {
      const pinned = els.out.scrollHeight - els.out.scrollTop - els.out.clientHeight < 24
      els.out.textContent = state.output
      drawn = state.output
      if (pinned && v.busy) els.out.scrollTop = els.out.scrollHeight // follow the stream unless the user scrolled up
    }
    els.out.setAttribute('aria-busy', String(v.busy))
    els.out.classList.toggle('sc-incomplete', v.incomplete)
    for (const el of els.letters.querySelectorAll('.sc-letter')) el.classList.toggle('on', v.lit.includes(el.dataset.section))
    els.letters.setAttribute('aria-label', `Sections started: ${v.lit.length ? v.lit.join(', ') : 'none'}`)
    els.progress.textContent = v.incomplete ? 'Incomplete' : v.progress
    els.copy.disabled = !v.canCopy
    els.answersBox.hidden = !v.showAnswers
    els.go.textContent = v.button
    els.go.disabled = v.busy
    els.error.hidden = !v.error
    els.errorText.textContent = v.error
    els.retry.hidden = !v.canRetry
  }

  function dispatch(ev) {
    const before = state
    state = St().reduce(state, ev)
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
    momentTimer = setTimeout(() => {
      els.letters.classList.remove('sc-settle')
      els.out.classList.remove('sc-glow')
    }, MOMENT_MS)
    if (!window.ScriptSound.isMuted(store())) window.ScriptSound.play(audio)
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
      text = T().followUp(original, state.questions, els.answers.value)
      followUp = true
    }
    if (text.length > MAX) return hint(`That is over ${MAX} characters with the answers. Shorten it a little.`, followUp ? els.answers : els.input)
    send(text, followUp)
  }

  async function send(text, followUp) {
    els.hint.textContent = ''
    els.copied.textContent = ''
    audio = audio || window.ScriptSound.ensureContext()
    dispatch({ type: 'start', text, followUp })
    const out = await window.ScriptStream.generate(text, { onDelta: t => dispatch({ type: 'delta', text: t }) })
    dispatch({ type: 'end', ok: out.type === 'done', error: out.error })
    window.Spend?.refresh?.() // the rail's spend chip shows this run's cost
  }

  async function onCopy() {
    const code = St().view(state).code
    if (code == null) return
    let ok = false
    try {
      await window.navigator.clipboard.writeText(code)
      ok = true
    } catch {
      ok = copyFallback(code)
    }
    clearTimeout(copiedTimer)
    els.copied.textContent = ok ? 'Copied' : 'Could not copy. Select the text instead.'
    copiedTimer = setTimeout(() => (els.copied.textContent = ''), COPIED_MS)
  }

  /** For a browser without the async clipboard (or without permission): a hidden textarea and execCommand. */
  function copyFallback(code) {
    const ta = doc.createElement('textarea')
    ta.value = code
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
    doc.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = doc.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }

  function open() {
    if (!els) mount()
    window.Shell.setTitle('SCRIPT', 'script')
    window.Shell.setStatus('Opus 5.5 · high effort',
      '<p>Each <b>Generate</b> is one Claude Code run on Opus 5.5 at high effort, with no tools and none of your settings, CLAUDE.md or memory. It is billed to your Claude account and counted in <b>Spend today</b>.</p>' +
      '<p>One run goes at a time. When the model asks questions first, answer them and press <b>Generate again</b>.</p>')
    if (state.phase === 'idle') els.input.focus({ preventScroll: true })
  }

  function close() {
    // Nothing to stop: a run keeps going while another page shows, and is here on return.
  }

  window.ScriptPage = { open, close, markup }
})()
