// The SCRIPT page's static markup (script-page.js puts it in #scriptView once, and wires it).
// Only fixed text and the fixed mute icons are here: no model text, nothing from the user.
// test/script-page.test.mjs and its neighbours read it as a string, with no DOM.
//
//   ScriptMarkup.html()        the page: the two columns (head row, box, foot row each) in .sc-fit,
//                              the History disclosure, and the empty Context aside. ⚠️ .sc-fit is a
//                              size container (script.css), so the FIXED aside must stay outside it.
//   ScriptMarkup.ICON          the mute button's two icons (sound, muted)
//   ScriptMarkup.MUTE_LABEL    the mute button's two names
//   ScriptMarkup.MAX           the longest text one run takes (script.mjs checks it too)
;(() => {
  const MAX = 8000
  const IS_MAC = /Mac|iPhone|iPad/.test(window.navigator?.platform || window.navigator?.userAgent || '')
  const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`
  const SPEAKER = '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z"/>'
  const ICON = {
    sound: svg(`${SPEAKER}<path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>`),
    muted: svg(`${SPEAKER}<path d="m16 9.5 5 5M21 9.5l-5 5"/>`),
  }
  const LETTERS = [['Situation', 'S'], ['Character', 'C'], ['Request', 'R'], ['Intent', 'I'], ['Presentation', 'P'], ['Tone', 'T']]
  const MUTE_LABEL = { off: 'Mute the completion sound', on: 'Turn the completion sound back on' }

  function html() {
    const letters = LETTERS.map(([s, l], i) => `<span class="sc-letter" data-section="${s}" title="${s}" style="--i:${i}">${l}</span>`).join('')
    return `<div class="sc-page">
  <p class="sc-lede small">Write a rough idea. It comes back as a prompt in six labelled parts, ready to paste into any AI. Nothing is done with the task itself.</p>
  <div class="sc-fit">
  <div class="sc-grid">
    <div class="sc-col">
      <div class="sc-head"><label for="scriptInput" class="sc-label">Your thoughts</label></div>
      <div class="sc-box" id="scriptInBox">
        <textarea id="scriptInput" class="sc-text" maxlength="${MAX}" spellcheck="true" placeholder="What do you want an AI to do? Who is it for, and why?"></textarea>
        <div class="sc-answers" id="scriptAnswersBox" hidden>
          <div class="sc-answers-head"><label for="scriptAnswers" class="sc-label">Your answers</label><button type="button" class="link sc-ask-open" id="scriptAskOpen" hidden>Show the questions</button></div>
          <textarea id="scriptAnswers" class="sc-text" placeholder="Answer the questions on the right, in your own words."></textarea>
        </div>
      </div>
      <div class="sc-foot">
        <button type="button" class="primary" id="scriptGo">Generate</button>
        <button type="button" id="scriptRestart" disabled>Restart</button>
        <span class="small faint" id="scriptKeys">${IS_MAC ? '⌘' : 'Ctrl'}+Enter</span>
        <span class="small faint sc-hint" id="scriptHint" aria-live="polite"></span>
        <span class="small sc-undo" id="scriptUndo" role="status" hidden><span>Started over.</span> <button type="button" class="link" id="scriptUndoBtn">Undo</button></span>
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
      <div class="sc-out" id="scriptOut" tabindex="0" role="region" aria-label="Your prompt" aria-busy="false" data-empty="Your prompt appears here."></div>
      <div class="sc-foot sc-foot-out">
        <div class="sc-error" id="scriptError" role="alert" hidden><i class="sc-mark" aria-hidden="true"></i><span id="scriptErrorText"></span><button type="button" id="scriptRetry">Retry</button></div>
        <p class="small faint sc-sent" id="scriptSent" hidden></p>
      </div>
    </div>
  </div>
  </div>
  <details class="sc-history" id="scriptHistory" hidden>
    <summary id="scriptHistorySum">History</summary>
    <ul class="sc-h-list" id="scriptHistoryList"></ul>
    <div class="sc-h-foot">
      <button type="button" id="scriptHistoryClear">Clear history</button>
      <span class="sc-h-ask" id="scriptHistoryAsk" role="group" aria-label="Clear history?" hidden><span class="sc-h-ask-text"></span> <button type="button" id="scriptHistoryYes">Clear all</button> <button type="button" id="scriptHistoryNo">Keep them</button></span>
      <span class="small sc-h-note" id="scriptHistoryNote" aria-live="polite"></span>
    </div>
  </details>
  <aside class="sc-ctx" id="scriptContext" aria-label="Context"></aside>
</div>`
  }

  window.ScriptMarkup = { html, ICON, MUTE_LABEL, MAX }
})()
