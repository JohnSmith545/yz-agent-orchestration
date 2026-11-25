// The Lessons page (#/lessons, quality-routes.mjs GET /api/lessons): what earlier QA, Security and Senior failures
// taught, one plain sentence each, and what waits for the user.
//
//   Waiting for you · 2        candidates a model run proposed from a failure: Accept, Edit (then Save and accept),
//                              Reject. A same-as is "Counts again as L3: …": Accept adds one to that lesson's count.
//   Failures not read yet · 4  each failure no run has read: Extract lessons (one small run, ONE at a time; the line
//                              under the heading says what a run costs, and whether new ones are read on their own)
//   Add a lesson               a text box (at most 160 characters) and the area
//   tests · 3                  the library by area, in the configured order, most hit first; each lesson with how often
//     Write the failing …      it was seen, the flows that taught it (links) and Retire; a retired one is dimmed,
//                              after the active ones, with Restore
//
// The address may open it in a state: `#/lessons?area=tests` shows one area, `#/lessons?edit=<candidate id>` opens
// that candidate's Edit form. Nothing a model wrote is active until the user accepts it here.
//
//   html(data, state)  PURE: the whole page; state { edit, area, running, error }
//   open(query) / close() / reload()   the page (shell.js)
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const GATE = { qa: 'QA', security: 'Security', senior: 'Senior' }
  /** What one run costs, measured on real runs (README, Lessons): MUST CHANGE IN LOCKSTEP with the README. */
  const RUN_COST = 'about $0.015'
  const HELP = '<p>A <b>lesson</b> is one plain sentence an earlier failure taught, such as <i>Write the failing test before the code</i>. ' +
    'The lessons that match a new task are printed in its builder\'s brief, at most 7, and they make the builder\'s self-check before QA.</p>' +
    `<p>When QA, Security or Senior fails a piece of work, one small model run (${RUN_COST}) reads what it found and proposes up to 3 lessons. ` +
    'Nothing it proposes is used until you <b>Accept</b> it. When it repeats a lesson you have, it says so, and accepting adds one to that lesson\'s count.</p>' +
    '<p><b>Retire</b> takes a lesson out of the briefs; <b>Restore</b> brings it back. You can also type a lesson yourself.</p>' +
    '<p>Automatic runs are set in config.json, <code>quality.autoLessons</code>. Failures from before the library started are never read on their own.</p>'

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const areaOptions = (areas, selected) => areas.map(a => `<option value="${esc(a)}"${a === selected ? ' selected' : ''}>${esc(a)}</option>`).join('')
  /** A plain link to the flow (#/flows?flow=<id>, flows-page.js opens it): it wraps like text on a phone. */
  const flowLink = (id, title) => `<a class="link" href="#/flows?flow=${encodeURIComponent(id ?? '')}" data-ql-flow="${esc(id)}">${esc(title || id)}</a>`

  function candidateRow(c, data, state) {
    const from = `<span class="ql-from">From ${flowLink(c.source?.flow, c.title)} (${esc(GATE[c.source?.gate] || c.source?.gate)})</span>`
    if (state.edit === c.id && c.kind === 'new') {
      return `<li class="ql-row"><form class="ql-edit" data-ql-form="${esc(c.id)}">` +
        `<label class="ql-label" for="qlEdit-${esc(c.id)}">Lesson</label>` +
        `<input id="qlEdit-${esc(c.id)}" name="text" maxlength="${Number(data.limits?.text) || 160}" value="${esc(c.text)}" required>` +
        `<label class="ql-label" for="qlArea-${esc(c.id)}">Area</label><select id="qlArea-${esc(c.id)}" name="area">${areaOptions(data.areas || [], c.area)}</select>` +
        `<span class="ql-acts"><button type="submit" class="primary">Save and accept</button><button type="button" data-ql-cancel>Cancel</button></span>` +
        `${state.error ? `<p class="small warn" role="alert">${esc(state.error)}</p>` : ''}</form><p class="ql-meta">${from}</p></li>`
    }
    const words = c.kind === 'same'
      ? `<span class="ql-text">Counts again as ${esc(c.lesson)}: ${esc(c.text)}</span>`
      : `<span class="ql-text">${esc(c.text)}</span>`
    const acts = `<button type="button" class="link" data-ql-accept="${esc(c.id)}">Accept</button>` +
      (c.kind === 'new' ? `<button type="button" class="link" data-ql-edit="${esc(c.id)}">Edit</button>` : '') +
      `<button type="button" class="link ql-bad" data-ql-reject="${esc(c.id)}">Reject</button>`
    return `<li class="ql-row"><div class="ql-main">${words}<span class="ql-meta"><span class="ql-area">${esc(c.area)}</span>${from}</span></div><div class="ql-acts">${acts}</div></li>`
  }

  function candidatesHtml(data, state) {
    const list = Array.isArray(data.candidates) ? data.candidates : []
    if (!list.length) return ''
    return `<section class="card ql-group" aria-labelledby="ql-h-wait"><h3 id="ql-h-wait">Waiting for you <span class="faint">· ${list.length}</span></h3>` +
      '<p class="ql-line">Proposed by a model run from a failure. Nothing here is used until you accept it.</p>' +
      `<ul class="ql-rows">${list.map(c => candidateRow(c, data, state)).join('')}</ul></section>`
  }

  function failuresHtml(data, state) {
    const list = Array.isArray(data.failures) ? data.failures : []
    if (!list.length) return ''
    const auto = data.settings?.autoLessons
      ? 'New failures are read on their own, one at a time; older ones wait for you.'
      : 'Automatic runs are off (config.json quality.autoLessons), so each waits for you.'
    const rows = list.map(f => {
      const running = state.running === f.key
      const btn = `<button type="button" data-ql-extract="${esc(f.key)}"${data.busy || state.running ? ' disabled' : ''}>${running ? 'Reading…' : f.retry ? 'Try again' : 'Extract lessons'}</button>`
      return `<li class="ql-row"><div class="ql-main"><span class="ql-text">${flowLink(f.flow, f.title)} <span class="faint">${esc(GATE[f.gate] || f.gate)} · ${esc(window.Shell?.ago(f.at) || '')}</span></span>` +
        (f.summary ? `<span class="ql-summary" title="${esc(f.summary)}">${esc(f.summary)}</span>` : '') +
        (f.retry ? '<span class="ql-meta warn">The last run could not be read.</span>' : '') + `</div><div class="ql-acts">${btn}</div></li>`
    }).join('')
    return `<section class="card ql-group" aria-labelledby="ql-h-fail"><h3 id="ql-h-fail">Failures not read yet <span class="faint">· ${list.length}</span></h3>` +
      `<p class="ql-line">Extract lessons reads one with a small model run, which costs ${RUN_COST}. ${auto}</p>` +
      `${state.note ? `<p class="small" role="status">${esc(state.note)}</p>` : ''}<ul class="ql-rows">${rows}</ul></section>`
  }

  function addHtml(data, state) {
    return '<section class="card ql-group" aria-labelledby="ql-h-add"><h3 id="ql-h-add">Add a lesson</h3>' +
      '<p class="ql-line">One plain sentence that tells the next builder what to do.</p>' +
      `<form class="ql-add" data-ql-add><label class="ql-label" for="qlNew">Lesson</label><input id="qlNew" name="text" maxlength="${Number(data.limits?.text) || 160}" placeholder="Stop the preview server you started." required>` +
      `<label class="ql-label" for="qlNewArea">Area</label><select name="area" id="qlNewArea">${areaOptions(data.areas || [], 'general')}</select>` +
      `<button type="submit" class="primary">Add</button>${state.addError ? `<p class="small warn" role="alert">${esc(state.addError)}</p>` : ''}</form></section>`
  }

  function lessonRow(l, titles) {
    const sources = (l.sources || []).map(s => `${flowLink(s.flow, titles.get(s.flow))} <span class="faint">(${esc(GATE[s.gate] || s.gate)})</span>`)
    const who = l.by === 'you' ? 'Typed by you' : 'From a failure, accepted by you'
    const meta = [`Seen ${plural(l.count, 'time')}`, who, ...(sources.length ? [`Taught by ${sources.join(', ')}`] : [])].map(m => `<span>${m}</span>`)
    const act = l.status === 'retired'
      ? `<button type="button" class="link" data-ql-restore="${esc(l.id)}">Restore</button>`
      : `<button type="button" class="link" data-ql-retire="${esc(l.id)}">Retire</button>`
    return `<li class="ql-row${l.status === 'retired' ? ' is-retired' : ''}"><div class="ql-main"><span class="ql-text">${esc(l.text)} <span class="faint">${esc(l.id)}</span>` +
      `${l.status === 'retired' ? ' <span class="ql-pill">retired</span>' : ''}</span><span class="ql-meta">${meta.join('<span aria-hidden="true">·</span>')}</span></div><div class="ql-acts">${act}</div></li>`
  }

  function lessonsHtml(data, state) {
    const all = Array.isArray(data.lessons) ? data.lessons : []
    if (!all.length) return '<section class="card ql-group"><p class="ql-empty">No lessons yet. They arrive from failures you accept above, or you can type one.</p></section>'
    const titles = new Map([...(data.candidates || []).map(c => [c.source?.flow, c.title]), ...(data.failures || []).map(f => [f.flow, f.title]), ...Object.entries(data.titles || {})])
    const order = [...(data.areas || []), ...new Set(all.map(l => l.area).filter(a => !(data.areas || []).includes(a)))]
    const groups = order.filter(a => !state.area || a === state.area).map(area => {
      const list = all.filter(l => l.area === area).sort((a, b) => (a.status === 'retired') - (b.status === 'retired') || b.count - a.count)
      if (!list.length) return ''
      return `<section class="card ql-group" aria-labelledby="ql-h-${esc(area)}"><h3 id="ql-h-${esc(area)}">${esc(area)} <span class="faint">· ${list.length}</span></h3>` +
        `<ul class="ql-rows">${list.map(l => lessonRow(l, titles)).join('')}</ul></section>`
    }).join('')
    return groups || `<section class="card ql-group"><p class="ql-empty">No lessons in ${esc(state.area)}.</p></section>`
  }

  /** The whole page. `data` is GET /api/lessons's answer. */
  function html(data, state = {}) {
    const st = { edit: null, area: null, running: null, error: '', note: '', addError: '', ...state }
    return `<div class="ql-page">${candidatesHtml(data, st)}${failuresHtml(data, st)}${addHtml(data, st)}${lessonsHtml(data, st)}</div>`
  }

  window.QualityLessons = { html, RUN_COST, open() {}, close() {}, reload() {} }
  if (!window.document) return

  // ═══ the page ═══

  const view = () => document.getElementById('lessonsView')
  let on = false
  let data = null
  let failure = ''
  let gen = 0
  const state = { edit: null, area: null, running: null, error: '', note: '', addError: '' }

  function head() {
    if (!on || window.Shell.current?.view !== 'lessons') return
    const active = (data?.lessons || []).filter(l => l.status === 'active').length
    const waiting = data?.candidates?.length || 0
    window.Shell.setTitle('Lessons', 'lessons', data ? active : null)
    window.Shell.setStatus(failure ? `<span class="warn">Could not load the lessons: ${esc(failure)}</span>`
      : data ? `${plural(active, 'active lesson')} · ${waiting} waiting for you` : 'Loading…', HELP)
  }

  function paint(focus = null) {
    head()
    const el = view()
    if (!el || !data) return
    el.innerHTML = html(data, state)
    const target = focus ? el.querySelector(focus) : null
    target?.focus()
  }

  async function reload() {
    if (!on) return
    const mine = ++gen
    try {
      const r = await fetch('/api/lessons')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || r.status)
      if (mine !== gen) return
      data = j
      failure = ''
    } catch (e) {
      if (mine !== gen) return
      failure = e?.message || String(e)
    }
    paint()
  }

  async function call(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }
    } catch (e) {
      return { ok: false, status: 0, j: { error: e?.message || String(e) } }
    }
  }
  const toast = t => window.Notifier?.toast(esc(t), { kind: 'info', keep: false })
  const enc = encodeURIComponent

  async function onClick(e) {
    const t = e.target
    const pick = name => t.closest(`[${name}]`)?.getAttribute(name)
    let id
    if ((id = pick('data-ql-edit'))) {
      Object.assign(state, { edit: id, error: '' })
      return paint(`[data-ql-form="${CSS.escape(id)}"] input`)
    }
    if (t.closest('[data-ql-cancel]')) {
      Object.assign(state, { edit: null, error: '' })
      return paint()
    }
    if ((id = pick('data-ql-accept')) || (id = pick('data-ql-reject'))) {
      const accept = !!t.closest('[data-ql-accept]')
      const r = await call(`/api/lessons/candidates/${enc(id)}/${accept ? 'accept' : 'reject'}`)
      if (!r.ok) window.alert?.(r.j?.error || `Failed (${r.status})`)
      else if (accept) toast(`Lesson ${r.j.lesson?.id} is in the library: ${r.j.lesson?.text}`)
      return reload()
    }
    if ((id = pick('data-ql-retire')) || (id = pick('data-ql-restore'))) {
      const retire = !!t.closest('[data-ql-retire]')
      const r = await call(`/api/lessons/${enc(id)}/${retire ? 'retire' : 'restore'}`)
      if (!r.ok) window.alert?.(r.j?.error || `Failed (${r.status})`)
      return reload()
    }
    if ((id = pick('data-ql-extract'))) {
      Object.assign(state, { running: id, note: '' })
      paint()
      const r = await call('/api/lessons/extract', { key: id })
      const cost = typeof r.j?.cost === 'number' ? ` It cost $${r.j.cost.toFixed(3)}.` : ''
      state.running = null
      state.note = r.ok ? `${r.j.candidates ? `${plural(r.j.candidates, 'lesson')} proposed: see Waiting for you.` : 'Nothing new to learn from that one.'}${cost}` : `${r.j?.error || `Failed (${r.status})`}${cost}`
      return reload()
    }
  }

  async function onSubmit(e) {
    const form = e.target
    e.preventDefault()
    const text = form.elements.text?.value || ''
    const area = form.elements.area?.value || ''
    if (form.hasAttribute('data-ql-add')) {
      const r = await call('/api/lessons', { text, area })
      state.addError = r.ok ? '' : r.j?.error || `Failed (${r.status})`
      if (r.ok) toast(`Lesson ${r.j.lesson?.id} is in the library.`)
      await reload()
      return view()?.querySelector('#qlNew')?.focus()
    }
    const id = form.getAttribute('data-ql-form')
    const r = await call(`/api/lessons/candidates/${enc(id)}/accept`, { text, area })
    if (!r.ok) {
      state.error = r.j?.error || `Failed (${r.status})`
      return paint(`[data-ql-form="${CSS.escape(id)}"] input`)
    }
    Object.assign(state, { edit: null, error: '' })
    toast(`Lesson ${r.j.lesson?.id} is in the library: ${r.j.lesson?.text}`)
    return reload()
  }

  let built = false
  function build() {
    const el = view()
    el.addEventListener('click', onClick)
    el.addEventListener('submit', onSubmit)
    built = true
  }

  window.QualityLessons = {
    html, RUN_COST, reload,
    open(query = {}) {
      if (!built) build()
      on = true
      state.area = typeof query.area === 'string' && query.area ? query.area : null
      state.edit = typeof query.edit === 'string' && query.edit ? query.edit : null
      head()
      reload()
    },
    close() {
      on = false
      Object.assign(state, { edit: null, error: '', note: '', addError: '' })
    },
  }
})()
