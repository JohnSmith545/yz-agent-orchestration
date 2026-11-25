// Completed on the page: the user's sign-off on a finished flow (completed.mjs), the buttons that give it, and the
// reminders that ask for it. ONE copy of the line and the buttons, used by every page that shows them:
//
//   the Agents page   one line over the diagram while any output waits (`3 outputs wait for your sign-off`, Show them
//                     opens the Output list in the panel); it becomes a notice once one waited warnAfterDays days
//   Home              the same line (#homeOutputs)
//   the Output box    the panel's Outputs list: a Completed tick on each row, Mark all completed when more than one
//                     waits, and its head says how many wait and how many are overdue (pipeline-panel.js); the Output
//                     node of the diagram says the same in its head (pipeline-view.js), in the notice colour once piled
//   a flow            the Sign-off block at the end of its Output tab, after Send (flow-output.js)
//   the Ask drawer, the Tickets page's Pass a task   the pile-up reminder once outputs.max wait, with Mark all
//                     completed right there; the composer still works (a reminder, never a block)
//
// Every button asks ONCE inline (the page's inline-confirm pattern: the question and its two buttons appear in place
// of the button, focus on the yes; Cancel or Escape puts it back), never a native dialog. The confirm is shown and
// hidden in the DOM, so a redraw that keeps the element keeps it open.
//
// Slots: a page puts `data-cv-line` or `data-cv-reminder` on an element and calls CompletedView.paint(root) after it
// draws; every refresh paints every slot again. Data: GET /api/outputs (completed-routes.mjs), every 15 s on every
// page and after each change; `outputs:change` on document tells the pages to read their lists again.
//
//   PURE   waitingLine(n), reminderLine(n)   MUST CHANGE IN LOCKSTEP with completed.mjs (the CLI says the same)
//          lineHtml(s), reminderHtml(s), allHtml(s), tickHtml(t, opts), markHtml(overdue, days), headHtml(s),
//          flowBlock(c), readonlyHtml(f, now), archiveLabel(row, now), waits(id), overdue(id), setData(s), data
//   DOM    refresh(), paint(root), complete(ids, on), show()
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const POLL_MS = 15_000
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const TICK = '<svg class="cv-tick-i" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 8.5l3 3 6-7"/></svg>'
  let data = null

  // ═══ pure ═══

  const outputs = n => `${n} ${n === 1 ? 'output waits' : 'outputs wait'}`
  const waitingLine = n => `${outputs(n)} for your sign-off`
  const reminderLine = n => `${waitingLine(n)}. Mark ${n === 1 ? 'it' : 'them'} completed before a new request.`
  const days = n => `${n} ${n === 1 ? 'day' : 'days'}`
  const countOf = s => Number(s?.counts?.waiting) || 0
  const idsOf = s => (Array.isArray(s?.waiting) ? s.waiting.map(w => w.id) : [])

  /**
   * The inline confirm: `label` the button, `question` (HTML, escaped by the caller) and `yes` the button that does it.
   * `aria` labels the button and the group when the visible words alone would not say which flow.
   */
  function askHtml({ label, question, yes, ids, cls = 'cv-btn', aria = '', group, title = '', icon = '' }) {
    return '<span class="cv-confirm">' +
      `<button type="button" class="${cls}" data-cv-ask aria-expanded="false"${aria ? ` aria-label="${esc(aria)}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${icon}${esc(label)}</button>` +
      `<span class="cv-ask" role="group" aria-label="${esc(group)}" hidden><span class="cv-ask-q">${question}</span>` +
      `<button type="button" class="primary" data-cv-yes data-cv-ids="${esc(ids.join(' '))}">${esc(yes)}</button>` +
      '<button type="button" class="link" data-cv-no>Cancel</button></span></span>'
  }

  /** Mark all completed, for more than one waiting output. */
  function allHtml(s) {
    const n = countOf(s)
    if (n < 2) return ''
    return askHtml({ label: 'Mark all completed', question: `Mark all ${n} completed? They go to the flow archive.`, yes: 'Mark all completed', ids: idsOf(s), group: `Mark all ${n} completed` })
  }

  /** The Completed tick on one output (a row of the Output list, the flow's Sign-off block). */
  function tickHtml(t, { label = 'Completed' } = {}) {
    const title = String(t?.title || t?.id || '')
    return askHtml({
      label, icon: TICK, cls: 'cv-btn cv-tick', title: 'Mark it completed', aria: `Mark ${title} completed`, group: `Mark ${title} completed`,
      question: `Mark <b>${esc(title)}</b> completed? It goes to the flow archive.`, yes: 'Completed', ids: [String(t?.id || '')],
    })
  }

  /** The quiet amber mark on an output that waits, in words too; `overdue` says how long. */
  const markHtml = (overdue = false, after = 2) =>
    `<span class="cv-mark${overdue ? ' is-over' : ''}"><i class="cv-dot" aria-hidden="true"></i>Mark it completed${overdue ? `, waiting more than ${days(after)}` : ''}</span>`

  /** The Agents page and Home: one line while anything waits; a notice once one is overdue. */
  function lineHtml(s) {
    const n = countOf(s)
    if (!n) return ''
    const o = Number(s.counts.overdue) || 0
    const over = o ? `<span class="cv-over">${o} waiting more than ${days(Number(s.warnAfterDays) || 2)}</span>` : ''
    return `<p class="cv-line${o ? ' is-notice' : ''}" role="status"><i class="cv-dot" aria-hidden="true"></i><b>${esc(waitingLine(n))}</b>${over}` +
      '<a class="link" href="#/agents?outputs" data-cv-show>Show them</a></p>'
  }

  /** The pile-up reminder above a composer: only at outputs.max or more. */
  function reminderHtml(s) {
    if (!s?.piled) return ''
    return `<div class="cv-remind" role="note"><p><i class="cv-dot" aria-hidden="true"></i>${esc(reminderLine(countOf(s)))}</p>${allHtml(s)}</div>`
  }

  /** The Output box's head: how many wait and how many are overdue, in the notice colour once piled up. */
  function headHtml(s) {
    const n = countOf(s)
    if (!n) return ''
    const o = Number(s.counts.overdue) || 0
    return `<span class="cv-head${s.piled ? ' is-notice' : ''}">${n} waiting${o ? ` · ${o} overdue` : ''}</span>`
  }

  const waiting = id => (Array.isArray(data?.waiting) ? data.waiting.find(w => w.id === id) : null)
  const waits = id => !!waiting(id)
  const overdue = id => !!waiting(id)?.overdue

  /**
   * The Sign-off block at the end of a flow's Output tab (flow-output.js render context `c`). A finished flow the user
   * has not put away: done, or one the server says waits (open but at the Output). Nothing on a read-only flow.
   */
  function flowBlock(c) {
    const f = c?.flow
    if (!f || f.completedAt || f.archivedAt || f.deletedAt) return ''
    if (f.status !== 'done' && !waits(f.id)) return ''
    const late = overdue(f.id)
    return `<section class="ob ob-complete" aria-label="Sign-off" ${c.keyed('complete', [f.id, f.title, late])}>` +
      (typeof c.head === 'function' ? c.head('Sign-off') : '') +
      `<div class="cv-row"><p class="cv-say">${late ? markHtml(true, Number(data?.warnAfterDays) || 2) : ''}` +
      '<span>Happy with this output? Mark it completed: it goes to the flow archive and off the boards, and still counts in the score.</span></p>' +
      `${tickHtml(f)}</div></section>`
  }

  /** `24 Nov` (with the year when it is not this one), in local time; '' without a time. */
  function dayOf(iso, now = new Date()) {
    const t = new Date(iso ?? NaN)
    if (Number.isNaN(t.getTime())) return ''
    const year = t.getFullYear() === now.getFullYear() ? '' : ` ${t.getFullYear()}`
    return `${t.getDate()} ${MONTHS[t.getMonth()]}${year}`
  }
  /** `Completed 24 Nov`: the flow archive's label for a completed flow; '' without a time. */
  const archiveLabel = (row, now = new Date()) => (dayOf(row?.completedAt, now) ? `Completed ${dayOf(row.completedAt, now)}` : '')

  /**
   * The read-only line of a COMPLETED flow opened by link (flows.js, in place of the archived one): when, and where to
   * take the mark off. No Restore: Unarchive refuses a completed flow (trash-routes.mjs), Uncomplete is the way.
   */
  function readonlyHtml(f, now = new Date()) {
    if (!f?.completedAt) return ''
    const when = dayOf(f.completedAt, now)
    return `<p class="fl-readonly" role="note"><span>This flow is <b>completed</b>${when ? ` (${esc(when)})` : ''}. It is in the flow archive, and nothing can be changed here.</span>` +
      `<a class="link" href="#/archive?q=${encodeURIComponent(f.id)}">Uncomplete it in the flow archive</a></p>`
  }

  /**
   * Where focus goes after a press, by the part of the page it was made in: [the scope, what to focus in it]. A list
   * redrawn under the keyboard would otherwise drop it to the top of the page. Something stable, never the button
   * that just went away: the Outputs switch, the heading of the list (its rows are redrawn when the pipeline is read
   * again, and may all be gone), the composer, the selected tab of the read-only flow.
   */
  const FOCUS_AFTER = [
    ['.pl-panel', '[data-mode="outputs"]'],
    ['#drawer', '#fcInput'],
    ['.fl-open', '.fl-readonly a, .fl-tabs [aria-selected="true"]'],
    ['.fx-pass, #fxBulk', '[name="task"], #fxBulkTask'],
  ]
  function focusAfter(el) {
    for (const [scope, sel] of FOCUS_AFTER) {
      const s = el?.closest?.(scope)
      if (s) return [s, sel]
    }
    return null
  }

  const api = {
    focusAfter,
    waitingLine, reminderLine, lineHtml, reminderHtml, allHtml, tickHtml, markHtml, headHtml, flowBlock, readonlyHtml, archiveLabel, waits, overdue,
    setData(s) {
      data = s || null
    },
    refresh() {}, paint() {}, complete() {}, show() {},
  }
  Object.defineProperty(api, 'data', { get: () => data })
  window.CompletedView = api
  if (!window.document) return

  // ═══ the page ═══

  const doc = window.document
  let last = ''

  /** Fill every slot under `root` whose HTML changed (an unchanged one keeps an open confirm and the focus). */
  function paint(root = doc) {
    for (const el of root.querySelectorAll?.('[data-cv-line], [data-cv-reminder]') || []) {
      const html = el.hasAttribute('data-cv-line') ? lineHtml(data) : reminderHtml(data)
      if (el._cvHtml === html) continue
      el._cvHtml = html
      el.innerHTML = html
      el.hidden = !html
    }
  }

  async function refresh() {
    try {
      const r = await fetch('/api/outputs')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || r.status)
      data = j
    } catch {
      return // the last summary stays; the next poll tries again
    }
    const sig = JSON.stringify([data.waiting, data.counts, data.piled])
    if (sig === last) return
    last = sig
    paint()
    doc.dispatchEvent(new CustomEvent('outputs:change', { detail: data }))
  }

  /** POST complete for each id in turn (the page's own Origin goes with it); the count that went through. */
  async function complete(ids, on = true) {
    let done = 0
    let error = ''
    for (const id of ids) {
      try {
        const r = await fetch(`/api/flows/${encodeURIComponent(id)}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ completed: on }) })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
        done++
      } catch (e) {
        error ||= e?.message || String(e)
      }
    }
    last = '' // whatever changed, every page reads again
    await refresh()
    window.FlowsView?.load()
    window.ArchivePage?.reload()
    doc.dispatchEvent(new CustomEvent('outputs:change', { detail: data }))
    return { done, error }
  }

  /** The Output list in the Agents page panel: open it there, or go there first. */
  function show() {
    const page = doc.querySelector('#agentsView .pl-page')
    if (window.Shell?.current?.view === 'agents' && page) return page.dispatchEvent(new CustomEvent('pipeline-outputs'))
    window.Shell?.go('#/agents?outputs')
  }

  const askOf = el => el.closest('.cv-confirm')
  function open(box, on, move = true) {
    const ask = box.querySelector('[data-cv-ask]')
    const q = box.querySelector('.cv-ask')
    ask.hidden = on
    ask.setAttribute('aria-expanded', String(on))
    box.classList.toggle('is-open', on) // an open question takes the whole row (completed.css)
    q.hidden = !on
    if (move) (on ? q.querySelector('[data-cv-yes]') : ask).focus()
  }

  doc.addEventListener('click', async e => {
    const t = e.target
    if (!t?.closest) return
    if (t.closest('[data-cv-show]')) {
      e.preventDefault()
      return show()
    }
    const ask = t.closest('[data-cv-ask]')
    if (ask) return open(askOf(ask), true)
    if (t.closest('[data-cv-no]')) return open(askOf(t), false)
    const yes = t.closest('[data-cv-yes]')
    if (!yes) return
    const ids = String(yes.dataset.cvIds || '').split(' ').filter(Boolean)
    const label = yes.textContent
    const after = focusAfter(yes) // taken now: the button may be gone once the list is drawn again
    yes.disabled = true
    yes.textContent = 'Marking…'
    const { done, error } = await complete(ids, true)
    // ⚠️ a redraw that kept this block (a failure, or a page that has not read the completed flow yet) must never
    // leave Marking… with a live Cancel: the button is put back and the question closed
    if (yes.isConnected) {
      yes.disabled = false
      yes.textContent = label
      open(askOf(yes), false, !done) // a failure: back on its own button; a success: on to a stable place below
    }
    const lost = !doc.activeElement || doc.activeElement === doc.body || !doc.activeElement.isConnected
    if (after && (done || lost) && after[0].isConnected) after[0].querySelector(after[1])?.focus({ preventScroll: true })
    if (error) window.alert?.(error)
    if (done) window.Notifier?.toast(esc(done === 1 ? 'Marked completed. It is in the flow archive.' : `${done} marked completed. They are in the flow archive.`), { kind: 'info', keep: false })
  })
  // Escape inside an open confirm closes it (and nothing else: the drawer or a window keeps its own Escape)
  doc.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return
    const box = e.target?.closest?.('.cv-confirm')
    if (!box || box.querySelector('.cv-ask')?.hidden) return
    e.preventDefault()
    e.stopPropagation()
    open(box, false)
  }, true)
  // `#/agents?outputs` (Show them, from Home): once the panel is drawn, it opens on the Output list
  window.Shell?.onRoute(r => {
    if (r.view === 'agents' && r.params?.query && 'outputs' in r.params.query) window.Shell.whenReady('#agentsView .pl-panel-list', () => setTimeout(show, 50), 4000)
  })

  // The toasts (notify.js .nt-stack, bottom right) sit over the end of the Output list: the list gets a bottom padding
  // the height of the stack (--cv-toasts, completed.css), so its last ticks scroll clear of it. The toasts are untouched.
  function roomForToasts() {
    const stack = doc.querySelector('.nt-stack')
    if (!stack || typeof ResizeObserver !== 'function') return
    const set = () => doc.documentElement.style.setProperty('--cv-toasts', stack.children.length ? `${Math.ceil(stack.offsetHeight) + 16}px` : '0px')
    new ResizeObserver(set).observe(stack)
    set()
  }

  Object.assign(api, { refresh, paint, complete, show })
  doc.addEventListener('DOMContentLoaded', roomForToasts)
  doc.addEventListener('DOMContentLoaded', refresh)
  setInterval(refresh, POLL_MS)
})()
