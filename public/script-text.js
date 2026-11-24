// The SCRIPT page's pure text functions (public/script-page.js uses them on every
// delta). No DOM, no state: test/script-text.test.mjs runs this file in a vm.
//
//   ScriptText.SECTIONS             the six labels, one per letter: S C R I P T
//   ScriptText.codeBlock(text)      the FIRST fenced block as { code, lang, closed }, or null.
//                                   Mid-stream an unclosed block gives what has arrived so far,
//                                   minus a closing fence still streaming in. `code` never holds
//                                   the fences, the language tag, or anything after the block.
//   ScriptText.blockSpan(text)      the same block with what is around it, for the renderer
//                                   (script-render.js): { before, code, lang, closed, after }, or
//                                   null. `before` ends at the opening fence line; `after` starts
//                                   past the closing one ('' while the block is still open).
//   ScriptText.labelOf(line)        { name, rest } when the line is a section label, else null.
//   ScriptText.sectionsStarted(t)   the sections whose label line has started INSIDE the block,
//                                   in SCRIPT order. A label is a line that starts with it,
//                                   tolerating leading spaces and markdown bold, then a colon.
//   ScriptText.finished(t, ended)   the completion moment: Tone has started and the block has
//                                   closed, or the stream ended well (`ended`) with all six seen.
//   ScriptText.classify(t)          a finished answer: 'prompt' (it has a code block),
//                                   'questions' (it has none: the model asked first), or 'empty'.
//   ScriptText.followUp(o, q, a, p) what Generate again sends after the questions. `p` is what the last
//                                   run sent: when it was already a follow-up of the same idea `o`, the
//                                   new answers go after it, so a SECOND round of questions keeps the
//                                   first round's answers (the model remembers nothing between runs).
;(() => {
  const SECTIONS = Object.freeze(['Situation', 'Character', 'Request', 'Intent', 'Presentation', 'Tone'])
  // The brief's label rule, applied line by line inside the code block (labelOf).
  const LABEL = /^\s*(?:\*\*)?(Situation|Character|Request|Intent|Presentation|Tone)(?:\*\*)?\s*:/
  const OPEN = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/
  const ANSWERS = 'Answers to your questions:'

  const lines = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n')

  function blockSpan(text) {
    const all = lines(text)
    // Only a COMPLETE fence line opens a block: the last line has no newline after it yet.
    let at = -1
    let fence = ''
    let lang = ''
    for (let i = 0; i < all.length - 1; i++) {
      const m = OPEN.exec(all[i])
      if (!m || (m[1][0] === '`' && m[2].includes('`'))) continue
      at = i
      fence = m[1]
      lang = m[2].trim().split(/\s+/)[0] || ''
      break
    }
    if (at < 0) return null
    const char = fence[0]
    const isClose = l => {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l)
      return Boolean(m && m[1][0] === char && m[1].length >= fence.length)
    }
    const before = all.slice(0, at).join('\n')
    const body = []
    for (let i = at + 1; i < all.length; i++) {
      if (isClose(all[i])) return { before, code: body.join('\n'), lang, closed: true, after: all.slice(i + 1).join('\n') }
      body.push(all[i])
    }
    // Unclosed: drop the line still streaming when it is the start of a closing fence, and a trailing blank.
    const last = body.at(-1)
    const partialFence = new RegExp(`^ {0,3}\\${char}+$`)
    if (last !== undefined && (last === '' || partialFence.test(last))) body.pop()
    return { before, code: body.join('\n'), lang, closed: false, after: '' }
  }

  function codeBlock(text) {
    const s = blockSpan(text)
    return s && { code: s.code, lang: s.lang, closed: s.closed }
  }

  function labelOf(line) {
    const m = LABEL.exec(String(line ?? ''))
    if (!m) return null
    // `**Situation:** text` leaves the closing ** after the colon: it belongs to the label, not the text.
    return { name: m[1], rest: String(line).slice(m[0].length).replace(/^\*\*/, '').trimStart() }
  }

  function sectionsStarted(text) {
    const b = codeBlock(text)
    if (!b) return []
    const seen = new Set()
    for (const l of b.code.split('\n')) seen.add(labelOf(l)?.name)
    return SECTIONS.filter(s => seen.has(s))
  }

  function finished(text, ended = false) {
    const b = codeBlock(text)
    if (!b) return false
    const seen = sectionsStarted(text)
    if (b.closed && seen.includes('Tone')) return true
    return Boolean(ended) && seen.length === SECTIONS.length
  }

  function classify(text) {
    if (!String(text ?? '').trim()) return 'empty'
    return codeBlock(text) ? 'prompt' : 'questions'
  }

  /** Trim blank lines (and the spaces on them) from both ends, keeping everything between. */
  const trimLines = s => String(s ?? '').replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '')

  function followUp(original, questions, answers, previous = '') {
    const idea = String(original ?? '')
    // ⚠️ Only a chain that starts with THIS idea goes on: an edited idea starts the answers over.
    const chained = typeof previous === 'string' && previous.startsWith(`${idea}\n\n${ANSWERS}\n`)
    return `${chained ? previous : idea}\n\n${ANSWERS}\n${trimLines(questions)}\n\n${trimLines(answers)}`
  }

  window.ScriptText = { SECTIONS, codeBlock, blockSpan, labelOf, sectionsStarted, finished, classify, followUp }
})()
