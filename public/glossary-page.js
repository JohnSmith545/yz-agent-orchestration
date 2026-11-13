// The Glossary page (#/glossary): every word the dashboard can explain, from
// the shared store (glossary-store.js): the built-in words, the ones learned
// from the marked words in flows, the ones an agent saved, and your own.
//
//   head      Glossary · N
//   bar       a search box (filters as you type over the word and its explanation; `/` focuses it),
//             All | Learned | From agents | Yours | Built-in, and Add a word
//   rows      the word, its one-line explanation, More when it has more, a muted meta line (learned
//             2d, from the agent 2d, yours, built-in, and `seen in 3 flows`, a link to the first of
//             them); Edit and Remove (never on a built-in word; it asks `Remove?` and a second click
//             removes) show on hover or focus
// Editing saves your wording (POST /api/glossary/term through the store): it then wins over
// everything, and no agent or learning turn overwrites it; its More stays. Up to 500 rows are drawn.
// Opening the page reloads the store, so words agents defined since show at once.
//
//   listHtml(terms, { q, filter, editing, confirm })   PURE: the rows, or the one empty or no-match line
//   add(term, short) / edit(key, term, short) / remove(key)   through the store
//   open() / close()   from the shell
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const LIMIT = 500
  const FILTERS = [['all', 'All'], ['learned', 'Learned'], ['agents', 'From agents'], ['yours', 'Yours'], ['built-in', 'Built-in']]
  const SOURCES = { all: null, learned: ['learned'], agents: ['agent'], yours: ['you'], 'built-in': ['built-in'] }
  const HELP = '<p>Every word the dashboard can explain. When an agent marks a technical word in a flow, the page looks it up the first time ' +
    'that flow opens: one small model turn per flow, a fraction of a cent, at most 200 new words a day. Hover the word anywhere to read it.</p>' +
    '<p>Edit a word to put it your way: your wording wins and is never overwritten. Built-in words come with the dashboard and cannot be removed.</p>'
  const G = () => window.Glossary
  const S = () => window.Shell

  // ═══ pure ═══

  function rows(terms, { q = '', filter = 'all' } = {}) {
    const want = SOURCES[filter] || null
    const needle = String(q).trim().toLowerCase()
    return (terms || [])
      .filter(e => !want || want.includes(e.source))
      .filter(e => !needle || `${e.term} ${e.short}`.toLowerCase().includes(needle))
      .sort((a, b) => String(a.key).localeCompare(String(b.key)))
  }

  /** Each filter with its count, the way every head reads: `Yours · 1`. */
  const filterLabels = terms => FILTERS.map(([v, l]) => [v, `${l} · ${rows(terms, { filter: v }).length}`])

  function meta(e) {
    const since = S()?.ago(e.at) || ''
    const who = { learned: 'learned', agent: 'from the agent', you: 'yours', 'built-in': 'built-in' }[e.source] || esc(e.source)
    const when = (e.source === 'learned' || e.source === 'agent') && since ? ` ${esc(since)}` : ''
    const n = (e.seenIn || []).length
    const seen = n ? ` · <button type="button" class="link" data-gl-flow="${esc(e.seenIn[0])}">seen in ${n} flow${n === 1 ? '' : 's'}</button>` : ''
    return `<p class="gl-meta">${who}${when}${seen}</p>`
  }

  function row(e, { editing, confirm } = {}) {
    const body = editing === e.key
      ? `<textarea class="gl-edit" rows="2" maxlength="300" aria-label="Your explanation of ${esc(e.term)}">${esc(e.short)}</textarea>` +
        '<div class="gl-edit-acts"><button type="button" class="primary" data-gl-save>Save</button><button type="button" class="link" data-gl-cancel>Cancel</button><span class="small warn gl-error" hidden></span></div>'
      : `<p class="gl-short">${esc(e.short)}</p>` + (e.more ? `<details class="gl-more"><summary>More</summary><p>${esc(e.more)}</p></details>` : '')
    const remove = confirm === e.key ? '<button type="button" class="link" data-gl-remove data-confirm>Remove?</button>' : '<button type="button" class="link" data-gl-remove>Remove</button>'
    const acts = editing === e.key ? '' : `<div class="gl-acts${confirm === e.key ? ' is-confirming' : ''}"><button type="button" class="link" data-gl-edit>Edit</button>` +
      (e.source !== 'built-in' ? remove : '') + '</div>'
    return `<li class="gl-row" data-key="${esc(e.key)}"><div class="gl-main"><span class="gl-term">${esc(e.term)}</span>${body}${meta(e)}</div>${acts}</li>`
  }

  function listHtml(terms, opts = {}) {
    if (!(terms || []).length) return '<p class="small faint gl-empty">No words yet.</p>'
    const list = rows(terms, opts)
    if (!list.length) return `<p class="small faint gl-empty">No word matches “${esc(String(opts.q ?? '').trim())}”.</p>`
    return `<ul class="gl-list">${list.slice(0, LIMIT).map(e => row(e, opts)).join('')}</ul>` +
      (list.length > LIMIT ? `<p class="small faint gl-limit">showing ${LIMIT} of ${list.length}</p>` : '')
  }

  // ═══ through the store ═══

  async function add(term, short) {
    const t = String(term ?? '').trim()
    const s = String(short ?? '').trim()
    if (!t || !s) return { error: 'Write the word and what it means.' }
    return G().save({ term: t, short: s })
  }
  const edit = (key, term, short) => (String(short ?? '').trim() ? G().save({ term, short: String(short).trim() }) : Promise.resolve({ error: 'Write what it means.' }))
  const remove = key => G().remove(key)

  // ═══ the page ═══

  let box = null
  let showing = false
  const state = { q: '', filter: 'all', editing: null, confirm: null }

  function bar() {
    return `<div class="gl-bar"><input type="search" class="gl-search" data-gl-q placeholder="Search words and explanations" aria-label="Search the glossary" aria-keyshortcuts="/">
        <div class="ob-seg" role="group" aria-label="Show">${FILTERS.map(([v, l]) => `<button type="button" data-gl-filter="${v}" aria-pressed="${v === state.filter}">${l}</button>`).join('')}</div>
        <button type="button" class="gl-add-btn" data-gl-add aria-expanded="false">Add a word</button></div>
      <form class="gl-add" data-gl-form hidden><input name="term" maxlength="40" placeholder="The word" aria-label="The word" required>
        <textarea name="short" rows="2" maxlength="300" placeholder="What it means, in plain words" aria-label="What it means" required></textarea>
        <div class="gl-edit-acts"><button type="submit" class="primary">Save</button><button type="button" class="link" data-gl-add-cancel>Cancel</button><span class="small warn gl-error" hidden></span></div></form>
      <div class="gl-box"></div>`
  }

  function paint() {
    if (!showing || !box) return
    const terms = G()?.all() || []
    S().setTitle('Glossary', 'glossary', terms.length)
    // the counts are on the filters (`Yours · 1`); the chip keeps only its ? (what the page is, how it learns)
    S().setStatus(G()?.loaded === false ? 'Loading…' : '', HELP)
    for (const [v, label] of filterLabels(terms)) {
      const b = box.querySelector(`[data-gl-filter="${v}"]`)
      if (b) b.textContent = label
    }
    const list = box.querySelector('.gl-box')
    if (list) list.innerHTML = listHtml(terms, state)
  }

  function mount() {
    box = document.getElementById('glossaryView')
    box.innerHTML = `<section class="card gl">${bar()}</section>`
    box.addEventListener('input', e => {
      if (!e.target.matches?.('[data-gl-q]')) return
      state.q = e.target.value
      paint()
    })
    box.addEventListener('click', onClick)
    box.addEventListener('submit', async e => {
      e.preventDefault()
      const form = e.target
      const r = await add(form.elements.term.value, form.elements.short.value)
      if (r.error) return showError(form, r.error)
      form.reset()
      form.hidden = true
      box.querySelector('[data-gl-add]').setAttribute('aria-expanded', 'false')
    })
    box.addEventListener('keydown', e => {
      if (e.key === 'Escape' && state.editing && e.target.closest?.('.gl-row')) {
        e.preventDefault()
        state.editing = null
        paint()
      }
    })
    document.addEventListener('keydown', e => {
      if (!showing || e.key !== '/' || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      box.querySelector('[data-gl-q]')?.focus()
    })
    G()?.onChange(paint)
  }

  function showError(where, text) {
    const err = where.querySelector('.gl-error')
    if (!err) return
    err.textContent = text
    err.hidden = false
  }

  async function onClick(e) {
    const t = e.target
    // a pending Remove? is let go by any other click
    if (state.confirm && !t.closest('[data-gl-remove]')) { state.confirm = null; paint() }
    const f = t.closest('[data-gl-filter]')
    if (f) {
      state.filter = f.dataset.glFilter
      for (const b of box.querySelectorAll('[data-gl-filter]')) b.setAttribute('aria-pressed', String(b === f))
      return paint()
    }
    if (t.closest('[data-gl-add]')) {
      const form = box.querySelector('[data-gl-form]')
      form.hidden = !form.hidden
      t.closest('[data-gl-add]').setAttribute('aria-expanded', String(!form.hidden))
      if (!form.hidden) form.elements.term.focus()
      return
    }
    if (t.closest('[data-gl-add-cancel]')) return void (box.querySelector('[data-gl-form]').hidden = true)
    const flow = t.closest('[data-gl-flow]')
    if (flow) return window.FlowsView?.gotoFlow(flow.dataset.glFlow)
    const li = t.closest('.gl-row')
    if (!li) return
    const key = li.dataset.key
    const entry = (G()?.all() || []).find(x => x.key === key)
    if (t.closest('[data-gl-edit]')) {
      state.editing = key
      paint()
      return box.querySelector(`.gl-row[data-key="${CSS.escape(key)}"] textarea`)?.focus()
    }
    if (t.closest('[data-gl-cancel]')) { state.editing = null; return paint() }
    if (t.closest('[data-gl-save]') && entry) {
      const r = await edit(key, entry.term, li.querySelector('textarea').value)
      if (r.error) return showError(li, r.error)
      state.editing = null
      return paint()
    }
    const rm = t.closest('[data-gl-remove]')
    if (rm && state.confirm !== key) {
      state.confirm = key // asks first: the button reads Remove? and a second click removes
      paint()
      return box.querySelector(`.gl-row[data-key="${CSS.escape(key)}"] [data-gl-remove]`)?.focus()
    }
    if (rm) {
      state.confirm = null
      const r = await remove(key)
      if (r.error) showError(li, r.error)
    }
  }

  window.GlossaryPage = {
    open() {
      showing = true
      if (!box) mount()
      paint()
      void G()?.refresh?.() // words agents defined since the last load show at once
    },
    close() {
      showing = false
      state.editing = state.confirm = null
    },
    listHtml,
    filterLabels,
    add,
    edit,
    remove,
  }
})()
