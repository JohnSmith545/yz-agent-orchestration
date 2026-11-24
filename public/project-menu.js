// The Project menu (projects-routes.mjs), at the top of the rail: the project the dashboard shows now, with a
// chevron and, under it, the orchestration it last took from the bank. Opening it lists the projects (the current
// one checked) and ends with "Add a project…" and "Rename or remove…". Choosing another project switches the
// WHOLE dashboard: the server restarts with it, and this page shows "Switching to <name>…", waits for the server
// to answer with the new project (a new bootId), and reloads itself; after 45 seconds it says plainly what to do.
//
// ═══ KEYBOARD ═══ The button has aria-haspopup="menu" and aria-expanded. Enter, Space or Down opens the menu on
// the current project (Up: on the last item); in the menu Up and Down move (wrapping), Home and End jump, Enter
// and Space choose, Escape and Tab close it and focus goes back to the button. A click outside closes it.
// The dialogs (add, rename or remove) are in-page: Escape closes them, focus goes back to the button; removing
// asks on the page, never with confirm().
//
// Address states, for a link or a screenshot: ?project=menu, ?project=add, ?project=manage,
// ?project=switching&to=<id> (the waiting screen, waiting for that project).
//
//   PURE, for the tests: buttonHtml, menuHtml, addHtml, manageHtml, switchingHtml, nextIndex, fromSearch, switchDone
//   ProjectMenu.watchRestart({ title, sub, target?, bootId })   the waiting screen, also used by the bank page
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const WAIT_MS = 45_000
  const POLL_MS = 600
  const CHEVRON = '<svg class="pm-chev" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3 4.5 6 7.5 9 4.5"/></svg>'
  const initial = name => esc((String(name || '?').trim()[0] || '?').toUpperCase())

  /** Pure: the rail button's inside. */
  function buttonHtml(d) {
    const cur = d?.current || { name: 'Project' }
    const orch = (d?.projects || []).find(p => p.current)?.orchestration
    const said = `Project: ${cur.name}${orch ? `. Orchestration: ${orch.name}` : ''}. Change project`
    return `<span class="rail-icon"><span class="pm-badge" aria-hidden="true">${initial(cur.name)}</span></span>` +
      `<span class="rail-label pm-label"><span class="pm-line"><span class="pm-name">${esc(cur.name)}</span>${CHEVRON}</span>` +
      (orch ? `<span class="pm-orch">Orchestration: ${esc(orch.name)}</span>` : '') + '</span>' +
      `<span class="pm-said" hidden>${esc(said)}</span>`
  }

  /** Pure: the menu: one radio item per project, then the two actions. */
  function menuHtml(d) {
    const items = (d?.projects || []).map(p =>
      `<button type="button" role="menuitemradio" aria-checked="${p.current ? 'true' : 'false'}" class="pm-item" data-pm-project="${esc(p.id)}">` +
      `<span class="pm-tick" aria-hidden="true">${p.current ? '<svg viewBox="0 0 12 12" focusable="false"><path d="m2.5 6.3 2.3 2.3 4.7-5"/></svg>' : ''}</span>` +
      `<span class="pm-item-text"><span class="pm-item-name">${esc(p.name)}</span>` +
      `<span class="pm-item-sub">${p.orchestration ? `Orchestration: ${esc(p.orchestration.name)}` : esc(p.repo)}</span></span></button>`).join('')
    return `${items}<div class="pm-sep" role="separator"></div>` +
      '<button type="button" role="menuitem" class="pm-item pm-action" data-pm-add><span class="pm-tick" aria-hidden="true"></span><span class="pm-item-text">Add a project…</span></button>' +
      '<button type="button" role="menuitem" class="pm-item pm-action" data-pm-manage><span class="pm-tick" aria-hidden="true"></span><span class="pm-item-text">Rename or remove…</span></button>'
  }

  /** Pure: the next item for a key, wrapping; -1 for a key that does not move. */
  function nextIndex(key, i, n) {
    if (!n) return -1
    if (key === 'ArrowDown') return (i + 1 + n) % n
    if (key === 'ArrowUp') return (i - 1 + n) % n
    if (key === 'Home') return 0
    if (key === 'End') return n - 1
    return -1
  }

  const field = (id, label, input, hint = '') =>
    `<div class="pm-field"><label for="${id}">${label}</label>${input}${hint ? `<p class="pm-hint" id="${id}-hint">${hint}</p>` : ''}</div>`

  /** Pure: the Add a project form, or the line after it was added. */
  function addHtml(s) {
    if (s.added) {
      return `<h2 id="pm-dialog-title">Added ${esc(s.added.name)}</h2>` +
        `<p class="pm-p">It starts with ${esc(s.added.startName)}. Its flows, rules and evidence are kept apart from every other project.</p>` +
        '<div class="pm-actions"><button type="button" data-pm-close>Stay here</button>' +
        `<button type="button" class="primary" data-pm-switch="${esc(s.added.id)}">Switch to ${esc(s.added.name)}</button></div>`
    }
    const v = s.values || {}
    const options = [`<option value="same"${!v.start || v.start === 'same' ? ' selected' : ''}>The same as ${esc(s.current?.name || 'this project')}</option>`,
      ...(s.bank || []).map(e => `<option value="${esc(e.id)}"${v.start === e.id ? ' selected' : ''}>${esc(e.name)}</option>`)].join('')
    return '<h2 id="pm-dialog-title">Add a project</h2>' +
      '<form class="pm-form" data-pm-form novalidate>' +
      field('pm-name', 'Name', `<input id="pm-name" name="name" class="set-input" maxlength="40" autocomplete="off" value="${esc(v.name || '')}">`) +
      field('pm-repo', 'Folder of its repository', `<input id="pm-repo" name="repo" class="set-input" spellcheck="false" autocomplete="off" placeholder="C:/work/my-repo" aria-describedby="pm-repo-hint" value="${esc(v.repo || '')}">`,
        'The top folder of a git repository on this computer.') +
      field('pm-match', 'How its sessions are recognised', `<input id="pm-match" name="sessionCwdMatch" class="set-input" spellcheck="false" autocomplete="off" maxlength="100" placeholder="the folder name" aria-describedby="pm-match-hint" value="${esc(v.sessionCwdMatch || '')}">`,
        'A session counts when its folder contains this text. Left empty, the folder name is used.') +
      field('pm-start', 'Orchestration it starts with', `<select id="pm-start" name="start">${options}</select>`) +
      (s.status ? `<p class="pm-status" role="status">${esc(s.status)}</p>` : '') +
      `<div class="pm-actions"><button type="button" data-pm-close>Cancel</button><button type="submit" class="primary"${s.saving ? ' disabled' : ''}>${s.saving ? 'Adding…' : 'Add project'}</button></div></form>`
  }

  /** Pure: the Rename or remove list, with the row being renamed or asked about. */
  function manageHtml(s) {
    const rows = (s.projects || []).map(p => {
      const name = esc(p.name)
      if (s.renaming === p.id) {
        return `<li class="pm-row"><form class="pm-rename" data-pm-rename-form="${esc(p.id)}"><label class="pm-sr" for="pm-rename">New name for ${name}</label>` +
          `<input id="pm-rename" class="set-input" maxlength="40" value="${esc(s.draft ?? p.name)}" autocomplete="off">` +
          '<button type="submit" class="primary">Save</button><button type="button" data-pm-cancel>Cancel</button></form></li>'
      }
      if (s.removing === p.id) {
        return `<li class="pm-row pm-asking" role="group" aria-label="Remove ${name}?"><p class="pm-p"><b>Remove ${name} from the list?</b> ` +
          'Only the list changes: its flows, rules and evidence stay on disk, and its repository is not touched.</p>' +
          `<div class="pm-actions"><button type="button" data-pm-cancel>Cancel</button><button type="button" class="pm-danger" data-pm-remove-yes="${esc(p.id)}">Remove</button></div></li>`
      }
      const why = p.current ? 'Shown now' : p.primary ? 'First project' : ''
      return `<li class="pm-row"><div class="pm-row-text"><span class="pm-item-name">${name}</span><span class="pm-item-sub">${esc(p.repo)}</span></div>` +
        `<div class="pm-row-acts">${why ? `<span class="pm-note">${why}</span>` : ''}<button type="button" class="link" data-pm-rename="${esc(p.id)}" aria-label="Rename ${name}">Rename</button>` +
        (p.current || p.primary ? '' : `<button type="button" class="link" data-pm-remove="${esc(p.id)}" aria-label="Remove ${name}">Remove</button>`) + '</div></li>'
    }).join('')
    return `<h2 id="pm-dialog-title">Rename or remove projects</h2><ul class="pm-rows">${rows}</ul>` +
      (s.status ? `<p class="pm-status" role="status">${esc(s.status)}</p>` : '') +
      '<p class="pm-hint">The project shown now cannot be removed, nor the first project, the one the dashboard was set up with.</p>' +
      '<div class="pm-actions"><button type="button" data-pm-close>Close</button></div>'
  }

  /** Pure: the waiting screen: waiting, refused, or not back in time. */
  function switchingHtml(s) {
    if (s.state === 'refused') {
      return `<h2 id="pm-wait-title">${esc(s.failTitle || 'Not switched')}</h2><p class="pm-p">${esc(s.error)}</p>` +
        '<div class="pm-actions"><button type="button" class="primary" data-pm-wait-close>Close</button></div>'
    }
    if (s.state === 'late') {
      return `<h2 id="pm-wait-title">${esc(s.lateTitle)}</h2>` +
        '<p class="pm-p">If you started the dashboard by hand, start it again in its folder with <code>npm start</code>. ' +
        `If it runs under keep-alive, it should be back soon${s.log ? `; its log is <code>${esc(s.log)}</code>` : ''}.</p>` +
        '<div class="pm-actions"><button type="button" class="primary" data-pm-reload>Try again</button></div>'
    }
    return `<div class="pm-spin" aria-hidden="true"></div><h2 id="pm-wait-title">${esc(s.title)}</h2><p class="pm-p">${esc(s.sub || 'The dashboard restarts. This page reloads by itself.')}</p>`
  }

  /** Pure: the state the address asks for (?project=menu|add|manage|switching&to=<id>). */
  function fromSearch(search) {
    const q = new URLSearchParams(String(search || '').replace(/^\?/, ''))
    const open = q.get('project')
    return ['menu', 'add', 'manage', 'switching'].includes(open) ? { open, to: q.get('to') || '' } : { open: null, to: '' }
  }

  /** Pure: is the server back with what we waited for (`target` the project id, or any; a NEW bootId)? */
  const switchDone = (body, target, bootId) => !!body && body.bootId !== bootId && (!target || body.current?.id === target)

  window.ProjectMenu = { buttonHtml, menuHtml, addHtml, manageHtml, switchingHtml, nextIndex, fromSearch, switchDone }
  if (!window.document) return

  // ═══ the page ═══

  const doc = window.document
  const slot = doc.getElementById('railProject')
  if (!slot) return
  const enc = encodeURIComponent
  let data = null
  const btn = doc.createElement('button')
  btn.type = 'button'
  btn.className = 'rail-item pm-button'
  btn.id = 'projectButton'
  btn.setAttribute('aria-haspopup', 'menu')
  btn.setAttribute('aria-expanded', 'false')
  btn.setAttribute('aria-controls', 'projectMenu')
  slot.append(btn)
  const menu = doc.createElement('div')
  menu.id = 'projectMenu'
  menu.className = 'pm-menu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', 'Projects')
  menu.hidden = true
  doc.body.append(menu)

  async function load() {
    try {
      const r = await fetch('/api/projects', { cache: 'no-store' })
      data = await r.json()
      paintButton()
    } catch {}
    return data
  }
  function paintButton() {
    btn.innerHTML = buttonHtml(data)
    const said = btn.querySelector('.pm-said')?.textContent || 'Change project'
    btn.setAttribute('aria-label', said)
    btn.title = said
  }
  const postJson = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    return { r, j: await r.json().catch(() => ({})) }
  }

  // ─── the menu ───
  const items = () => [...menu.querySelectorAll('.pm-item')]
  function openMenu(focusAt = 'current') {
    menu.innerHTML = menuHtml(data)
    const b = btn.getBoundingClientRect()
    const phone = window.matchMedia?.('(max-width: 720px)').matches
    menu.style.top = phone ? '' : `${Math.max(8, b.top)}px`
    menu.hidden = false
    btn.setAttribute('aria-expanded', 'true')
    const list = items()
    const at = focusAt === 'last' ? list.length - 1 : Math.max(0, list.findIndex(el => el.getAttribute('aria-checked') === 'true'))
    list[at]?.focus()
  }
  function closeMenu(refocus = true) {
    if (menu.hidden) return
    menu.hidden = true
    btn.setAttribute('aria-expanded', 'false')
    if (refocus) btn.focus()
  }
  btn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()))
  btn.addEventListener('keydown', e => {
    if (['ArrowDown', 'ArrowUp'].includes(e.key) || ((e.key === 'Enter' || e.key === ' ') && menu.hidden)) {
      e.preventDefault()
      openMenu(e.key === 'ArrowUp' ? 'last' : 'current')
    }
  })
  menu.addEventListener('keydown', e => {
    const list = items()
    const i = list.indexOf(doc.activeElement)
    const n = nextIndex(e.key, i, list.length)
    if (n >= 0) {
      e.preventDefault()
      list[n].focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeMenu()
    } else if (e.key === 'Tab') closeMenu(false)
  })
  menu.addEventListener('click', e => {
    const it = e.target.closest?.('.pm-item')
    if (!it) return
    if (it.dataset.pmProject !== undefined) {
      const p = data.projects.find(x => x.id === it.dataset.pmProject)
      closeMenu()
      if (p && !p.current) switchTo(p)
    } else if (it.hasAttribute('data-pm-add')) openDialog('add')
    else if (it.hasAttribute('data-pm-manage')) openDialog('manage')
  })
  doc.addEventListener('pointerdown', e => {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu(false)
  })

  // ─── the dialogs ───
  let dialog = null
  const dlg = { mode: null, values: {}, status: '', saving: false, added: null, bank: [], renaming: null, removing: null, draft: null }
  function paintDialog() {
    if (!dialog) return
    const box = dialog.querySelector('.pm-dialog')
    const s = { ...dlg, current: data?.current, projects: data?.projects }
    box.innerHTML = dlg.mode === 'add' ? addHtml(s) : manageHtml(s)
  }
  async function openDialog(mode) {
    closeMenu(false)
    Object.assign(dlg, { mode, values: {}, status: '', saving: false, added: null, renaming: null, removing: null, draft: null })
    dialog?.remove()
    dialog = doc.createElement('div')
    dialog.className = 'modal pm-modal'
    dialog.innerHTML = '<div class="box card pm-dialog" role="dialog" aria-modal="true" aria-labelledby="pm-dialog-title"></div>'
    doc.body.append(dialog)
    paintDialog()
    dialog.querySelector('input, button')?.focus()
    if (mode === 'add') {
      try {
        const r = await fetch('/api/orchestrations', { cache: 'no-store' })
        dlg.bank = (await r.json()).entries || []
        if (dialog && dlg.mode === 'add' && !dlg.added) {
          const focused = dialog.contains(doc.activeElement) ? doc.activeElement.id : 'pm-name'
          dlg.values = readForm() // what was typed while the bank loaded stays
          paintDialog()
          if (focused) dialog.querySelector(`#${focused}`)?.focus()
        }
      } catch {}
    }
  }
  function closeDialog() {
    dialog?.remove()
    dialog = null
    btn.focus()
  }
  const readForm = () => {
    const f = dialog?.querySelector('[data-pm-form]')
    if (!f) return dlg.values
    return Object.fromEntries(['name', 'repo', 'sessionCwdMatch', 'start'].map(k => [k, f.elements[k]?.value ?? '']))
  }
  doc.addEventListener('keydown', e => {
    if (e.key === 'Escape' && dialog && !e.defaultPrevented) {
      e.preventDefault()
      closeDialog()
    }
  })
  doc.addEventListener('submit', async e => {
    if (!dialog?.contains(e.target)) return
    e.preventDefault()
    const form = e.target
    if (form.matches('[data-pm-form]')) {
      dlg.values = readForm()
      Object.assign(dlg, { saving: true, status: 'Checking the folder…' })
      paintDialog()
      const { r, j } = await postJson('/api/projects', dlg.values)
      dlg.saving = false
      if (!r.ok) {
        dlg.status = j.error || `Not added (${r.status}).`
        paintDialog()
        return dialog.querySelector('[data-pm-form] .primary')?.focus()
      }
      const start = dlg.values.start === 'same' || !dlg.values.start ? `the same orchestration as ${data?.current?.name}` : (dlg.bank.find(x => x.id === dlg.values.start)?.name || 'the chosen orchestration')
      dlg.added = { ...j.project, startName: start }
      await load()
      paintDialog()
      dialog.querySelector('[data-pm-switch]')?.focus()
    } else if (form.matches('[data-pm-rename-form]')) {
      const id = form.dataset.pmRenameForm
      dlg.draft = form.querySelector('input').value
      const { r, j } = await postJson(`/api/projects/${enc(id)}/rename`, { name: dlg.draft })
      if (!r.ok) dlg.status = j.error || `Not renamed (${r.status}).`
      else Object.assign(dlg, { renaming: null, draft: null, status: `Renamed to ${j.project.name}.` })
      await load()
      paintDialog()
    }
  })
  doc.addEventListener('click', async e => {
    if (!dialog) return
    if (e.target === dialog) return closeDialog() // the backdrop
    const t = e.target.closest?.('button')
    if (!t || !dialog.contains(t)) return
    if (t.hasAttribute('data-pm-close')) return closeDialog()
    if (t.dataset.pmSwitch) {
      const p = data?.projects.find(x => x.id === t.dataset.pmSwitch)
      closeDialog()
      return p && switchTo(p)
    }
    if (t.dataset.pmRename) Object.assign(dlg, { renaming: t.dataset.pmRename, removing: null, draft: null, status: '' })
    else if (t.dataset.pmRemove) Object.assign(dlg, { removing: t.dataset.pmRemove, renaming: null, status: '' })
    else if (t.hasAttribute('data-pm-cancel')) Object.assign(dlg, { removing: null, renaming: null, draft: null })
    else if (t.dataset.pmRemoveYes) {
      const id = t.dataset.pmRemoveYes
      const name = data?.projects.find(x => x.id === id)?.name
      const { r, j } = await postJson(`/api/projects/${enc(id)}/remove`)
      dlg.removing = null
      dlg.status = r.ok ? `${name} is no longer in the list. Its data stays on disk.` : j.error || `Not removed (${r.status}).`
      await load()
    } else return
    paintDialog()
    dialog?.querySelector('#pm-rename, [data-pm-remove-yes], [data-pm-rename], .pm-actions button')?.focus()
  })

  // ─── switching ───
  let waiting = null
  function showWait(s) {
    if (!waiting) {
      waiting = doc.createElement('div')
      waiting.className = 'modal pm-wait'
      waiting.innerHTML = '<div class="box card pm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="pm-wait-title" aria-live="polite"></div>'
      doc.body.append(waiting)
    }
    waiting.querySelector('.pm-dialog').innerHTML = switchingHtml(s)
    waiting.querySelector('button')?.focus()
  }
  function closeWait() {
    waiting?.remove()
    waiting = null
    btn.focus()
  }
  doc.addEventListener('click', e => {
    if (!waiting) return
    if (e.target.closest?.('[data-pm-wait-close]')) closeWait()
    else if (e.target.closest?.('[data-pm-reload]')) window.location.reload()
  })

  /** Waits for the server to come back (a NEW bootId, and `target` when given), then reloads; says so after 45 s. */
  /** `landAt` (a hash such as #/bank): where the page reloads to, so it never comes back on the question it just answered. */
  async function watchRestart({ title, sub, target = '', bootId, log = '', lateTitle, landAt = '' }) {
    showWait({ state: 'wait', title, sub })
    const until = Date.now() + WAIT_MS
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, POLL_MS))
      try {
        const r = await fetch('/api/projects', { cache: 'no-store' })
        const body = await r.json()
        if (switchDone(body, target, bootId)) {
          if (landAt) window.history.replaceState(null, '', landAt)
          return window.location.reload()
        }
        if (body.bootId === bootId && body.restartError) {
          return showWait({ state: 'refused', failTitle: 'The dashboard did not restart', error: body.restartError })
        }
      } catch {} // the server is between the old and the new: keep waiting
    }
    showWait({ state: 'late', lateTitle: lateTitle || `${title.replace(/…$/, '')} is taking too long`, log })
  }

  async function switchTo(p) {
    const bootId = data?.bootId
    showWait({ state: 'wait', title: `Switching to ${p.name}…` })
    const { r, j } = await postJson(`/api/projects/${enc(p.id)}/switch`)
    if (r.status === 200 && j.already) return closeWait()
    if (!r.ok) return showWait({ state: 'refused', error: j.error || `Not switched (${r.status}).` })
    return watchRestart({ title: `Switching to ${p.name}…`, target: p.id, bootId, log: j.log, lateTitle: `${p.name} did not come back within 45 seconds` })
  }

  window.ProjectMenu.watchRestart = watchRestart
  window.ProjectMenu.reload = load
  window.ProjectMenu.data = () => data

  load().then(() => {
    const want = fromSearch(window.location.search)
    if (want.open === 'menu') openMenu()
    else if (want.open === 'add' || want.open === 'manage') openDialog(want.open)
    else if (want.open === 'switching') {
      const p = data?.projects.find(x => x.id === want.to)
      if (p) watchRestart({ title: `Switching to ${p.name}…`, target: p.id, bootId: data.bootId, lateTitle: `${p.name} did not come back within 45 seconds` })
    }
  })
})()
