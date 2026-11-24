// The SCRIPT History list (the DOM side; the words come from script-history.js). A disclosure
// under the two columns, closed by default and remembered in this browser, listing the runs
// the server logged: GET /api/script/log (newest first, at most 50), DELETE /api/script/log/<id>
// for one, DELETE /api/script/log for all.
//
//   ScriptHistoryView.create(section, { onRestore(run) }) → { refresh(currentId?) }
//     section    the page's <details id="scriptHistory"> (script-page.js markup)
//     onRestore  a row was clicked: bring that run back. Returns false when it was refused (a run
//                is going), and the list says why.
//     refresh    read the log again and redraw the rows. It never closes the disclosure, and it
//                keeps the scroll where it is. `currentId` (the stream's final `run`) marks the
//                run just made.
//
// Rules it keeps:
// - A log that fails or is missing (an older server, a 404) hides the section. Never an error.
// - ⚠️ Run text and titles are text: every field goes in with textContent.
// - Clear history asks once, in the page, before clearing all. No browser dialog.
// - Every browser storage access is in try/catch (`script.historyOpen` = '1' when open).
;(() => {
  if (!window.document) return
  const URL_PATH = '/api/script/log'
  const OPEN_KEY = 'script.historyOpen'
  const H = () => window.ScriptHistory

  function create(section, { onRestore = () => true } = {}) {
    const doc = section.ownerDocument
    const $ = id => doc.getElementById(id)
    const sum = $('scriptHistorySum')
    const list = $('scriptHistoryList')
    const clear = $('scriptHistoryClear')
    const askBox = $('scriptHistoryAsk')
    const askYes = $('scriptHistoryYes')
    const askNo = $('scriptHistoryNo')
    const note = $('scriptHistoryNote')
    let runs = []
    let current = null

    let open = false
    try {
      open = window.localStorage.getItem(OPEN_KEY) === '1'
    } catch {
      open = false
    }
    section.open = open
    section.addEventListener('toggle', () => {
      try {
        window.localStorage.setItem(OPEN_KEY, section.open ? '1' : '0')
      } catch {
        /* not remembered: storage is off */
      }
    })

    const make = (tag, cls, text) => {
      const e = doc.createElement(tag)
      if (cls) e.className = cls
      if (text) e.textContent = text
      return e
    }

    function rowEl(run) {
      const r = H().row(run)
      const li = make('li', 'sc-h-item')
      if (r.id === current) {
        li.classList.add('sc-h-current')
        li.setAttribute('aria-current', 'true')
      }
      const pick = make('button', 'sc-h-row')
      pick.type = 'button'
      pick.dataset.id = r.id
      const when = make('span', 'sc-h-when', r.when)
      if (r.exact) when.title = r.exact
      const kind = make('span', `sc-h-kind sc-h-${r.kind}`, r.label)
      pick.append(when, make('span', 'sc-h-idea', r.idea), kind)
      if (r.cost) pick.append(make('span', 'sc-h-cost', r.cost))
      if (r.sent) pick.append(make('span', 'sc-h-sent', r.sent))
      pick.addEventListener('click', () => {
        note.textContent = onRestore(run) === false ? 'Wait for this run to finish first.' : ''
      })
      const remove = make('button', 'link sc-h-remove', 'Remove')
      remove.type = 'button'
      remove.setAttribute('aria-label', `Remove the run: ${r.idea}`)
      remove.addEventListener('click', () => removeOne(r.id, li))
      li.append(pick, remove)
      return li
    }

    function draw() {
      sum.textContent = H().summary(runs.length)
      list.replaceChildren(...runs.map(rowEl))
      clear.hidden = !runs.length
      if (!runs.length) hideAsk()
    }

    async function refresh(currentId) {
      if (currentId !== undefined) current = currentId || null
      let answer = null
      try {
        const res = await window.fetch(URL_PATH, { cache: 'no-store' })
        if (res.ok) answer = await res.json()
      } catch {
        answer = null
      }
      if (!answer || !Array.isArray(answer.runs)) {
        section.hidden = true
        return
      }
      runs = H().runs(answer)
      section.hidden = false
      const y = window.scrollY
      draw()
      if (window.scrollY !== y) window.scrollTo({ top: y }) // a redraw never moves the page
    }

    async function del(path) {
      try {
        await window.fetch(path, { method: 'DELETE' })
      } catch {
        /* the refresh below shows what is really kept */
      }
      await refresh()
    }

    async function removeOne(id, li) {
      // the focus goes to the next row (or the summary) so the keyboard is not lost
      const next = li.nextElementSibling?.querySelector('.sc-h-row') || li.previousElementSibling?.querySelector('.sc-h-row')
      await del(`${URL_PATH}/${encodeURIComponent(id)}`)
      const again = next && list.querySelector(`.sc-h-row[data-id="${CSS.escape(next.dataset.id)}"]`)
      ;(again || sum).focus({ preventScroll: true })
    }

    function hideAsk() {
      askBox.hidden = true
      clear.hidden = !runs.length
    }

    clear.addEventListener('click', () => {
      askBox.querySelector('.sc-h-ask-text').textContent = `Clear all ${runs.length === 1 ? '1 run' : `${runs.length} runs`}?`
      clear.hidden = true
      askBox.hidden = false
      askNo.focus()
    })
    askNo.addEventListener('click', () => (hideAsk(), clear.focus()))
    askYes.addEventListener('click', async () => {
      hideAsk()
      await del(URL_PATH)
      sum.focus({ preventScroll: true })
    })

    return { refresh }
  }

  window.ScriptHistoryView = { create }
})()
