// The SCRIPT answer as parts to draw (script-view.js draws them; no DOM here, so
// test/script-render.test.mjs runs it in a vm). Needs script-text.js first.
//
//   ScriptRender.parts(text, { live })  → a list of parts, in order:
//       { kind: 'para', note, spans }                     a paragraph of prose
//       { kind: 'list', ordered, start, note, items }     a numbered or bulleted list, items are spans;
//                                                         `nested: true` on a bulleted list indented under,
//                                                         or right under, a numbered item (a question's
//                                                         choices: script-questions.js keeps them with it)
//       { kind: 'prompt', lead, sections, closed }        the code block as a card: `lead` is plain text
//                                                         before the first label, `sections` are
//                                                         { name, letter, text } in the order written
//     A span is { style: 'text' | 'strong' | 'code', text }. `note` is true for prose AFTER the block
//     (the assumptions line), which the page shows small and quiet.
//
// Rules it keeps:
// - Text in, plain data out. Nothing here is HTML: the view sets every span with textContent.
// - ⚠️ The card shows the block's text as it is. Copy (ScriptText.codeBlock) is not affected: it
//   still copies the block exactly, label lines and all.
// - `live` is true while the run streams. Then anything that could still turn into a mark is held
//   back for a moment instead of flashing raw: a fence line being typed, a list number without its
//   text yet, a lone `*` that may become `**`, a section label not yet at its colon. An open `**` or
//   backtick styles the rest of the text, since its close is on the way. Finished text is strict: an
//   unpaired `**` or backtick stays as written.
;(() => {
  const T = window.ScriptText
  const OL = /^\s*(\d{1,9})[.)]\s+(.*)$/
  const UL = /^\s*[-*•+]\s+(.*)$/
  // a last line that may still become a fence, a list item or a bullet (live only)
  const HOLD = [/^ {0,3}(?:`{1,2}|~{1,2})$/, /^ {0,3}(?:`{3,}|~{3,})[^`]*$/, /^\s*\d{1,9}[.)]?$/, /^\s*[-*•+]$/]

  const trimLines = s => String(s ?? '').replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '')

  /** Bold and code spans in one paragraph or item. Code spans stay on one line; bold may cross lines. */
  function inline(s, live) {
    // First pass: which ** markers pair up (outside code spans). An odd last one is literal unless live.
    const stars = []
    for (let i = 0; i < s.length; ) {
      const close = s[i] === '`' ? codeEnd(s, i) : -1
      if (close > 0) i = close + 1
      else if (s.startsWith('**', i)) (stars.push(i), (i += 2))
      else i++
    }
    const literal = stars.length % 2 && !live ? stars.at(-1) : -1
    const out = []
    let buf = ''
    let bold = false
    const flush = () => {
      if (!buf) return
      const style = bold ? 'strong' : 'text'
      const prev = out.at(-1)
      if (prev?.style === style) prev.text += buf
      else out.push({ style, text: buf })
      buf = ''
    }
    for (let i = 0; i < s.length; ) {
      if (s[i] === '`') {
        const close = codeEnd(s, i)
        if (close > 0) {
          flush()
          out.push({ style: 'code', text: s.slice(i + 1, close) })
          i = close + 1
          continue
        }
        if (live && !s.includes('\n', i)) {
          flush() // an open code span at the tail: the rest is code
          if (s.length > i + 1) out.push({ style: 'code', text: s.slice(i + 1) })
          break
        }
      } else if (s.startsWith('**', i) && i !== literal) {
        flush()
        bold = !bold
        i += 2
        continue
      } else if (live && s[i] === '*' && i === s.length - 1) {
        break // half of a ** still arriving
      }
      buf += s[i]
      i++
    }
    flush()
    return out
  }

  /** The index of the backtick closing a code span opened at `i`, on the same line, or -1. */
  function codeEnd(s, i) {
    const j = s.indexOf('`', i + 1)
    const nl = s.indexOf('\n', i + 1)
    return j > i + 1 && (nl < 0 || j < nl) ? j : -1
  }

  /** Prose into paragraphs and lists. `live` holds back a last line that is still becoming a mark. */
  function prose(text, live, note, out) {
    const all = String(text ?? '').split('\n')
    if (live && HOLD.some(r => r.test(all.at(-1)))) all.pop()
    const groups = []
    let cur = null
    for (const line of all) {
      const ol = OL.exec(line)
      const ul = ol ? null : UL.exec(line)
      if (!line.trim()) cur = null
      else if (ol || ul) {
        const ordered = Boolean(ol)
        if (cur?.kind !== 'list' || cur.ordered !== ordered) {
          const under = groups.at(-1)?.kind === 'list' && groups.at(-1).ordered // the last group is a numbered list
          const nested = !ordered && under && (/^\s/.test(line) || cur === groups.at(-1)) // indented, or no blank line between
          groups.push((cur = { kind: 'list', ordered, start: ordered ? Number(ol[1]) : 1, items: [], ...(nested ? { nested } : {}) }))
        }
        cur.items.push(ordered ? ol[2] : ul[1])
      } else if (cur?.kind === 'list' && /^\s+\S/.test(line)) {
        cur.items[cur.items.length - 1] += ' ' + line.trim() // an indented line continues its item
      } else if (cur?.kind === 'para') cur.lines.push(line)
      else groups.push((cur = { kind: 'para', lines: [line] }))
    }
    groups.forEach((g, n) => {
      const tail = live && n === groups.length - 1
      if (g.kind === 'para') out.push({ kind: 'para', note, spans: inline(trimLines(g.lines.join('\n')).trim(), tail) })
      else out.push({ kind: 'list', ordered: g.ordered, start: g.start, note, items: g.items.map((t, k) => inline(t.trim(), tail && k === g.items.length - 1)), ...(g.nested ? { nested: true } : {}) })
    })
  }

  /** A last line in the block that may still become a label (`Char`, `**Tone**`) waits for its colon. */
  function labelComing(line) {
    const m = /^\s*(\**)([A-Za-z]*)\**\s*$/.exec(line)
    if (!m) return false
    return m[2] ? T.SECTIONS.some(s => s.startsWith(m[2])) : Boolean(m[1])
  }

  function prompt(code, live, closed) {
    const all = code.split('\n')
    if (live && all.length && labelComing(all.at(-1))) all.pop()
    const lead = []
    const sections = []
    for (const line of all) {
      const l = T.labelOf(line)
      if (l) sections.push({ name: l.name, letter: l.name[0], lines: [l.rest] })
      else if (sections.length) sections.at(-1).lines.push(line)
      else lead.push(line)
    }
    return {
      kind: 'prompt',
      lead: trimLines(lead.join('\n')),
      sections: sections.map(s => ({ name: s.name, letter: s.letter, text: trimLines(s.lines.join('\n')) })),
      closed,
    }
  }

  function parts(text, { live = false } = {}) {
    const src = String(text ?? '').replace(/\r\n?/g, '\n')
    const out = []
    const span = T.blockSpan(src)
    if (!span) {
      prose(src, live, false, out)
      return out
    }
    prose(span.before, false, false, out)
    out.push(prompt(span.code, live && !span.closed, span.closed))
    if (span.closed) prose(span.after, live, true, out)
    return out
  }

  window.ScriptRender = { parts }
})()
