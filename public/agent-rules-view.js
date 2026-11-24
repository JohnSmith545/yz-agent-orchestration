// The Specification and Rules sections of an agent's details pane on the Agents page (#/agents), and the draft
// the Settings editor keeps. PURE: an agent node, its saved entry (GET /api/agents/rules) and a draft in, HTML or
// a new draft out (test/agent-rules-view.test.mjs). public/agent-rules.js owns the state, the requests and the
// DOM; public/pipeline-details.js places the sections in the pane.
//
// Rules this file keeps:
// - Every text the user typed goes through esc(), in the read view and in the editor alike.
// - The sections sit between <!--ar--> and <!--/ar--> with the label and the mode on the <section>
//   (data-ar-slot, data-ar-mode), so the page can keep an editor in use where it is while the pane around it is
//   redrawn (outsideOf, editSlotOf; agent-rules.js paint).
// - The limits mirror agent-rules.mjs RULE_LIMITS, which the server keeps anyway; the page only says a problem
//   sooner. A draft is never changed in place: each step returns a new one.
// - Copy is short plain sentences: no jargon, no em dashes.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  /** MUST CHANGE IN LOCKSTEP with agent-rules.mjs RULE_LIMITS (the GET sends the server's, which win). */
  const LIMITS = Object.freeze({ spec: 2000, rule: 300, rules: 30 })
  const num = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cleanRule = s => String(s ?? '').replace(/\s+/g, ' ').trim()
  const countLine = (len, max) => `${num(len)} of ${num(max)} characters`
  const idOf = node => `ar-${node.id}`
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = n => String(n).padStart(2, '0')
  /** `24 Nov 10:05`, local: a fixed text (never a relative one), so a redraw draws the same pane. */
  function whenOf(at) {
    const d = new Date(at)
    return Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  /** A gear, drawn in the text colour (feather icons, MIT). */
  const GEAR = '<svg class="ar-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'

  // ═══ the draft ═══

  /** A fresh draft of a saved entry (null: nothing saved). */
  const draftOf = entry => ({ spec: entry?.spec || '', rules: (entry?.rules || []).map(r => r.text), pending: '', error: '', saving: false })

  /** The draft with `text` added as a rule, or the same draft and an error to show. */
  function addRule(draft, text, limits = LIMITS) {
    const rule = cleanRule(text)
    if (!rule) return { draft, error: 'Write the rule first.' }
    if (rule.length > limits.rule) return { draft, error: `That rule is too long. Keep each rule to ${num(limits.rule)} characters.` }
    if (draft.rules.length >= limits.rules) return { draft, error: `That is the most rules an agent can have (${limits.rules}).` }
    return { draft: { ...draft, rules: [...draft.rules, rule], pending: '', error: '' }, error: '' }
  }

  const removeRule = (draft, i) => ({ ...draft, rules: draft.rules.filter((_, k) => k !== i) })

  /** The PUT body: the spec and the rules, with a rule left typed in the Add field counted in. */
  function toBody(draft) {
    const pending = cleanRule(draft.pending)
    return { spec: draft.spec, rules: pending ? [...draft.rules, pending] : [...draft.rules] }
  }

  /** What the server would refuse in `body`, as the sentence to show, or ''. */
  function problem(body, limits = LIMITS) {
    if (String(body.spec ?? '').trim().length > limits.spec) return `The specification is too long. Keep it to ${num(limits.spec)} characters.`
    if (body.rules.length > limits.rules) return `That is too many rules. An agent can have ${limits.rules} at most.`
    const long = body.rules.findIndex(r => cleanRule(r).length > limits.rule)
    if (long >= 0) return `Rule ${long + 1} is too long. Keep each rule to ${num(limits.rule)} characters.`
    return ''
  }

  // ═══ HTML ═══

  /** The head's Settings button: a gear and the word (`word`: Edit in the agent window), aria-expanded while the editor is open. */
  const settingsButton = (node, editing, word = 'Settings') =>
    `<button type="button" class="link pl-det-set" data-ar-act="settings" data-ar-label="${esc(node.label)}" aria-expanded="${editing ? 'true' : 'false'}" aria-controls="${esc(idOf(node))}">${GEAR}${esc(word)}</button>`

  /** The agent's last saved changes, newest first, behind a quiet disclosure (closed unless `open`); '' when none. */
  function changesHtml(node, changes, open) {
    if (!changes?.length) return ''
    const items = changes.map(c => `<li><time datetime="${esc(c.at)}" title="${esc(new Date(c.at).toString())}">${esc(whenOf(c.at))}</time> <span>${esc(c.text)}</span></li>`).join('')
    return `<details class="ar-log" data-ar-log="${esc(node.label)}"${open ? ' open' : ''}><summary data-ar-summary>Changes <span class="faint">· ${changes.length}</span></summary><ol class="ar-changes">${items}</ol></details>`
  }

  function viewHtml(node, role, entry, changes = [], logOpen = false) {
    const spec = entry?.spec || ''
    const rules = entry?.rules || []
    const specHtml = spec
      ? `<h3 class="pl-det-sub">Specification</h3><p class="ar-spec">${esc(spec)}</p>`
      : `<h3 class="pl-det-sub">Specification <span class="faint">· Default</span></h3>${role ? `<p class="pl-desc">${esc(role)}</p>` : '<p class="pl-none">No specification yet.</p>'}`
    const list = rules.length ? `<ol class="ar-rules">${rules.map(r => `<li>${esc(r.text)}</li>`).join('')}</ol>` : '<p class="pl-none">No rules yet.</p>'
    return `${specHtml}<h3 class="pl-det-sub">Rules${rules.length ? ` <span class="faint">· ${rules.length}</span>` : ''}</h3>${list}${changesHtml(node, changes, logOpen)}`
  }

  /** The editable rule list: each rule with its Remove button (agent-rules.js redraws just this after Add or Remove). */
  function rulesListHtml(draft) {
    if (!draft.rules.length) return '<p class="pl-none">No rules yet.</p>'
    return `<ol class="ar-rules ar-rules-edit">${draft.rules.map((r, i) =>
      `<li><span class="ar-rule"><span class="ar-rule-text">${esc(r)}</span><button type="button" class="link ar-remove" data-ar-act="remove" data-ar-i="${i}" aria-label="Remove rule ${i + 1}: ${esc(r)}">Remove</button></span></li>`).join('')}</ol>`
  }

  const rulesCount = draft => (draft.rules.length ? `· ${draft.rules.length}` : '')

  // ⚠️ No maxlength on either field, ON PURPOSE: the browser would cut a long paste without a word, and the cut
  // text would then pass every check (QA, 2026-11-24). addRule and problem refuse it with a sentence instead.
  function editorHtml(node, draft, limits) {
    const id = esc(idOf(node))
    return `<div class="ar-field">
        <label class="pl-det-sub" for="${id}-spec">Specification</label>
        <p class="ar-hint" id="${id}-hint">What this agent is for and how it should work, in your words.</p>
        <textarea id="${id}-spec" data-ar-field="spec" rows="5" aria-describedby="${id}-hint ${id}-count">\n${esc(draft.spec)}</textarea>
        <p class="ar-count" id="${id}-count" data-ar-count>${countLine(draft.spec.length, limits.spec)}</p>
      </div>
      <h3 class="pl-det-sub" id="${id}-rules">Rules <span class="faint" data-ar-n>${rulesCount(draft)}</span></h3>
      <div data-ar-list>${rulesListHtml(draft)}</div>
      <div class="ar-add">
        <label class="ar-add-label" for="${id}-add">Add a rule</label>
        <div class="ar-add-row"><input type="text" id="${id}-add" data-ar-field="pending" value="${esc(draft.pending)}" placeholder="For example: run the tests before you say done." autocomplete="off"><button type="button" data-ar-act="add">Add</button></div>
      </div>
      <p class="ar-error" role="status" aria-live="polite" data-ar-error>${esc(draft.error)}</p>
      <div class="ar-actions"><button type="button" class="primary" data-ar-act="save"${draft.saving ? ' disabled' : ''}>${draft.saving ? 'Saving…' : 'Save'}</button><button type="button" data-ar-act="cancel">Cancel</button></div>
      <p class="ar-how">Agents read these when they start a request.</p>`
  }

  /**
   * The sections for `node`: read when there is no draft, the editor when there is. `entry` is the saved one
   * (null: nothing saved), `role` the line that stands in for a missing specification, `changes` its last saved
   * changes ({ at, text }, newest first) and `logOpen` whether the user opened them.
   */
  function slotHtml(node, role, { entry = null, draft = null, limits = LIMITS, changes = [], logOpen = false } = {}) {
    const mode = draft ? 'edit' : 'view'
    const aria = draft ? `Settings for ${node.label}` : `Specification and rules of ${node.label}`
    return `<!--ar--><section class="ar ar-${mode}" id="${esc(idOf(node))}" data-ar-slot="${esc(node.label)}" data-ar-mode="${mode}" aria-label="${esc(aria)}">` +
      `${draft ? editorHtml(node, draft, limits) : viewHtml(node, role, entry, changes, logOpen)}</section><!--/ar-->`
  }

  const SLOT = /<!--ar-->[\s\S]*?<!--\/ar-->/
  /** The pane HTML with the sections taken out. */
  const outsideOf = html => String(html).replace(SLOT, '<!--ar-->')
  const unesc = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e])
  /** The label of the editor in a pane's HTML, or null when the sections there are read only (or absent). */
  function editSlotOf(html) {
    const m = /<!--ar--><section[^>]*\bdata-ar-slot="([^"]*)" data-ar-mode="edit"/.exec(String(html))
    return m ? unesc(m[1]) : null
  }

  window.AgentRulesView = {
    LIMITS, esc, countLine, whenOf, rulesCount, draftOf, addRule, removeRule, toBody, problem,
    settingsButton, slotHtml, viewHtml, rulesListHtml, outsideOf, editSlotOf,
  }
})()
