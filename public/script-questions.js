// The SCRIPT questions pop-up, the pure side (script-ask.js draws it; no DOM here, so
// test/script-questions.test.mjs runs it in a vm). Needs script-text.js and script-render.js.
//
//   ScriptQuestions.split(text)       { lead, items, tail } or null. `items` are the questions, in
//                                     order, each { n, spans }: numbered or bulleted lines from the
//                                     renderer, `n` the number the answer gets (the list's own number,
//                                     or 1, 2, 3 for bullets). `lead` and `tail` are the renderer's
//                                     paragraph parts around them, shown as quiet text. null when there
//                                     are no items: the pop-up then shows the whole text with ONE field.
//   ScriptQuestions.title(split)      the pop-up's head: "Brainstorming has 3 questions".
//   ScriptQuestions.answersText(split, answers)   the answers as Generate again sends them: a
//                                     numbered list matching the questions, "(no answer)" for an
//                                     empty one; with no items, the one answer as typed.
//   ScriptQuestions.hasAnswer(answers)  at least one field has words.
//
// Text in, plain data out: the spans are text, never HTML, like everything from script-render.js.
;(() => {
  const R = window.ScriptRender
  const NONE = '(no answer)'

  function split(text) {
    const parts = R.parts(text).filter(p => p.kind !== 'prompt')
    const first = parts.findIndex(p => p.kind === 'list')
    if (first < 0) return null
    const items = []
    for (const p of parts) {
      if (p.kind !== 'list') continue
      p.items.forEach((spans, k) => items.push({ n: p.ordered ? p.start + k : items.length + 1, spans }))
    }
    return { lead: parts.slice(0, first), items, tail: parts.slice(first).filter(p => p.kind !== 'list') }
  }

  function title(s) {
    if (!s) return 'Brainstorming has a question'
    return `Brainstorming has ${s.items.length} question${s.items.length === 1 ? '' : 's'}`
  }

  const clean = a => String(a ?? '').trim()

  function answersText(s, answers) {
    const list = Array.isArray(answers) ? answers : []
    if (!s) return clean(list[0])
    return s.items.map((it, i) => `${it.n}. ${clean(list[i]) || NONE}`).join('\n')
  }

  const hasAnswer = answers => (Array.isArray(answers) ? answers : []).some(a => clean(a))

  window.ScriptQuestions = { split, title, answersText, hasAnswer }
})()
