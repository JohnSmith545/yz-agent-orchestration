// The orchestration grid on the Tickets page: agents across (Master, Agent 1,
// 2, 3), levels down (Local, Dev, Stage, Prod), tickets in the cells. Hover a
// ticket for its details and the flows that name it (a flow title opens that
// flow); click it to open its row in the table below. A ticket a subagent built
// shows that subagent's short label on its chip, and its hover names the subagent. Each
// column head says whether that agent is working now, and opens its progress
// report (built from its transcript by /api/report).
(() => {
  const $ = (s, el = document) => el.querySelector(s)
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const LEVEL = { local: 'Local', dev: 'Dev', stage: 'Stage', prod: 'Prod' }
  const LEVEL_HINT = {
    local: 'In a worktree or on followup, not pushed to dev yet',
    dev: 'Merged into origin/dev (deploys to the dev site)',
    stage: 'On origin/stage',
    prod: 'On origin/main, live for real users',
  }
  const REVIEW = { reviewed: 'Code reviewed', 'needs-review': 'Needs review', 'no-code': 'No code yet', 'not-codebase': 'Not from codebase' }
  const VERDICT = { now: 'Deliver now', check: 'After a dev check', docfix: 'After a doc fix', notyet: 'Not yet' }
  // The head is a name and a number (spec 6); what the number counts and the
  // legend live behind the ? popover (help.js).
  const HELP = '<p>The number counts the tickets that have code. Columns are the agents that built them; rows are how far the code got (Local, Dev, Stage, Prod).</p>' +
    '<p>Chip colours: green is reviewed, amber needs review, grey is anything else. A small dot on a chip means more work is still local.</p>' +
    '<p>A name after a number is the subagent that built that ticket, under the session that started it.</p>' +
    '<p>Hover a chip for its details; click it to open its row in the Tickets table. A column head says whether that agent works now.</p>'

  let box = null
  let data = null
  let shownTotal = null // the head count last drawn, so a new total counts up from it
  const tip = document.createElement('div')
  tip.className = 'ox-tip'
  tip.hidden = true
  document.body.appendChild(tip)

  // ─── column head: is the agent working? ───
  function head(c) {
    const a = c.agent
    if (!a) return `<th class="ox-col"><div class="ox-name">${esc(c.label)}</div><div class="ox-state off"><i></i>Not running</div>
      ${c.planned.length ? `<div class="ox-planned">${c.planned.length} planned, not started</div>` : ''}</th>`
    const working = a.state === 'active' || a.state === 'testing'
    // A dot and one word (spec 6), each a <dfn> the explainer opens (explain.js);
    // what a working agent runs (tests, say) is in the hover.
    const label =
      working ? '<dfn data-term="working" tabindex="0">Working</dfn>'
      : a.status === 'waiting' ? '<dfn data-term="waiting" tabindex="0">Waiting</dfn>'
      : '<dfn data-term="idle" tabindex="0">Idle</dfn>'
    const hint = a.state === 'testing' ? 'Working: running tests or checks' : a.status === 'waiting' ? 'Waiting for input' : ''
    const doing = a.lastTool ? `${a.lastTool.tool}: ${a.lastTool.summary || ''}` : ''
    return `<th class="ox-col">
      <div class="ox-name">${esc(c.label)}</div>
      <div class="ox-state ${working ? 'on' : a.status === 'waiting' ? 'wait' : 'idle'}"${hint ? ` title="${hint}"` : ''}><i></i>${label}<span class="faint"> · ${esc(window.Shell.ago(a.at))}</span></div>
      ${doing ? `<div class="ox-doing" title="${esc(doing)}">${esc(doing)}</div>` : ''}
      ${a.talkingWith ? `<div class="ox-doing">${a.talkingWith.direction === 'to' ? 'Messaged' : 'Heard from'} ${esc(a.talkingWith.with)} · ${esc(window.Shell.ago(a.talkingWith.t))}</div>` : ''}
      ${a.subagentsRunning ? `<div class="ox-doing">${a.subagentsRunning} subagent${a.subagentsRunning > 1 ? 's' : ''} running</div>` : ''}
      <div class="ox-links">
        <button type="button" class="link" data-report="${esc(a.sessionId)}" data-label="${esc(c.label)}" title="What it did, from its transcript">Progress report</button>
        <a class="link" href="#/agent/${encodeURIComponent(a.sessionId)}">Live view</a>
      </div>
      ${c.planned.length ? `<div class="ox-planned" title="${esc(c.planned.join(', '))}">${c.planned.length} planned, not started</div>` : ''}
    </th>`
  }

  // ─── cells ───
  /** A chip shows the number alone for the collection's own prefix (data.prefix); any other id stays whole. */
  const chipLabel = (id, prefix) => (prefix && id.startsWith(`${prefix}-`) ? id.slice(prefix.length + 1) : id)

  /** Pure: one ticket's chip. A ticket a subagent built carries that subagent's short label after its number. */
  function chipHtml(t, prefix) {
    const r = t.mark?.review || 'none'
    const subagent = t.subagent ? `<span class="ox-subagent">${esc(t.subagent.label)}</span>` : ''
    return `<button type="button" class="ox-chip rv-${r} ${t.state === 'Accepted' ? 'accepted' : ''} ${t.outside ? 'outside' : ''}" data-tid="${esc(t.id)}">${esc(chipLabel(t.id, prefix))}${subagent}${t.moreLocal ? '<i class="ox-more" title="More work still local"></i>' : ''}</button>`
  }
  const chip = id => chipHtml(data.tickets[id], data.prefix)

  /** Pure: who built a ticket, for the hover: the subagent (a link to watch it, and whose subagent it is), else the agents. */
  function builtBy(t) {
    const h = t.subagent
    if (!h) return esc((t.agents || []).join(', ') || '–')
    const href = `#/agent/${encodeURIComponent(h.sessionId)}/${encodeURIComponent(h.id)}`
    return `<a class="link" href="${esc(href)}">${esc(h.description)}</a> · subagent of ${esc(h.parent || 'an ended session')}`
  }

  function render() {
    if (!box || !data) return
    const cols = data.columns
    const total = Object.values(data.tickets).filter(t => t.level).length
    box.innerHTML = `
      <section class="card ox">
        <div class="card-head">
          <h3>Orchestration <span class="faint">· <span class="num ox-total">${shownTotal ?? total}</span></span></h3>
          <button type="button" class="help" aria-label="What the grid shows">?</button>
        </div>
        <div class="tablewrap">
          <table class="ox-grid">
            <thead><tr><th class="ox-corner"></th>${cols.map(head).join('')}</tr></thead>
            <tbody>
              ${['local', 'dev', 'stage', 'prod'].map(l => `<tr>
                <th class="ox-level" title="${esc(LEVEL_HINT[l])}"><dfn data-term="${l}" tabindex="0">${LEVEL[l]}</dfn><span>${cols.reduce((n, c) => n + data.cells[c.label][l].length, 0)}</span></th>
                ${cols.map(c => `<td class="ox-cell lv-${l}">${data.cells[c.label][l].map(chip).join('') || '<span class="ox-empty">—</span>'}</td>`).join('')}
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>`
    box.querySelectorAll('[data-report]').forEach(b => b.addEventListener('click', () => report(b.dataset.report, b.dataset.label)))
    window.Help.attach($('.ox .help', box), HELP)
    window.Motion.countUp($('.ox-total', box), total)
    shownTotal = total
  }

  // ─── hover details ───
  function details(id) {
    const t = data.tickets[id]
    if (!t) return ''
    const lv = l => {
      const v = t.levels[l]
      if (!v) return `<li class="no"><b>${LEVEL[l]}</b> not yet</li>`
      if (Array.isArray(v)) return `<li class="yes"><b>${LEVEL[l]}</b> ${v.map(w => `${esc(w.worktree)}: ${esc(w.subject)}`).join('<br>')}</li>`
      return `<li class="yes"><b>${LEVEL[l]}</b> <code>${esc(v.sha)}</code> ${esc(v.date)} · ${esc(v.subject)}</li>`
    }
    const m = t.mark
    return `<div class="ox-tip-head"><span class="id">${esc(t.id)}</span>${t.state ? `<span class="fx-pill st-${esc(String(t.state).toLowerCase())}">${esc(t.state)}</span>` : ''}</div>
      <div class="ox-tip-title">${esc(t.title)}</div>
      <div class="ox-tip-row"><span>Built by</span><div>${builtBy(t)}</div></div>
      ${m ? `<div class="ox-tip-row"><span>Review</span><div>${esc(REVIEW[m.review] || m.review)}${m.verdict ? ` · <b>${esc(VERDICT[m.verdict])}</b>` : ''}</div></div>` : ''}
      ${m?.note ? `<p class="ox-tip-note">${esc(m.note)}</p>` : ''}
      ${t.plan ? `<div class="ox-tip-row"><span>Plan</span><div>${esc(t.plan.verdict)} · wave ${esc(t.plan.wave || '—')} · launch ${esc(t.plan.must || '—')}</div></div>` : ''}
      <ul class="ox-tip-levels">${['local', 'dev', 'stage', 'prod'].map(lv).join('')}</ul>
      ${t.flows?.length ? `<div class="ox-tip-row ox-tip-flows"><span>in flows:</span><div>${t.flows.map(flowLine).join('<br>')}</div></div>` : ''}
      <div class="ox-tip-foot">Click to open it in the table</div>`
  }
  /** One open flow naming the ticket: its title opens it (flows.js), then the node it is on. */
  function flowLine(f) {
    return `<button type="button" class="link" data-flow="${esc(f.id)}">${esc(f.title)}</button>` +
      `${f.current ? ` · next: ${esc(f.current)}` : ''}${f.waiting ? ' · <b>waiting</b>' : ''}`
  }
  /**
   * Where the card goes, in viewport px, for chip rect `r`, card `w`×`h` and
   * viewport `vw`×`vh`: below, else above, else beside (right, then left),
   * else below anyway. ⚠️ NEVER over the chip: the card takes the pointer
   * (its flow links), so a card on top of the chip makes the chip unclickable.
   */
  function tipSpot(r, w, h, vw, vh) {
    const M = 8
    const x = Math.max(M, Math.min(r.left + r.width / 2 - w / 2, vw - w - M))
    if (r.bottom + M + h <= vh - M) return { x, y: r.bottom + M }
    if (r.top - h - M >= M) return { x, y: r.top - h - M }
    const y = Math.max(M, Math.min(r.top + r.height / 2 - h / 2, vh - h - M))
    if (r.right + M + w <= vw - M) return { x: r.right + M, y }
    if (r.left - w - M >= M) return { x: r.left - w - M, y }
    return { x, y: r.bottom + M }
  }
  function place(el) {
    const r = el.getBoundingClientRect()
    tip.hidden = false
    const { x, y } = tipSpot(r, tip.offsetWidth, tip.offsetHeight, innerWidth, innerHeight)
    tip.style.left = `${x + scrollX}px`
    tip.style.top = `${y + scrollY}px`
  }
  // The card holds links (its flows), so leaving a chip hides it only after a
  // moment, and moving onto the card keeps it open.
  let hideTimer = 0
  const hideSoon = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => (tip.hidden = true), 250) }
  tip.addEventListener('mouseenter', () => clearTimeout(hideTimer))
  tip.addEventListener('mouseleave', hideSoon)
  document.addEventListener('mouseover', e => {
    const el = e.target.closest?.('[data-tid]')
    if (!el || !data) return
    clearTimeout(hideTimer)
    tip.innerHTML = details(el.dataset.tid)
    place(el)
  })
  document.addEventListener('mouseout', e => {
    if (e.target.closest?.('[data-tid]') && !e.relatedTarget?.closest?.('[data-tid]') && !tip.contains(e.relatedTarget)) hideSoon()
  })
  document.addEventListener('focusin', e => {
    const el = e.target.closest?.('[data-tid]')
    if (el && data) { clearTimeout(hideTimer); tip.innerHTML = details(el.dataset.tid); place(el) }
  })
  document.addEventListener('focusout', e => { if (!tip.contains(e.relatedTarget)) tip.hidden = true })
  tip.addEventListener('click', e => {
    const f = e.target.closest('[data-flow]')
    if (!f) return
    tip.hidden = true
    window.FlowsView?.gotoFlow(f.dataset.flow)
  })
  document.addEventListener('click', e => {
    const el = e.target.closest?.('.ox-chip[data-tid]')
    if (!el) return
    tip.hidden = true
    window.FactoryView?.gotoTicket(el.dataset.tid)
  })

  // ─── progress report modal ───
  const modal = document.createElement('div')
  modal.className = 'ox-modal'
  modal.hidden = true
  modal.innerHTML = `<div class="ox-modal-box card" role="dialog" aria-modal="true" aria-labelledby="oxRepTitle">
      <div class="card-head"><h3 id="oxRepTitle">Progress report</h3>
        <div class="fx-row-actions"><select id="oxHours" aria-label="Period"><option value="1">Last hour</option><option value="4" selected>Last 4 hours</option><option value="24">Last day</option></select>
        <button type="button" class="link" id="oxClose">Close</button></div></div>
      <div class="ox-modal-body fc-msg ai" id="oxRep"></div>
    </div>`
  document.body.appendChild(modal)
  let rep = null
  async function report(sessionId, label, hours = 4) {
    rep = { sessionId, label }
    modal.hidden = false
    $('#oxRepTitle', modal).textContent = `${label}: progress report`
    $('#oxRep', modal).innerHTML = '<p class="faint">Reading the session…</p>'
    try {
      const r = await fetch(`/api/report?session=${encodeURIComponent(sessionId)}&hours=${hours}`)
      const md = await r.text()
      $('#oxRep', modal).innerHTML = r.ok ? window.FactoryChat.md(md) : `<p class="warn">${esc(md)}</p>`
    } catch (e) {
      $('#oxRep', modal).innerHTML = `<p class="warn">${esc(e.message)}</p>`
    }
  }
  $('#oxClose', modal).addEventListener('click', () => (modal.hidden = true))
  $('#oxHours', modal).addEventListener('change', e => rep && report(rep.sessionId, rep.label, e.target.value))
  modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true })
  // Only while it shows, and it takes the key: the shell then leaves the chat drawer open.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || modal.hidden) return
    e.preventDefault()
    modal.hidden = true
  })

  window.OrchestrationGrid = {
    mount(el) { box = el; render() },
    unmount() { box = null; tip.hidden = true },
    async load(collection, force) {
      try {
        const r = await fetch(`/api/orchestration?c=${encodeURIComponent(collection || '')}${force ? '&refresh=1' : ''}`)
        if (!r.ok) throw new Error(await r.text())
        data = await r.json()
        render()
      } catch (e) {
        if (box) box.innerHTML = `<div class="banner">Orchestration grid: ${esc(e.message.slice(0, 200))}</div>`
      }
      return data
    },
    get data() { return data },
    /** Opens the progress report modal for one session (the Agents page uses it too). */
    report: (sessionId, label) => report(sessionId, label),
    LEVEL,
    tipSpot,
    chipLabel,
    chipHtml,
    builtBy,
  }
})()
