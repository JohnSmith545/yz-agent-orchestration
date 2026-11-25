// Predict and warn's alerts on the page, the DOM half (the words and HTML are predict-view.js):
//
//   the Agents page   one line at the TOP of the page, above Pipeline score, while any alert stands (`3 alerts`, what
//                     kinds, Show them, a ?), its rows folded under it: Open the flow, Copy handover request, Snooze
//                     for a week, Dismiss for today; one agent holding many flows is one row with Dismiss all for
//                     today and its flows folded under it (an open fold stays open across the redraws)
//   Home              the same count on one line, linking to them (#homeAlerts, `#/agents?alerts` opens the rows)
//   the diagram       a quiet mark on the box of an agent whose session re-reads a large history (a context alert)
//
// Slots: a page puts `data-pe-alerts` (the line and its rows) or `data-pe-home` on an element and calls
// PredictAlerts.paint(root) after it draws; every load paints every slot again, and a slot whose HTML did not change
// is left alone (an open list stays open, the focus stays put). Data: GET /api/alerts every 30 s on every page and
// right after a dismiss or a snooze. Dismiss (one key, or a group's keys) is POST /api/alerts/dismiss and Snooze is
// POST /api/alerts/snooze, both with the page's own Origin (the browser sends it).
//
// Rules: no sound, no pop-up, no toast; the list's open or closed state is remembered in this browser (every storage
// access in try/catch); Copy handover request copies a sentence and sends nothing.
//
//   PredictAlerts.refresh(), paint(root), data
;(() => {
  const doc = window.document
  if (!doc) return
  const POLL_MS = 30_000
  const OPEN_KEY = 'predict.alertsOpen'
  const V = () => window.PredictView
  let data = null
  let open = false
  try {
    open = window.localStorage.getItem(OPEN_KEY) === '1'
  } catch {}
  const remember = () => {
    try {
      window.localStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {}
  }

  /** Fill every slot under `root` whose HTML changed. */
  function paint(root = doc) {
    if (!V()) return
    for (const el of root.querySelectorAll?.('[data-pe-alerts]') || []) {
      const line = V().lineHtml(data, { open })
      const html = line ? `${line}<div class="pe-list" id="peList"${open ? '' : ' hidden'}>${V().listHtml(data)}</div>` : ''
      if (el._peHtml === html) continue
      const focusKey = doc.activeElement && el.contains(doc.activeElement) ? focusOf(doc.activeElement) : null
      // a group's fold the user opened stays open: its times change every minute, so the HTML does too
      const opened = new Set([...el.querySelectorAll('[data-pe-fold][open]')].map(d => d.getAttribute('data-pe-fold')))
      el._peHtml = html
      el.innerHTML = html
      for (const d of el.querySelectorAll('[data-pe-fold]')) if (opened.has(d.getAttribute('data-pe-fold'))) d.open = true
      el.hidden = !html
      const help = el.querySelector('.help')
      if (help) window.Help?.attach(help, V().ALERTS_HELP)
      if (focusKey) el.querySelector(focusKey)?.focus({ preventScroll: true })
    }
    for (const el of root.querySelectorAll?.('[data-pe-home]') || []) {
      const html = V().homeHtml(data)
      if (el._peHtml === html) continue
      el._peHtml = html
      el.innerHTML = html
      el.hidden = !html
    }
    mark()
  }
  /** A selector for the focused control, so a redraw puts the focus back on the same one. */
  function focusOf(el) {
    if (el.matches('[data-pe-toggle]')) return '[data-pe-toggle]'
    for (const a of ['data-pe-dismiss', 'data-pe-dismiss-all', 'data-pe-snooze', 'data-pe-copy']) if (el.hasAttribute(a)) return `[${a}="${CSS.escape(el.getAttribute(a))}"]`
    return null
  }

  /** The quiet mark on the diagram: the box of each agent with a context alert. */
  function mark() {
    const agents = new Map((data?.alerts || []).filter(a => a.kind === 'context' && a.agent).map(a => [a.agent, a]))
    for (const node of doc.querySelectorAll('#agentsView .pl-node')) {
      const name = node.querySelector('.pl-name')?.textContent || ''
      const a = agents.get(name)
      node.classList.toggle('pe-ctx', !!a)
      const title = a ? 'Long history: each turn re-reads a large conversation. See the alerts at the top of this page.' : ''
      if ((node.getAttribute('title') || '') !== title) {
        if (title) node.setAttribute('title', title)
        else node.removeAttribute('title')
      }
    }
  }
  let marking = 0
  const markSoon = () => {
    if (marking) return
    marking = window.requestAnimationFrame?.(() => {
      marking = 0
      mark()
    }) || 0
  }

  async function refresh() {
    try {
      const r = await fetch('/api/alerts')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || r.status)
      data = j
    } catch {
      return // the last alerts stay; the next poll tries again
    }
    paint()
  }

  function setOpen(on, focusRows = false) {
    open = on
    remember()
    paint()
    if (focusRows) doc.querySelector('[data-pe-alerts] .pe-list-rows a, [data-pe-alerts] .pe-list-rows button')?.focus({ preventScroll: true })
  }

  /** Dismiss for today (one alert), Dismiss all for today (a group's keys) or Snooze for a week: POST, then read again. */
  async function dismiss(btn) {
    const all = btn.hasAttribute('data-pe-dismiss-all')
    const snooze = btn.hasAttribute('data-pe-snooze')
    const body = all ? { keys: btn.getAttribute('data-pe-dismiss-all').split(' ').filter(Boolean) } : { key: btn.getAttribute(snooze ? 'data-pe-snooze' : 'data-pe-dismiss') }
    const label = btn.textContent
    btn.disabled = true
    btn.textContent = snooze ? 'Snoozing…' : 'Dismissing…'
    try {
      const r = await fetch(snooze ? '/api/alerts/snooze' : '/api/alerts/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok && r.status !== 404) throw new Error(j.error || `Failed (${r.status})`)
    } catch (e) {
      btn.disabled = false
      btn.textContent = label
      window.alert?.(e?.message || String(e))
      return
    }
    const slot = btn.closest('[data-pe-alerts]')
    await refresh()
    // the row is gone: the focus goes to the next row's dismiss, else to the line's toggle, never to the top of the page
    if (slot && (!doc.activeElement || doc.activeElement === doc.body || !doc.activeElement.isConnected)) {
      ;(slot.querySelector('[data-pe-dismiss]') || slot.querySelector('[data-pe-toggle]'))?.focus({ preventScroll: true })
    }
  }

  async function copy(btn) {
    const a = (data?.alerts || []).find(x => x.key === btn.getAttribute('data-pe-copy'))
    if (!a?.handover) return
    let ok = false
    try {
      await window.navigator.clipboard.writeText(a.handover)
      ok = true
    } catch {
      // no clipboard (an older browser, or the page not focused): a hidden text box and the copy command
      const box = doc.createElement('textarea')
      box.value = a.handover
      box.setAttribute('readonly', '')
      box.style.position = 'fixed'
      box.style.opacity = '0'
      doc.body.appendChild(box)
      box.select()
      try {
        ok = doc.execCommand('copy')
      } catch {}
      box.remove()
    }
    btn.textContent = ok ? 'Copied: paste it to the agent' : 'Could not copy'
    setTimeout(() => {
      if (btn.isConnected) btn.textContent = 'Copy handover request'
    }, 2500)
  }

  doc.addEventListener('click', e => {
    const t = e.target
    if (!t?.closest) return
    const toggle = t.closest('[data-pe-toggle]')
    if (toggle) return setOpen(!open)
    const d = t.closest('[data-pe-dismiss], [data-pe-dismiss-all], [data-pe-snooze]')
    if (d) return void dismiss(d)
    const c = t.closest('[data-pe-copy]')
    if (c) return void copy(c)
  })

  // `#/agents?alerts` (See them, from Home): the rows open once the page is drawn
  window.Shell?.onRoute?.(r => {
    if (r.view === 'agents' && r.params?.query && 'alerts' in r.params.query) window.Shell.whenReady('#agentsView [data-pe-alerts]', () => setOpen(true), 4000)
  })

  // the diagram is patched and rebuilt as the pipeline is read again: the marks follow it
  doc.addEventListener('DOMContentLoaded', () => {
    const view = doc.getElementById('agentsView')
    if (view && typeof MutationObserver === 'function') new MutationObserver(markSoon).observe(view, { childList: true, subtree: true })
    refresh()
  })
  setInterval(refresh, POLL_MS)

  const api = { refresh, paint }
  Object.defineProperty(api, 'data', { get: () => data })
  window.PredictAlerts = api
})()
