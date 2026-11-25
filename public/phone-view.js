// The phone page's markup (public/phone.html), PURE: each function takes plain data and returns an HTML string, so
// the tests run it in a vm. Every value goes through esc. No inline style or handler anywhere (the phone listener's
// Content-Security-Policy allows neither): phone-app.js binds the clicks by data- attributes.
//
//   signIn({ status, busy })            the PIN pad
//   nav(tab, summary, label)            the bottom bar: Now, Needs you, Outputs, the coordinator; thumb reach
//   now(summary, nowMs)                 N things need you, the counts, each agent in one line, finished today
//   needs(summary, ui)                  each question (Yes / No, or a text box) and each by-hand flow with its ticks
//   outputs(summary, ui)                each output waiting for sign-off, its story lines, Completed with an inline confirm
//   talk(thread, ui)                    the thread with the coordinator, what happens to a message, the box
// `ui` is { status: { key: text }, busy: { key: true }, confirm: flowId | null }.
;(() => {
  const S = window.PhoneState
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const attr = (k, v) => ` ${k}="${esc(v)}"`
  const status = (ui, key) => {
    const t = ui?.status?.[key]
    return `<p class="ph-status" role="status"${attr('data-status', key)}>${t ? esc(t) : ''}</p>`
  }
  /** A reply's text with its Markdown bold and code shown as such, AFTER escaping: nothing else becomes markup. */
  const marks = s => esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>')
  const busy = (ui, key) => (ui?.busy?.[key] ? ' disabled' : '')

  const ICON = '<svg class="ph-logo" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><rect x="6" y="6" width="36" height="36" rx="9"/><path d="M16 25.5l5.5 5.5L32 19"/></svg>'

  function signIn(v = {}) {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
      .map(k => `<button type="button" class="ph-key"${attr('data-ph-key', k)}>${k}</button>`).join('') +
      '<button type="button" class="ph-key ph-key-word" data-ph-key="clear">Clear</button>' +
      '<button type="button" class="ph-key" data-ph-key="0">0</button>' +
      '<button type="button" class="ph-key ph-key-word" data-ph-key="back" aria-label="Delete the last digit">Delete</button>'
    return '<main class="ph-sign">' + ICON +
      '<h1 class="ph-title">Sign in</h1><p class="ph-muted">Type your phone PIN.</p>' +
      '<form class="ph-pinform" data-ph-login novalidate>' +
      '<label class="ph-sr" for="phPin">Phone PIN</label>' +
      '<input id="phPin" class="ph-pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12" data-ph-pin>' +
      `<div class="ph-pad" role="group" aria-label="Number pad">${keys}</div>` +
      `<button type="submit" class="primary ph-wide"${v.busy ? ' disabled' : ''}>${v.busy ? 'Signing in…' : 'Sign in'}</button>` +
      `<p class="ph-status" role="status">${esc(v.status || '')}</p>` +
      '</form></main>'
  }

  function nav(tab, summary, label) {
    const n = summary?.needs || {}
    const item = (key, text, count) =>
      `<button type="button" class="ph-tab"${attr('data-ph-tab', key)}${tab === key ? ' aria-current="page"' : ''}>` +
      `<span class="ph-tab-label">${esc(text)}</span>${count ? `<span class="ph-badge" aria-label="${esc(`${count} waiting`)}">${count}</span>` : ''}</button>`
    return '<nav class="ph-nav" aria-label="Sections">' +
      item('now', 'Now', 0) + item('needs', 'Needs you', (n.asks || 0) + (n.hands || 0)) + item('outputs', 'Outputs', n.outputs || 0) + item('talk', label || 'Master', 0) +
      '</nav>'
  }

  function now(sum, nowMs = Date.now()) {
    if (!sum) return '<p class="ph-muted ph-pad-top">Loading…</p>'
    const counts = S.countParts(sum.needs).map(p =>
      `<button type="button" class="ph-count"${attr('data-ph-tab', p.tab)}><span class="ph-count-n">${p.n}</span><span class="ph-count-l">${esc(p.label)}</span></button>`).join('')
    const agents = sum.agents === null
      ? '<p class="ph-muted">Your PC is still gathering what the agents are doing. It shows here in a moment.</p>'
      : (sum.agents || []).length
      ? `<ul class="ph-agents">${sum.agents.map(a =>
        `<li class="ph-agent"><span class="ph-dot${a.busy ? ' is-busy' : ''}" aria-hidden="true"></span><span class="ph-agent-name">${esc(a.label)}</span>` +
        `<span class="ph-agent-state">${esc(S.agentWord(a))}</span>` +
        `<span class="ph-agent-flow">${a.flow ? esc(a.flow) : '<span class="ph-faint">no open flow</span>'}</span></li>`).join('')}</ul>`
      : '<p class="ph-muted">No agents are running on your PC now.</p>'
    return '<section class="ph-sec" aria-labelledby="phNowH">' +
      `<h1 id="phNowH" class="ph-big">${esc(S.needsLine(sum.needs?.total))}</h1>` +
      `<div class="ph-counts">${counts}</div>` +
      `<h2 class="ph-h">Agents</h2>${agents}` +
      `<p class="ph-line">Finished today: <b>${Number(sum.finishedToday) || 0}</b></p>` +
      `<p class="ph-faint">Updated ${esc(S.when(sum.builtAt, nowMs))}</p>` +
      '</section>'
  }

  function askCard(a, ui) {
    const key = `ask:${a.flowId}:${a.nodeId}`
    const ids = `${attr('data-flow', a.flowId)}${attr('data-node', a.nodeId)}`
    const means = [a.yes ? `Yes: ${a.yes}` : '', a.no ? `No: ${a.no}` : ''].filter(Boolean).join(' · ')
    const answer = a.kind === 'text'
      ? `<label class="ph-k"${attr('for', `phA-${a.flowId}-${a.nodeId}`)}>Your answer</label>` +
        `<textarea class="ph-input" rows="3" maxlength="2000"${attr('id', `phA-${a.flowId}-${a.nodeId}`)}${attr('data-draft', key)}></textarea>` +
        `<div class="ph-actions"><button type="button" class="primary" data-ph-answer-text${ids}${busy(ui, key)}>Send answer</button></div>`
      : `<div class="ph-actions"><button type="button" class="primary" data-ph-answer="yes"${ids}${busy(ui, key)}>Yes</button>` +
        `<button type="button" data-ph-answer="no"${ids}${busy(ui, key)}>No</button></div>` +
        (means ? `<p class="ph-faint">${esc(means)}</p>` : '')
    return `<article class="ph-card"${attr('data-key', key)}>` +
      `<p class="ph-kicker">Question · ${esc(a.agent || 'an agent')} · ${esc(a.flowTitle)}</p>` +
      `<h3 class="ph-q">${esc(a.question)}</h3>` +
      (a.why ? `<p class="ph-why">${esc(a.why)}</p>` : '') + answer + status(ui, key) + '</article>'
  }

  function handCard(h, ui) {
    const key = `hand:${h.flowId}`
    const steps = (h.steps || []).length
      ? `<ol class="ph-steps">${h.steps.map(s =>
        `<li><label class="ph-step"><input type="checkbox" data-ph-tick${attr('data-flow', h.flowId)}${attr('data-step', s.id)}${s.done ? ' checked' : ''}${busy(ui, key)}>` +
        `<span class="ph-step-text"><span class="ph-do">${esc(s.do)}</span>` +
        (s.where ? `<span class="ph-sub">Where: ${esc(s.where)}</span>` : '') +
        (s.expect ? `<span class="ph-sub">You should see: ${esc(s.expect)}</span>` : '') +
        (s.copy ? `<code class="ph-copy">${esc(s.copy)}</code>` : '') +
        '</span></label></li>').join('')}</ol>`
      : '<p class="ph-faint">No steps yet. Asking the agent for them is done at the PC.</p>'
    return `<article class="ph-card"${attr('data-key', key)}>` +
      `<p class="ph-kicker">By hand · ${esc(h.agent || 'an agent')}</p><h3 class="ph-q">${esc(h.title)}</h3>` +
      (h.reason ? `<p class="ph-why">${esc(h.reason)}</p>` : '') + steps + status(ui, key) + '</article>'
  }

  function needs(sum, ui = {}) {
    if (!sum) return '<p class="ph-muted ph-pad-top">Loading…</p>'
    const asks = sum.asks || []
    const hands = sum.hands || []
    if (!asks.length && !hands.length) return '<section class="ph-sec"><h1 class="ph-big">Nothing waits on you</h1><p class="ph-muted">Questions and by-hand steps show here.</p></section>'
    return '<section class="ph-sec" aria-label="Needs you">' +
      (asks.length && sum.costNote ? `<p class="ph-note">${esc(sum.costNote)}</p>` : '') +
      asks.map(a => askCard(a, ui)).join('') + hands.map(h => handCard(h, ui)).join('') + '</section>'
  }

  function outputs(sum, ui = {}, nowMs = Date.now()) {
    if (!sum) return '<p class="ph-muted ph-pad-top">Loading…</p>'
    const list = sum.outputs || []
    if (!list.length) return '<section class="ph-sec"><h1 class="ph-big">No outputs to sign off</h1><p class="ph-muted">Finished work waits here for your Completed.</p></section>'
    return '<section class="ph-sec" aria-label="Outputs">' + list.map(o => {
      const key = `out:${o.flowId}`
      const ids = attr('data-flow', o.flowId)
      const story = (o.story || []).length
        ? `<ul class="ph-story">${o.story.map(l => `<li><b>${esc(l.who)}</b> ${esc(l.did)}${l.why ? ` <span class="ph-faint">${esc(l.why)}</span>` : ''}</li>`).join('')}</ul>`
        : ''
      const act = ui.confirm === o.flowId
        ? `<div class="ph-confirm" role="group" aria-label="Confirm Completed"><p class="ph-line">Mark it completed? It moves to the archive.</p>` +
          `<div class="ph-actions"><button type="button" class="primary" data-ph-complete-yes${ids}${busy(ui, key)}>Yes</button><button type="button" data-ph-complete-no${ids}>Cancel</button></div></div>`
        : `<div class="ph-actions"><button type="button" class="primary" data-ph-complete${ids}>Completed</button></div>`
      const when = o.finishedAt ? `finished ${S.when(o.finishedAt, nowMs)}` : 'finished'
      return `<article class="ph-card"${attr('data-key', key)}>` +
        `<p class="ph-kicker">${esc(o.agent || 'An agent')} · ${esc(when)}${o.overdue ? ' · <span class="ph-warn-text">waiting a while</span>' : ''}</p>` +
        `<h3 class="ph-q">${esc(o.title)}</h3>${story}${act}${status(ui, key)}</article>`
    }).join('') + '</section>'
  }

  function talk(th, ui = {}) {
    if (!th) return '<p class="ph-muted ph-pad-top">Loading…</p>'
    const label = th.label || 'Master'
    const items = S.threadItems(th)
    const list = items.length
      ? `<ol class="ph-thread">${items.map(x =>
        `<li class="ph-msg ${x.who === 'you' ? 'is-you' : 'is-them'}${x.state === 'failed' ? ' is-failed' : ''}">` +
        `<p class="ph-msg-text">${x.who === 'you' ? esc(x.text) : marks(x.text)}</p>` +
        `<span class="ph-meta">${esc(x.who === 'you' ? 'You' : label)}${S.clock(x.at) ? ` · ${esc(S.clock(x.at))}` : ''}${x.who === 'you' ? ` · ${esc(S.messageWord(x, label))}` : ''}</span></li>`).join('')}</ol>`
      : '<p class="ph-faint">No messages yet.</p>'
    const sending = !!th.busy || !!ui.busy?.talk
    return '<section class="ph-sec ph-talk" aria-label="' + esc(`Talk to ${label}`) + '">' +
      `<p class="ph-note">Your message is handed to ${esc(label)} on your PC by a short paid turn (a few cents). ${esc(label)} answers when it gets to it. Your PC must be on.</p>` +
      (th.running === false ? `<p class="ph-note ph-warn-text">${esc(label)} is not running on your PC now: a message waits until it is.</p>` : '') +
      list +
      '<form class="ph-send" data-ph-talk novalidate>' +
      `<label class="ph-sr" for="phTalk">${esc(`Message to ${label}`)}</label>` +
      `<textarea id="phTalk" class="ph-input" rows="3" maxlength="2000" data-draft="talk"${attr('placeholder', `Message ${label}`)}></textarea>` +
      `<button type="submit" class="primary"${sending ? ' disabled' : ''}>${sending ? 'Sending…' : 'Send'}</button></form>` +
      status(ui, 'talk') + '</section>'
  }

  window.PhoneView = { esc, signIn, nav, now, needs, outputs, talk }
})()
