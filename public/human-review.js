// Human review: everything that cannot go on without the user, as ONE box on the Agents diagram, and the count that
// says so everywhere else. All of it reads GET /api/human (human.mjs), polled every 15 s on every page:
//
//   the box     drawn INSIDE the diagram's canvas (pipeline-view.js hands it each layout: place), under the boxes
//               and their arrows, its left and right edges on the outermost boxes' edges, so it lines up with them
//               and never covers a box, an arrow or a label; it is not a step of any route (pipeline.mjs is untouched)
//   the rail    a count on the Agents entry
//   Home        one line: how many things need you, and a link to the box (#homeHuman)
//   the head    the page head's "N waiting on you" pill opens the box (shell.js)
//
//   ┌──────────────────────────────────────────────────────────────────────────────┐
//   │ ● Human review   13 waiting on you                                            │
//   │ Add a dark mode toggle                              Question · Agent 3 · 3h   │
//   │ The test passes; dev is where QA can try it                                   │
//   │ Deploy the fix to dev?                                          [Yes] [No]    │
//   │ Production deploy needs its secrets               By hand 1 of 4 · Agent 2 · 2d│
//   │ 1 of 4 done. Next: Add the deploy token as a repository secret               │
//   └──────────────────────────────────────────────────────────────────────────────┘   (rows scroll inside it)
//
// A question is answered right here, with the same controls as everywhere (FlowBoard.askControls) on the same
// route (FlowsView.answer, POST /api/flows/<id>/answer). A row's title opens its flow at the right place: the
// question for an ask (FlowsView.gotoFlow at its node), the by-hand steps for manual work (FlowsView.gotoHand), the
// ticket on the Tickets page for a marked ticket with no flow. `#/agents?human` scrolls the box into view.
//
//   rowHtml(item, flows?)   PURE: one row
//   html(data)              PURE: the box's inside (its head with the count, then the rows or one calm line)
//   spot(lay)               PURE: { x, y, w } in the canvas, from pipeline-layout.js's layout
//   homeHtml(data)          PURE: Home's one line
//   place(canvas, lay) / refresh() / show() / needsHand(flowId) / data
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const enc = encodeURIComponent
  const POLL_MS = 15_000
  const GAP = 6 // between the diagram's layout (its own padding included) and the box
  const BOTTOM = 10 // under the box, inside the canvas
  const KIND = { ask: 'Question', hand: 'By hand', blocked: 'Blocked', ticket: 'Ticket' }
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

  // ═══ pure ═══

  /** Where the box goes in the canvas: under everything the layout drew, from the leftmost box's left edge to the rightmost box's right edge. */
  function spot(lay) {
    const nodes = lay?.nodes || []
    if (!nodes.length) return { x: 12, y: GAP, w: Math.max(240, (lay?.width || 300) - 24) }
    const left = Math.min(...nodes.map(n => n.x))
    const right = Math.max(...nodes.map(n => n.x + n.w))
    return { x: left, y: Math.ceil(lay.height) + GAP, w: Math.max(0, right - left) }
  }

  /** The kind word, with the progress of by-hand work and the ticket id of a marked ticket. */
  function kindWord(i) {
    if (i.kind === 'hand' && i.progress?.total) return `${KIND.hand} · ${i.progress.done} of ${i.progress.total}`
    if (i.kind === 'ticket') return `${KIND.ticket} ${i.ticketId}`
    return KIND[i.kind] || ''
  }

  function rowHtml(i) {
    const waited = window.Shell?.ago(i.since) || ''
    const meta = [`<span class="hr-kind k-${esc(i.kind)}">${esc(kindWord(i))}</span>`, i.agent ? esc(i.agent) : '', waited ? `waiting ${esc(waited)}` : ''].filter(Boolean)
    const open = i.kind === 'ticket' ? `data-hr-ticket="${esc(i.ticketId)}"` : `data-hr-open="${esc(i.flowId)}" data-hr-kind="${esc(i.kind)}"${i.nodeId ? ` data-hr-node="${esc(i.nodeId)}"` : ''}`
    const label = i.kind === 'ask' ? 'Open the question in its flow' : i.kind === 'hand' ? 'Open the steps in its flow' : i.kind === 'ticket' ? 'Open the ticket' : 'Open the flow'
    const ask = i.kind === 'ask' && i.ask
      ? `<div class="hr-ask" data-flow="${esc(i.flowId)}"><p class="hr-q">${esc(i.ask.title)}</p><div class="hr-acts">${window.FlowBoard.askControls({ id: i.flowId }, { id: i.nodeId, kind: i.ask.kind, yes: i.ask.yes, no: i.ask.no, answer: null }, 'hr')}</div></div>`
      : ''
    return `<li class="hr-row k-${esc(i.kind)}"><div class="hr-top"><button type="button" class="link hr-title" ${open} title="${label}">${esc(i.title)}</button>` +
      `<span class="hr-meta">${meta.join('<span aria-hidden="true">·</span>')}</span></div>` +
      (ask ? `${ask}<p class="hr-why"><span class="hr-why-k">Why?</span> ${esc(i.reason)}</p>` : `<p class="hr-why">${esc(i.reason)}</p>`) + '</li>'
  }

  function html(data) {
    const items = Array.isArray(data?.items) ? data.items : []
    const n = items.length
    const head = `<div class="hr-head"><h3 class="hr-h" id="hrHead" tabindex="-1"><i class="hr-dot" aria-hidden="true"></i>Human review</h3>` +
      `<span class="hr-count${n ? '' : ' is-zero'}" aria-label="${plural(n, 'thing')} waiting on you">${n}</span>${n ? '<span class="hr-sub">waiting on you</span>' : ''}</div>`
    if (data?.error) return `${head}<p class="hr-empty warn">Could not load what waits on you: ${esc(data.error)}</p>`
    if (!data) return `${head}<p class="hr-empty">Loading…</p>`
    if (!n) return `${head}<p class="hr-empty">Nothing waits on you. The agents can go on by themselves.</p>`
    return `${head}<ol class="hr-rows" tabindex="0" aria-label="What waits on you, newest first">${items.map(rowHtml).join('')}</ol>`
  }

  /** Home's one line: how many things need you, what they are, and the link to the box. */
  function homeHtml(data) {
    const c = data?.counts
    if (!c) return ''
    if (!c.total) return '<p class="hr-home"><i class="hr-dot is-calm" aria-hidden="true"></i>Nothing needs you right now.</p>'
    const parts = [[c.ask, 'question'], [c.hand, 'by-hand task'], [c.blocked, 'blocked flow'], [c.ticket, 'ticket only you can do', 'tickets only you can do']].filter(([v]) => v > 0).map(([v, one, many]) => plural(v, one, many))
    return `<p class="hr-home"><i class="hr-dot" aria-hidden="true"></i><b>${plural(c.total, 'thing needs', 'things need')} you</b><span class="hr-home-parts">${esc(parts.join(', '))}</span>` +
      '<a class="link" href="#/agents?human" data-hr-show>Open Human review</a></p>'
  }

  const api = { spot, rowHtml, html, homeHtml, data: null, place() {}, refresh() {}, show() {}, needsHand: () => false }
  window.HumanReview = api
  if (!window.document) return

  // ═══ the page ═══

  const doc = window.document
  let data = null
  let last = '' // the JSON of the last answer, so an unchanged poll redraws nothing
  let canvas = null
  let lay = null
  const box = doc.createElement('section')
  box.className = 'hr-box'
  box.setAttribute('aria-labelledby', 'hrHead')

  /** Keep what was typed in an answer field (and the focus) across a redraw. */
  function paintBox() {
    const vals = new Map([...box.querySelectorAll('input[data-key]')].map(i => [i.dataset.key, i.value]))
    const a = doc.activeElement
    const focus = a && box.contains(a) ? (a.dataset?.key ? `input[data-key="${CSS.escape(a.dataset.key)}"]` : a.dataset?.hrOpen ? `[data-hr-open="${CSS.escape(a.dataset.hrOpen)}"]` : null) : null
    const scroll = box.querySelector('.hr-rows')?.scrollTop || 0
    box.innerHTML = html(data)
    for (const i of box.querySelectorAll('input[data-key]')) if (vals.has(i.dataset.key)) i.value = vals.get(i.dataset.key)
    const rows = box.querySelector('.hr-rows')
    if (rows) rows.scrollTop = scroll
    if (focus) box.querySelector(focus)?.focus()
    fit()
  }

  /** Into the diagram's canvas at its spot; the canvas grows to hold it (its height is the layout's plus the box). */
  function fit() {
    if (!canvas || !lay) return
    if (box.parentNode !== canvas) canvas.appendChild(box)
    const s = spot(lay)
    Object.assign(box.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px` })
    canvas.style.height = `${s.y + box.offsetHeight + BOTTOM}px`
  }

  function place(c, l) {
    canvas = c
    lay = l
    if (!box.innerHTML) paintBox()
    else fit()
  }

  function paintElsewhere() {
    const n = data?.counts?.total || 0
    const icon = doc.querySelector('#rail a.rail-item[data-view="agents"] .rail-icon')
    if (icon) {
      let b = icon.querySelector('.hr-rail-count')
      if (!b) icon.insertAdjacentHTML('beforeend', '<span class="hr-rail-count" hidden></span>'), (b = icon.querySelector('.hr-rail-count'))
      b.hidden = !n
      b.textContent = n > 99 ? '99+' : String(n)
      icon.parentElement.title = n ? `Agents · ${plural(n, 'thing')} waiting on you in Human review` : 'Agents'
    }
    const home = doc.getElementById('homeHuman')
    if (home) {
      home.innerHTML = homeHtml(data)
      home.hidden = !home.innerHTML
    }
  }

  async function refresh() {
    let next
    try {
      const r = await fetch('/api/human')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || r.status)
      next = j
    } catch (e) {
      next = { ...(data || {}), error: e?.message || String(e) }
    }
    const sig = JSON.stringify([next.items, next.counts, next.error])
    data = next
    if (sig === last) return
    last = sig
    paintBox()
    paintElsewhere()
    // the open flow's checklist may now know it needs the user (flows.js reads needsHand on its next draw)
    if (window.Shell?.current?.view === 'flows') window.FlowsView?.load()
  }

  /** The Agents page with the box in view and its heading focused, from anywhere (the head's pill, Home, a toast). */
  function show() {
    if (window.Shell?.current?.view !== 'agents' || !box.isConnected) return window.Shell?.go('#/agents?human')
    box.style.scrollMarginTop = `${(doc.getElementById('pageHead')?.offsetHeight || 0) + 16}px`
    box.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
    box.querySelector('.hr-h')?.focus({ preventScroll: true })
  }

  // ONE listener on the box: it stops every click there, so the diagram never reads a click in the box as a click on
  // a node (pipeline-view.js listens on the whole diagram, and an ask button carries data-node).
  box.addEventListener('click', async e => {
    e.stopPropagation()
    const t = e.target
    const ticket = t.closest('[data-hr-ticket]')
    if (ticket) return window.FactoryView?.gotoTicket(ticket.dataset.hrTicket)
    const open = t.closest('[data-hr-open]')
    if (open) {
      const { hrOpen: id, hrKind: kind, hrNode: node } = open.dataset
      return kind === 'hand' ? window.FlowsView?.gotoHand(id) : window.FlowsView?.gotoFlow(id, node || undefined)
    }
    const b = t.closest('[data-answer]')
    if (b) {
      const flowId = b.closest('[data-flow]')?.dataset.flow
      b.disabled = true
      await window.FlowsView?.answer(flowId, b.dataset.node, b.dataset.answer)
      return refresh()
    }
  })
  box.addEventListener('submit', async e => {
    const form = e.target.closest('form[data-text]')
    if (!form) return
    e.preventDefault()
    e.stopPropagation()
    const value = new FormData(form).get('answer').trim()
    if (!value) return
    await window.FlowsView?.answer(form.closest('[data-flow]')?.dataset.flow, form.dataset.text, value)
    refresh()
  })
  doc.addEventListener('click', e => {
    if (e.target.closest?.('[data-hr-show]')) {
      e.preventDefault()
      show()
    }
  })
  // `#/agents?human` (the pill, Home's link): once the diagram has placed the box, bring it into view
  window.Shell?.onRoute(r => {
    if (r.view === 'agents' && r.params?.query && 'human' in r.params.query) window.Shell.whenReady('#agentsView .hr-box', () => setTimeout(show, 50), 4000)
  })

  Object.assign(api, { place, refresh, show, needsHand: id => !!data?.items?.some(i => i.kind === 'hand' && i.flowId === id) })
  Object.defineProperty(api, 'data', { get: () => data })
  doc.addEventListener('DOMContentLoaded', refresh)
  setInterval(refresh, POLL_MS)
})()
