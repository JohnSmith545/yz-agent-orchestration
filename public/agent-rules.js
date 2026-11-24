// The Settings editor of an agent's details pane on the Agents page (#/agents): the user's specification and
// rules for each agent, read from GET /api/agents/rules and saved with PUT /api/agents/rules/<label>
// (agent-rules-routes.mjs). agent-rules-view.js draws the sections; pipeline-details.js places them in the pane;
// agents-page.js hands its details element to bind(), paints the pane through paint(), asks paneOpts(node) what
// to draw, calls load() with every pipeline load and escape() first on Escape.
//
// Rules this file keeps:
// - ⚠️ AN EDITOR IN USE SURVIVES EVERY REDRAW. The pane is redrawn on every status load (about every 15 seconds)
//   and when the pipeline reloads. paint() never replaces the live editor element: when the new pane HTML has the
//   same agent's editor, the editor stays where it is (never taken out of the tree, so it keeps the focus, the
//   cursor and what was typed) and only what is around it is swapped, and only when that changed. Add, Remove
//   and a failed Save change just their own part of the live editor.
// - The draft lives here, per agent, updated on every keystroke, so it also survives clicking another node and
//   coming back. It goes only when Save succeeds, or on Cancel or Escape.
// - A failed Save keeps the draft and says so in one calm line (the server's own sentence when it sent one).
// - Text the user typed reaches HTML only through agent-rules-view.js, which escapes it; here it is set as
//   textContent or a field value.
// - The DOM is reached with attribute selectors only, and paint() takes its HTML parser as an argument, so the
//   tests run this file in a vm with a small fake DOM (test/agent-rules-page.test.mjs).
;(() => {
  const V = () => window.AgentRulesView
  const FAILED = 'Could not save just now. What you typed is kept. Try Save again.'
  let entries = null // label -> { spec, rules, updatedAt }, from the last GET
  let limits = null
  let changes = {} // label -> its last saved changes, [{ at, text }], newest first
  const logOpen = {} // label -> true while its Changes disclosure is open, so a redraw keeps it open
  let seen = '' // the last GET answer, as text: a redraw only when it changed
  const drafts = {} // label -> the open editor's draft
  let box = null
  let redraw = () => {}

  const lim = () => limits || V().LIMITS

  /** What pipeline-details.js needs for `node`: the saved entry, the open draft (the live object), the limits, its changes. */
  const paneOpts = node => ({
    entry: entries?.[node.label] || null, draft: drafts[node.label] || null, limits: lim(),
    changes: changes[node.label] || [], logOpen: !!logOpen[node.label],
  })

  async function load() {
    try {
      const r = await fetch('/api/agents/rules')
      if (!r.ok) return
      const body = await r.json()
      const text = JSON.stringify(body)
      if (text === seen) return
      seen = text
      entries = body?.agents || {}
      changes = body?.changes || {}
      limits = body?.limits || null
      redraw()
    } catch {
      // the next pipeline load tries again; the pane shows the defaults meanwhile
    }
  }

  // ═══ the live editor ═══

  /** The live editor of `label` in the pane, or null. */
  const editorOf = label => (box ? [...box.querySelectorAll('[data-ar-slot][data-ar-mode="edit"]')].find(s => s.getAttribute('data-ar-slot') === label) || null : null)
  const part = (label, sel) => editorOf(label)?.querySelector(sel) || null

  function focusSpec(label) {
    const t = part(label, '[data-ar-field="spec"]')
    if (!t) return
    t.focus()
    const end = String(t.value ?? '').length
    t.setSelectionRange?.(end, end)
  }
  function focusSettings(label) {
    const b = box && [...box.querySelectorAll('[data-ar-act="settings"]')].find(x => x.getAttribute('data-ar-label') === label)
    b?.focus()
  }

  /** Show the draft's error and Save state in the live editor. */
  function syncStatus(label) {
    const d = drafts[label]
    const err = part(label, '[data-ar-error]')
    if (err) err.textContent = d?.error || ''
    const save = part(label, '[data-ar-act="save"]')
    if (save) {
      save.disabled = !!d?.saving
      save.textContent = d?.saving ? 'Saving…' : 'Save'
    }
  }
  /** Redraw just the rule list and its count in the live editor. */
  function syncList(label) {
    const d = drafts[label]
    const list = part(label, '[data-ar-list]')
    if (list) list.innerHTML = V().rulesListHtml(d)
    const n = part(label, '[data-ar-n]')
    if (n) n.textContent = V().rulesCount(d)
  }

  function add(label) {
    const d = drafts[label]
    if (!d) return
    const { draft, error } = V().addRule(d, d.pending, lim())
    drafts[label] = error ? { ...d, error } : draft
    syncStatus(label)
    if (error) return
    syncList(label)
    const field = part(label, '[data-ar-field="pending"]')
    if (field) {
      field.value = ''
      field.focus()
    }
  }

  function remove(label, i) {
    const d = drafts[label]
    if (!d) return
    drafts[label] = { ...V().removeRule(d, i), error: '' }
    syncStatus(label)
    syncList(label)
    // the focus goes to the rule that took its place, else the one before, else the Add field
    const buttons = [...(editorOf(label)?.querySelectorAll('[data-ar-act="remove"]') || [])]
    const next = buttons[Math.min(i, buttons.length - 1)] || part(label, '[data-ar-field="pending"]')
    next?.focus()
  }

  async function save(label) {
    const d = drafts[label]
    if (!d || d.saving) return
    const body = V().toBody(d)
    const problem = V().problem(body, lim())
    if (problem) {
      drafts[label] = { ...d, error: problem }
      return syncStatus(label)
    }
    drafts[label] = { ...d, saving: true, error: '' }
    syncStatus(label)
    let answer
    try {
      const r = await fetch(`/api/agents/rules/${encodeURIComponent(label)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      answer = { ok: r.ok, body: await r.json().catch(() => ({})) }
    } catch {
      answer = { ok: false, body: {} }
    }
    const now = drafts[label]
    if (!now) return // cancelled while it was saving
    if (!answer.ok || !answer.body?.agent) {
      drafts[label] = { ...now, saving: false, error: answer.body?.error || FAILED }
      return syncStatus(label)
    }
    entries = { ...(entries || {}), [label]: answer.body.agent }
    if (Array.isArray(answer.body.changes)) changes = { ...changes, [label]: answer.body.changes }
    seen = ''
    // typed on while it saved: keep the editor open with the newer text
    if (JSON.stringify(V().toBody(now)) !== JSON.stringify(body)) {
      drafts[label] = { ...now, saving: false, error: '' }
      return syncStatus(label)
    }
    delete drafts[label]
    redraw()
    focusSettings(label)
  }

  function cancel(label) {
    delete drafts[label]
    redraw()
    focusSettings(label)
  }

  /** One user action on `label`'s sections: settings, add, remove (rule `i`), save, cancel. */
  async function act(name, label, i) {
    if (name === 'settings') {
      if (!drafts[label]) {
        if (!entries) await load()
        if (!entries) return // never open on nothing: a Save would wipe what is saved
        drafts[label] = V().draftOf(entries[label])
        redraw()
      }
      return focusSpec(label)
    }
    if (name === 'add') return add(label)
    if (name === 'remove') return remove(label, i)
    if (name === 'save') return save(label)
    if (name === 'cancel') return cancel(label)
  }

  /** Escape: closes the editor on show and returns true (the key is taken); false when there is none. */
  function escape() {
    const live = box?.querySelector('[data-ar-slot][data-ar-mode="edit"]')
    if (!live) return false
    cancel(live.getAttribute('data-ar-slot'))
    return true
  }

  function bind(el, render) {
    box = el
    redraw = render
    el.addEventListener('click', e => {
      // a Changes summary: remember it, so the next redraw draws it the way the user left it (the click comes before the toggle)
      const log = e.target?.closest?.('[data-ar-summary]') && e.target.closest('[data-ar-log]')
      if (log) logOpen[log.getAttribute('data-ar-log')] = !log.open
      const b = e.target?.closest?.('[data-ar-act]')
      if (!b) return
      const label = b.getAttribute('data-ar-label') ?? b.closest('[data-ar-slot]')?.getAttribute('data-ar-slot')
      if (label != null) act(b.getAttribute('data-ar-act'), label, Number(b.getAttribute('data-ar-i')))
    })
    el.addEventListener('input', e => {
      const f = e.target?.closest?.('[data-ar-field]')
      const label = f?.closest('[data-ar-slot]')?.getAttribute('data-ar-slot')
      const d = label != null && drafts[label]
      if (!d) return
      const field = f.getAttribute('data-ar-field')
      d[field] = String(f.value ?? '')
      if (field === 'spec') {
        const count = part(label, '[data-ar-count]')
        if (count) count.textContent = V().countLine(d.spec.length, lim().spec)
      }
    })
    el.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return
      const f = e.target?.closest?.('[data-ar-field="pending"]')
      const label = f?.closest('[data-ar-slot]')?.getAttribute('data-ar-slot')
      if (label == null) return
      e.preventDefault()
      add(label)
    })
  }

  // ═══ paint: the pane, with an editor in use kept where it is ═══

  function parseHtml(html) {
    const t = document.createElement('template')
    t.innerHTML = html
    return t.content
  }

  /** Put `fresh`'s nodes around `live` in place of the old ones; false when the two panes do not line up. */
  function swapAround(live, fresh) {
    const next = fresh.querySelector('[data-ar-slot]')
    const oldRoot = live.parentNode
    const newRoot = next?.parentNode
    if (!next || !newRoot || !oldRoot) return false
    const topLevel = newRoot.nodeType === 11
    if (topLevel ? oldRoot !== box : oldRoot === box || oldRoot.nodeName !== newRoot.nodeName) return false
    if (!topLevel) {
      for (const a of [...oldRoot.attributes]) if (!newRoot.hasAttribute(a.name)) oldRoot.removeAttribute(a.name)
      for (const a of [...newRoot.attributes]) if (oldRoot.getAttribute(a.name) !== a.value) oldRoot.setAttribute(a.name, a.value)
    }
    for (const n of [...oldRoot.childNodes]) if (n !== live) n.remove()
    let before = true
    for (const n of [...newRoot.childNodes]) {
      if (n === next) before = false
      else if (before) oldRoot.insertBefore(n, live)
      else oldRoot.appendChild(n)
    }
    return true
  }

  /**
   * Paint `html` into `el` (the details pane). Returns whether anything outside the editor changed (the page
   * then fills the chat card slot again). The same HTML twice paints nothing; an editor in use for the same
   * agent is kept (see the rules at the top); anything else is painted whole.
   */
  function paint(el, html, parse = parseHtml) {
    if (el._html === html) return false
    const live = el.querySelector('[data-ar-slot][data-ar-mode="edit"]')
    if (live && V().editSlotOf(html) === live.getAttribute('data-ar-slot')) {
      const outside = V().outsideOf(html)
      el._html = html
      if (el._outside === outside) return false
      if (swapAround(live, parse(html))) {
        el._outside = outside
        return true
      }
    }
    el.innerHTML = html
    el._html = html
    el._outside = V().outsideOf(html)
    return true
  }

  window.AgentRules = { bind, load, paneOpts, paint, act, escape }
})()
