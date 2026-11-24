// The Context panel on the Brainstorming page (#/brainstorming): what it is told before it writes. It slides out from the
// right edge like the Agents page's panel (pipeline-panel.js), with a slim "Context · N" tab while closed.
//
//   ScriptContext.create(el, { page })   el: <aside class="sc-ctx">, page: the .sc-page (gets `ctx-open`)
//
// What it holds (GET/PUT /api/script/context, POST /api/script/context/notes, PUT and DELETE .../notes/<id>,
// script-context-routes.mjs):
// - Orchestration: a switch for the dashboard's own brief of the agents, routes and rules, with a Preview.
// - Live session: one running session by label, read by the server only when Generate is pressed.
// - Notes: the user's own, each with a switch, Edit and Remove; Add a note; Add files (or drop files on the
//   panel), read in the browser and saved one note per file, named after the file.
// Rules this file keeps:
// - ⚠️ User and model text is NEVER HTML: innerHTML only ever takes the fixed MARKUP; everything else is built
//   with createElement and textContent.
// - Open or closed is remembered in this browser (`script.contextOpen`), every localStorage access in a try.
// - Closed, the body is `inert` and hidden from screen readers; the tab opens it and focus moves to the close
//   button, and back to the tab on close (or Escape). The motion is a transform, none under reduced motion.
// - The pure helpers (window.ScriptContext.pure) are tested in node:vm (test/script-context-panel.test.mjs).
;(() => {
  const OPEN_KEY = 'script.contextOpen'
  const API = '/api/script/context'
  const NEAR = 0.8 // the warning shows from 80% of the cap
  const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|ya?ml|toml|ini|cfg|conf|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|dart|c|h|cpp|cs|php|sh|ps1|bat|sql|log|env|gitignore|svg)$/i
  const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|toml))/

  const fmt = n => Number(n || 0).toLocaleString('en-GB')
  const pure = {
    countOn(v) {
      if (!v) return 0
      return (v.orchestration?.on ? 1 : 0) + (v.session?.on ? 1 : 0) + (v.notes || []).filter(n => n.on).length
    },
    tabLabel: n => (n ? `Context · ${n}` : 'Context'),
    sizeText: n => `${fmt(n)} ${n === 1 ? 'character' : 'characters'}`,
    totalLine(v) {
      const base = `About ${fmt(v.total)} characters attached`
      return v.session?.on ? `${base}, plus up to ${fmt(v.session.max)} from the live session.` : `${base}.`
    },
    warnLine(v) {
      const cap = v.limits.totalMax
      if (v.total > cap) return `Over the ${fmt(cap)} limit. The largest parts will be cut or left out.`
      const likely = v.total + (v.session?.on ? v.session.max : 0)
      return likely >= cap * NEAR ? `Close to the ${fmt(cap)} limit. Past it, the largest parts are cut first.` : ''
    },
    /** By name first (Windows calls a .ts file a video), else by type. The content check catches the rest. */
    isTextFile: f => TEXT_EXT.test(f?.name || '') || TEXT_TYPE.test(f?.type || ''),
    /** Why a file is refused before it is read ('' when it can be read): not text, or far too big to be a note. */
    fileRefusal(f, limits) {
      const name = String(f?.name || 'file')
      if (!pure.isTextFile(f)) return `${name} is not a text file, so it was not added.`
      if ((f?.size || 0) > limits.textMax * 4) return `${name} is over ${fmt(limits.textMax)} characters, so it was not added.`
      return ''
    },
    /** A file and its text as { title, text }, or { error } in one calm line. */
    noteFromFile(f, text, limits) {
      const name = String(f?.name || 'file')
      const before = pure.fileRefusal(f, limits)
      if (before) return { error: before }
      if (/[\u0000�]/.test(text)) return { error: `${name} is not a text file, so it was not added.` }
      if (!String(text).trim()) return { error: `${name} is empty, so it was not added.` }
      if (text.length > limits.textMax) return { error: `${name} is over ${fmt(limits.textMax)} characters, so it was not added.` }
      return { title: name.slice(0, limits.titleMax), text }
    },
  }

  const X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'
  const MARKUP = `
    <button type="button" class="sc-ctx-tab" aria-controls="scCtxBody" aria-expanded="false"><span class="sc-ctx-tab-text">Context</span></button>
    <div class="sc-ctx-body" id="scCtxBody" role="region" aria-labelledby="scCtxTitle">
      <div class="sc-ctx-head">
        <h2 class="sc-ctx-title" id="scCtxTitle">Context</h2>
        <button type="button" class="sc-ctx-x" aria-label="Close the context panel" title="Close">${X}</button>
      </div>
      <p class="sc-ctx-lede">What Brainstorming is told before it writes. It goes only to your own Claude run.</p>
      <div class="sc-ctx-scroll">
        <section class="sc-ctx-sec" aria-labelledby="scCtxOrchH">
          <div class="sc-ctx-row">
            <h3 id="scCtxOrchH">Orchestration</h3>
            <label class="sc-ctx-switch"><input type="checkbox" role="switch" id="scCtxOrch" aria-labelledby="scCtxOrchH" aria-describedby="scCtxOrchNote"><span class="sc-ctx-track" aria-hidden="true"></span></label>
          </div>
          <p class="sc-ctx-note" id="scCtxOrchNote">Your agents, routes and rules, written by the dashboard.</p>
          <details class="sc-ctx-preview"><summary>Preview <span class="faint" data-brief-size></span></summary><pre class="sc-ctx-pre" tabindex="0" aria-label="The orchestration brief"></pre></details>
        </section>
        <section class="sc-ctx-sec">
          <h3><label for="scCtxSession">Live session</label></h3>
          <select id="scCtxSession" aria-describedby="scCtxSessionNote"><option value="">None</option></select>
          <p class="sc-ctx-note" id="scCtxSessionNote">Its latest conversation is read when you press Generate.</p>
        </section>
        <section class="sc-ctx-sec" aria-labelledby="scCtxNotesH">
          <h3 id="scCtxNotesH">Notes <span class="faint" data-note-count></span></h3>
          <ul class="sc-ctx-notes" aria-labelledby="scCtxNotesH"></ul>
          <p class="sc-ctx-note" data-no-notes>No notes yet. Add one, or drop text files here.</p>
          <div class="sc-ctx-actions">
            <button type="button" data-add>Add a note</button>
            <button type="button" data-files>Add files</button>
            <input type="file" multiple class="sc-ctx-file" tabindex="-1" aria-hidden="true">
          </div>
          <form class="sc-ctx-form" hidden>
            <label class="sc-ctx-field">Title <input type="text" name="title" maxlength="80" required></label>
            <label class="sc-ctx-field">Text <textarea name="text" rows="7" maxlength="20000" required></textarea></label>
            <div class="sc-ctx-actions"><button type="submit" class="primary">Save</button><button type="button" data-cancel>Cancel</button></div>
          </form>
          <p class="sc-ctx-msg" role="status" aria-live="polite"></p>
        </section>
      </div>
      <div class="sc-ctx-foot"><p data-total></p><p class="sc-ctx-warn" data-warn></p></div>
    </div>`

  const store = {
    get() {
      try {
        return window.localStorage.getItem(OPEN_KEY)
      } catch {
        return null
      }
    },
    set(open) {
      try {
        if (open) window.localStorage.setItem(OPEN_KEY, '1')
        else window.localStorage.removeItem(OPEN_KEY)
      } catch {}
    },
  }

  async function api(method, path, body) {
    try {
      const res = await window.fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      const data = await res.json().catch(() => ({}))
      return res.ok ? { data } : { error: data.error || 'That did not work. Try again.' }
    } catch {
      return { error: 'The dashboard could not be reached. Try again.' }
    }
  }

  function create(el, { page = null } = {}) {
    const doc = window.document
    el.innerHTML = MARKUP
    const q = s => el.querySelector(s)
    const tab = q('.sc-ctx-tab')
    const body = q('.sc-ctx-body')
    const closeBtn = q('.sc-ctx-x')
    const orch = q('#scCtxOrch')
    const pre = q('.sc-ctx-pre')
    const select = q('#scCtxSession')
    const list = q('.sc-ctx-notes')
    const form = q('.sc-ctx-form')
    const fileInput = q('.sc-ctx-file')
    const msg = q('.sc-ctx-msg')
    const st = { open: store.get() === '1', view: null, editing: null, confirming: null }

    const say = text => (msg.textContent = text)
    const text = (tag, cls, t) => {
      const n = doc.createElement(tag)
      if (cls) n.className = cls
      if (t !== undefined) n.textContent = t
      return n
    }

    function paintFrame() {
      el.classList.toggle('open', st.open)
      page?.classList.toggle('ctx-open', st.open)
      tab.setAttribute('aria-expanded', String(st.open))
      tab.title = st.open ? 'Close the context panel' : 'Open the context panel'
      body.inert = !st.open
      if (st.open) body.removeAttribute('aria-hidden')
      else body.setAttribute('aria-hidden', 'true')
    }

    function noteItem(n) {
      const li = text('li', 'sc-ctx-item')
      const sw = text('label', 'sc-ctx-switch')
      const box = text('input')
      box.type = 'checkbox'
      box.setAttribute('role', 'switch')
      box.checked = n.on
      box.dataset.toggle = n.id
      box.setAttribute('aria-label', `Send ${n.title}`)
      const track = text('span', 'sc-ctx-track')
      track.setAttribute('aria-hidden', 'true')
      sw.append(box, track)
      const main = text('div', 'sc-ctx-item-main')
      main.append(text('span', 'sc-ctx-item-title', n.title), text('span', 'sc-ctx-item-size faint', pure.sizeText(n.chars)))
      const acts = text('div', 'sc-ctx-item-acts')
      if (st.confirming === n.id) {
        acts.append(text('span', 'sc-ctx-ask', 'Remove this note?'))
        const yes = text('button', 'link', 'Remove')
        yes.type = 'button'
        yes.dataset.removeYes = n.id
        const no = text('button', 'link', 'Keep')
        no.type = 'button'
        no.dataset.removeNo = n.id
        acts.append(yes, no)
      } else {
        const edit = text('button', 'link', 'Edit')
        edit.type = 'button'
        edit.dataset.edit = n.id
        edit.setAttribute('aria-label', `Edit ${n.title}`)
        const rm = text('button', 'link', 'Remove')
        rm.type = 'button'
        rm.dataset.remove = n.id
        rm.setAttribute('aria-label', `Remove ${n.title}`)
        acts.append(edit, rm)
      }
      li.append(sw, main, acts)
      return li
    }

    function paint() {
      const v = st.view
      const n = pure.countOn(v)
      q('.sc-ctx-tab-text').textContent = pure.tabLabel(n)
      if (!v) return
      orch.checked = v.orchestration.on
      pre.textContent = v.orchestration.text
      q('[data-brief-size]').textContent = `· ${pure.sizeText(v.orchestration.chars)}`
      select.replaceChildren(Object.assign(text('option', '', 'None'), { value: '' }))
      for (const c of v.session.choices) {
        const o = text('option', '', c.state === 'not running' ? `${c.label} (not running)` : c.label)
        o.value = c.label
        select.append(o)
      }
      select.value = v.session.on || ''
      // a note's switch keeps the keyboard focus across the redraw, or Space would work once and then be lost (QA, 2026-11-24)
      const held = list.contains(doc.activeElement) ? doc.activeElement.dataset?.toggle : null
      list.replaceChildren(...v.notes.map(noteItem))
      if (held) list.querySelector(`[data-toggle="${CSS.escape(held)}"]`)?.focus()
      q('[data-no-notes]').hidden = v.notes.length > 0
      q('[data-note-count]').textContent = v.notes.length ? `· ${v.notes.length}` : ''
      q('[data-add]').disabled = v.notes.length >= v.limits.notesMax
      q('[data-files]').disabled = v.notes.length >= v.limits.notesMax
      q('[data-total]').textContent = pure.totalLine(v)
      q('[data-warn]').textContent = pure.warnLine(v)
    }

    async function load() {
      const r = await api('GET', API)
      if (r.error) return say(r.error)
      st.view = r.data
      paint()
    }
    /** One write, then a fresh read; `ok` is said when it worked. */
    async function write(method, path, payload, ok) {
      const r = await api(method, path, payload)
      if (r.error) {
        say(r.error)
        return false
      }
      if (ok) say(ok)
      await load()
      return true
    }

    function setOpen(open) {
      st.open = open
      store.set(open)
      paintFrame()
      if (open) void load()
    }
    function showForm(note = null) {
      st.editing = note?.id || null
      form.hidden = false
      form.elements.title.value = note?.title || ''
      form.elements.text.value = note?.text || ''
      form.elements.title.focus()
    }
    function hideForm() {
      form.hidden = true
      st.editing = null
      form.reset()
    }

    async function addFiles(files) {
      const v = st.view
      if (!v || !files?.length) return
      const said = []
      let added = 0
      for (const f of files) {
        if (v.notes.length + added >= v.limits.notesMax) {
          said.push(`${f.name} was not added: there are already ${v.limits.notesMax} notes.`)
          continue
        }
        const refused = pure.fileRefusal(f, v.limits)
        if (refused) {
          said.push(refused)
          continue
        }
        let content
        try {
          content = await f.text()
        } catch {
          said.push(`${f.name} could not be read, so it was not added.`)
          continue
        }
        const note = pure.noteFromFile(f, content, v.limits)
        if (note.error) {
          said.push(note.error)
          continue
        }
        const r = await api('POST', `${API}/notes`, note)
        if (r.error) said.push(`${f.name}: ${r.error}`)
        else added++
      }
      if (added) said.unshift(added === 1 ? 'Added 1 file as a note.' : `Added ${added} files as notes.`)
      say(said.join(' '))
      await load()
    }

    // ─── events ───
    tab.addEventListener('click', () => {
      setOpen(!st.open)
      if (st.open) closeBtn.focus()
    })
    closeBtn.addEventListener('click', () => {
      setOpen(false)
      tab.focus()
    })
    el.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !st.open || !body.contains(e.target)) return
      if (!form.hidden) return hideForm(), q('[data-add]').focus()
      setOpen(false)
      tab.focus()
    })
    orch.addEventListener('change', () => write('PUT', API, { orchestration: orch.checked }, orch.checked ? 'The orchestration will be sent.' : 'The orchestration will not be sent.'))
    select.addEventListener('change', () => write('PUT', API, { session: select.value || null }, select.value ? `${select.value} will be read when you press Generate.` : 'No live session will be sent.'))
    q('[data-add]').addEventListener('click', () => showForm())
    q('[data-cancel]').addEventListener('click', () => {
      hideForm()
      q('[data-add]').focus()
    })
    q('[data-files]').addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', async () => {
      await addFiles([...fileInput.files])
      fileInput.value = ''
    })
    form.addEventListener('submit', async e => {
      e.preventDefault()
      const payload = { title: form.elements.title.value, text: form.elements.text.value }
      const ok = st.editing
        ? await write('PUT', `${API}/notes/${encodeURIComponent(st.editing)}`, payload, 'Note saved.')
        : await write('POST', `${API}/notes`, payload, 'Note added.')
      if (ok) {
        hideForm()
        q('[data-add]').focus()
      }
    })
    list.addEventListener('change', e => {
      const id = e.target.dataset?.toggle
      if (id) write('PUT', `${API}/notes/${encodeURIComponent(id)}`, { on: e.target.checked })
    })
    list.addEventListener('click', async e => {
      const b = e.target.closest('button')
      if (!b) return
      const note = id => st.view?.notes.find(n => n.id === id)
      if (b.dataset.edit) return showForm(note(b.dataset.edit))
      if (b.dataset.remove) {
        st.confirming = b.dataset.remove
        paint()
        return list.querySelector('[data-remove-no]')?.focus()
      }
      if (b.dataset.removeNo) {
        const id = b.dataset.removeNo
        st.confirming = null
        paint()
        return list.querySelector(`[data-remove="${CSS.escape(id)}"]`)?.focus()
      }
      if (b.dataset.removeYes) {
        const title = note(b.dataset.removeYes)?.title || 'The note'
        st.confirming = null
        await write('DELETE', `${API}/notes/${encodeURIComponent(b.dataset.removeYes)}`, null, `Removed ${title}.`)
        q('[data-add]').focus()
      }
    })
    // drop text files anywhere on the open panel
    el.addEventListener('dragover', e => {
      if (!st.open || !e.dataTransfer?.types?.includes('Files')) return
      e.preventDefault()
      el.classList.add('drop')
    })
    el.addEventListener('dragleave', e => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop')
    })
    el.addEventListener('drop', e => {
      el.classList.remove('drop')
      if (!st.open || !e.dataTransfer?.files?.length) return
      e.preventDefault()
      void addFiles([...e.dataTransfer.files])
    })

    paintFrame()
    void load()
    return { reload: load, isOpen: () => st.open }
  }

  window.ScriptContext = { create, pure, MARKUP }
})()
