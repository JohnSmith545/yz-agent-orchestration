// Human review: everything that cannot go on without the user, as ONE box on the Agents diagram, and the count that
// says so everywhere else. All of it reads GET /api/human (human.mjs), polled every 15 s on every page:
//
//   the box     drawn INSIDE the diagram's canvas (pipeline-view.js hands it each layout: place), under the boxes
//               and their arrows, its left and right edges on the outermost boxes' edges (on a phone, top to bottom,
//               the whole width), so it lines up with them and never covers a box, an arrow or a label; it is not a
//               step of any route (pipeline.mjs is untouched)
//   the rail    a count on the Agents entry, and the page head's "N waiting on you": both count what keeps an agent
//               waiting (sessions stopped for you, questions and by-hand work), never the tickets, so the two always agree
//   a session   a Claude Code session stopped for your permission or reply (waiting.mjs) is a row that opens that
//               session, and a NEW one raises a sticky toast and a desktop notification once
//   Home        one line: what needs you now, the tickets apart, and a link to the box (#homeHuman)
//
//   ┌──────────────────────────────────────────────────────────────────────────────┐
//   │ ● Human review   13 questions · 2 by hand · 60 tickets                        │
//   │ [All 75] [Questions 13] [By hand 2] [Blocked 0] [Tickets 60]                  │   filter chips, remembered
//   │ Add a dark mode toggle                              Question · Agent 3 · 3h   │
//   │ Deploy the fix to dev?                                          [Yes] [No]    │
//   │ Why? The test passes; dev is where QA can try it                              │
//   │ Cloud Hosting: Billing account linked                     Ticket FLA-820 · 2w │
//   │ Marked not codebase work: a person, console or process task.                  │
//   │ No one has written the steps yet.                            [Ask for steps]  │
//   └──────────────────────────────────────────────────────────────────────────────┘   (rows scroll inside it)
//
// A question is answered right here, with the same controls as everywhere (FlowBoard.askControls) on the same
// route (FlowsView.answer, POST /api/flows/<id>/answer). A row's title opens its flow at the right place, with an
// address of its own: the question (`#/flows?flow=<id>&node=<node>`), the by-hand steps (`&at=hand`), the flow,
// or the ticket on the Tickets page. A ticket with no flow has ONE next step, Ask for steps: it starts a flow for
// the ticket with the right agent and asks for by-hand steps on the same relay path as everywhere
// (POST /api/tickets/<id>/request-hand, human-routes.mjs). `#/agents?human` scrolls the box into view.
//
//   FILTERS, filterOf(stored, counts)   PURE: the chips, and the one in effect (Questions while there are any)
//   rowHtml(item) / html(data, filter) / splitText(counts) / homeHtml(data) / spot(lay) / waiting(counts)   PURE
//   place(canvas, lay) / refresh() / show() / needsHand(flowId) / data
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const enc = encodeURIComponent
  const POLL_MS = 15_000
  const GAP = 6 // between the diagram's layout (its own padding included) and the box
  const BOTTOM = 10 // under the box, inside the canvas
  const FILTER_KEY = 'human.filter'
  const KIND = { session: 'Session', ask: 'Question', hand: 'By hand', blocked: 'Blocked', ticket: 'Ticket' }
  /** The chips, in order: [key, label]. MUST CHANGE IN LOCKSTEP with human.mjs counts. */
  const FILTERS = [['all', 'All'], ['session', 'Sessions'], ['ask', 'Questions'], ['hand', 'By hand'], ['blocked', 'Blocked'], ['ticket', 'Tickets']]
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

  // ═══ pure ═══

  /**
   * Where the box goes in the canvas: under everything the layout drew. Left to right, from the leftmost box's left
   * edge to the rightmost box's right edge; top to bottom (a phone), the whole width, so it is never squeezed.
   */
  function spot(lay) {
    const nodes = lay?.nodes || []
    if (!nodes.length) return { x: 12, y: GAP, w: Math.max(240, (lay?.width || 300) - 24) }
    const y = Math.ceil(lay.height) + GAP
    if (lay.dir === 'TB') return { x: 0, y, w: Math.max(0, Math.floor(lay.width)) }
    const left = Math.min(...nodes.map(n => n.x))
    const right = Math.max(...nodes.map(n => n.x + n.w))
    return { x: left, y, w: Math.max(0, right - left) }
  }

  /** What keeps an agent waiting on the user: stopped sessions, questions and by-hand work (the rail and the page head show this). */
  const waiting = c => (Number(c?.session) || 0) + (Number(c?.ask) || 0) + (Number(c?.hand) || 0)

  /** The chip in effect: the stored one when it is a chip, else Questions while there are any, else All. */
  const filterOf = (stored, counts) => (FILTERS.some(([k]) => k === stored) ? stored : Number(counts?.ask) > 0 && !Number(counts?.session) ? 'ask' : 'all')

  /** `13 questions · 2 by hand · 60 tickets`: the split, never one mixed number; '' when nothing waits. */
  function splitText(c) {
    return [[c?.session, 'session waiting', 'sessions waiting'], [c?.ask, 'question', 'questions'], [c?.hand, 'by hand', 'by hand'], [c?.blocked, 'blocked', 'blocked'], [c?.ticket, 'ticket', 'tickets']]
      .filter(([v]) => Number(v) > 0).map(([v, one, many]) => plural(Number(v), one, many)).join(' · ')
  }

  /** The kind word, with the progress of by-hand work and the ticket id of a marked ticket. */
  function kindWord(i) {
    if (i.kind === 'hand' && i.progress?.total) return `${KIND.hand} · ${i.progress.done} of ${i.progress.total}`
    if (i.kind === 'ticket') return `${KIND.ticket} ${i.ticketId}`
    if (i.kind === 'session') return i.wait === 'question' ? 'Needs your reply' : 'Needs your OK'
    return KIND[i.kind] || ''
  }

  function rowHtml(i) {
    const waited = window.Shell?.ago(i.since) || ''
    const meta = [`<span class="hr-kind k-${esc(i.kind)}">${esc(kindWord(i))}</span>`, i.agent ? esc(i.agent) : '', waited ? `waiting ${esc(waited)}` : ''].filter(Boolean)
    const open = i.kind === 'session' ? `data-hr-agent="${esc(i.sessionId)}"` : i.kind === 'ticket' ? `data-hr-ticket="${esc(i.ticketId)}"` : `data-hr-open="${esc(i.flowId)}" data-hr-kind="${esc(i.kind)}"${i.nodeId ? ` data-hr-node="${esc(i.nodeId)}"` : ''}`
    const label = i.kind === 'session' ? 'Open the session to answer it' : i.kind === 'ask' ? 'Open the question in its flow' : i.kind === 'hand' ? 'Open the steps in its flow' : i.kind === 'ticket' ? 'Open the ticket' : 'Open the flow'
    const ask = i.kind === 'ask' && i.ask
      ? `<div class="hr-ask" data-flow="${esc(i.flowId)}"><p class="hr-q">${esc(i.ask.title)}</p><div class="hr-acts">${window.FlowBoard.askControls({ id: i.flowId }, { id: i.nodeId, kind: i.ask.kind, yes: i.ask.yes, no: i.ask.no, answer: null }, 'hr')}</div></div>`
      : ''
    // a ticket with no flow: its one honest next step is to ask the right agent for the steps (human-routes.mjs)
    const steps = i.kind === 'ticket'
      ? `<div class="hr-next"><span class="hr-next-t">No one has written the steps yet.</span><button type="button" class="hr-steps" data-hr-steps="${esc(i.ticketId)}">Ask for steps</button></div>`
      : ''
    return `<li class="hr-row k-${esc(i.kind)}"><div class="hr-top"><button type="button" class="link hr-title" ${open} title="${label}">${esc(i.title)}</button>` +
      `<span class="hr-meta">${meta.join('<span aria-hidden="true">·</span>')}</span></div>` +
      (ask ? `${ask}<p class="hr-why"><span class="hr-why-k">Why?</span> ${esc(i.reason)}</p>` : `<p class="hr-why">${esc(i.reason)}</p>`) + steps + replyHtml(i) + '</li>'
  }

  /**
   * Pure: what a waiting session's row offers. A question: a reply box (Send), and how the last reply went (Sending,
   * Sent, or Not delivered with Retry). A permission prompt: only VS Code can press Approve or Deny, so it says so.
   */
  function replyHtml(i) {
    if (i?.kind !== 'session') return ''
    if (i.wait !== 'question') return '<p class="hr-reply-note">Approve or deny it in VS Code: a message cannot press the button.</p>'
    const id = esc(i.sessionId)
    const r = i.reply
    const sending = r?.status === 'sending'
    const state = !r ? ''
      : sending ? '<p class="hr-reply-state">Sending your reply…</p>'
      : r.status === 'sent' ? `<p class="hr-reply-state is-sent">Sent ${esc(window.Shell?.ago(r.sentAt) || '')}. This clears once the session picks it up.</p>`
      : `<p class="hr-reply-state is-failed">Not delivered: ${esc(r.error || 'the message did not go out')}. <button type="button" class="link" data-hr-retry="${id}">Retry</button></p>`
    return `<form class="hr-reply" data-hr-reply="${id}"><textarea name="reply" rows="2" maxlength="2000" data-key="reply:${id}" aria-label="Your reply to ${esc(i.title)}" placeholder="Your reply. Enter sends, Shift+Enter adds a line."${sending ? ' disabled' : ''}></textarea>` +
      `<button type="submit" class="primary"${sending ? ' disabled' : ''}>Send</button></form>${state}`
  }

  const EMPTY = { session: 'No session is waiting on you.', ask: 'No questions wait on you.', hand: 'No work waits for you to do by hand.', blocked: 'No flow is blocked.', ticket: 'No ticket waits on you.' }

  function chipsHtml(counts, filter) {
    const n = k => (k === 'all' ? Number(counts?.total) || 0 : Number(counts?.[k]) || 0)
    return `<div class="lg-chips hr-chips" role="group" aria-label="Show in Human review">${FILTERS.map(([k, label]) =>
      `<button type="button" data-hr-chip="${k}" aria-pressed="${k === filter}">${label} <span class="hr-chip-n">${n(k)}</span></button>`).join('')}</div>`
  }

  function html(data, filter = filterOf(null, data?.counts)) {
    const items = Array.isArray(data?.items) ? data.items : []
    const split = splitText(data?.counts)
    const head = `<div class="hr-head"><h3 class="hr-h" id="hrHead" tabindex="-1"><i class="hr-dot" aria-hidden="true"></i>Human review</h3>` +
      (split ? `<span class="hr-split">${esc(split)}</span>` : '') + '</div>'
    if (data?.error) return `${head}<p class="hr-empty warn">Could not load what waits on you: ${esc(data.error)}</p>`
    if (!data) return `${head}<p class="hr-empty">Loading…</p>`
    if (!items.length) return `${head}<p class="hr-empty">Nothing waits on you. The agents can go on by themselves.</p>`
    const shown = filter === 'all' ? items : items.filter(i => i.kind === filter)
    const list = shown.length
      ? `<ol class="hr-rows" tabindex="0" aria-label="What waits on you, newest first">${shown.map(rowHtml).join('')}</ol>`
      : `<p class="hr-empty">${EMPTY[filter] || ''}</p>`
    return `${head}<div class="hr-chips-box">${chipsHtml(data.counts, filter)}</div>${list}`
  }

  /** Home's one line: what keeps an agent waiting on you now, the tickets only you can do apart, and the link to the box. */
  function homeHtml(data) {
    const c = data?.counts
    if (!c) return ''
    if (!c.total) return '<p class="hr-home"><i class="hr-dot is-calm" aria-hidden="true"></i>Nothing needs you right now.</p>'
    const now = waiting(c) + (Number(c.blocked) || 0)
    const parts = [[c.session, 'session waiting', 'sessions waiting'], [c.ask, 'question'], [c.hand, 'by-hand task'], [c.blocked, 'blocked flow']].filter(([v]) => v > 0).map(([v, one, many]) => plural(v, one, many))
    const lead = now ? `<b>${plural(now, 'thing needs', 'things need')} you now</b><span class="hr-home-parts">${esc(parts.join(', '))}</span>` : '<b>Nothing blocks an agent</b>'
    const tickets = c.ticket ? `<span class="hr-home-parts">${esc(plural(c.ticket, 'ticket', 'tickets'))} only you can do</span>` : ''
    return `<p class="hr-home"><i class="hr-dot${now ? '' : ' is-calm'}" aria-hidden="true"></i>${lead}${tickets}<a class="link" href="#/agents?human" data-hr-show>Open Human review</a></p>`
  }

  /** The session rows in `next` that were not in `prev`: each is a new wait to raise once. */
  const newWaits = (prev, next) => {
    const seen = new Set((prev || []).filter(i => i.kind === 'session').map(i => `${i.key}@${i.since}`))
    return (next || []).filter(i => i.kind === 'session' && !seen.has(`${i.key}@${i.since}`))
  }

  const api = { FILTERS, filterOf, newWaits, replyHtml, sendReply() {}, splitText, waiting, spot, rowHtml, html, homeHtml, data: null, place() {}, refresh() {}, show() {}, needsHand: () => false }
  window.HumanReview = api
  if (!window.document) return

  // ═══ the page ═══

  const doc = window.document
  let data = null
  let last = '' // the JSON of the last answer, so an unchanged poll redraws nothing
  let canvas = null
  let lay = null
  const store = {
    get: () => { try { return window.localStorage.getItem(FILTER_KEY) } catch { return null } },
    set: v => { try { window.localStorage.setItem(FILTER_KEY, v) } catch {} },
  }
  const box = doc.createElement('section')
  box.className = 'hr-box'
  box.setAttribute('aria-labelledby', 'hrHead')

  /** Keep what was typed in an answer field (and the focus) across a redraw. */
  function paintBox() {
    const vals = new Map([...box.querySelectorAll('input[data-key], textarea[data-key]')].map(i => [i.dataset.key, i.value]))
    const a = doc.activeElement
    const keep = a && box.contains(a) ? ['data-key', 'data-hr-open', 'data-hr-agent', 'data-hr-chip', 'data-hr-steps'].find(k => a.hasAttribute(k)) : null
    const focus = keep ? `[${keep}="${CSS.escape(a.getAttribute(keep))}"]` : null
    const scroll = box.querySelector('.hr-rows')?.scrollTop || 0
    box.innerHTML = html(data, filterOf(store.get(), data?.counts))
    for (const i of box.querySelectorAll('input[data-key], textarea[data-key]')) if (vals.has(i.dataset.key)) i.value = vals.get(i.dataset.key)
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
    const n = waiting(data?.counts)
    const icon = doc.querySelector('#rail a.rail-item[data-view="agents"] .rail-icon')
    if (icon) {
      let b = icon.querySelector('.hr-rail-count')
      if (!b) icon.insertAdjacentHTML('beforeend', '<span class="hr-rail-count" hidden></span>'), (b = icon.querySelector('.hr-rail-count'))
      b.hidden = !n
      b.textContent = n > 99 ? '99+' : String(n)
      icon.parentElement.title = n ? `Agents · ${plural(n, 'thing')} waiting on you in Human review` : 'Agents'
    }
    // the page head's pill: the same number, so it always agrees with the rail (shell.js draws it)
    if (data?.counts) window.Shell?.setWaiting(n)
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
    if (data?.items && next.items) for (const w of newWaits(data.items, next.items)) raiseWait(w) // not on the first load: the pill says it
    data = next
    if (sig === last) return
    last = sig
    paintBox()
    paintElsewhere()
    doc.dispatchEvent(new CustomEvent('humanreview:change')) // the diagram's Human task box shows the counts too (pipeline-view.js)
    // the open flow's checklist may now know it needs the user (flows.js reads needsHand on its next draw)
    if (window.Shell?.current?.view === 'flows') window.FlowsView?.load()
  }

  /** A toast and a desktop notification for a session that just stopped for the user. */
  function raiseWait(w) {
    const open = () => window.Shell?.go(`#/agent/${enc(w.sessionId)}`)
    window.Notifier?.toast(`<b>${esc(w.title)}</b> is waiting on you<br>${esc(w.reason)}`, { kind: 'decision', sticky: true })
    window.Notifier?.desktop(`${w.title} is waiting on you`, w.reason, open)
  }

  /** The Agents page with the box in view and its heading focused, from anywhere (the head's pill, Home, a toast). */
  function show() {
    if (window.Shell?.current?.view !== 'agents' || !box.isConnected) return window.Shell?.go('#/agents?human')
    box.style.scrollMarginTop = `${(doc.getElementById('pageHead')?.offsetHeight || 0) + 16}px`
    box.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
    box.querySelector('.hr-h')?.focus({ preventScroll: true })
  }

  /** Send a reply (or Retry the last one) to a waiting session; the page shows how it went on the next refresh. */
  async function sendReply(sessionId, text, { retry = false } = {}) {
    try {
      const r = await fetch(`/api/sessions/${enc(sessionId)}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(retry ? { retry: true } : { text }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || 'Could not send the reply. Try again.')
      return true
    } catch (e) {
      // the server's message is written for the user; a network failure gets a plain next step
      const msg = e instanceof TypeError ? 'Could not reach the dashboard. Check it is running, then try again.' : e.message
      window.Notifier?.toast(esc(msg), { kind: 'info', keep: false })
      return false
    } finally {
      refresh()
    }
  }

  /** A reply form submitted, or Retry clicked, anywhere (the box or the session page): true when it was one. */
  function onReply(e) {
    const retry = e.target.closest?.('[data-hr-retry]')
    if (e.type === 'click' && retry) {
      retry.disabled = true
      sendReply(retry.dataset.hrRetry, '', { retry: true })
      return true
    }
    const form = e.type === 'submit' && e.target.closest?.('form[data-hr-reply]')
    if (!form) return false
    e.preventDefault()
    const area = form.querySelector('textarea')
    const text = area.value.trim()
    if (!text) return area.focus(), true
    form.querySelectorAll('textarea, button').forEach(x => (x.disabled = true))
    sendReply(form.dataset.hrReply, text).then(ok => {
      if (ok) area.value = ''
    })
    return true
  }
  doc.addEventListener('submit', onReply)
  doc.addEventListener('click', onReply)
  // Enter sends, Shift+Enter adds a line
  doc.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || !e.target.closest?.('form[data-hr-reply] textarea')) return
    e.preventDefault()
    e.target.closest('form').requestSubmit()
  })

  /** Ask for steps on a ticket with no flow: the server starts its flow and relays the request (human-routes.mjs). */
  async function askSteps(btn) {
    btn.disabled = true
    btn.textContent = 'Asking…'
    try {
      const r = await fetch(`/api/tickets/${enc(btn.dataset.hrSteps)}/request-hand`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
      if (j.via === 'chat') window.FactoryChat?.prefill(j.text)
      window.Notifier?.toast(j.via === 'chat' ? 'The request is in the Ask drawer: send it there.' : 'Asked for steps. They will show in Human review, under By hand.', { kind: 'info', keep: false })
    } catch (e) {
      window.alert?.(e.message)
      btn.disabled = false
      btn.textContent = 'Ask for steps'
    }
    refresh()
  }

  // ONE listener on the box: it stops every click there, so the diagram never reads a click in the box as a click on
  // a node (pipeline-view.js listens on the whole diagram, and an ask button carries data-node).
  box.addEventListener('click', async e => {
    e.stopPropagation()
    if (onReply(e)) return
    const t = e.target
    const chip = t.closest('[data-hr-chip]')
    if (chip) {
      store.set(chip.dataset.hrChip)
      box.querySelector('.hr-rows')?.scrollTo?.(0, 0)
      return paintBox()
    }
    const steps = t.closest('[data-hr-steps]')
    if (steps) return askSteps(steps)
    const agent = t.closest('[data-hr-agent]')
    if (agent) return window.Shell?.go(`#/agent/${enc(agent.dataset.hrAgent)}`)
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

  Object.assign(api, { place, refresh, show, sendReply, needsHand: id => !!data?.items?.some(i => i.kind === 'hand' && i.flowId === id) })
  Object.defineProperty(api, 'data', { get: () => data })
  doc.addEventListener('DOMContentLoaded', refresh)
  setInterval(refresh, POLL_MS)
})()
