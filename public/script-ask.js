// The SCRIPT questions pop-up (the user, 2026-11-24: "if prompt generator asks add a question
// pop up on it's text box"). When a run ends on questions, it opens over the Your thoughts box:
// a head that says how many questions, each question with its own answer field, then
// "Answer and generate" and "Later". The split and the answers' wording are pure, in
// script-questions.js; script-page.js decides when it is open (ScriptState `asking`).
//
//   ScriptAsk.create(host, { onSubmit(answers), onLater(answers) })
//       → { open(questionsText), close(), forget(), isOpen() }
//     host       the left box (.sc-box, position: relative). The pop-up is laid over it, so
//                nothing shifts and the two boxes stay aligned; it scrolls inside itself.
//     onSubmit   "Answer and generate", or Ctrl or Cmd with Enter, with at least one answer:
//                gets the answers as ScriptQuestions.answersText writes them.
//     onLater    "Later", Escape or the close button: gets that text, or '' when nothing was typed.
//     open       draws the questions (the same questions keep what was typed), shows it and puts
//                the focus in the first field. close hides it and puts the focus back.
//     forget     drops what was typed (Restart).
//
// Rules it keeps:
// - ⚠️ Text is NEVER HTML: the questions are text nodes and strong or code elements
//   (ScriptView.spanNodes); every label is textContent.
// - Escape is taken on the document in capture, with preventDefault and stopPropagation, so one
//   Escape closes the pop-up only, never the chat drawer too (shell.js, help.js).
// - Tab and Shift+Tab stay inside while it is open; it is a dialog named by its head.
;(() => {
  if (!window.document) return
  const Q = () => window.ScriptQuestions
  const FOCUSABLE = 'button:not([disabled]):not([hidden]), textarea:not([disabled])'

  function create(host, { onSubmit = () => {}, onLater = () => {} } = {}) {
    const doc = host.ownerDocument
    const make = (tag, cls, text) => {
      const e = doc.createElement(tag)
      if (cls) e.className = cls
      if (text != null) e.textContent = text
      return e
    }
    const box = make('div', 'sc-ask')
    box.id = 'scriptAsk'
    box.hidden = true
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('aria-labelledby', 'scriptAskTitle')
    const head = make('div', 'sc-ask-head')
    const title = make('h3', 'sc-ask-title')
    title.id = 'scriptAskTitle'
    const x = make('button', 'sc-ask-x', '×')
    x.type = 'button'
    x.setAttribute('aria-label', 'Close the questions')
    head.append(title, x)
    const body = make('div', 'sc-ask-body')
    const foot = make('div', 'sc-ask-foot')
    const go = make('button', 'primary', 'Answer and generate')
    go.type = 'button'
    const later = make('button', '', 'Later')
    later.type = 'button'
    const hint = make('span', 'small sc-ask-hint')
    hint.setAttribute('aria-live', 'polite')
    foot.append(go, later, hint)
    box.append(head, body, foot)
    host.appendChild(box)

    let key = null
    let split = null
    let fields = []
    let back = null

    /** Quiet text above or below the questions: the renderer's paragraphs, as text. */
    const note = p => {
      const el = make('p', 'sc-ask-note')
      el.append(...window.ScriptView.spanNodes(doc, p.kind === 'list' ? p.items.flat() : p.spans))
      return el
    }

    function build(text) {
      key = text
      split = Q().split(text)
      fields = []
      body.replaceChildren()
      title.textContent = Q().title(split)
      if (!split) {
        const whole = make('p', 'sc-ask-whole', text.trim())
        whole.id = 'scriptAskQ0'
        const ta = make('textarea', 'sc-text')
        ta.setAttribute('aria-labelledby', 'scriptAskQ0')
        ta.rows = 4
        fields.push(ta)
        body.append(whole, ta)
        return
      }
      split.lead.forEach(p => body.appendChild(note(p)))
      const list = make('ol', 'sc-ask-list')
      split.items.forEach((it, i) => {
        const li = make('li')
        li.value = it.n
        const q = make('p', 'sc-ask-q')
        q.id = `scriptAskQ${i}`
        q.append(...window.ScriptView.spanNodes(doc, it.spans))
        const ta = make('textarea', 'sc-text')
        ta.setAttribute('aria-labelledby', q.id)
        ta.rows = 2
        fields.push(ta)
        li.append(q, ta)
        list.appendChild(li)
      })
      body.appendChild(list)
      split.tail.forEach(p => body.appendChild(note(p)))
    }

    const answers = () => fields.map(f => f.value)
    const text = () => (Q().hasAnswer(answers()) ? Q().answersText(split, answers()) : '')

    function submit() {
      if (!Q().hasAnswer(answers())) {
        hint.textContent = 'Answer at least one question.'
        fields[0]?.focus()
        return
      }
      onSubmit(Q().answersText(split, answers()))
    }

    go.addEventListener('click', submit)
    later.addEventListener('click', () => onLater(text()))
    x.addEventListener('click', () => onLater(text()))
    box.addEventListener('input', () => (hint.textContent = ''))
    box.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        submit()
      } else if (e.key === 'Tab') {
        const all = [...box.querySelectorAll(FOCUSABLE)]
        const i = all.indexOf(doc.activeElement)
        if (e.shiftKey && i <= 0) (e.preventDefault(), all.at(-1)?.focus())
        else if (!e.shiftKey && i === all.length - 1) (e.preventDefault(), all[0]?.focus())
      }
    })
    // Capture: one Escape closes one thing, before the shell closes the drawer.
    doc.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || box.hidden || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      onLater(text())
    }, true)

    function open(questions) {
      const t = String(questions ?? '')
      if (t !== key) build(t)
      hint.textContent = ''
      if (!box.hidden) return
      const active = doc.activeElement
      back = active && !box.contains(active) ? active : null
      box.hidden = false
      body.scrollTop = 0
      fields[0]?.focus({ preventScroll: true })
    }

    function close() {
      if (box.hidden) return
      const hadFocus = box.contains(doc.activeElement)
      box.hidden = true
      // back where it was; when that was nowhere (Generate was disabled during the run), the
      // answers box that now holds what was typed, else Your thoughts
      const usable = back && back !== doc.body && back.isConnected && !back.disabled
      const fallback = host.querySelector('.sc-answers:not([hidden]) textarea') || host.querySelector('textarea')
      if (hadFocus) (usable ? back : fallback)?.focus({ preventScroll: true })
      back = null
    }

    function forget() {
      key = null
      fields.forEach(f => (f.value = ''))
    }

    return { open, close, forget, isOpen: () => !box.hidden }
  }

  window.ScriptAsk = { create }
})()
