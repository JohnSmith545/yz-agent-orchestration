// The word card: what a marked word (a term chip, terms.js) or any other
// <dfn data-term> means, drawn into the ONE popover explain.js owns, from the
// shared glossary store (glossary-store.js).
//
//   hover   250 ms over a word opens its card; moving away closes it after
//           200 ms unless the pointer is inside the card
//   focus   the keyboard opens it at once; it closes when the focus leaves
//   click   pins it (Enter or Space too) until Escape or a press outside;
//           any click inside the card pins it as well
//
// The card: the word, its plain explanation, More when the entry has more, a
// tiny source tag (built-in, learned, from the agent, yours) and two actions:
//   Ask the agent  inside a flow (an ancestor with data-flow): POST
//                  /api/flows/<id>/ask-term { term, sentence }. The chat agent's
//                  own flow comes back as text for the Ask drawer (prefilled,
//                  never sent); any other agent gets ONE relay message (about
//                  $0.30) and the card says `sent to <agent>`. Outside a flow it
//                  prefills the Ask drawer.
//   Edit           the explanation as a small textarea; Save posts your wording
//                  (source yours) through the store; Escape cancels.
// A word the store does not know yet reads `Looking this up…` while a learn
// call is waiting for it, else offers `Explain it` (one /api/explain turn for
// that word) next to Ask the agent: never a blank card.
//
// The rail marks no words: a click there follows the link (the rail is
// navigation first), so a dfn inside #rail is ignored here.
;(() => {
  const doc = document
  const OPEN_MS = 250
  const CLOSE_MS = 200
  const COST = 'about $0.30' // one relay turn (spec 7.4a)
  const BLOCK = 'p, li, dd, td, h2, h3, figcaption, summary, .st-text, .sv-row-head' // where a word's sentence is read from
  const SOURCE = { 'built-in': 'built-in', learned: 'learned', agent: 'from the agent', you: 'yours' }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const X = () => window.Explain
  const G = () => window.Glossary
  const T = () => window.Terms

  /** The card on show: { d, key, raw, flowId, rect, pinned, via, mode, note, answer, busy, failed }, or null. */
  let cur = null
  let openT = 0
  let closeT = 0

  const dfnOf = t => {
    const d = t?.closest?.('dfn[data-term]')
    return d && !d.closest('#rail') ? d : null
  }
  const flowOf = id => window.FlowsView?.data?.flows?.find(f => f.id === id)
  const chatName = () => window.FactoryChat?.name || 'Independent'
  const costNote = c => (typeof c === 'number' && Number.isFinite(c) ? `cost $${c.toFixed(c < 0.01 ? 4 : 2)}` : 'cost ~$0.01')

  function askTitle(flowId) {
    if (!flowId) return `Puts the question in the Ask drawer, for ${chatName()}`
    const agent = flowOf(flowId)?.agent
    if (agent && agent === chatName()) return 'Puts the question in the Ask drawer for you to send'
    return `Sends one message to ${agent || 'the agent'} (${COST})`
  }

  // ═══ the card ═══

  function html(c) {
    const e = G()?.get(c.key)
    const tag = e ? `<span class="tc-src">${esc(SOURCE[e.source] || e.source)}</span>` : ''
    const head = `<div class="tc-head"><span class="xp-term">${esc(c.raw || e?.term || c.key)}</span>${tag}</div>`
    const button = (act, label, title = '') => `<button type="button" class="link" data-tc="${act}"${title ? ` title="${esc(title)}"` : ''}>${label}</button>`
    const ask = button('ask', 'Ask the agent', askTitle(c.flowId))
    const note = c.note ? `<p class="tc-note">${esc(c.note)}</p>` : ''
    if (c.mode === 'edit') {
      return `${head}<textarea class="tc-edit" rows="5" maxlength="300" aria-label="Your explanation of ${esc(c.raw)}">${esc(e?.short || c.answer?.text || '')}</textarea>` +
        `<div class="tc-acts"><button type="button" class="primary" data-tc="save">Save</button>${button('cancel', 'Cancel')}</div>${note}`
    }
    let main
    let acts = `${ask}${button('edit', 'Edit')}`
    if (e) main = `<p class="xp-short">${esc(e.short)}</p>` + (e.more ? `<details class="xp-more"><summary>More</summary><p>${esc(e.more)}</p></details>` : '')
    else if (c.answer) main = `<p class="xp-short">${esc(c.answer.text)}</p><div class="xp-cost">${costNote(c.answer.cost)}</div>`
    else if (c.busy) { main = '<p class="xp-short xp-wait">Explaining…</p>'; acts = ask }
    else if (G()?.stateOf(c.key) === 'learning') { main = '<p class="xp-short xp-wait">Looking this up…</p>'; acts = ask }
    else {
      main = `<p class="xp-short xp-wait">${c.failed ? "Couldn't explain that" : 'No explanation yet.'}</p>`
      acts = `${button('explain', 'Explain it', 'One short model turn, about $0.01')}${ask}`
    }
    return `${head}${main}<div class="tc-acts">${acts}</div>${note}`
  }

  function render() {
    if (!cur) return
    const r = cur.d.isConnected === false ? cur.rect : cur.d.getBoundingClientRect?.() || cur.rect
    X().show(html(cur), r, { held: cur.d })
  }

  function open(d, { pin = false, via = 'hover' } = {}) {
    clearTimeout(openT)
    clearTimeout(closeT)
    closeT = 0
    if (cur && cur.d === d && X().isOpen()) {
      if (pin) cur.pinned = true
      if (via !== 'hover') cur.via = via
      return
    }
    const next = {
      d,
      key: T().normalise(d.dataset.term),
      raw: String(d.dataset.raw || d.textContent || d.dataset.term || '').trim(),
      flowId: d.closest('[data-flow]')?.dataset.flow || '',
      rect: d.getBoundingClientRect?.(),
      pinned: pin,
      via,
      mode: 'view',
    }
    cur = null
    X().close()
    cur = next
    render()
  }

  const close = () => X().close()
  function closeSoon() {
    if (closeT) return
    closeT = setTimeout(() => {
      closeT = 0
      if (cur && !cur.pinned) close()
    }, CLOSE_MS)
  }

  // ═══ actions ═══

  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j?.error || `Failed (${r.status})`)
    return j
  }
  function toDrawer(text) {
    close()
    window.Shell?.drawer?.open?.()
    window.FactoryChat?.prefill?.(text)
  }

  const act = {
    async ask(c) {
      if (!c.flowId) return toDrawer(`Explain "${c.raw}" in the context of this dashboard: `)
      const sentence = T().sentence(c.d.closest?.(BLOCK)?.textContent || c.raw, c.raw)
      try {
        const r = await post(`/api/flows/${encodeURIComponent(c.flowId)}/ask-term`, { term: c.raw, sentence })
        if (r.via === 'chat') return toDrawer(r.text)
        c.note = `sent to ${flowOf(c.flowId)?.agent || 'the agent'}`
      } catch (err) {
        c.note = err.message
      }
    },
    edit(c) {
      c.mode = 'edit'
      c.note = ''
    },
    cancel(c) {
      c.mode = 'view'
    },
    async save(c) {
      const short = String(X().pop.querySelector('textarea')?.value ?? '').trim()
      if (!short) return
      const e = G().get(c.key)
      const r = await G().save({ term: e?.term || c.raw, short })
      if (r.error) c.note = r.error
      else c.mode = 'view'
    },
    async explain(c) {
      c.busy = true
      c.failed = false
      if (cur === c) render()
      const a = await X().ask(c.raw)
      c.busy = false
      if (a.error) c.failed = true
      else {
        if (a.saved || a.from === 'glossary') await G()?.refresh()
        if (!G()?.get(c.key)) c.answer = a
      }
    },
  }

  /** Called by explain.js on Escape: cancels an edit and says so (true), else lets the popover close. */
  function escape() {
    if (cur?.mode !== 'edit') return false
    cur.mode = 'view'
    render()
    return true
  }

  // ═══ wiring ═══

  X().onClose(() => {
    cur = null
    clearTimeout(closeT)
    closeT = 0
  })
  G()?.onChange(() => {
    if (cur && cur.mode !== 'edit' && X().isOpen()) render()
  })
  X().pop.addEventListener('click', async e => {
    const b = e.target?.closest?.('[data-tc]')
    const c = cur
    if (!b || !c || !act[b.dataset.tc]) return
    e.preventDefault()
    c.pinned = true
    const run = act[b.dataset.tc](c)
    if (cur === c) render()
    await run
    if (cur === c) {
      render()
      if (c.mode === 'edit') X().pop.querySelector('textarea')?.focus?.()
    }
  })

  doc.addEventListener('mouseover', e => {
    const d = dfnOf(e.target)
    if (d) {
      clearTimeout(closeT)
      closeT = 0
      if (cur?.d === d && X().isOpen()) return
      clearTimeout(openT)
      openT = setTimeout(() => open(d), OPEN_MS)
      return
    }
    clearTimeout(openT)
    if (X().pop.contains(e.target)) {
      clearTimeout(closeT)
      closeT = 0
    } else if (cur && !cur.pinned && cur.via === 'hover' && X().isOpen()) closeSoon()
  })
  // Capture, so a word inside a clickable card or a button explains instead of opening it.
  doc.addEventListener('click', e => {
    const d = dfnOf(e.target)
    if (d) {
      e.preventDefault()
      e.stopPropagation()
      if (cur?.d === d && cur.pinned && X().isOpen()) return close()
      return open(d, { pin: true, via: 'click' })
    }
    if (cur && X().pop.contains(e.target)) cur.pinned = true
  }, true)
  doc.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const d = dfnOf(e.target)
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    open(d, { pin: true, via: 'key' })
  }, true)
  doc.addEventListener('focusin', e => {
    const d = dfnOf(e.target)
    if (d) open(d, { via: 'focus' })
  })
  doc.addEventListener('focusout', e => {
    if (!cur || e.target !== cur.d || cur.pinned) return
    if (e.relatedTarget && X().pop.contains(e.relatedTarget)) return
    closeSoon()
  })

  window.TermCard = { open: (d, opts) => open(d, opts), close, escape }
})()
