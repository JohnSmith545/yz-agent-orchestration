// Marked words on the page: an agent writes a technical word in square brackets
// (`Checked the code for [idempotency]`) and the page shows it as a term chip,
// a <dfn> that explains itself on hover (term-card.js, from the shared glossary
// store, glossary-store.js). Pure, no DOM, so test/terms-page.test.mjs runs it.
//
//   normalise(word)    the glossary key: MUST CHANGE IN LOCKSTEP with terms.mjs normalise
//   find(text)         the marked words of raw text, each once: MUST CHANGE IN LOCKSTEP with terms.mjs findTerms
//   html(escaped)      ALREADY-ESCAPED text (or md() output) with every marked word as a chip
//   plain(text)        raw text with the brackets of marked words dropped: SVG labels and tooltips
//   sentence(text, w)  the sentence of `text` that holds `w`, at most 300 characters (Ask the agent)
//
// What counts as a marked word, exactly as the server reads it: the text in ONE
// pair of brackets, trimmed, 2 to 40 characters, on one line, made of letters,
// digits, spaces and . - _ + # / only, never a dash first (no tag, quote,
// bracket or shell character);
// never a markdown link or image, a reference link, a checkbox, or a diagram
// kind prefix ([actor] [store] [decision] [box]); `[[x]]` is the word x.
//
// ⚠️ html() works on text that is already escaped: it only ever wraps a run of
// that text in a <dfn>, and it re-escapes the raw word for the attributes. It
// never looks inside a tag, nor inside <code>, <pre>, <a> or an existing <dfn>.
;(() => {
  const TERM_MIN = 2 // MUST CHANGE IN LOCKSTEP with terms.mjs
  const TERM_MAX = 40
  const SENTENCE_MAX = 300
  const KINDS = ['actor', 'store', 'decision', 'box'] // diagram-text.mjs DIAGRAM_KINDS
  const MARK = /\[([^[\]\r\n]*)\](?![([])/g
  // letters of any script, digits, spaces and . - _ + # / only, never a dash first (terms.mjs WORD)
  const WORD = /^(?!-)[\p{L}\p{M}\p{N} ._+#/-]+$/u
  const KEEP_S = new Set(['alias', 'atlas', 'bias', 'bus', 'canvas', 'chaos', 'ethos', 'gas', 'kubernetes', 'lens', 'news', 'series', 'species', 'status'])
  const KEEP_E = new Set(['cache', 'niche', 'headache', 'avalanche', 'moustache'])
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const unesc = s => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e])

  // terms.mjs singular and normalise, in step (idempotent)
  function singular(w) {
    if (w.length < 5 || KEEP_S.has(w) || /(ss|us|is)$/.test(w) || /^[0-9]+s$/.test(w)) return w
    const es = /^(.*(?:ss|x|ch|sh))es$/.exec(w)
    if (es) return KEEP_E.has(`${es[1]}e`) ? `${es[1]}e` : es[1]
    const kept = /^(.*)es$/.exec(w)
    if (kept && KEEP_S.has(kept[1])) return kept[1]
    return w.endsWith('s') ? w.slice(0, -1) : w
  }

  function normalise(term) {
    const key = String(term ?? '')
      .replace(/\b((?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,})s\b/g, '$1')
      .toLowerCase()
      .replace(/[\s_-]+/g, ' ')
      .replace(/^[\s"'“‘(\[{]+|[\s"'”’)\]}.,:;!?]+$/g, '')
      .trim()
    return key.replace(/([a-z0-9]+)$/, w => singular(w))
  }

  /** The word of one match, or null when the match is not a marked word. `raw` is the bracket content as written. */
  function word(raw, text, at) {
    if (at > 0 && text[at - 1] === '!') return null // an image ![alt](src)
    const term = raw.trim().replace(/\s+/g, ' ')
    if (term.length < TERM_MIN || term.length > TERM_MAX || KINDS.includes(term.toLowerCase()) || !WORD.test(term)) return null
    return normalise(term) ? term : null
  }

  /** Every marked word in `text`, in order, each once by key, the first spelling kept. */
  function find(text) {
    if (typeof text !== 'string' || !text.includes('[')) return []
    const out = []
    const seen = new Set()
    for (const m of text.matchAll(MARK)) {
      const term = word(m[1], text, m.index)
      if (!term || seen.has(normalise(term))) continue
      seen.add(normalise(term))
      out.push(term)
    }
    return out
  }

  /** `text` with each marked word replaced by what `wrap(term, shown)` returns; `[[x]]` loses both pairs. */
  function each(text, decode, wrap) {
    let out = ''
    let from = 0
    for (const m of text.matchAll(MARK)) {
      const term = word(decode(m[1]), text, m.index)
      if (!term) continue
      const outer = text[m.index - 1] === '[' && text[m.index + m[0].length] === ']'
      const start = outer ? m.index - 1 : m.index
      if (start < from) continue
      out += text.slice(from, start) + wrap(term, m[1].trim())
      from = m.index + m[0].length + (outer ? 1 : 0)
    }
    return out + text.slice(from)
  }

  const chip = (term, shown) =>
    `<dfn class="t-chip" data-term="${esc(normalise(term))}" data-raw="${esc(term)}" tabindex="0">${shown.replace(/\s+/g, ' ')}</dfn>`
  const SKIP = /^<(\/?)(code|pre|a|dfn|script|style|textarea)\b/i

  function html(escaped) {
    const parts = String(escaped ?? '').split(/(<[^>]*>)/)
    let skip = 0
    return parts.map(p => {
      if (p.startsWith('<')) {
        const m = SKIP.exec(p)
        if (m) skip = Math.max(0, skip + (m[1] ? -1 : 1))
        return p
      }
      return skip || !p.includes('[') ? p : each(p, unesc, chip)
    }).join('')
  }

  const plain = text => (text == null ? '' : each(String(text), s => s, term => term))

  function sentence(text, w) {
    const all = String(text ?? '').replace(/\s+/g, ' ').trim()
    const needle = String(w ?? '').trim().toLowerCase()
    const s = all.split(/(?<=[.!?])\s+/).find(x => x.toLowerCase().includes(needle)) || all
    if (s.length <= SENTENCE_MAX) return s
    const at = Math.max(0, s.toLowerCase().indexOf(needle))
    const start = Math.max(0, Math.min(at - Math.floor(SENTENCE_MAX / 2), s.length - SENTENCE_MAX))
    return s.slice(start, start + SENTENCE_MAX)
  }

  window.Terms = { normalise, find, html, plain, sentence, TERM_MIN, TERM_MAX }
})()
