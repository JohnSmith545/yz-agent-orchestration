// Predict and warn's figures on other blocks, the DOM half (the words and HTML are predict-view.js):
//
//   a flow's Output tab   the Cost block (flow-output.js calls block(c) in its render and update(flow, redraw) in its
//                         fill, and puts sig(id) in its signature): `Tokens: 12.4M, about $4.10`, the estimate, and
//                         estimate against actual once the flow finished (GET /api/predict/flow)
//   the Tickets page      an open ticket's Estimate (factory.js puts `data-pe-ticket="<id>"` in its detail and calls
//                         paintTickets(root) after it draws): computed on the fly for a ticket not yet started
//   Pipeline time         How good the estimates have been, folded (time-strip.js calls accuracy(el, win) when it
//                         loads): mounted once before How it is counted, read again on the same cadence and window
//   Pipeline tokens       one line, placed on flows and not (token-strip.js calls placed(el, stats) when it paints)
//
// Rules: each read is cached a short while and a newer answer replaces an older one only when it changed, so nothing
// flickers; a failed read keeps what was shown; nothing here writes anything.
//
//   PredictFlow.update(flow, redraw), block(c), sig(id), paintTickets(root), accuracy(el, win), placed(el, stats)
;(() => {
  const V = () => window.PredictView
  const FLOW_MS = 30_000
  const TICKET_MS = 60_000
  const flows = new Map() // id -> { at, updatedAt, data, loading }
  const tickets = new Map() // id -> { at, data, loading }

  // ═══ a flow's Output tab ═══

  function update(flow, redraw) {
    if (!flow?.id) return
    const was = flows.get(flow.id)
    const fresh = was && Date.now() - was.at < FLOW_MS && was.updatedAt === flow.updatedAt
    if (fresh || was?.loading) return
    const entry = { at: Date.now(), updatedAt: flow.updatedAt, data: was?.data ?? null, loading: true }
    flows.set(flow.id, entry)
    fetch(`/api/predict/flow?id=${encodeURIComponent(flow.id)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        entry.loading = false
        if (!j || JSON.stringify(j) === JSON.stringify(entry.data)) return
        entry.data = j
        redraw?.()
      })
      .catch(() => {
        entry.loading = false
      })
  }

  /** The Cost block, or nothing while its figures are not read yet. */
  function block(c) {
    const data = flows.get(c?.flow?.id)?.data
    if (!data || !V()) return ''
    const open = !data.actual && c.flow.status !== 'done'
    const head = typeof c.head === 'function' ? c.head('Cost') : ''
    return `<section class="ob ob-cost" aria-label="Cost" ${c.keyed('pe-cost', data)}>${head}${V().costHtml(data, { open })}</section>`
  }
  const sig = id => JSON.stringify(flows.get(id)?.data ?? null)

  // ═══ the Tickets page ═══

  function paintTickets(root) {
    for (const el of root?.querySelectorAll?.('[data-pe-ticket]') || []) {
      const id = el.getAttribute('data-pe-ticket')
      const was = tickets.get(id)
      if (was?.data) el.innerHTML = V().ticketHtml(was.data)
      else if (!el.textContent) el.textContent = 'Working it out…'
      if ((was && Date.now() - was.at < TICKET_MS) || was?.loading) continue
      const entry = { at: Date.now(), data: was?.data ?? null, loading: true }
      tickets.set(id, entry)
      fetch(`/api/predict/ticket?id=${encodeURIComponent(id)}`)
        .then(async r => (r.ok ? r.json() : { error: (await r.json().catch(() => ({}))).error || `the server answered ${r.status}` }))
        .then(j => {
          entry.loading = false
          if (j.error) {
            for (const s of root.querySelectorAll(`[data-pe-ticket="${CSS.escape(id)}"]`)) s.textContent = `No estimate: ${j.error}`
            return
          }
          entry.data = j
          for (const s of root.querySelectorAll(`[data-pe-ticket="${CSS.escape(id)}"]`)) s.innerHTML = V().ticketHtml(j)
        })
        .catch(() => {
          entry.loading = false
        })
    }
  }

  // ═══ Pipeline time: how good the estimates have been ═══

  let accSeq = 0
  function accuracy(el, win) {
    const body = el?.querySelector('.psc-body')
    if (!body || !V()) return
    let box = body.querySelector('[data-pe-acc]')
    if (!box) {
      box = document.createElement('details')
      box.className = 'psc-how pe-acc'
      box.setAttribute('data-pe-acc', '')
      box.innerHTML = '<summary>How good the estimates have been</summary><div class="psc-how-body pe-acc-body">Loading…</div>'
      const how = [...body.querySelectorAll(':scope > .psc-how')].at(-1)
      body.insertBefore(box, how || null)
    }
    const seq = ++accSeq
    fetch(`/api/predict/accuracy?days=${encodeURIComponent(win || '30')}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (!j || seq !== accSeq) return
        const inner = box.querySelector('.pe-acc-body')
        const html = j.enabled === false ? '<p>Estimates are off (estimates.enabled in config.json).</p>' : V().accuracyHtml(j)
        if (inner._peHtml !== html) {
          inner._peHtml = html
          inner.innerHTML = html
        }
      })
      .catch(() => {})
  }

  // ═══ Pipeline tokens: placed on flows and not ═══

  function placed(el, stats) {
    const row = el?.querySelector('.ptk-row')
    if (!row || !V()) return
    let line = el.querySelector('.pe-placed')
    if (!line) {
      line = document.createElement('p')
      line.className = 'pe-placed'
      line.innerHTML = '<span class="pe-placed-text"></span><button type="button" class="help" aria-label="How tokens are placed on flows">?</button>'
      row.insertAdjacentElement('afterend', line)
      window.Help?.attach(line.querySelector('.help'), V().PLACED_HELP)
    }
    const text = V().placedText(stats?.placed)
    line.hidden = !text
    const span = line.querySelector('.pe-placed-text')
    if (span.textContent !== text) span.textContent = text
  }

  window.PredictFlow = { update, block, sig, paintTickets, accuracy, placed }
})()
