// Explain (spec 7): the ONE popover every explanation uses, and the selection
// bubble.
//
//   - a word: a term chip or any <dfn data-term> opens its card on hover, focus
//     or click. term-card.js draws that card into this popover (show).
//   - any page text you select (2 to 500 characters, outside inputs, textareas
//     and the chat drawer): a small Explain bubble appears by the selection.
//     A selection the glossary knows (the shared store, glossary-store.js)
//     shows its entry; anything else asks POST /api/explain, one cheap headless
//     turn (explain.mjs), and shows its answer with the cost. A short selection
//     the server saved as a learned word refreshes the store. On any failure
//     the popover says exactly "Couldn't explain that", with the Ask link.
//
// window.Explain = { show(html, rect, { anchor, held }), close(), isOpen(),
// explainText(text, rect?, node?), ask(text), onClose(fn), pop }. explainText
// resolves to what it showed: the entry, the answer ({ text, cost, from, saved })
// or { error }.
//
// The popover is position: fixed and closes on Escape (one Escape closes one
// thing: an edit in the card first, term-card.js), an outside press, or a
// scroll that moves what it explains (the page, or a box holding the word or
// the selected text: the chat log streaming elsewhere leaves it open); z-index
// 45 puts it above the chat drawer (35), under toasts (80).
;(() => {
  const doc = document
  const MIN = 2
  const MAX = 500 // MUST CHANGE IN LOCKSTEP with explain.mjs EXPLAIN_MAX
  const CLIENT_TIMEOUT_MS = 25_000 // the server gives the turn 20 s
  const FAILED = "Couldn't explain that"
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const G = () => window.Glossary

  // ═══ the popover ═══

  const pop = doc.createElement('div')
  pop.className = 'xp-pop'
  pop.hidden = true
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', 'Explanation')
  doc.body.appendChild(pop)
  let askTerm = ''
  let held = null // what the popover explains on the page (the word, or the selected text): a scroll must move it to close
  let generation = 0 // bumped on every show and close; a late answer for an older one is dropped
  const closers = []

  /** Puts `html` in the popover and places it under the rect (above when there is no room), inside the viewport. */
  function paint(html, rect) {
    pop.innerHTML = html
    pop.hidden = false
    const M = 8
    const vw = window.innerWidth || 1024
    const vh = window.innerHeight || 768
    const r = rect || { left: M, top: M, bottom: M, width: 0 }
    const w = pop.offsetWidth || 320
    const h = pop.offsetHeight || 120
    const x = Math.max(M, Math.min(r.left, vw - w - M))
    const y = r.bottom + M + h <= vh - M ? r.bottom + M : Math.max(M, r.top - h - M)
    pop.style.left = `${x}px`
    pop.style.top = `${y}px`
  }
  /** The popover for someone else's content (the word card): anything still loading for an older one is dropped. */
  function show(html, rect, { held: h = null } = {}) {
    generation++
    held = h
    hideBubble()
    paint(html, rect)
  }
  /** Tells the card (term-card.js) the popover is no longer its own. */
  const release = () => closers.forEach(fn => fn())

  const askLink = '<div class="xp-foot"><button type="button" class="link xp-ask">Ask Independent about this</button></div>'
  const costNote = cost => (typeof cost === 'number' && Number.isFinite(cost) ? `cost $${cost.toFixed(cost < 0.01 ? 4 : 2)}` : 'cost ~$0.01')
  const entryHtml = (e, title) =>
    `<div class="xp-term">${esc(title || e.term)}</div><p class="xp-short">${esc(e.short)}</p>` +
    (e.more ? `<details class="xp-more"><summary>More</summary><p>${esc(e.more)}</p></details>` : '') + askLink
  const answerHtml = (text, a) => `<div class="xp-term">${esc(text)}</div><p class="xp-short">${esc(a.text)}</p><div class="xp-cost">${costNote(a.cost)}</div>` + askLink
  const failedHtml = text => `<div class="xp-term">${esc(text)}</div><p class="xp-short xp-failed">${FAILED}</p>` + askLink

  function close() {
    generation++
    pop.hidden = true
    held = null
    hideBubble()
    release()
  }

  /** A selection: its glossary entry when the store has it, else one fallback turn. `node` is where the text sits on the page. */
  async function explainText(text, rect, node) {
    const raw = String(text ?? '').trim()
    if (raw.length < MIN || raw.length > MAX) return { error: `select ${MIN} to ${MAX} characters` }
    const mine = ++generation
    release()
    held = node || null
    askTerm = raw
    await G()?.ready
    if (mine !== generation) return { error: 'closed' }
    const e = G()?.get(raw)
    if (e) {
      paint(entryHtml(e, raw), rect)
      return e
    }
    paint(`<div class="xp-term">${esc(raw)}</div><p class="xp-short xp-wait">Explaining…</p>`, rect)
    const a = await ask(raw)
    if (a.saved) void G()?.refresh()
    if (mine !== generation) return a
    paint(a.error ? failedHtml(raw) : answerHtml(raw, a), rect)
    return a
  }

  /** POST /api/explain; resolves { text, cost, from, saved } or { error }, never rejects. */
  async function ask(text) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null
    const timer = ctl ? setTimeout(() => ctl.abort(), CLIENT_TIMEOUT_MS) : 0
    try {
      const r = await fetch('/api/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: ctl?.signal })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || typeof j.text !== 'string' || !j.text.trim()) return { error: j.error || `status ${r.status}` }
      return { text: j.text, cost: typeof j.cost === 'number' ? j.cost : null, from: j.from || 'model', saved: !!j.saved }
    } catch (err) {
      return { error: err?.message || 'failed' }
    } finally {
      clearTimeout(timer)
      void window.Spend?.refresh?.() // the turn may have cost something: the rail chip catches up now, not on its next poll
    }
  }

  pop.addEventListener('click', e => {
    if (!e.target?.closest?.('.xp-ask')) return
    e.preventDefault()
    const term = askTerm
    close()
    window.Shell?.drawer?.open?.()
    window.FactoryChat?.prefill?.(`Explain "${term}" in the context of this dashboard: `)
  })

  // ═══ the selection bubble ═══

  const bubble = doc.createElement('button')
  bubble.type = 'button'
  bubble.className = 'xp-bubble'
  bubble.hidden = true
  bubble.textContent = 'Explain'
  doc.body.appendChild(bubble)
  let bubbleText = ''
  let bubbleRect = null
  let bubbleNode = null // the selected text's node, so only a scroll that moves it hides the bubble
  function hideBubble() {
    bubble.hidden = true
    bubbleText = ''
    bubbleNode = null
  }
  /** True when the node sits where a selection must not offer Explain: a field, the chat drawer, our own popover. */
  function offLimits(node) {
    const elOf = node && (node.nodeType === 1 ? node : node.parentElement)
    return !elOf || !!elOf.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], #drawer, .xp-pop, .xp-bubble')
  }
  function onSelect(e) {
    if (e?.target === bubble) return
    setTimeout(() => {
      const s = window.getSelection?.()
      const text = s && s.rangeCount ? s.toString().trim() : ''
      const active = doc.activeElement
      if (text.length < MIN || text.length > MAX || offLimits(s.anchorNode) || offLimits(s.focusNode) || (active && /^(INPUT|TEXTAREA)$/.test(active.tagName))) return hideBubble()
      const range = s.getRangeAt(0)
      const r = range.getBoundingClientRect()
      bubbleText = text
      bubbleNode = range.commonAncestorContainer || s.anchorNode
      bubbleRect = { left: r.left, top: r.top, bottom: r.bottom, width: r.width }
      const vw = window.innerWidth || 1024
      bubble.style.left = `${Math.max(8, Math.min(r.right - 8, vw - 90))}px`
      bubble.style.top = `${r.bottom + 6}px`
      bubble.hidden = false
    }, 0)
  }
  bubble.addEventListener('mousedown', e => e.preventDefault()) // keeps the selection while the click lands
  bubble.addEventListener('click', () => {
    const text = bubbleText
    const rect = bubbleRect
    const node = bubbleNode
    hideBubble()
    if (text) void explainText(text, rect, node)
  })

  // ═══ wiring ═══

  if (doc.addEventListener) {
    doc.addEventListener(
      'keydown',
      e => {
        if (e.key !== 'Escape' || (pop.hidden && bubble.hidden)) return
        // Before the shell's own Escape (which closes the chat drawer): one Escape closes one thing.
        e.preventDefault()
        if (!pop.hidden && window.TermCard?.escape?.()) return // an edit in the card is cancelled first
        close()
      },
      true,
    )
    doc.addEventListener(
      'mousedown',
      e => {
        if (pop.hidden || pop.contains(e.target) || e.target === bubble || e.target?.closest?.('dfn[data-term]')) return
        close()
      },
      true,
    )
    // Only a scroll that carries the thing away closes it (help.js does the same):
    // the page, or a box holding the word or the selected text.
    const moves = (t, node) => t === doc || (!!node && !!t?.contains?.(node))
    doc.addEventListener(
      'scroll',
      e => {
        const t = e.target
        if (pop.contains(t)) return
        if (!pop.hidden && moves(t, held)) close()
        if (!bubble.hidden && moves(t, bubbleNode)) hideBubble()
      },
      { capture: true, passive: true },
    )
    doc.addEventListener('mouseup', onSelect)
    doc.addEventListener('keyup', e => {
      if (e.key !== 'Escape') onSelect(e)
    })
    window.addEventListener?.('resize', close)
  }

  window.Explain = {
    show,
    close,
    isOpen: () => !pop.hidden,
    explainText,
    ask,
    onClose: fn => closers.push(fn),
    pop,
  }
})()
