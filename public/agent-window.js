// The agent window on the Agents page (#/agents): a click on any agent box (the coordinator, the planner, a
// producer, QA, Security, the chat agent) opens that agent's settings as a modal dialog in the middle of the screen.
// In this order: its card (agent-cards.js), Model, Subagents, Specification and rules (the EXISTING editor,
// agent-rules.js and agent-rules-view.js, re-homed here unchanged), Files and context, Changes. The pure half is
// agent-window-view.js; the store and routes are agent-settings.mjs and agent-settings-routes.mjs.
//
//   AgentWindow.attach({ data, onClose })   once, from agents-page.js: `data()` gives { graph, status } now;
//                                           onClose(label) runs after a close (the page clears the address)
//   AgentWindow.open(nodeId, returnTo?)     open for that graph node; the focus goes back to `returnTo` on close
//   AgentWindow.close()                     close, asking first in the window when something is not saved
//   AgentWindow.refresh()                   redraw from data() (every status load); a section in use is kept
//   AgentWindow.isOpen(), .current()        whether it is open, and the label it shows
//
// Rules this file keeps:
// - ⚠️ A PROPER DIALOG: <dialog> opened with showModal() (the page behind is inert), role="dialog",
//   aria-modal="true", labelled by its title. Focus moves in and Tab wraps inside it; Esc and Close close it; the
//   focus returns to the agent box; the page behind does not scroll (html.aw-lock). A click on the backdrop closes
//   it, unless a rules draft or a typed note would be lost: then the window asks, in itself, never with confirm().
// - Each section is painted into its own element only when its HTML changed, so a status load every 15 seconds
//   never takes the focus, a half-typed note or an open rules editor away. The rules section is painted through
//   AgentRules.paint, which keeps an editor in use where it is (agent-rules.js).
// - The Model choice saves on change (PUT /api/agents/settings/<label>); a file or note saves on Add, a switch and
//   Remove at once (POST, PUT, DELETE /api/agents/files/<label>…). A refusal shows the server's own sentence.
// - Files are read in the browser as text (Blob.text); a binary or unreadable one is refused with a sentence
//   before anything is sent (AgentWindowView.readProblem).
;(() => {
  const V = () => window.AgentWindowView
  const FAILED = 'Could not save just now. Try again.'
  let dlg = null
  let parts = {}
  let data = () => ({ graph: null, status: null })
  let onClose = () => {}
  let nodeId = null
  let returnTo = null
  let settings = null // the last GET /api/agents/settings
  let seen = ''
  let busy = false
  let confirming = null // the file whose Remove was pressed: its row asks Remove or Keep, in the window

  const $ = sel => dlg?.querySelector(sel) || null
  const nodeOf = () => (data().graph?.nodes || []).find(n => n.id === nodeId) || null
  const labelOf = () => nodeOf()?.label || null
  const statusOf = label => (data().status?.agents || []).find(a => a.label === label) || null
  const entryOf = label => settings?.agents?.[label] || null
  const limits = () => settings?.limits || V().LIMITS

  // ═══ the dialog, built once ═══

  function build() {
    dlg = document.createElement('dialog')
    dlg.className = 'aw'
    dlg.setAttribute('role', 'dialog')
    dlg.setAttribute('aria-modal', 'true')
    dlg.setAttribute('aria-labelledby', 'awTitle')
    dlg.innerHTML = `<div class="aw-box">
      <div class="aw-head"><h2 id="awTitle" class="aw-title"></h2><span class="aw-role" data-aw-role></span>
        <button type="button" class="aw-x" data-aw-close aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="aw-ask" data-aw-ask hidden><p>Some changes here are not saved yet. Close and lose them?</p>
        <div class="aw-ask-acts"><button type="button" class="primary" data-aw-keep>Keep editing</button><button type="button" data-aw-discard>Close without saving</button></div></div>
      <div class="aw-body">
        <section class="aw-sec aw-card" data-aw-card aria-label="What it is doing"></section>
        <section class="aw-sec" aria-labelledby="awModelH"><h3 class="aw-h" id="awModelH">Model</h3><div data-aw-model-box></div><p class="aw-status" data-aw-model-status role="status" aria-live="polite"></p></section>
        <section class="aw-sec" aria-labelledby="awSubsH"><h3 class="aw-h" id="awSubsH">Subagents</h3><div data-aw-subs></div></section>
        <section class="aw-sec" aria-labelledby="awRulesH"><div data-aw-rules></div></section>
        <section class="aw-sec" aria-labelledby="awFilesH"><h3 class="aw-h" id="awFilesH">Files and context</h3>
          <div data-aw-files></div>
          <div class="aw-drop" data-aw-drop>
            <p class="aw-drop-text">Drop text files here, or <label class="link aw-pick" for="awPick">choose files</label>.</p>
            <input type="file" id="awPick" class="aw-file-input" data-aw-pick multiple accept=".md,.txt,.markdown,.json,.yml,.yaml,.csv,.log,.xml,.ini,.toml,text/*">
          </div>
          <div class="aw-note">
            <label class="aw-field"><span>Note title</span><input type="text" data-aw-note-title autocomplete="off" placeholder="For example: Where the test data lives"></label>
            <label class="aw-field"><span>Note</span><textarea rows="4" data-aw-note-text placeholder="Anything this agent should know."></textarea></label>
            <div class="aw-note-acts"><button type="button" data-aw-note-add>Add note</button></div>
          </div>
          <p class="aw-status" data-aw-files-status role="status" aria-live="polite"></p>
        </section>
        <section class="aw-sec" aria-labelledby="awChangesH"><h3 class="aw-h" id="awChangesH">Changes</h3><div data-aw-changes></div></section>
      </div>
    </div>`
    document.body.appendChild(dlg)
    parts = {
      title: $('.aw-title'), role: $('[data-aw-role]'), card: $('[data-aw-card]'), model: $('[data-aw-model-box]'), modelStatus: $('[data-aw-model-status]'),
      subs: $('[data-aw-subs]'), rules: $('[data-aw-rules]'), files: $('[data-aw-files]'), filesStatus: $('[data-aw-files-status]'),
      changes: $('[data-aw-changes]'), ask: $('[data-aw-ask]'), noteTitle: $('[data-aw-note-title]'), noteText: $('[data-aw-note-text]'),
      pick: $('[data-aw-pick]'), drop: $('[data-aw-drop]'), body: $('.aw-body'),
    }
    // the rules editor lives in this window now: agent-rules.js binds to its box, and redraws through us
    window.AgentRules?.bind(parts.rules, () => paint(true))
    wire()
  }

  function wire() {
    dlg.addEventListener('cancel', e => { // Esc
      e.preventDefault()
      close()
    })
    dlg.addEventListener('click', e => {
      if (e.target === dlg) return close() // the backdrop
      if (e.target.closest('[data-aw-close]')) return close()
      if (e.target.closest('[data-aw-keep]')) return keepEditing()
      if (e.target.closest('[data-aw-discard]')) return close({ discard: true })
      if (e.target.closest('[data-aw-note-add]')) return addNote()
      const act = e.target.closest('[data-aw-act]')
      const row = act?.closest('[data-aw-file]')
      if (row && act.dataset.awAct === 'toggle') return toggleFile(row.dataset.awFile, act.getAttribute('aria-checked') !== 'true')
      if (row && act.dataset.awAct === 'remove') return askRemove(row.dataset.awFile)
      if (row && act.dataset.awAct === 'remove-yes') return removeFile(row.dataset.awFile)
      if (row && act.dataset.awAct === 'remove-no') return keepFile(row.dataset.awFile)
      const report = e.target.closest('[data-report]')
      if (report) return window.OrchestrationGrid?.report(report.dataset.report, report.dataset.label)
      const sub = e.target.closest('[data-href]')
      if (sub) {
        close({ discard: true })
        location.hash = sub.dataset.href
      }
    })
    dlg.addEventListener('change', e => {
      if (e.target.matches('[data-aw-model], [data-aw-effort]')) saveModel(e.target)
      if (e.target.matches('[data-aw-pick]')) {
        addFiles([...(e.target.files || [])])
        e.target.value = ''
      }
    })
    // Tab wraps inside the window (showModal already makes the page behind inert)
    dlg.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return
      const all = [...dlg.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && !x.closest('[hidden]') && x.offsetParent !== null)
      if (!all.length) return
      const first = all[0]
      const last = all.at(-1)
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    })
    const drop = parts.drop
    for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, e => {
      e.preventDefault()
      drop.classList.add('is-over')
    })
    for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('is-over'))
    drop.addEventListener('drop', e => {
      e.preventDefault()
      addFiles([...(e.dataTransfer?.files || [])])
    })
  }

  // ═══ open and close ═══

  /** Whether closing now would lose something: an open rules editor, or a note being typed. */
  function unsaved() {
    const label = labelOf()
    const rules = label && window.AgentRules?.paneOpts({ label }).draft
    return !!rules || !!parts.noteTitle?.value.trim() || !!parts.noteText?.value.trim()
  }

  function keepEditing() {
    parts.ask.hidden = true
    ;(parts.rules.querySelector('[data-ar-field="spec"]') || parts.noteText)?.focus()
  }

  async function open(id, from = null) {
    if (!dlg) build()
    const fresh = nodeId !== id
    nodeId = id
    returnTo = from || returnTo
    if (fresh) {
      confirming = null
      parts.noteTitle.value = ''
      parts.noteText.value = ''
      parts.filesStatus.textContent = ''
      parts.modelStatus.textContent = ''
      parts.ask.hidden = true
    }
    paint(true)
    if (!dlg.open) {
      dlg.showModal()
      document.documentElement.classList.add('aw-lock')
      parts.body.scrollTop = 0
      dlg.querySelector('[data-aw-close]')?.focus()
    }
    window.AgentRules?.load()
    await load()
  }

  function close({ discard = false } = {}) {
    if (!dlg?.open) return
    if (!discard && unsaved()) {
      parts.ask.hidden = false
      parts.ask.querySelector('[data-aw-keep]')?.focus()
      return
    }
    const label = labelOf()
    if (label && window.AgentRules?.paneOpts({ label }).draft) window.AgentRules.act('cancel', label)
    parts.noteTitle.value = ''
    parts.noteText.value = ''
    parts.ask.hidden = true
    dlg.close()
    document.documentElement.classList.remove('aw-lock')
    const back = returnTo
    returnTo = null
    const was = nodeId
    nodeId = null
    onClose(label, was)
    if (back?.isConnected) back.focus()
  }

  // ═══ reading and painting ═══

  async function load() {
    try {
      const r = await fetch('/api/agents/settings')
      if (!r.ok) return
      const body = await r.json()
      const text = JSON.stringify(body)
      if (text === seen) return
      seen = text
      settings = body
      paint()
    } catch {
      // the next open or status load tries again; the window shows what it has meanwhile
    }
  }

  /** Paint `el` with `html` only when it changed (a section in use is never replaced for nothing). */
  function put(el, html) {
    if (el._html === html) return false
    el.innerHTML = html
    el._html = html
    return true
  }

  function paint(force = false) {
    if (!dlg || !nodeId) return
    const node = nodeOf()
    if (!node) return
    const W = V()
    const label = node.label
    const agent = statusOf(label)
    const entry = entryOf(label)
    parts.title.textContent = label
    const role = W.ROLE_NAME[node.role] || ''
    parts.role.textContent = role && role !== label ? role : '' // "Security Security" says nothing twice
    // the card, as the pane drew it; the chat agent has its own card (agent-cards.js renderChat)
    const card = node.role === 'chat'
      ? '<div class="agent-cards ac-grid ac-chat-slot" hidden></div>'
      : agent ? window.AgentCards.card(agent, { worktrees: data().status?.worktrees || [] }) : window.AgentCards.missingRoot(label)
    if (put(parts.card, card) && node.role === 'chat') window.AgentCards?.renderChat?.()
    // the Model choice is redrawn only when the saved one changed, so an open select keeps its place
    const model = W.modelHtml({ label, role: node.role, entry: entry || {}, models: settings?.models, chatModel: settings?.chat?.model, session: agent?.model || null, idBase: 'aw' })
    if (!parts.model.contains(document.activeElement) || force) put(parts.model, model)
    put(parts.subs, W.subagentsHtml(agent, label, { role: node.role }))
    // the EXISTING rules editor, re-homed: its own head, then the sections agent-rules-view.js draws
    const R = window.AgentRules
    const RV = window.AgentRulesView
    if (R && RV) {
      const opts = R.paneOpts(node)
      const head = `<div class="aw-sec-head"><h3 class="aw-h" id="awRulesH">Specification and rules</h3>${RV.settingsButton(node, !!opts.draft, 'Edit')}</div>`
      R.paint(parts.rules, head + RV.slotHtml(node, window.PipelineDetails?.ROLE?.[node.role] || '', { ...opts, changes: [] }))
    }
    put(parts.files, W.filesListHtml(entry || {}, limits(), label, { confirm: confirming }))
    const ruleChanges = R ? R.paneOpts(node).changes : []
    put(parts.changes, W.changesHtml(W.mergeChanges(ruleChanges, settings?.changes?.[label] || [])))
  }

  // ═══ saving ═══

  async function send(method, url, body) {
    try {
      const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { ok: r.ok, body: await r.json().catch(() => ({})) }
    } catch {
      return { ok: false, body: {} }
    }
  }

  /** Take a write's answer into the last GET, so the window shows it at once. */
  function take(label, answer) {
    if (!answer?.agent || !settings) return
    settings = { ...settings, agents: { ...settings.agents, [label]: answer.agent }, changes: { ...settings.changes, [label]: answer.changes || [] } }
    seen = ''
    paint(true)
  }

  async function saveModel(select) {
    const label = labelOf()
    if (!label) return
    const key = select.matches('[data-aw-model]') ? 'model' : 'effort'
    parts.modelStatus.textContent = 'Saving…'
    const r = await send('PUT', `/api/agents/settings/${encodeURIComponent(label)}`, { [key]: select.value || null })
    if (!r.ok) {
      parts.modelStatus.textContent = r.body?.error || FAILED
      return
    }
    take(label, r.body)
    parts.modelStatus.textContent = 'Saved. Switch the session itself in the editor.'
    $(`[data-aw-${key}]`)?.focus()
  }

  const say = text => (parts.filesStatus.textContent = text)

  async function post(label, item) {
    const r = await send('POST', `/api/agents/files/${encodeURIComponent(label)}`, item)
    if (!r.ok) return r.body?.error || FAILED
    take(label, r.body)
    return ''
  }

  async function addFiles(files) {
    const label = labelOf()
    if (!label || busy || !files.length) return
    busy = true
    const W = V()
    const added = []
    const refused = []
    for (const file of files) {
      if (W.tooBig(file, limits())) {
        refused.push(`${file.name} is too long. Keep each file or note to ${limits().chars.toLocaleString('en-GB')} characters.`)
        continue
      }
      let text
      try {
        text = await file.text()
      } catch {
        text = null
      }
      const problem = W.readProblem(file, text, limits())
      if (problem) {
        refused.push(problem)
        continue
      }
      const error = await post(label, { title: file.name, text, kind: 'file', name: file.name })
      if (error) refused.push(`${file.name}: ${error}`)
      else added.push(file.name)
    }
    busy = false
    say([added.length ? `Added ${added.join(', ')}.` : '', ...refused].filter(Boolean).join(' '))
  }

  async function addNote() {
    const label = labelOf()
    if (!label || busy) return
    const title = parts.noteTitle.value
    const text = parts.noteText.value
    const problem = V().noteProblem(title, text, limits(), entryOf(label))
    if (problem) {
      say(problem)
      return (problem.startsWith('Give it') ? parts.noteTitle : parts.noteText).focus()
    }
    busy = true
    say('Saving…')
    const error = await post(label, { title, text, kind: 'note' })
    busy = false
    if (error) return say(error)
    parts.noteTitle.value = ''
    parts.noteText.value = ''
    say('Note added.')
    parts.noteTitle.focus()
  }

  async function toggleFile(id, on) {
    const label = labelOf()
    if (!label) return
    const r = await send('PUT', `/api/agents/files/${encodeURIComponent(label)}/${encodeURIComponent(id)}`, { on })
    if (!r.ok) return say(r.body?.error || FAILED)
    take(label, r.body)
    say(on ? 'Switched on: the agent reads it with its rules.' : 'Switched off: the agent no longer reads it.')
    parts.files.querySelector(`[data-aw-file="${CSS.escape(id)}"] [data-aw-act="toggle"]`)?.focus()
  }

  /** Remove asks first, in the row: Remove or Keep (the focus goes to Keep, the safe one). */
  function askRemove(id) {
    confirming = id
    paint()
    parts.files.querySelector(`[data-aw-file="${CSS.escape(id)}"] [data-aw-act="remove-no"]`)?.focus()
  }
  function keepFile(id) {
    confirming = null
    paint()
    parts.files.querySelector(`[data-aw-file="${CSS.escape(id)}"] [data-aw-act="remove"]`)?.focus()
  }

  async function removeFile(id) {
    confirming = null
    const label = labelOf()
    if (!label) return
    const rows = [...parts.files.querySelectorAll('[data-aw-file]')]
    const at = rows.findIndex(r => r.dataset.awFile === id)
    const r = await send('DELETE', `/api/agents/files/${encodeURIComponent(label)}/${encodeURIComponent(id)}`)
    if (!r.ok) return say(r.body?.error || FAILED)
    take(label, r.body)
    say('Removed.')
    // the focus goes to the row that took its place, else the one before, else the file picker
    const left = [...parts.files.querySelectorAll('[data-aw-act="remove"]')]
    ;(left[Math.min(at, left.length - 1)] || parts.drop.querySelector('.aw-pick'))?.focus()
  }

  window.AgentWindow = {
    attach(opts = {}) {
      if (typeof opts.data === 'function') data = opts.data
      if (typeof opts.onClose === 'function') onClose = opts.onClose
    },
    open,
    close,
    refresh() {
      if (dlg?.open) {
        paint()
        load()
      }
    },
    isOpen: () => !!dlg?.open,
    current: () => (dlg?.open ? labelOf() : null),
  }
})()
