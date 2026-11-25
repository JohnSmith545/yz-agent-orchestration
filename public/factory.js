// The Tickets page (#/tickets, section #factoryView): one column holding the
// orchestration grid, then two folds, closed by default and remembered:
// Tickets (the collection in board order with live Switchboard state and
// review marks) and Worktrees (worktrees.js, from the /api/status rows).
// The page header shows the collection name as the title, ONE status chip
// (Switchboard 12m · auto 20m, the rest behind its ?) and ONE Refresh: the
// shell's generic #refresh hides while this page is open (spec 5).
// Row actions hand work to the chat agent (factory-chat.js) or, through it,
// to other agents. The flows live on #/flows and the chat in the drawer.
// Pass a task (on a ticket and in the bulk bar) shows the pile-up reminder once outputs.max finished flows wait for
// the user's sign-off (completed-view.js): a reminder above the form, which still sends.
(() => {
  const $ = (s, el = document) => el.querySelector(s)
  const $$ = (s, el = document) => [...el.querySelectorAll(s)]
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const store = {
    get(k, d) { try { const v = localStorage.getItem('factory.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
    set(k, v) { try { localStorage.setItem('factory.' + k, JSON.stringify(v)) } catch {} },
  }
  const POLL_MS = 20_000

  const REVIEW = {
    reviewed: { label: 'Code reviewed', short: 'Reviewed' },
    'needs-review': { label: 'Needs review', short: 'Needs review' },
    'no-code': { label: 'No code yet', short: 'No code yet' },
    'not-codebase': { label: 'Not from codebase', short: 'Not codebase' },
  }
  const VERDICT = {
    now: 'Deliver now', check: 'After a dev check', docfix: 'After a doc fix', notyet: 'Not yet',
  }
  const STATE_ORDER = ['Unstarted', 'Started', 'Finished', 'Delivered', 'Rejected', 'Accepted']

  let data = null
  let agents = []
  let worktrees = null
  let timer = null
  let open = false
  let generation = 0 // a close and reopen during the first load must not start two timers
  const expanded = new Set()
  const selected = new Set()
  let filters = store.get('filters', {})
  let sort = store.get('sort', 'board')
  let query = ''
  // The two folds: button id, body id, and whether it is open (remembered).
  const FOLDS = {
    tickets: { button: 'fxFold', body: 'fxTickets', on: store.get('ticketsOpen', false) },
    worktrees: { button: 'fxWtFold', body: 'fxWorktrees', on: store.get('worktreesOpen', false) },
  }
  // A ticket asked for (gotoTicket) before the page was open: shown once it loads.
  let pendingTicket = null

  const root = () => document.getElementById('factoryView')

  // ─── load ───
  async function load() {
    try {
      const r = await fetch('/api/factory?c=' + encodeURIComponent(store.get('collection', '')))
      if (!r.ok) throw new Error((await r.json()).error || r.status)
      data = await r.json()
      await window.RoutingTickets?.load() // ticket intake: the sort, the task type, duplicates (routing-tickets.js)
      render()
      window.OrchestrationGrid?.load(store.get('collection', '')).then(() => open && data && renderRows())
    } catch (e) {
      if (open) window.Shell?.setStatus(`<span class="warn">Could not load: ${esc(e.message)}</span>`)
    }
  }
  /**
   * The /api/status build (no refresh flag, so the server's cached copy):
   * the live agents for the Pass a task menus, and the worktree rows for the
   * Worktrees fold. ONE fetch serves both.
   */
  async function loadStatus() {
    try {
      const r = await fetch('/api/status')
      const s = await r.json()
      agents = (s.agents || []).map(a => ({ name: a.name, label: a.label, state: a.state }))
      worktrees = s.worktrees || []
    } catch { agents = [] }
    renderWorktrees()
  }
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
    return j
  }

  // ─── derived values ───
  const reviewOf = t => t.mark?.review || 'not-codebase'
  const mustOf = t => {
    const m = (t.plan?.must || '').toLowerCase()
    return !t.plan ? 'unplanned' : m.startsWith('yes') || m.includes('yes') ? 'must' : m.startsWith('no') ? 'no' : 'later'
  }
  const isDone = t => t.state === 'Accepted'
  const FACETS = {
    state: { label: 'Board', get: t => t.state, order: STATE_ORDER },
    phase: { label: 'Phase', get: t => t.phase || 'No label' },
    review: { label: 'Review', get: reviewOf, names: Object.fromEntries(Object.entries(REVIEW).map(([k, v]) => [k, v.label])), order: Object.keys(REVIEW) },
    verdict: { label: 'Verdict', get: t => t.mark?.verdict || 'none', names: { ...VERDICT, none: 'No verdict' }, order: [...Object.keys(VERDICT), 'none'] },
    owner: { label: 'Owner', get: t => t.owner, names: { me: 'Mine', other: 'Someone else', none: 'Unowned' }, order: ['me', 'other', 'none'] },
    must: { label: 'Launch', get: mustOf, names: { must: 'Must for launch', later: 'Later', no: 'Not needed', unplanned: 'Not in the plan' }, order: ['must', 'later', 'no', 'unplanned'] },
  }
  // ticket intake's Sort facet: code, no code, needs a person, unsure (routing-tickets.js)
  if (window.RoutingTickets) FACETS.kind = window.RoutingTickets.facet(t => window.RoutingTickets.kindOf(window.RoutingTickets.entry(t.id)))
  function passes(t, skip) {
    for (const [k, f] of Object.entries(FACETS)) {
      if (k === skip) continue
      const on = filters[k]
      if (on && on.length && !on.includes(f.get(t))) return false
    }
    if (query) {
      const hay = [t.id, t.title, t.phase, t.state, t.plan?.left, t.plan?.verdict, t.mark?.note].join(' ').toLowerCase()
      if (!hay.includes(query.toLowerCase())) return false
    }
    return true
  }
  function sorted(list) {
    const l = [...list]
    if (sort === 'number') return l.sort((a, b) => a.n - b.n)
    // The board shows Current Sprint, then Backlog, then Icebox; position within a column is `order`.
    const col = t => ({ CurrentSprint: 0, Backlog: 1, Icebox: 2 })[t.column] ?? 3
    return l.sort((a, b) => col(a) - col(b) || (a.order ?? Infinity) - (b.order ?? Infinity) || a.n - b.n)
  }

  // ─── render: the page frame (once per open) ───
  function shell() {
    root().innerHTML = `
      <div class="fx">
        <div id="fxOrch"></div>
        <button type="button" class="fx-fold" id="fxFold" aria-expanded="false" aria-controls="fxTickets">Tickets <span class="faint" id="fxFoldCount"></span></button>
        <div id="fxTickets" hidden>
          <div class="fx-stats" id="fxStats"></div>
          <div class="toolbar fx-toolbar">
            <input type="search" id="fxQ" placeholder="Search id, title, what is left, notes" aria-label="Search tickets">
            <div class="fx-facets" id="fxFacets"></div>
            <label class="check"><input type="checkbox" id="fxNeeds"> Needs review only</label>
            <select id="fxSort" aria-label="Sort">
              <option value="board">Board order</option>
              <option value="number">Ticket number</option>
            </select>
            <button type="button" class="link" id="fxClear">Clear filters</button>
          </div>
          <div class="card tablewrap fx-table">
            <table>
              <thead><tr>
                <th class="sel"><input type="checkbox" id="fxAll" aria-label="Select all shown"></th>
                <th>#</th><th>Ticket</th><th>Board</th><th>Built by · where</th><th>Owner</th><th>Launch</th><th>Code review</th><th></th>
              </tr></thead>
              <tbody id="fxRows"></tbody>
            </table>
          </div>
          <div class="fx-bulk" id="fxBulk" hidden></div>
        </div>
        <button type="button" class="fx-fold" id="fxWtFold" aria-expanded="false" aria-controls="fxWorktrees">Worktrees <span class="faint" id="fxWtCount"></span></button>
        <div class="card tablewrap fx-wt" id="fxWorktrees" hidden></div>
      </div>`
    for (const name of Object.keys(FOLDS)) {
      $('#' + FOLDS[name].button).addEventListener('click', () => fold(name, !FOLDS[name].on))
      fold(name, FOLDS[name].on)
    }
    $('#fxQ').addEventListener('input', e => { query = e.target.value; renderRows() })
    $('#fxSort').value = sort
    $('#fxSort').addEventListener('change', e => { sort = e.target.value; store.set('sort', sort); renderRows() })
    $('#fxNeeds').addEventListener('change', e => { filters.review = e.target.checked ? ['needs-review'] : []; saveFilters(); render() })
    $('#fxClear').addEventListener('click', () => { filters = {}; query = ''; $('#fxQ').value = ''; saveFilters(); render() })
    $('#fxAll').addEventListener('change', e => {
      if (!data) return
      const shown = sorted(data.tickets.filter(t => passes(t))).map(t => t.id)
      for (const id of shown) e.target.checked ? selected.add(id) : selected.delete(id)
      renderRows()
    })
  }
  const saveFilters = () => store.set('filters', filters)
  /** Opens or closes one fold (`tickets` or `worktrees`) and remembers it. */
  function fold(name, on) {
    const f = FOLDS[name]
    f.on = on
    store.set(name + 'Open', on)
    $('#' + f.button)?.setAttribute('aria-expanded', String(on))
    const body = $('#' + f.body)
    if (body) body.hidden = !on
  }

  // ─── the page header: the collection picker and ONE Refresh ───
  // The shell's #refresh rebuilds /api/status, which is not what this page
  // shows, so it hides while Tickets is open and comes back on close.
  function mountActions() {
    const box = document.getElementById('pageActions')
    if (!box || $('#fxRefresh')) return
    const generic = document.getElementById('refresh')
    if (generic) generic.hidden = true
    box.insertAdjacentHTML('beforeend',
      '<select id="fxCollection" aria-label="Collection" hidden></select>' +
      '<button type="button" id="fxRefresh" title="Read every ticket from Switchboard now (read only)">Refresh</button>')
    $('#fxRefresh').addEventListener('click', refreshNow)
    $('#fxCollection').addEventListener('change', e => { store.set('collection', e.target.value); load() })
  }
  function unmountActions() {
    $('#fxRefresh')?.remove()
    $('#fxCollection')?.remove()
    const generic = document.getElementById('refresh')
    if (generic) generic.hidden = false
  }

  async function refreshNow() {
    const b = $('#fxRefresh')
    if (!b) return
    b.disabled = true
    b.textContent = 'Reading…'
    try {
      const s = await post('/api/factory/refresh?c=' + encodeURIComponent(data?.collection?.id || ''))
      if (!s.ok) alert('Switchboard refresh failed: ' + s.message)
    } catch (e) { alert(e.message) }
    // The page may have closed while Switchboard was read; the button went with it.
    if (b.isConnected) {
      b.disabled = false
      b.textContent = 'Refresh'
    }
    load()
  }

  // ─── render: everything that depends on data ───
  function render() {
    if (!data || !open) return
    renderMeta()
    renderStats()
    renderFacets()
    renderRows()
  }

  const minutes = m => (m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`)
  /**
   * The page title is the collection name; the status chip is ONLY when
   * Switchboard was last read (plus the auto timer), with the range, the
   * count and any failure behind its ? popover (help.js).
   */
  function renderMeta() {
    const c = data.collection
    window.Shell?.setTitle(c ? c.name : 'Tickets', c ? 'collection' : 'tickets')
    $('#fxFoldCount').textContent = `· ${data.tickets.length}`
    const sel = $('#fxCollection')
    if (sel) {
      sel.hidden = data.collections.length < 2
      sel.innerHTML = data.collections.map(x => `<option value="${esc(x.id)}" ${x.id === c?.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')
    }
    window.Shell?.setStatus(...statusChip())
  }
  /** [the chip line, the HTML behind its ?] */
  function statusChip() {
    const c = data.collection
    if (!c) return ['No collection', '<p>Add one under <code>factory.collections</code> in config.json.</p>']
    const r = data.refresh || {}
    const read = window.Shell.ago(data.snapshotAt) || 'not read'
    const more = [
      c.range ? `<p>${esc(c.name)}: ${esc(c.prefix)}-${esc(c.range[0])} to ${esc(c.prefix)}-${esc(c.range[1])}, ${data.tickets.length} tickets.</p>` : `<p>${data.tickets.length} tickets.</p>`,
      `<p>${data.snapshotAt ? `Last read from Switchboard: ${esc(read)}` : 'Not read from Switchboard yet'}${r.everyMinutes ? `; read again every ${esc(minutes(r.everyMinutes))}` : ''}. Refresh reads it now (read only).</p>`,
      r.ok === false ? `<p class="warn">The last refresh failed: ${esc(r.message)}</p>` : '',
    ].join('')
    const auto = r.everyMinutes ? ` · auto ${minutes(r.everyMinutes)}` : ''
    const text = r.running ? 'Switchboard reading…' : `Switchboard ${read}${auto}`
    return [`<span${r.ok === false && !r.running ? ' class="warn"' : ''}>${esc(text)}</span>`, more]
  }

  // ─── the Worktrees fold (worktrees.js draws the table) ───
  function renderWorktrees() {
    if (!open) return
    const box = $('#fxWorktrees')
    if (!box) return
    $('#fxWtCount').textContent = worktrees ? `· ${worktrees.length}` : ''
    box.innerHTML = !worktrees
      ? '<p class="empty">Could not read the worktrees.</p>'
      : worktrees.length ? window.Worktrees.html(worktrees) : '<p class="empty">No worktrees.</p>'
  }

  function renderStats() {
    const T = data.tickets
    const by = (f, v) => T.filter(t => f(t) === v).length
    const done = T.filter(isDone).length
    const pct = T.length ? Math.round((done / T.length) * 100) : 0
    // Each tile is drawn with what it showed before, then counts up to its new number (spec 8).
    const shown = new Map($$('[data-count]', $('#fxStats')).map(b => [b.dataset.count, b.textContent]))
    const num = (key, n) => `<b data-count="${esc(key)}" data-to="${n}">${shown.get(key) ?? n}</b>`
    const chip = (facet, value, n, label, cls = '') =>
      `<button type="button" class="fx-stat ${cls}" data-facet="${facet}" data-value="${esc(value)}" aria-pressed="${(filters[facet] || []).length === 1 && filters[facet][0] === value}">${num(`${facet}:${value}`, n)}<span>${esc(label)}</span></button>`
    $('#fxStats').innerHTML = `
      <div class="fx-progress" title="${done} of ${T.length} accepted on Switchboard">
        <div class="fx-progress-bar"><i style="width:${pct}%"></i></div>
        <span>${num('done', done)} of ${T.length} accepted · ${pct}%</span>
      </div>
      <div class="fx-stat-row">
        ${['Unstarted', 'Started', 'Finished', 'Delivered', 'Rejected', 'Accepted'].map(s => chip('state', s, by(t => t.state, s), s, 'st-' + s.toLowerCase())).join('')}
      </div>
      <div class="fx-stat-row">
        ${Object.entries(REVIEW).map(([k, v]) => chip('review', k, by(reviewOf, k), v.label, 'rv-' + k)).join('')}
      </div>${FACETS.kind ? window.RoutingTickets.chipsHtml(k => by(FACETS.kind.get, k), chip) : ''}`
    $$('[data-count]', $('#fxStats')).forEach(b => window.Motion.countUp(b, Number(b.dataset.to)))
    $$('.fx-stat', $('#fxStats')).forEach(b => b.addEventListener('click', () => {
      const f = b.dataset.facet, v = b.dataset.value
      const already = (filters[f] || []).length === 1 && filters[f][0] === v
      filters[f] = already ? [] : [v]
      saveFilters()
      render()
    }))
    $('#fxNeeds').checked = (filters.review || []).length === 1 && filters.review[0] === 'needs-review'
  }

  // ─── facet dropdowns (checkbox lists) ───
  function renderFacets() {
    const box = $('#fxFacets')
    const openKey = box.querySelector('details[open]')?.dataset.key
    box.innerHTML = Object.entries(FACETS).map(([k, f]) => {
      const counts = new Map()
      for (const t of data.tickets) if (passes(t, k)) counts.set(f.get(t), (counts.get(f.get(t)) || 0) + 1)
      const all = new Set(data.tickets.map(f.get))
      const values = [...all].sort((a, b) => {
        const o = f.order || []
        return (o.indexOf(a) < 0 ? 99 : o.indexOf(a)) - (o.indexOf(b) < 0 ? 99 : o.indexOf(b)) || String(a).localeCompare(String(b))
      })
      const on = filters[k] || []
      return `<details class="fx-dd" data-key="${k}" ${openKey === k ? 'open' : ''}>
        <summary class="${on.length ? 'on' : ''}">${esc(f.label)}${on.length ? ` <b>${on.length}</b>` : ''}</summary>
        <div class="fx-dd-menu">
          ${values.map(v => `<label class="check"><input type="checkbox" data-facet="${k}" value="${esc(v)}" ${on.includes(v) ? 'checked' : ''}>
            <span>${esc(f.names?.[v] ?? v)}</span><span class="faint num">${counts.get(v) || 0}</span></label>`).join('')}
          <div class="fx-dd-foot"><button type="button" class="link" data-dd-clear="${k}">Clear</button></div>
        </div>
      </details>`
    }).join('')
    $$('input[data-facet]', box).forEach(i => i.addEventListener('change', () => {
      const k = i.dataset.facet
      filters[k] = $$(`input[data-facet="${k}"]:checked`, box).map(x => x.value)
      saveFilters()
      renderStats(); renderFacets(); renderRows()
    }))
    $$('[data-dd-clear]', box).forEach(b => b.addEventListener('click', () => { filters[b.dataset.ddClear] = []; saveFilters(); render() }))
  }

  // ─── rows ───
  const statePill = s => `<span class="fx-pill st-${esc(String(s ?? '').toLowerCase())}">${esc(s)}</span>`
  function reviewPill(t) {
    const r = reviewOf(t)
    const v = t.mark?.verdict
    return `<span class="fx-pill rv-${r}" title="${esc(t.mark?.note || '')}">${esc(REVIEW[r].short)}</span>${v ? ` <span class="fx-verdict v-${v}">${esc(VERDICT[v])}</span>` : ''}`
  }
  /** Who built it and how far it got, from the orchestration grid (orchestration.js). */
  function whereTxt(id) {
    const o = window.OrchestrationGrid?.data?.tickets?.[id]
    if (!o || !o.level) return '<span class="faint">—</span>'
    return `<span class="ox-where lv-${o.level}" data-tid="${esc(id)}">${esc(window.OrchestrationGrid.LEVEL[o.level])}</span> <span class="small">${esc(o.agents.join(', '))}</span>`
  }
  const ownerTxt = o => (o === 'me' ? 'Mine' : o === 'other' ? 'Other' : '<span class="faint">Unowned</span>')
  const mustTxt = t => ({ must: 'Must', later: 'Later', no: 'No', unplanned: '<span class="faint">—</span>' })[mustOf(t)]

  function renderRows() {
    const list = sorted(data.tickets.filter(t => passes(t)))
    $('#fxRows').innerHTML = list.length
      ? list.map((t, i) => row(t, i + 1)).join('')
      : `<tr><td colspan="9" class="empty">No ticket matches these filters.</td></tr>`
    const shownIds = list.map(t => t.id)
    $('#fxAll').checked = shownIds.length > 0 && shownIds.every(id => selected.has(id))
    $('.fx-table thead th:nth-child(3)').textContent = `Ticket · ${list.length} of ${data.tickets.length}`
    bindRows()
    window.CompletedView?.paint($('#fxRows')) // the pile-up reminder in each open Pass a task (completed-view.js)
    renderBulk()
  }
  function row(t, pos) {
    const isOpen = expanded.has(t.id)
    return `<tr class="fx-r ${isOpen ? 'open' : ''} ${isDone(t) ? 'done' : ''}" data-id="${esc(t.id)}">
        <td class="sel"><input type="checkbox" data-sel="${esc(t.id)}" ${selected.has(t.id) ? 'checked' : ''} aria-label="Select ${esc(t.id)}"></td>
        <td class="num faint">${sort === 'board' ? pos : ''}</td>
        <td class="title"><span class="id">${esc(t.id)}</span>${t.extra ? ' <span class="fx-tag">extra</span>' : ''}${window.RoutingTickets?.rowTag(window.RoutingTickets.entry(t.id)) || ''}<span class="fx-t">${esc(t.title)}</span>
          <span class="sub">${esc(t.phase || '')}${t.plan?.verdict ? ` · plan: ${esc(t.plan.verdict)}` : ''}${t.plan?.wave ? ` · wave ${esc(t.plan.wave)}` : ''}</span></td>
        <td>${statePill(t.state)}</td>
        <td>${whereTxt(t.id)}</td>
        <td>${ownerTxt(t.owner)}</td>
        <td>${mustTxt(t)}</td>
        <td>${reviewPill(t)}</td>
        <td class="fx-acts"><button type="button" class="link" data-toggle="${esc(t.id)}" aria-expanded="${isOpen}">${isOpen ? 'Close' : 'Open'}</button></td>
      </tr>${isOpen ? detail(t) : ''}`
  }
  function detail(t) {
    const m = t.mark || {}
    const agentOpts = agents.map(a => `<option value="${esc(a.name)}">${esc(a.label)}${a.state ? ' · ' + esc(a.state) : ''}</option>`).join('')
    return `<tr class="fx-detail" data-for="${esc(t.id)}"><td></td><td colspan="8">
      <div class="fx-dgrid">
        <div>
          <h4>The plan</h4>
          ${t.plan ? `<p><b>${esc(t.plan.verdict || '—')}</b>${t.plan.section ? ` · <span class="faint">${esc(t.plan.section)}</span>` : ''}</p><p>${esc(t.plan.left || '')}</p>
            <p class="small">Launch: ${esc(t.plan.must || '—')} · Wave: ${esc(t.plan.wave || '—')}</p>` : '<p class="faint">Not in the plan file.</p>'}
          <h4>Code review</h4>
          <p>${m.note ? esc(m.note) : '<span class="faint">No note.</span>'}</p>
          <p class="small faint">${m.by ? `Marked by ${esc(m.by)} · ${window.Shell.ago(m.at)}` : ''}</p>
          <form class="fx-mark" data-mark="${esc(t.id)}">
            <select name="review">${Object.entries(REVIEW).map(([k, v]) => `<option value="${k}" ${reviewOf(t) === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
            <select name="verdict"><option value="">No verdict</option>${Object.entries(VERDICT).map(([k, v]) => `<option value="${k}" ${m.verdict === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
            <input name="note" value="${esc(m.note || '')}" placeholder="Note: what is left">
            <button type="submit">Save mark</button>
          </form>
          ${window.RoutingTickets?.detailHtml(t.id, window.RoutingTickets.entry(t.id)) || ''}
        </div>
        <div>
          <h4>Do something</h4>
          <div class="fx-do">
            <button type="button" class="primary" data-review="${esc(t.id)}">Review the code with ${esc(window.FactoryChat?.name || 'the chat agent')}</button>
            <button type="button" data-ask="${esc(t.id)}">Explain this ticket</button>
          </div>
          <form class="fx-pass" data-pass="${esc(t.id)}">
            <div data-cv-reminder hidden></div>
            <label class="small">Pass a task to an agent</label>
            ${window.RoutingTickets?.suggestionHtml(window.RoutingTickets.entry(t.id)) || ''}
            <select name="agent" required>${agentOpts || '<option value="">No live agents found</option>'}</select>
            <textarea name="task" rows="2" placeholder="What should they do for ${esc(t.id)}?" required></textarea>
            <button type="submit">Send through ${esc(window.FactoryChat?.name || 'chat')}</button>
          </form>
        </div>
      </div>
    </td></tr>`
  }
  function bindRows() {
    const box = $('#fxRows')
    $$('[data-toggle]', box).forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.toggle
      expanded.has(id) ? expanded.delete(id) : expanded.add(id)
      renderRows()
    }))
    $$('tr.fx-r td.title', box).forEach(td => td.addEventListener('click', e => {
      if (window.getSelection()?.toString()) return
      const id = td.parentElement.dataset.id
      expanded.has(id) ? expanded.delete(id) : expanded.add(id)
      renderRows()
    }))
    $$('[data-sel]', box).forEach(c => c.addEventListener('change', () => { c.checked ? selected.add(c.dataset.sel) : selected.delete(c.dataset.sel); renderBulk() }))
    $$('form[data-mark]', box).forEach(f => f.addEventListener('submit', async e => {
      e.preventDefault()
      const v = Object.fromEntries(new FormData(f))
      try {
        await post('/api/factory/mark', { id: f.dataset.mark, review: v.verdict ? 'reviewed' : v.review, verdict: v.verdict, note: v.note })
        load()
      } catch (err) { alert(err.message) }
    }))
    $$('[data-review]', box).forEach(b => b.addEventListener('click', () => reviewTickets([b.dataset.review])))
    $$('[data-ask]', box).forEach(b => b.addEventListener('click', () => explainTicket(data.tickets.find(x => x.id === b.dataset.ask))))
    $$('form[data-pass]', box).forEach(f => f.addEventListener('submit', e => {
      e.preventDefault()
      const v = Object.fromEntries(new FormData(f))
      if (v.agent) passTo(v.agent, [f.dataset.pass], v.task)
    }))
  }

  // ─── actions through the chat agent ───
  // Nothing happens outside a defined flow (flow-route.mjs): each action names the flow type it starts.
  function reviewTickets(ids) {
    window.FactoryChat.send(
      `Review the code for ${ids.join(', ')}. First start a review flow for each ticket (factory flow new <id> "<title>" --type review --tickets <ID>) ` +
      `and record the review in it. For each: read the Switchboard ticket (get_story_details), find its commits and files in the repo, ` +
      `check the code does what the ticket asks, and be adversarial (bugs with file:line). Then record each result with the factory mark command ` +
      `(reviewed + verdict, or needs-review / no-code / not-codebase), and put anything that is my call to me with the factory flow ask command.`
    )
  }
  function explainTicket(t) {
    window.FactoryChat.send(
      `Explain ${t.id} (${t.title}) in plain words: what it is for, where it stands (board: ${t.state}, review: ${reviewOf(t)}), and exactly what is left. ` +
      `First start an ask flow for it (factory flow new <id> "<title>" --type ask --tickets ${t.id}) and tell the answer in it.`
    )
  }
  function passTo(agent, ids, task) {
    window.FactoryChat.send(
      `Pass this to ${agent} with SendMessage (check the exact name with ListAgents), about ${ids.join(', ')}:\n\n${task}\n\n` +
      `Tell ${agent} to start a build flow first (factory flow new <id> "<title>" --type build --tickets ${ids.join(',')} --by "${agent}"), ` +
      `follow its route (it hands the finished change to QA, which tests and pushes it) and narrate the work in that flow. ` +
      `Add the ticket titles and anything from our review they need, keep it short, and tell me exactly what you sent.`
    )
  }
  function renderBulk() {
    const bar = $('#fxBulk')
    if (!selected.size) { bar.hidden = true; return }
    bar.hidden = false
    const ids = [...selected]
    bar.innerHTML = `<div class="fx-bulk-remind" data-cv-reminder hidden></div><b>${ids.length} selected</b>
      <button type="button" class="primary" id="fxBulkReview">Review with ${esc(window.FactoryChat?.name || 'chat')}</button>
      <select id="fxBulkAgent" aria-label="Agent">${agents.map(a => `<option value="${esc(a.name)}">${esc(a.label)}</option>`).join('')}</select>
      <input id="fxBulkTask" placeholder="Task for the agent">
      <button type="button" id="fxBulkPass">Pass to agent</button>
      <button type="button" class="link" id="fxBulkClear">Clear selection</button>`
    $('#fxBulkReview').addEventListener('click', () => reviewTickets(ids))
    $('#fxBulkPass').addEventListener('click', () => {
      const a = $('#fxBulkAgent').value, task = $('#fxBulkTask').value.trim()
      if (!a || !task) return alert('Pick an agent and write the task.')
      passTo(a, ids, task)
    })
    $('#fxBulkClear').addEventListener('click', () => { selected.clear(); renderRows() })
    window.CompletedView?.paint(bar) // the pile-up reminder over Pass to agent (completed-view.js)
  }

  /**
   * Opens one ticket's row in the table. From another page (a flow on
   * #/flows names a ticket) it goes to #/tickets first and shows the row once
   * the collection has loaded.
   */
  function gotoTicket(id) {
    if (!open || !data) {
      pendingTicket = id
      if (!open) window.Shell?.go('#/tickets')
      return
    }
    fold('tickets', true)
    filters = {}; query = ''; $('#fxQ').value = ''; saveFilters()
    expanded.add(id)
    render()
    const row = () => $(`tr.fx-r[data-id="${CSS.escape(id)}"]`)
    const tr = row()
    if (!tr) return
    // to the top of the screen, and kept there while the grid above the table draws (scroll-keep.js): found again
    // by id each time, since a redraw replaces the row
    window.ScrollKeep ? window.ScrollKeep.to(row) : tr.scrollIntoView({ block: 'start' })
    tr.classList.add('flash')
    setTimeout(() => row()?.classList.remove('flash'), 1500)
  }

  // close dropdowns on outside click
  document.addEventListener('click', e => {
    if (!open) return
    for (const d of $$('.fx-dd[open]')) if (!d.contains(e.target)) d.removeAttribute('open')
  })

  window.FactoryView = {
    async open(query = {}) {
      if (query?.ticket) pendingTicket = String(query.ticket).toUpperCase() // #/tickets?ticket=FLA-820 opens that row (routing-tickets.js links)
      if (open) return
      open = true
      const gen = ++generation
      shell()
      mountActions()
      window.Shell?.setStatus('Loading…')
      window.OrchestrationGrid?.mount($('#fxOrch'))
      await Promise.all([load(), loadStatus()])
      if (!open || gen !== generation) return
      render()
      if (pendingTicket && data) {
        const id = pendingTicket
        pendingTicket = null
        gotoTicket(id)
      }
      timer = setInterval(() => { load(); loadStatus() }, POLL_MS)
    },
    close() {
      if (!open) return
      open = false
      clearInterval(timer)
      window.OrchestrationGrid?.unmount()
      unmountActions()
      root().innerHTML = ''
    },
    reload: load,
    gotoTicket,
    /** The loaded collection's tickets ([] until it loads), for the command palette (palette.js). */
    tickets: () => data?.tickets || [],
  }
})()
