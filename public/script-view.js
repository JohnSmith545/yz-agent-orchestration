// The SCRIPT output box's drawing (script-page.js calls it on every delta). It turns the
// parts from script-render.js into DOM and keeps them up to date as the answer streams.
// test/script-view.test.mjs runs it in a vm against a tiny fake DOM.
//
//   ScriptView.create(root) → { render(parts, { live }), clear() }
//   ScriptView.spanNodes(doc, spans) → nodes   the spans as text nodes and strong or code elements
//
// Rules it keeps:
// - ⚠️ Model text is NEVER HTML: every piece goes in with createTextNode or textContent. Only the
//   elements this file makes (p, ol, ul, li, strong, code, the card's rows) are elements.
// - Patch, never redraw: a paragraph, list item, card or row already on screen keeps its element,
//   and only the text that changed is replaced. Their entry animations (script.css: sc-rise) run
//   once, when the element is made, so nothing on screen replays on each delta.
// - While `live`, the class sc-live sits on the ONE element being written (the last paragraph,
//   list item or row text), which draws the blinking caret after it. It moves as the text moves,
//   and goes when the run is over.
;(() => {
  /** Bold, code and plain spans as nodes: text nodes, and strong or code elements set with textContent. */
  function spanNodes(doc, spans) {
    return spans.map(s => {
      if (s.style === 'text') return doc.createTextNode(s.text)
      const e = doc.createElement(s.style === 'strong' ? 'strong' : 'code')
      e.textContent = s.text
      return e
    })
  }

  function create(root) {
    const doc = root.ownerDocument
    let nodes = []
    let liveEl = null

    const make = (tag, cls) => {
      const e = doc.createElement(tag)
      if (cls) e.className = cls
      return e
    }
    const fill = (el, spans) => el.replaceChildren(...spanNodes(doc, spans))
    const sig = v => JSON.stringify(v)
    const keyOf = p => (p.kind === 'list' ? (p.ordered ? 'ol' : 'ul') : p.kind === 'para' ? (p.note ? 'note' : 'para') : 'prompt')

    // ═══ paragraphs and lists ═══

    function para(p) {
      const n = { key: keyOf(p), el: make('p', p.note ? 'sc-para sc-note' : 'sc-para'), sig: '' }
      patchPara(n, p)
      return n
    }
    function patchPara(n, p) {
      const s = sig(p.spans)
      if (s !== n.sig) (fill(n.el, p.spans), (n.sig = s))
    }

    function list(p) {
      const n = { key: keyOf(p), el: make(p.ordered ? 'ol' : 'ul', p.note ? 'sc-list sc-note' : 'sc-list'), items: [] }
      patchList(n, p)
      return n
    }
    function patchList(n, p) {
      if (p.ordered && p.start !== 1) n.el.setAttribute('start', String(p.start))
      else n.el.removeAttribute('start')
      p.items.forEach((spans, i) => {
        let it = n.items[i]
        if (!it) {
          it = n.items[i] = { el: make('li'), sig: '' }
          n.el.appendChild(it.el)
        }
        const s = sig(spans)
        if (s !== it.sig) (fill(it.el, spans), (it.sig = s))
      })
      while (n.items.length > p.items.length) n.items.pop().el.remove()
    }

    // ═══ the prompt card: an optional plain lead, then one row per section ═══

    function card(p) {
      const n = { key: 'prompt', el: make('div', 'sc-card'), lead: null, rows: [] }
      n.el.setAttribute('role', 'group')
      n.el.setAttribute('aria-label', 'The prompt')
      patchCard(n, p)
      return n
    }
    function row(sec) {
      const el = make('div', 'sc-row')
      el.setAttribute('data-section', sec.name)
      const badge = make('span', 'sc-badge')
      badge.setAttribute('aria-hidden', 'true')
      badge.textContent = sec.letter
      const label = make('span', 'sc-row-label')
      label.textContent = sec.name
      const text = make('div', 'sc-row-text')
      text.textContent = sec.text
      el.append(badge, label, text)
      return { el, name: sec.name, textEl: text, text: sec.text }
    }
    function patchCard(n, p) {
      if (p.lead && !n.lead) {
        n.lead = { el: make('div', 'sc-lead'), text: null }
        n.el.insertBefore(n.lead.el, n.el.firstChild)
      } else if (!p.lead && n.lead) {
        n.lead.el.remove()
        n.lead = null
      }
      if (n.lead && n.lead.text !== p.lead) (n.lead.el.textContent = p.lead), (n.lead.text = p.lead)
      p.sections.forEach((sec, i) => {
        const r = n.rows[i]
        if (!r) n.el.appendChild((n.rows[i] = row(sec)).el)
        else if (r.name !== sec.name) {
          const fresh = row(sec)
          r.el.replaceWith(fresh.el)
          n.rows[i] = fresh
        } else if (r.text !== sec.text) (r.textEl.textContent = sec.text), (r.text = sec.text)
      })
      while (n.rows.length > p.sections.length) n.rows.pop().el.remove()
    }

    // ═══ the list of parts ═══

    const build = p => (p.kind === 'para' ? para(p) : p.kind === 'list' ? list(p) : card(p))
    const patch = (n, p) => (p.kind === 'para' ? patchPara(n, p) : p.kind === 'list' ? patchList(n, p) : patchCard(n, p))
    const tailOf = n => (n.items ? n.items.at(-1)?.el ?? n.el : n.rows ? n.rows.at(-1)?.textEl ?? n.lead?.el ?? n.el : n.el)

    function render(parts, { live = false } = {}) {
      parts.forEach((p, i) => {
        const n = nodes[i]
        if (n && n.key === keyOf(p)) return patch(n, p)
        const fresh = build(p)
        if (n) n.el.replaceWith(fresh.el)
        else root.appendChild(fresh.el)
        nodes[i] = fresh
      })
      while (nodes.length > parts.length) nodes.pop().el.remove()
      const tail = live && nodes.length ? tailOf(nodes.at(-1)) : null
      if (tail !== liveEl) {
        liveEl?.classList.remove('sc-live')
        tail?.classList.add('sc-live')
        liveEl = tail
      }
    }

    function clear() {
      root.replaceChildren()
      nodes = []
      liveEl = null
    }

    return { render, clear }
  }

  window.ScriptView = { create, spanNodes }
})()
