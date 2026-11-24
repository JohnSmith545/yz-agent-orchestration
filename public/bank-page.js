// The Orchestration bank page (#/bank, bank-routes.mjs): the saved orchestration styles, newest first, shared by
// every project. Each shows its name, when it was saved, from which project, and one summary line; it can be
// opened (#/bank/<id>: the diagram drawn read-only with pipeline-view.js, and each agent's specification and
// rules under it), renamed, duplicated, deleted (asked on the page) and used on this project (#/bank/<id>/use: a
// confirmation that lists exactly what differs from the style in use now, the route with every agent in it, that
// the style in use now is saved to the bank first, and which agents have no session here yet). Using one restarts
// the dashboard; ProjectMenu.watchRestart waits, then lands on #/bank (never back on the question) with one line
// saying what is in use now (afterUseLine, kept for that one reload in sessionStorage). A style that EQUALS the one
// in use (the server's `same`) is never offered again: no Use button, and its confirmation asks nothing.
// The words (route, roles, models, changes) come from the server (style-words.mjs); this file only lays them out.
//
//   PURE, for the tests: listHtml(view), entryHtml(view), confirmHtml(view), afterUseLine(note), whenText(iso)
//   BankPage.open(id?, mode?) / close()   from the shell
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const enc = encodeURIComponent
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const two = n => String(n).padStart(2, '0')
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const andList = a => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`)

  /** Pure: `25 Nov 2026, 09:05` in local time; '' for anything that is not a time. */
  function whenText(iso) {
    const d = new Date(iso)
    if (!iso || Number.isNaN(d.getTime())) return ''
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}`
  }

  const status = s => (s ? `<p class="pm-status" role="status">${esc(s)}</p>` : '')
  const AFTER_USE = 'bank.afterUse'

  /** Pure: the one line the list shows after a Use, from the note the page kept over the reload; '' for none. */
  function afterUseLine(note) {
    if (!note || typeof note.entry !== 'string' || typeof note.autosaved !== 'string') return ''
    const before = note.existing ? `was already in the bank as ${note.autosaved}` : `is saved in the bank as ${note.autosaved}`
    return `${note.entry} is now in use on ${note.project || 'this project'}. The orchestration used before ${before}.`
  }

  /** Pure: one saved style in the list, as it is, being renamed, or being asked about. */
  function cardHtml(e, v) {
    const name = esc(e.name)
    const inUse = !!v.inUse && v.inUse === e.id // the style still EQUALS it (bank-routes.mjs), not only the last one taken
    const head = v.renaming === e.id
      ? `<form class="bk-rename" data-bk-rename-form="${esc(e.id)}"><label class="pm-sr" for="bk-rename">New name for ${name}</label>` +
        `<input id="bk-rename" class="set-input" maxlength="60" autocomplete="off" value="${esc(v.draft ?? e.name)}">` +
        '<button type="submit" class="primary">Save</button><button type="button" data-bk-cancel>Cancel</button></form>'
      : `<div class="bk-card-head"><h2 class="bk-name"><a href="#/bank/${enc(e.id)}">${name}</a></h2>${inUse ? '<span class="bk-tag">In use here</span>' : ''}</div>`
    const meta = `<p class="bk-meta">Saved ${esc(whenText(e.savedAt)) || 'at an unknown time'}${e.from?.name ? ` from ${esc(e.from.name)}` : ''}</p>`
    const ask = v.deleting === e.id
      ? `<div class="bk-ask" role="group" aria-label="Delete ${name}?"><p class="bk-p"><b>Delete ${name}?</b> Only the bank changes: no project loses its orchestration.</p>` +
        `<button type="button" data-bk-cancel>Cancel</button><button type="button" class="pm-danger" data-bk-delete-yes="${esc(e.id)}">Delete</button></div>`
      : ''
    const acts = v.renaming === e.id || v.deleting === e.id ? '' : '<div class="bk-acts">' +
      `<a class="link" href="#/bank/${enc(e.id)}" aria-label="Open ${name}">Open</a>` +
      `<button type="button" class="link" data-bk-rename="${esc(e.id)}" aria-label="Rename ${name}">Rename</button>` +
      `<button type="button" class="link" data-bk-duplicate="${esc(e.id)}" aria-label="Duplicate ${name}">Duplicate</button>` +
      `<button type="button" class="link" data-bk-delete="${esc(e.id)}" aria-label="Delete ${name}">Delete</button>` +
      (inUse ? '' : `<a class="bk-btn" href="#/bank/${enc(e.id)}/use" aria-label="Use ${name} on this project">Use on this project</a>`) + '</div>'
    return `<li class="card bk-card" data-bk-entry="${esc(e.id)}">${head}${meta}<p class="bk-summary">${esc(e.summary)}</p>${ask}${acts}</li>`
  }

  /** Pure: the list page: the save bar (or its form), a status line, the saved styles. */
  function listHtml(v) {
    const project = esc(v.current?.name || 'this project')
    const bar = v.saving
      ? `<form class="card bk-save" data-bk-save-form><label class="pm-sr" for="bk-save-name">Name of the saved orchestration</label>` +
        `<input id="bk-save-name" class="set-input" maxlength="60" autocomplete="off" value="${esc(v.saveName || '')}">` +
        '<button type="submit" class="primary">Save</button><button type="button" data-bk-cancel>Cancel</button></form>'
      : `<div class="bk-bar"><p class="bk-p">Saved ways of working, shared by every project. Use one on ${project} to switch how its agents work together; the one in use is saved here first, so you can always switch back.</p>` +
        '<button type="button" data-bk-save>Save the current orchestration…</button></div>'
    const seeded = v.seeded ? `<p class="bk-p">The orchestration in use was saved here as <b>${esc(v.seeded.name)}</b>.</p>` : ''
    const list = (v.entries || []).length
      ? `<ul class="bk-list">${v.entries.map(e => cardHtml(e, v)).join('')}</ul>`
      : '<div class="card bk-empty"><p class="bk-p">Nothing saved yet. Save the current orchestration to keep a copy you can switch back to.</p></div>'
    // the line after a Use is news, not a problem: its own calm look (bk-note), apart from a refusal's status
    const note = v.note ? `<p class="pm-status bk-note" role="status">${esc(v.note)}</p>` : ''
    return `<div class="bk-page">${bar}${seeded}${note}${status(v.status)}${list}</div>`
  }

  function agentHtml(a) {
    return `<li class="card bk-agent" tabindex="-1" data-bk-agent="${esc(a.label)}"><h3>${esc(a.label)} <span class="bk-role">${esc(a.roleWords || '')}</span></h3>` +
      (a.modelWords ? `<p class="bk-model">${esc(a.modelWords)}</p>` : '') +
      (a.spec ? `<p class="bk-spec">${esc(a.spec)}</p>` : '') +
      (a.rules.length ? `<ol>${a.rules.map(r => `<li>${esc(r)}</li>`).join('')}</ol>` : '') +
      (!a.spec && !a.rules.length ? '<p class="bk-none">No specification or rules.</p>' : '') + '</li>'
  }

  /** Pure: one saved style opened: its summary, its diagram box, each agent with its specification and rules. */
  function entryHtml(v) {
    const e = v.entry
    const name = esc(e.name)
    return '<div class="bk-page"><header class="bk-head"><a class="link bk-back" href="#/bank">All saved orchestrations</a>' +
      `<div class="bk-card-head"><h2 class="bk-name">${name}</h2>${v.inUse ? '<span class="bk-tag">In use here</span>' : ''}</div>` +
      `<p class="bk-meta">Saved ${esc(whenText(e.savedAt))}${e.from?.name ? ` from ${esc(e.from.name)}` : ''} · ${esc(v.view.summary)}</p>` +
      (v.confirm ? '' : `<p class="bk-p bk-route">${esc(v.view.route || '')}</p>`) + '</header>' + // the confirmation says the route itself
      (v.confirm ? confirmHtml(v)
        : v.same ? '<p class="bk-p bk-same">This is the orchestration in use on this project now.</p>'
          : `<div class="bk-acts bk-acts-start"><a class="bk-btn" href="#/bank/${enc(e.id)}/use">Use on this project</a></div>`) +
      '<h3 class="bk-h">Who hands work to whom</h3><div class="card bk-diagram pl-wrap" data-bk-diagram></div>' +
      `<h3 class="bk-h">Agents</h3><ul class="bk-agents">${v.view.agents.map(agentHtml).join('')}</ul></div>`
  }

  /** Pure: the in-page confirmation of Use on this project: exactly what differs, the route, the save first, the agents with no session. */
  function confirmHtml(v) {
    const project = esc(v.project?.name || 'this project')
    const name = esc(v.entry.name)
    if (v.same) {
      return `<section class="card bk-confirm" aria-labelledby="bk-confirm-title"><h2 id="bk-confirm-title">Already in use</h2><p class="bk-p">${name} is already the orchestration in use on ${project}. There is nothing to change.</p>` +
        '<div class="pm-actions"><a class="link" href="#/bank">Back to the bank</a></div></section>'
    }
    const changes = Array.isArray(v.changes) ? v.changes : []
    const what = changes.length
      ? `<p class="bk-p">What changes from the orchestration in use now:</p><ul class="bk-changes">${changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`
      : '<p class="bk-p">Only details this list does not name differ, such as the session names behind the agents.</p>'
    const items = [
      `The route: ${esc(v.view.route || '')}`,
      `The orchestration in use now (${esc(v.current?.summary || '')}) is saved to the bank first, under a dated name, so you can switch back.`,
      ...(v.noSession?.length ? [`${esc(andList(v.noSession))} ${v.noSession.length === 1 ? 'has' : 'have'} no session in ${project} yet. ${v.noSession.length === 1 ? 'It is set up all the same and waits for a session with that name.' : 'They are set up all the same and wait for sessions with those names.'}`] : []),
      'The dashboard restarts to load it, and this page reloads.',
    ]
    return `<section class="card bk-confirm" aria-labelledby="bk-confirm-title"><h2 id="bk-confirm-title">Use ${name} on ${project}?</h2>${what}` +
      `<ul>${items.map(x => `<li>${x}</li>`).join('')}</ul>${status(v.status)}` +
      `<div class="pm-actions"><a class="link" href="#/bank/${enc(v.entry.id)}">Cancel</a><button type="button" class="primary" data-bk-use-yes="${esc(v.entry.id)}"${v.using ? ' disabled' : ''}>${v.using ? 'Saving…' : `Use ${name}`}</button></div></section>`
  }

  window.BankPage = { listHtml, entryHtml, confirmHtml, afterUseLine, whenText }
  if (!window.document) return

  // ═══ live ═══

  const doc = window.document
  const root = () => doc.getElementById('bankView')
  const v = { entries: [], used: null, inUse: null, current: null, seeded: null, status: '', saving: false, saveName: '', renaming: null, deleting: null, draft: null }
  let one = null // the opened style: { entry, view, noSession, current, inUse, confirm, status, using }
  let token = 0
  /** The after-use note lives in sessionStorage for one reload; a storage that throws just means no line. */
  const keepNote = note => { try { window.sessionStorage.setItem(AFTER_USE, JSON.stringify(note)) } catch {} }
  function takeNote() {
    try {
      const raw = window.sessionStorage.getItem(AFTER_USE)
      window.sessionStorage.removeItem(AFTER_USE)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }
  const postJson = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    return { r, j: await r.json().catch(() => ({})) }
  }

  function paint(focus) {
    const el = root()
    if (!el) return
    if (one) {
      el.innerHTML = entryHtml(one)
      const box = el.querySelector('[data-bk-diagram]')
      if (box && window.PipelineView) {
        // read-only: a click on an agent's box brings its card below into view
        window.PipelineView.create(box, {
          onNode: id => {
            const label = one?.view.graph.nodes.find(n => n.id === id)?.label
            const card = [...el.querySelectorAll('[data-bk-agent]')].find(c => c.dataset.bkAgent === label)
            card?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
            card?.focus({ preventScroll: true })
          },
        }).update({ graph: one.view.graph, tickets: [], agents: [] })
      }
      window.Shell?.setTitle('Orchestration bank', 'bank')
      window.Shell?.setStatus(esc(one.entry.name))
    } else {
      el.innerHTML = listHtml(v)
      window.Shell?.setTitle('Orchestration bank', 'bank', v.entries.length)
      window.Shell?.setStatus(v.used ? `In use here: <b>${esc(v.used.name)}</b>` : '')
    }
    if (focus) el.querySelector(focus)?.focus()
  }

  async function loadList() {
    const r = await fetch('/api/orchestrations', { cache: 'no-store' })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
    Object.assign(v, { entries: j.entries, used: j.used, inUse: j.inUse ?? null, current: j.current, seeded: j.seeded || v.seeded })
  }

  async function open(id, mode) {
    const mine = ++token
    const el = root()
    if (!el) return
    v.status = ''
    try {
      if (id) {
        const r = await fetch(`/api/orchestrations/${enc(id)}`, { cache: 'no-store' })
        const j = await r.json()
        if (mine !== token) return
        if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
        one = { ...j, project: window.ProjectMenu?.data?.()?.current || null, confirm: mode === 'use', status: '', using: false }
        paint(mode === 'use' && !one.same ? '[data-bk-use-yes]' : '.bk-back')
      } else {
        one = null
        await loadList()
        if (mine !== token) return
        const note = takeNote()
        v.note = note ? afterUseLine(note) : ''
        paint()
      }
    } catch (e) {
      if (mine === token) el.innerHTML = `<div class="banner">Orchestration bank: ${esc(e.message)}</div>`
    }
  }

  async function act(fn, ok) {
    try {
      const { r, j } = await fn()
      if (!r.ok) v.status = j.error || `Failed (${r.status})`
      else {
        v.status = ok(j)
        Object.assign(v, { renaming: null, deleting: null, draft: null, saving: false })
      }
      await loadList()
    } catch (e) {
      v.status = e.message
    }
    paint()
    window.ProjectMenu?.reload?.()
  }

  doc.addEventListener('click', async e => {
    const el = root()
    if (!el || el.hidden || !el.contains(e.target)) return
    const t = e.target.closest('button')
    if (!t) return
    if (t.hasAttribute('data-bk-save')) {
      Object.assign(v, { saving: true, saveName: `${v.current?.name || 'Project'}, ${whenText(new Date().toISOString())}`.slice(0, 60), status: '' })
      return paint('#bk-save-name')
    }
    if (t.hasAttribute('data-bk-cancel')) {
      Object.assign(v, { saving: false, renaming: null, deleting: null, draft: null })
      return paint()
    }
    if (t.dataset.bkRename) return Object.assign(v, { renaming: t.dataset.bkRename, deleting: null, status: '' }), paint('#bk-rename')
    if (t.dataset.bkDelete) return Object.assign(v, { deleting: t.dataset.bkDelete, renaming: null, status: '' }), paint('[data-bk-delete-yes]')
    if (t.dataset.bkDuplicate) return act(() => postJson(`/api/orchestrations/${enc(t.dataset.bkDuplicate)}/duplicate`), j => `Saved a copy: ${j.entry.name}.`)
    if (t.dataset.bkDeleteYes) {
      const name = v.entries.find(x => x.id === t.dataset.bkDeleteYes)?.name
      return act(() => postJson(`/api/orchestrations/${enc(t.dataset.bkDeleteYes)}/delete`), () => `Deleted ${name}.`)
    }
    if (t.dataset.bkUseYes && one) {
      const bootId = window.ProjectMenu?.data?.()?.bootId
      Object.assign(one, { using: true, status: '' })
      paint()
      const { r, j } = await postJson(`/api/orchestrations/${enc(t.dataset.bkUseYes)}/use`)
      if (!r.ok) {
        Object.assign(one, { using: false, status: j.error || `Not used (${r.status}).` })
        return paint('[data-bk-use-yes]')
      }
      const note = { entry: one.entry.name, project: one.project?.name || '', autosaved: j.autosaved?.name || '', existing: !!j.autosaved?.existing }
      keepNote(note)
      // back on the LIST after the reload, never on the question again: Enter there would apply it once more
      return window.ProjectMenu?.watchRestart({ title: `Using ${one.entry.name}…`, sub: 'The dashboard restarts to load it; this page reloads by itself.', bootId, landAt: '#/bank', lateTitle: 'The dashboard did not come back within 45 seconds' })
    }
  })

  doc.addEventListener('submit', e => {
    const el = root()
    if (!el?.contains(e.target)) return
    e.preventDefault()
    const f = e.target
    if (f.matches('[data-bk-save-form]')) {
      v.saveName = f.querySelector('input').value
      return act(() => postJson('/api/orchestrations', { name: v.saveName }), j => `Saved ${j.entry.name}.`)
    }
    if (f.matches('[data-bk-rename-form]')) {
      v.draft = f.querySelector('input').value
      return act(() => postJson(`/api/orchestrations/${enc(f.dataset.bkRenameForm)}/rename`, { name: v.draft }), j => `Renamed to ${j.entry.name}.`)
    }
  })

  window.BankPage.open = open
  window.BankPage.close = () => {
    token++
    one = null
  }
})()
