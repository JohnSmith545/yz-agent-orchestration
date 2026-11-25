// The agent window on the Agents page (#/agents), the PURE half: what each section of the window says, the green
// pill on an agent box, and the checks a file or note gets in the browser before it is sent. No DOM, no fetch, so
// test/agent-window-view.test.mjs runs it in a vm. public/agent-window.js owns the dialog, the state and the
// requests; the store and its routes are agent-settings.mjs and agent-settings-routes.mjs.
//
//   running(agent)                      the subagents running under an agent's /api/status record now
//   pillHtml(n, label)                  the pill on a box: "3 running", with "3 subagents running under Agent 1"
//   modelHtml(view)                     Model: the choice and effort, or the fixed Opus line, or the chat model
//   subagentsHtml(agent, label, now)    Subagents: name, kind and how long each has run, or an honest empty line
//   filesListHtml(entry, limits, label) Files and context: each file or note with its switch and Remove, the totals
//   changesHtml(changes)                Changes: rule changes and settings changes, newest first
//   readProblem(file, text, limits)     a picked or dropped file that is not text or too long, as a sentence
//   noteProblem(title, text, limits, entry)   what the server would refuse in a note, sooner
//
// Rules this file keeps:
// - Every text from a user, a file or a transcript goes through esc().
// - The limits mirror agent-settings.mjs FILE_LIMITS (the GET sends the server's, which win); the server refuses
//   anyway, and its sentence is the one shown.
// - Copy is for one person who steers agents: short plain sentences, no jargon, no em dashes.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const num = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  /** MUST CHANGE IN LOCKSTEP with agent-settings.mjs FILE_LIMITS, MODELS and EFFORTS. */
  const LIMITS = Object.freeze({ chars: 20000, files: 20, total: 60000, title: 100 })
  const MODELS = Object.freeze([
    { id: 'claude-fable-5-2', name: 'Fable 5.2' }, { id: 'claude-opus-5-5', name: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }, { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
  ])
  const EFFORTS = Object.freeze(['low', 'medium', 'high'])
  /** MUST CHANGE IN LOCKSTEP with agent-settings.mjs FIXED_ROLES. */
  const FIXED_ROLES = ['planner', 'security', 'senior']
  const ROLE_NAME = { coordinator: 'Coordinator', planner: 'Planner', producer: 'Producer', chat: 'Chat agent', qa: 'QA', security: 'Security', senior: 'Senior' }
  const FIXED_NAME = { planner: 'planner', security: 'Security agent', senior: 'Senior agent' }
  const modelName = (id, models = MODELS) => models.find(m => m.id === id)?.name || id || ''
  const isOpus = id => /opus/i.test(String(id || ''))

  // ═══ subagents and the pill ═══

  /** The subagents running now: started and not finished (orchestration.mjs counts them the same way). */
  const running = agent => (Array.isArray(agent?.subagents) ? agent.subagents : []).filter(s => s && s.state && s.state !== 'idle' && s.state !== 'done')

  /** The green pill on an agent box, or '' when nothing runs under it. Its text is short; its label says it in full. */
  function pillHtml(n, label) {
    const k = Number(n) || 0
    if (k <= 0) return ''
    const said = `${k} ${k === 1 ? 'subagent' : 'subagents'} running under ${label}`
    return `<span class="pl-pill" role="img" aria-label="${esc(said)}" title="${esc(said)}"><span class="pl-pill-n">${k}</span><span class="pl-pill-w">running</span></span>`
  }

  /** "12 min", "1 h 5 min", "under a minute": how long since `at`. */
  function howLong(at, now = Date.now()) {
    const t = Date.parse(at)
    if (Number.isNaN(t)) return ''
    const min = Math.max(0, Math.floor((now - t) / 60000))
    if (min < 1) return 'under a minute'
    if (min < 60) return `${min} min`
    return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`
  }

  function subagentsHtml(agent, label, { role = '', now = Date.now() } = {}) {
    if (role === 'chat') return '<p class="aw-none">The chat agent is run by the dashboard; subagents it starts are not listed here.</p>'
    if (!agent) return `<p class="aw-none">${esc(label)} is not running, so nothing runs under it.</p>`
    const list = running(agent)
    if (!list.length) return `<p class="aw-none">No subagents are running under ${esc(label)} right now.</p>`
    const rows = list.map(s => {
      const kind = s.agentType ? esc(s.agentType) : 'subagent'
      const long = howLong(s.startedAt || s.updatedAt, now)
      return `<li><span class="aw-sub-name">${esc(s.description || 'A subagent')}</span>` +
        `<span class="aw-sub-meta">${kind}${s.model ? ` · ${esc(modelName(s.model))}` : ''}${long ? ` · running ${esc(long)}` : ''}</span></li>`
    }).join('')
    return `<ul class="aw-subs">${rows}</ul>`
  }

  // ═══ the model ═══

  const option = (value, text, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(text)}</option>`

  /**
   * The Model section. `view` is { label, role, entry: the GET's agent (model, effort, fixed), models, chatModel,
   * session: the model the session's newest reply ran on (or null), idBase }.
   */
  function modelHtml({ label, role, entry = {}, models = MODELS, chatModel = '', session = null, idBase = 'aw' } = {}) {
    const warn = text => `<p class="aw-warn" role="note">${esc(text)}</p>`
    if (FIXED_ROLES.includes(role) || entry.fixed) {
      const off = session && !isOpus(session) ? warn(`This session is running on ${modelName(session, models)}, not Opus. Switch it to Opus in the editor.`) : ''
      return `<p class="aw-fixed"><b>Opus 5.5, high effort</b></p>` +
        `<p class="aw-hint">The ${FIXED_NAME[role] || 'agent'} always runs on Opus at high effort, so its work is as careful as it can be. It is told so with its rules every time it starts.</p>${off}`
    }
    if (role === 'chat') {
      return `<p class="aw-fixed"><b>${esc(modelName(chatModel, models) || 'Not set')}</b></p>` +
        '<p class="aw-hint">The chat agent runs on the model in config.json (factory.chat.model). Change it there.</p>'
    }
    const m = entry.model || ''
    const e = entry.effort || ''
    const differs = session && m && session !== m ? warn(`This session is running on ${modelName(session, models)}. Switch it in the editor to use ${modelName(m, models)}.`) : ''
    return `<div class="aw-model-row">` +
      `<label class="aw-field"><span>Claude model</span><select id="${esc(idBase)}-model" data-aw-model>${option('', 'Not chosen', !m)}${models.map(x => option(x.id, x.name, x.id === m)).join('')}</select></label>` +
      `<label class="aw-field"><span>Effort</span><select id="${esc(idBase)}-effort" data-aw-effort>${option('', 'Not chosen', !e)}${EFFORTS.map(x => option(x, x[0].toUpperCase() + x.slice(1), x === e)).join('')}</select></label>` +
      '</div>' +
      '<p class="aw-hint">The dashboard cannot switch a session that is open in the editor. Your choice is saved, told to the agent with its rules, and used for the subagents it starts; switch the session itself in the editor.</p>' +
      differs
  }

  // ═══ files and notes ═══

  const sizeLine = f => `${f.kind === 'file' ? `File${f.name ? ` ${esc(f.name)}` : ''}` : 'Note'} · ${num(f.chars)} characters`

  /** The files list; `confirm` is the id of the file whose Remove was pressed: its row asks first (Remove or Keep). */
  function filesListHtml(entry, limits = LIMITS, label = '', { confirm = null } = {}) {
    const files = Array.isArray(entry?.files) ? entry.files : []
    const total = files.reduce((n, f) => n + (Number(f.chars) || 0), 0)
    const sum = `<p class="aw-sum">${files.length} of ${limits.files} · ${num(total)} of ${num(limits.total)} characters</p>`
    if (!files.length) return `<p class="aw-none">Nothing added yet. Add a text file or a note, and ${esc(label || 'the agent')} reads it with its rules.</p>${sum}`
    const rows = files.map(f => {
      const on = f.on !== false
      return `<li class="aw-file${on ? '' : ' is-off'}" data-aw-file="${esc(f.id)}">` +
        `<span class="aw-file-main"><span class="aw-file-title">${esc(f.title)}</span><span class="aw-file-meta">${sizeLine(f)}</span></span>` +
        (f.id === confirm
          ? `<span class="aw-confirm" role="alert">Remove ${esc(f.title)}? ${esc(label || 'The agent')} will no longer read it.</span>` +
            '<button type="button" class="aw-danger" data-aw-act="remove-yes">Remove</button><button type="button" data-aw-act="remove-no">Keep</button></li>'
          : `<button type="button" class="aw-switch" role="switch" aria-checked="${on}" data-aw-act="toggle" aria-label="${esc(`Give ${f.title} to the agent`)}"><span class="aw-knob" aria-hidden="true"></span><span class="aw-switch-word">${on ? 'On' : 'Off'}</span></button>` +
            `<button type="button" class="link aw-remove" data-aw-act="remove" aria-label="${esc(`Remove ${f.title}`)}">Remove</button></li>`)
    }).join('')
    return `<ul class="aw-files">${rows}</ul>${sum}`
  }

  /** What is wrong with a picked or dropped file and the text read from it, as one sentence, or ''. */
  function readProblem(file, text, limits = LIMITS) {
    const name = String(file?.name || 'That file')
    if (typeof text !== 'string') return `${name} could not be read as text.`
    const bad = (text.match(/�/g) || []).length
    if (text.includes('\u0000') || (text.length > 0 && bad / text.length > 0.01)) return `${name} is not a text file, so it cannot be added. Add a text file such as .md or .txt.`
    if (!text.trim()) return `${name} is empty.`
    if (text.length > limits.chars) return `${name} is too long. Keep each file or note to ${num(limits.chars)} characters.`
    return ''
  }

  /** A file over this many bytes cannot fit the character limit (a character is at least one byte). */
  const tooBig = (file, limits = LIMITS) => Number(file?.size) > limits.chars * 4

  /** What the server would refuse in a new note or file for an agent whose saved entry is `entry`, or ''. */
  function noteProblem(title, text, limits = LIMITS, entry = null) {
    const t = String(title ?? '').replace(/\s+/g, ' ').trim()
    if (!t) return 'Give it a title.'
    if (t.length > limits.title) return `The title is too long. Keep it to ${limits.title} characters.`
    if (!String(text ?? '').trim()) return 'The note is empty. Write something first.'
    if (String(text).length > limits.chars) return `That is too long. Keep each file or note to ${num(limits.chars)} characters.`
    const files = Array.isArray(entry?.files) ? entry.files : []
    if (files.length >= limits.files) return `That is the most this agent can have: ${limits.files} files and notes. Remove one first.`
    if (files.reduce((n, f) => n + (Number(f.chars) || 0), 0) + String(text).length > limits.total) return `That would take this agent past ${num(limits.total)} characters in all. Remove or shorten another file first.`
    return ''
  }

  // ═══ changes ═══

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = n => String(n).padStart(2, '0')
  function whenOf(at) {
    const d = new Date(at)
    return Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  /** Rule changes and settings changes together, newest first, at most `n`. */
  function mergeChanges(rules = [], settings = [], n = 10) {
    return [...(rules || []), ...(settings || [])].filter(c => c && !Number.isNaN(Date.parse(c.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, n)
  }

  function changesHtml(changes) {
    if (!changes?.length) return '<p class="aw-none">No changes saved yet.</p>'
    return `<ol class="aw-changes">${changes.map(c => `<li><time datetime="${esc(c.at)}">${esc(whenOf(c.at))}</time> <span>${esc(c.text)}</span></li>`).join('')}</ol>`
  }

  window.AgentWindowView = {
    LIMITS, MODELS, EFFORTS, ROLE_NAME, esc, running, pillHtml, howLong, subagentsHtml, modelHtml, filesListHtml,
    readProblem, tooBig, noteProblem, mergeChanges, changesHtml, modelName,
  }
})()
