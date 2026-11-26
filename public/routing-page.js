// The Routing page (#/routing, section #routingView): which agent, model and effort the routing rules suggest for
// each kind of task, what happened when work was handed out, and the latest flows' task types, which the user can
// correct. The routes are routing-routes.mjs.
//
//   Routing rules    the rules in order, each editable in place: When (task type, risk, size), then Agent, Model,
//                    Effort and Why; move up or down, remove, add, back to the defaults; Save asks first (a plain
//                    confirm in the page) and writes config.json's routing.rules. The first rule that fits wins.
//   What happened    one line: N finished flows recorded of the 100 a learning method needs; then a table per task
//                    type and model: flows, right first time, median time, median cost, `Too few to trust` under 5
//   Latest flows     each flow's task type (a select corrects it), its size, the suggestion, what was used and
//                    whether it was followed. `#/routing?flow=<id>` scrolls to one and focuses its select.
//   Ticket sorting   the model sort's state: off (and how to turn it on), or a button for the unsure tickets
//
// Every change is the page's own (its Origin): PUT /api/routing/rules, POST /api/routing/flows/<id>,
// POST /api/routing/intake/run. ⚠️ A suggestion is never an order: the page says so where it shows one.
//
//   PURE: html(view, draft, ui), ruleRow(rule, i, view), tableHtml(table), flowsHtml(flows, types), modelName(id, models)
//   open(query) / close()
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const TYPE_NAMES = { 'small-fix': 'small fix', 'by-hand': 'by hand' }
  const typeName = t => (t ? TYPE_NAMES[t] || t : 'not known')
  const modelName = (id, models) => (models || []).find(m => m.id === id)?.name || id || ''
  const FEW = 5
  const HELP = '<p>When work is handed out (Pass a task on the Tickets page, <code>flow new</code>, the planner\'s hand-out), ' +
    'the <b>first rule that fits</b> the task suggests an agent, a model and an effort. A key left as Any fits every task.</p>' +
    '<p>It is a <b>suggestion, not an order</b>: nothing is switched by itself, and you or the coordinator take it or not. ' +
    'The planner, Security and Senior always run on Opus at high effort; no rule changes that.</p>' +
    '<p>The <b>task type</b> comes from the words, labels and story type. When the rules are unsure, only a rule with Any type fits. ' +
    'Correct a type below or on a ticket; your correction always wins.</p>' +
    '<p><b>What was used</b> is the model and effort you set for that agent on the Agents page at the time, not a model the dashboard saw run. ' +
    'Tokens and cost show only when another part of the dashboard records them per flow; until then they are left out, never guessed.</p>' +
    '<p>Each finished flow is recorded once. About 100 are needed before a learning method could suggest better than these rules; none is built yet.</p>' +
    '<p><b>Ticket sorting</b> with a model is off unless <code>routing.intakeModel</code> is set in config.json. One run sorts up to 30 unsure tickets ' +
    'and costs about one cent with Haiku 5.5; its cost shows in the spend chip as Ticket sorting.</p>'

  const option = (value, label, on) => `<option value="${esc(value)}"${on ? ' selected' : ''}>${esc(label)}</option>`
  const select = (attr, label, values, current, anyLabel = 'Any') =>
    `<select ${attr} aria-label="${esc(label)}">${option('', anyLabel, current == null || current === '')}${values.map(([v, l]) => option(v, l, String(current) === String(v))).join('')}</select>`

  function ruleRow(r, i, v) {
    const w = r.when || {}
    const typeVal = Array.isArray(w.type) ? w.type.join(',') : w.type
    const types = (v.types || []).map(t => [t, typeName(t)])
    if (Array.isArray(w.type) && w.type.length > 1) types.unshift([typeVal, w.type.map(typeName).join(' or ')])
    const n = (v.draft || []).length
    return `<tr data-rr="${i}">
      <td class="num faint">${i + 1}</td>
      <td class="rr-when" data-k="When">${select('data-rr-type', `Rule ${i + 1} task type`, types, typeVal)}${select('data-rr-risk', `Rule ${i + 1} risk`, (v.risks || []).map(x => [x, `${x} risk`]), w.risk)}${select('data-rr-size', `Rule ${i + 1} size`, (v.sizes || []).map(x => [x, x]), w.size)}</td>
      <td data-k="Agent">${select('data-rr-agent', `Rule ${i + 1} agent`, (v.agents || []).filter(a => ['coordinator', 'producer', 'chat'].includes(a.role)).map(a => [a.label, a.label]), r.agent, 'No agent')}</td>
      <td data-k="Model">${select('data-rr-model', `Rule ${i + 1} model`, (v.models || []).map(m => [m.id, m.name]), r.model, 'No model')}</td>
      <td data-k="Effort">${select('data-rr-effort', `Rule ${i + 1} effort`, (v.efforts || []).map(x => [x, x]), r.effort, 'No effort')}</td>
      <td class="rr-why"><input data-rr-why value="${esc(r.why)}" maxlength="160" aria-label="Rule ${i + 1} why" placeholder="Why, in one plain line"></td>
      <td class="rr-acts"><button type="button" class="rr-icon" data-rr-up="${i}" aria-label="Move rule ${i + 1} up"${i === 0 ? ' disabled' : ''}>↑</button><button type="button" class="rr-icon" data-rr-down="${i}" aria-label="Move rule ${i + 1} down"${i === n - 1 ? ' disabled' : ''}>↓</button><button type="button" class="link" data-rr-remove="${i}">Remove</button></td>
    </tr>`
  }

  const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`)
  const mins = m => (m == null ? '—' : m >= 90 ? `${Math.round(m / 6) / 10} h` : `${Math.round(m)} min`)
  const usd = (u, of) => (u == null || !of ? '<span class="faint">not known</span>' : `$${u.toFixed(2)}`)

  function tableHtml(t, models) {
    const recorded = Number(t?.recorded) || 0
    const target = Number(t?.target) || 100
    const line = `<p class="rr-count"><b>${recorded}</b> finished ${recorded === 1 ? 'flow' : 'flows'} recorded, of the ${target} a learning method needs. No learning method is built yet: the rules above decide.</p>`
    const rows = Array.isArray(t?.rows) ? t.rows : []
    if (!rows.length) return `${line}<p class="rr-empty">Nothing has finished since routing was switched on. Each flow that is delivered or stopped adds one line.</p>`
    const body = rows.map(r => r.fewer
      ? `<tr><td>${esc(typeName(r.type))}</td><td>${esc(modelName(r.model, models) || 'not known')}</td><td class="num">${r.flows}</td><td colspan="3" class="faint">Too few to trust</td></tr>`
      : `<tr><td>${esc(typeName(r.type))}</td><td>${esc(modelName(r.model, models) || 'not known')}</td><td class="num">${r.flows}</td><td class="num">${pct(r.firstTime)}${r.judged ? ` <span class="faint">(${r.right} of ${r.judged})</span>` : ''}</td><td class="num">${mins(r.medianMinutes)}</td><td class="num">${usd(r.medianUsd, r.costOf)}</td></tr>`).join('')
    return `${line}<div class="tablewrap rr-tablewrap"><table class="rr-out"><thead><tr><th>Task type</th><th>Model</th><th>Flows</th><th>Right first time</th><th>Median time</th><th>Median cost</th></tr></thead><tbody>${body}</tbody></table></div>` +
      `<p class="rr-note">Under ${FEW} flows a row says Too few to trust.</p>`
  }

  // what the last column says: never a bare Not known (QA, 2026-11-26)
  const followedText = f => (f === true ? 'Suggestion followed' : f === false ? 'Suggestion not followed' : 'Suggestion followed: not known yet')

  function flowsHtml(flows, v) {
    const list = Array.isArray(flows) ? flows : []
    if (!list.length) return '<p class="rr-empty">No flow has a routing record yet. Each new flow gets one when it starts.</p>'
    return `<ul class="rr-flows">${list.map(f => {
      const r = f.routing || {}
      const s = r.suggested
      const u = r.used
      const sug = s ? [s.agent, s.model && modelName(s.model, v.models), s.effort && `${s.effort} effort`].filter(Boolean).join(', ') : 'nothing fitted'
      const used = u ? [u.agent, u.model ? modelName(u.model, v.models) : 'model not set', u.effort ? `${u.effort} effort` : 'effort not set'].join(', ') : 'not yet'
      return `<li class="rr-flow" data-rr-flow="${esc(f.id)}">
        <div class="rr-flow-top"><a class="link rr-flow-t" href="#/flows?flow=${encodeURIComponent(f.id)}">${esc(f.title)}</a><span class="faint">${esc(f.agent)} · ${esc(f.status)}</span></div>
        <div class="rr-flow-meta">
          <label class="rr-type">Task type ${select(`data-rr-flowtype="${esc(f.id)}"`, `Task type of ${f.title}`, (v.types || []).map(t => [t, typeName(t)]), r.type, 'Not known')}</label>
          <span class="faint">${esc(r.typeBy === 'you' ? 'set by you' : r.confidence || '')}</span>
          <span>${esc(r.size || '')}</span>
          <span>Suggested: ${esc(sug)}</span><span>Used: ${esc(used)}</span><span class="rr-f f-${String(r.followed)}">${followedText(r.followed)}</span>
        </div></li>`
    }).join('')}</ul>`
  }

  function intakeHtml(ui, models) {
    const m = ui.model
    if (!m) return ''
    if (!m.on) return '<p class="rr-muted">Sorting tickets with a model is off. The rules sort every ticket; set <code>routing.intakeModel</code> in config.json (for example claude-haiku-5-5) to let one cheap run sort the ones they are unsure about.</p>'
    if (!m.unsure) return `<p class="rr-muted">The model sort is on (${esc(modelName(m.model, models))}). No open ticket is unsure right now.</p>`
    return `<p class="rr-muted">${m.unsure} open ${m.unsure === 1 ? 'ticket is' : 'tickets are'} unsure. One run sorts up to 30 at once with ${esc(modelName(m.model, models))}, for about one cent.</p>` +
      `<button type="button" data-rr-intake${m.running || ui.busy ? ' disabled' : ''}>${m.running || ui.busy ? 'Sorting…' : 'Sort the unsure tickets'}</button>`
  }

  function html(v, ui = {}) {
    const draft = v.draft || []
    const warn = v.warning ? `<p class="rr-warn warn">${esc(v.warning)}</p>` : ''
    const rows = draft.length ? draft.map((r, i) => ruleRow(r, i, v)).join('') : '<tr><td colspan="7" class="rr-empty">No rules: nothing will be suggested.</td></tr>'
    return `<div class="rr-page">
      <section class="rr-card" aria-labelledby="rrRulesH"><h3 class="rr-h" id="rrRulesH">Routing rules</h3>
        <p class="rr-lead">The first rule that fits a task suggests who does it and on what. A suggestion, not an order.</p>${warn}
        <div class="tablewrap rr-tablewrap"><table class="rr-rules"><thead><tr><th>#</th><th>When</th><th>Agent</th><th>Model</th><th>Effort</th><th>Why</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="rr-bar"><button type="button" data-rr-add>Add a rule</button><button type="button" class="link" data-rr-defaults>Back to the defaults</button>
          <span class="rr-spacer"></span>${ui.dirty ? '<span class="faint">Not saved</span>' : ''}<button type="button" class="primary" data-rr-save${ui.dirty ? '' : ' disabled'}>Save rules</button></div>
        ${ui.status ? `<p class="rr-status" role="status">${esc(ui.status)}</p>` : ''}
      </section>
      <section class="rr-card" aria-labelledby="rrOutH"><h3 class="rr-h" id="rrOutH">What happened</h3>${tableHtml(v.table, v.models)}</section>
      <section class="rr-card" aria-labelledby="rrFlowsH"><h3 class="rr-h" id="rrFlowsH">Latest flows</h3>${flowsHtml(v.flows, v)}</section>
      <section class="rr-card" aria-labelledby="rrIntakeH"><h3 class="rr-h" id="rrIntakeH">Ticket sorting</h3>${intakeHtml(ui, v.models)}</section>
    </div>`
  }

  const api = { html, ruleRow, tableHtml, flowsHtml, modelName, HELP }
  window.RoutingPage = api
  if (!window.document) return

  // ═══ the page ═══
  const root = () => document.getElementById('routingView')
  let view = null
  let ui = { dirty: false, status: '', model: null, busy: false }
  let open = false
  let query = {}

  const clone = x => JSON.parse(JSON.stringify(x))
  function paint() {
    const el = root()
    if (!el || !view) return
    const a = document.activeElement
    const keep = a && el.contains(a) ? [...a.attributes].find(x => x.name.startsWith('data-rr'))?.name : null
    const row = a?.closest?.('[data-rr]')?.dataset.rr
    el.innerHTML = html(view, ui)
    if (keep) (row != null ? el.querySelector(`[data-rr="${row}"] [${keep}]`) : el.querySelector(`[${keep}]`))?.focus()
    window.Shell?.setStatus(view.custom ? `${view.draft.length} rules from config.json` : 'The default rules', HELP)
  }

  async function load() {
    try {
      const [r, t] = await Promise.all([fetch('/api/routing'), fetch('/api/routing/tickets')])
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || r.status)
      const tickets = t.ok ? await t.json() : null
      if (!open) return
      view = { ...j, draft: ui.dirty && view ? view.draft : clone(j.rules) }
      ui.model = tickets?.model || null
      paint()
      if (query.flow) {
        const f = root().querySelector(`[data-rr-flow="${CSS.escape(query.flow)}"]`)
        f?.scrollIntoView({ block: 'center' })
        f?.querySelector('select')?.focus()
        query = {}
      }
    } catch (e) {
      window.Shell?.setStatus(`<span class="warn">Could not load routing: ${esc(e.message)}</span>`)
    }
  }

  /** The draft rule at row `i` as the inputs say now. */
  function readRow(i) {
    const tr = root().querySelector(`[data-rr="${i}"]`)
    const val = s => tr.querySelector(s)?.value || ''
    const when = {}
    const type = val('[data-rr-type]')
    if (type) when.type = type.includes(',') ? type.split(',') : type
    if (val('[data-rr-risk]')) when.risk = val('[data-rr-risk]')
    if (val('[data-rr-size]')) when.size = val('[data-rr-size]')
    const r = { when }
    for (const k of ['agent', 'model', 'effort']) if (val(`[data-rr-${k}]`)) r[k] = val(`[data-rr-${k}]`)
    r.why = tr.querySelector('[data-rr-why]')?.value || ''
    return r
  }
  const edit = fn => {
    fn(view.draft)
    ui.dirty = true
    ui.status = ''
    paint()
  }

  async function save() {
    const n = view.draft.length
    if (!window.confirm(`Save these ${n} routing ${n === 1 ? 'rule' : 'rules'}? Every agent reads them at its next hand-out. Nothing is switched by itself.`)) return
    try {
      const r = await fetch('/api/routing/rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules: view.draft }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
      view = { ...j, draft: clone(j.rules) }
      ui = { ...ui, dirty: false, status: 'Saved to config.json. The next hand-out reads them.' }
    } catch (e) {
      ui.status = `Not saved. ${e.message}`
    }
    paint()
  }

  async function correct(id, type) {
    try {
      const r = await fetch(`/api/routing/flows/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: type || null }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
    } catch (e) {
      window.alert(e.message)
    }
    load()
  }

  async function runIntake() {
    ui.busy = true
    paint()
    try {
      const r = await fetch('/api/routing/intake/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const j = await r.json().catch(() => ({}))
      ui.status = r.ok ? `Sorted ${j.sorted} of ${j.asked} tickets${j.cost ? ` for $${j.cost.toFixed(3)}` : ''}. Correct any on the Tickets page.` : `Not sorted. ${j.error || r.status}`
    } catch (e) {
      ui.status = `Not sorted. ${e.message}`
    }
    ui.busy = false
    load()
  }

  document.addEventListener('change', e => {
    if (!open || !root()?.contains(e.target)) return
    const flow = e.target.closest('[data-rr-flowtype]')
    if (flow) return correct(flow.dataset.rrFlowtype, flow.value)
    const row = e.target.closest('[data-rr]')
    if (row) edit(d => (d[Number(row.dataset.rr)] = readRow(row.dataset.rr)))
  })
  document.addEventListener('input', e => {
    if (!open || !e.target.matches?.('[data-rr-why]')) return
    const i = Number(e.target.closest('[data-rr]').dataset.rr)
    view.draft[i].why = e.target.value
    if (!ui.dirty) edit(() => {})
  })
  document.addEventListener('click', e => {
    if (!open || !root()?.contains(e.target)) return
    const t = e.target.closest('button')
    if (!t || t.disabled) return
    if (t.matches('[data-rr-add]')) return edit(d => d.push({ when: {}, effort: 'medium', why: '' }))
    if (t.matches('[data-rr-defaults]')) return edit(d => d.splice(0, d.length, ...clone(view.defaults)))
    if (t.matches('[data-rr-save]')) return save()
    if (t.matches('[data-rr-intake]')) return runIntake()
    const at = k => Number(t.dataset[k])
    if (t.dataset.rrUp) return edit(d => d.splice(at('rrUp') - 1, 2, d[at('rrUp')], d[at('rrUp') - 1]))
    if (t.dataset.rrDown) return edit(d => d.splice(at('rrDown'), 2, d[at('rrDown') + 1], d[at('rrDown')]))
    if (t.dataset.rrRemove) return edit(d => d.splice(at('rrRemove'), 1))
  })

  Object.assign(api, {
    open(q = {}) {
      open = true
      query = q || {}
      if (root()) root().innerHTML = '<p class="rr-empty">Loading…</p>'
      load()
    },
    close() {
      open = false
      if (root()) root().innerHTML = ''
    },
  })
})()
