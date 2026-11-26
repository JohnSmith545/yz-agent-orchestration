// Ticket intake on the Tickets page (factory.js calls these through window.RoutingTickets; each call is ?.-guarded
// there, so the page works without this file). The data is GET /api/routing/tickets (routing-routes.mjs), loaded with
// the collection and kept here.
//
//   a Sort facet and a row of filter chips   Code · No code · Needs a person · Unsure (factory.js's own chips)
//   on each row                              the sort as a small tag, and `Looks like FLA-761` for a likely duplicate
//   in an opened row                         Sorting: the kind with its reason and who sorted it, a select to correct
//                                            it; the task type with a select to correct it; Not a duplicate
//   in Pass a task                           the routing suggestion, one line, `a suggestion, not an order`
//
// Every change is a POST /api/routing/tickets/<ID> from this page (its own Origin), then the page reloads.
//
//   PURE: KIND_NAMES, kindOf(entry), facet(), chipsHtml(countOf, chip), rowTag(entry), detailHtml(id, entry, types),
//         suggestionHtml(entry)
//   load() / entry(id) / data
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const KIND_NAMES = { code: 'Code', 'no-code': 'No code', 'needs-a-person': 'Needs a person', unsure: 'Unsure' }
  const ORDER = ['code', 'no-code', 'needs-a-person', 'unsure']
  const BY = { you: 'set by you', model: 'sorted by the model', rules: 'sorted by the rules' }
  const TYPE_NAMES = { 'small-fix': 'small fix', 'by-hand': 'by hand' }
  const typeName = t => (t ? TYPE_NAMES[t] || t : 'not known')

  /** The facet value of a ticket's sort: its kind, or unsure. */
  const kindOf = e => (!e ? 'unsure' : e.confidence === 'unsure' ? 'unsure' : e.kind)

  function facet(get) {
    return { label: 'Sort', get, names: { ...KIND_NAMES }, order: [...ORDER] }
  }

  /** Haiku 5.5 for claude-haiku-5-5: the words the Routing page uses. */
  const modelWords = id => String(id || '').replace(/^claude-/, '').replace(/^([a-z]+)-(\d+)-(\d+)$/, (m, n, a, b) => `${n.charAt(0).toUpperCase()}${n.slice(1)} ${a}.${b}`)
  let sortStatus = ''
  /**
   * The Sort the unsure tickets button (the Routing page's, same action, same cost note), beside the chips when the
   * model sort is on (routing.intakeModel) and a ticket is unsure; '' otherwise (QA, 2026-11-26).
   */
  function sortHtml(m, busy = false) {
    if (!m?.on || !(m.unsure > 0)) return sortStatus ? `<p class="rt-sort small" role="status">${esc(sortStatus)}</p>` : ''
    const going = !!(m.running || busy)
    return `<p class="rt-sort small">${m.unsure} open ${m.unsure === 1 ? 'ticket is' : 'tickets are'} unsure. One run sorts up to 30 at once with ${esc(modelWords(m.model))}, for about one cent. ` +
      `<button type="button" data-rt-intake${going ? ' disabled' : ''}>${going ? 'Sorting…' : 'Sort the unsure tickets'}</button>` +
      `${sortStatus ? ` <span role="status">${esc(sortStatus)}</span>` : ''}</p>`
  }

  /** The chip row, drawn with factory.js's own chip(facet, value, n, label, cls); countOf(kind) counts the tickets shown. */
  function chipsHtml(countOf, chip, model = api.data?.model) {
    return `<div class="fx-stat-row rt-chips" aria-label="Sort">${ORDER.map(k => chip('kind', k, Number(countOf(k)) || 0, KIND_NAMES[k], `rt-k-${k}`)).join('')}</div>${sortHtml(model, sorting)}`
  }
  let sorting = false

  function rowTag(e) {
    if (!e) return ''
    const k = kindOf(e)
    const dup = e.duplicate ? ` <span class="rt-dup" title="${esc(e.duplicate.reason)}">Looks like ${esc(e.duplicate.of)}</span>` : ''
    return ` <span class="rt-kind rt-k-${k}" title="${esc(e.reason)}">${esc(KIND_NAMES[k])}</span>${dup}`
  }

  const option = (value, label, on) => `<option value="${esc(value)}"${on ? ' selected' : ''}>${esc(label)}</option>`

  function detailHtml(id, e, types) {
    if (!e) return ''
    const kinds = ['code', 'no-code', 'needs-a-person']
    const dup = e.duplicate
      ? `<p class="rt-line">Looks like <button type="button" class="link" data-rt-goto="${esc(e.duplicate.of)}">${esc(e.duplicate.of)}</button>: ${esc(e.duplicate.reason)}
          <button type="button" class="rt-btn" data-rt-notdup="${esc(id)}" data-rt-of="${esc(e.duplicate.of)}">Not a duplicate</button></p>` : ''
    return `<div class="rt-box" data-rt-for="${esc(id)}">
      <h4>Sorting</h4>
      <p class="rt-line"><span class="rt-kind rt-k-${kindOf(e)}">${esc(KIND_NAMES[kindOf(e)])}</span> ${esc(e.reason)} <span class="faint">(${esc(BY[e.by] || '')})</span></p>
      <label class="rt-field"><span>Correct it</span><select data-rt-kind="${esc(id)}" aria-label="Sort ${esc(id)}">
        ${option('', e.by === 'you' ? 'Back to automatic' : 'Keep as it is', false)}${kinds.map(k => option(k, KIND_NAMES[k], e.by === 'you' && e.kind === k)).join('')}</select></label>
      <p class="rt-line">Task type: <b>${esc(typeName(e.type))}</b> <span class="faint">(${esc(e.typeBy === 'you' ? 'set by you' : e.typeConfidence)})</span></p>
      <label class="rt-field"><span>Correct it</span><select data-rt-type="${esc(id)}" aria-label="Task type of ${esc(id)}">
        ${option('', e.typeBy === 'you' ? 'Back to automatic' : 'Keep as it is', false)}${(types || []).map(t => option(t, typeName(t), e.typeBy === 'you' && e.type === t)).join('')}</select></label>
      ${dup}
    </div>`
  }

  function suggestionHtml(e) {
    if (!e) return ''
    return `<p class="rt-suggest small">${esc(e.suggestion)}${e.suggested ? ' <span class="faint">A suggestion, not an order.</span>' : ''}</p>`
  }

  const api = { KIND_NAMES, kindOf, facet, chipsHtml, rowTag, detailHtml, suggestionHtml, data: null, load: async () => null, entry: () => null }
  window.RoutingTickets = api
  if (!window.document) return

  // ═══ the page ═══
  const TYPES = ['wording', 'style', 'small-fix', 'feature', 'refactor', 'tests', 'docs', 'data', 'infra', 'investigation', 'review', 'by-hand']
  let data = null

  async function load() {
    try {
      const r = await fetch('/api/routing/tickets')
      if (r.ok) data = await r.json()
    } catch {
      /* the Tickets page still works without the sorting */
    }
    return data
  }

  async function change(id, body) {
    try {
      const r = await fetch(`/api/routing/tickets/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
    } catch (e) {
      window.alert?.(e.message)
    }
    await load()
    window.FactoryView?.reload()
  }

  document.addEventListener('change', e => {
    const k = e.target.closest?.('[data-rt-kind]')
    if (k && k.value !== '') return change(k.dataset.rtKind, { kind: k.value })
    if (k) return change(k.dataset.rtKind, { kind: null })
    const t = e.target.closest?.('[data-rt-type]')
    if (t) return change(t.dataset.rtType, { type: t.value || null })
  })
  document.addEventListener('click', e => {
    const nd = e.target.closest?.('[data-rt-notdup]')
    if (nd) return change(nd.dataset.rtNotdup, { notDuplicateOf: nd.dataset.rtOf })
    const go = e.target.closest?.('[data-rt-goto]')
    if (go) window.FactoryView?.gotoTicket(go.dataset.rtGoto)
    if (e.target.closest?.('[data-rt-intake]')) return sortUnsure()
  })

  /** The Routing page's own run (POST /api/routing/intake/run), from the Tickets page. */
  async function sortUnsure() {
    if (sorting) return
    sorting = true
    sortStatus = ''
    window.FactoryView?.reload()
    try {
      const r = await fetch('/api/routing/intake/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const j = await r.json().catch(() => ({}))
      sortStatus = r.ok ? `Sorted ${j.sorted} of ${j.asked} tickets${j.cost ? ` for ${j.cost.toFixed(3)}` : ''}. Correct any in its row.` : `Not sorted. ${j.error || r.status}`
    } catch (err) {
      sortStatus = `Not sorted. ${err.message}`
    }
    sorting = false
    await load()
    window.FactoryView?.reload()
  }

  Object.assign(api, {
    load,
    entry: id => data?.tickets?.[id] || null,
    detailHtml: (id, e) => detailHtml(id, e, TYPES),
  })
  Object.defineProperty(api, 'data', { get: () => data })
})()
