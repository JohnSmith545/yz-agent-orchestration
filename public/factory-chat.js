// The chat with Independent, in the shell's drawer (spec 5): talks to the chat
// agent (chat.mjs on the server) and streams its answer, tool calls and cost.
// Selected text is explained by explain.js (its Explain bubble, on every page),
// whose popover links back here through prefill.
//
// The shell mounts it ONCE, the first time the drawer opens, and keeps the
// mount and its EventSource while the page lives; closing the drawer only hides
// it. The drawer has ONE head: mount(el, head) writes the transcript and the
// form into `el` and the head line (Ask · name, the model with the chat's mode,
// the New chat menu, Stop) into `head`, the slot the shell keeps in its drawer
// head. The mode reads `· light` (a fresh session with the brief, the default),
// `· forked` (a copy of the user's session, about $7 for its first message), or `· forked next`
// after "Start from my session (costs more)" in the New chat menu.
//
// Every change of status.busy is announced as a `chat:status` event on
// document ({ detail: { busy } }); the rail's Ask item shows a dot from it.
// The head shows Independent's state as a dot and one word (Working, Waiting,
// Idle): busy from this stream, waiting from the pulse's chat.state.
(() => {
  const $ = (s, el = document) => el.querySelector(s)
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  let box = null
  let head = null
  let es = null
  /** Settles once the transcript is loaded and the event stream is open (mount). */
  let ready = null
  let status = { busy: false, name: 'Independent', model: '' }
  let log = []
  let live = ''
  /** The last /api/pulse chat.state (orchestration.mjs chatState): how waiting reaches the head. */
  let pulseState = 'idle'
  /** The glossary word for each state (public/glossary.json has working, waiting, idle). */
  const STATE_WORD = { working: 'Working', waiting: 'Waiting', idle: 'Idle' }
  /** working, waiting or idle: Shell.chatState over the stream's busy and the pulse's state. */
  const stateNow = () => (window.Shell?.chatState || (c => (c.busy ? 'working' : c.state === 'waiting' ? 'waiting' : 'idle')))({ busy: status.busy, state: pulseState })

  // ─── markdown (the agent's answers): paragraphs, lists, code, tables, links ───
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  }
  function md(text) {
    const lines = String(text).split('\n')
    const out = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (/^```/.test(line)) {
        const code = []
        i++
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++])
        i++
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
        continue
      }
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
        const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
        const head = cells(line)
        i += 2
        const body = []
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]))
        out.push(`<div class="md-table"><table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
        continue
      }
      const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line)
      if (li) {
        const tag = /\d/.test(li[2]) ? 'ol' : 'ul'
        const items = []
        while (i < lines.length) {
          const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i])
          if (m) { items.push({ depth: m[1].length >= 2 ? 1 : 0, text: m[3] }); i++ }
          else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1].text += ' ' + lines[i].trim(); i++ }
          else break
        }
        out.push(`<${tag}>${items.map(x => `<li class="${x.depth ? 'sub' : ''}">${inline(x.text)}</li>`).join('')}</${tag}>`)
        continue
      }
      const h = /^#{1,4}\s+(.*)$/.exec(line)
      if (h) { out.push(`<p class="md-h">${inline(h[1])}</p>`); i++; continue }
      if (!line.trim()) { i++; continue }
      const para = [line]
      i++
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i])) para.push(lines[i++])
      out.push(`<p>${inline(para.join(' '))}</p>`)
    }
    return out.join('')
  }

  // ─── render ───
  function frame() {
    head.innerHTML = `
      <h2 class="fc-who"><span class="fc-dot" id="fcDot"></span><span>Ask</span><span class="fc-sep" aria-hidden="true">·</span><span id="fcName"></span><span class="fc-state" id="fcState"></span><span class="fc-model" id="fcModel"></span></h2>
      <div class="fc-head-actions">
        <button type="button" id="fcStop" hidden>Stop</button>
        <details class="fc-new" id="fcNew">
          <summary>New chat</summary>
          <div class="fc-new-menu" role="menu">
            <button type="button" class="link" role="menuitem" id="fcNewLight">New chat</button>
            <button type="button" class="link" role="menuitem" id="fcNewFork">Start from my session (costs more)</button>
          </div>
        </details>
      </div>`
    box.innerHTML = `
      <div class="fc-log" id="fcLog" aria-live="polite"></div>
      <form class="fc-form" id="fcForm">
        <div class="fc-quick">
          <button type="button" data-q="Which tickets need a code review next, in board order? Pick the 3 most important and say why.">What to review next</button>
          <button type="button" data-q="What is blocking the next release right now? Short list, worst first, with who has to act.">What blocks release</button>
          <button type="button" data-q="List the live agents (ListAgents) and what each is doing.">Who is working</button>
        </div>
        <textarea id="fcInput" rows="3" placeholder="Talk to the agent. Enter sends, Shift+Enter for a new line."></textarea>
        <div class="fc-send"><span class="small faint" id="fcHint"></span><button type="submit" class="primary" id="fcSend">Send</button></div>
      </form>`
    $('#fcForm', box).addEventListener('submit', e => { e.preventDefault(); send($('#fcInput', box).value) })
    $('#fcInput', box).addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e.target.value) } })
    $('#fcStop', head).addEventListener('click', () => fetch('/api/chat/stop', { method: 'POST' }))
    // Delegated: the transcript is redrawn whole on every event.
    $('#fcLog', box).addEventListener('click', e => {
      const b = e.target.closest?.('[data-flow]')
      if (b) window.FlowsView?.gotoFlow(b.dataset.flow)
    })
    $('#fcNewLight', head).addEventListener('click', () => newChat(false))
    $('#fcNewFork', head).addEventListener('click', () => newChat(true))
    // The menu closes on a press outside it, and Escape closes it first (capture),
    // before the shell's own Escape closes the drawer: one Escape closes one thing.
    document.addEventListener('mousedown', e => {
      const menu = $('#fcNew', head)
      if (menu.open && !menu.contains(e.target)) menu.open = false
    }, true)
    document.addEventListener('keydown', e => {
      const menu = $('#fcNew', head)
      if (e.key !== 'Escape' || !menu.open) return
      e.preventDefault()
      e.stopPropagation()
      menu.open = false
    }, true)
    box.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => send(b.dataset.q)))
  }
  /**
   * The New chat menu: `fork` false starts the next chat light (a fresh session
   * with the brief); true starts it from the user's session once (a fork of
   * forkFrom, about $7 for its first message). The answer is the new status, so the head
   * reads `· forked next` at once.
   */
  async function newChat(fork) {
    $('#fcNew', head).open = false
    const ask = fork
      ? 'Start from your session? The next message copies your whole session in, and every message in that chat costs more.'
      : `Start a new chat? ${status.name} starts again with a fresh, light session.`
    if (!confirm(ask)) return
    const r = await fetch('/api/chat/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fork }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { alert(j.error || 'Could not start a new chat.'); return }
    setStatus(j)
    renderStatus()
  }
  /**
   * Merges a status from the server, and announces a change of busy to the
   * shell. `announce` sends it even without a change: the first status after
   * mounting takes over from notify.js, whose poll fed the dot until then.
   */
  function setStatus(next, announce = false) {
    const was = Boolean(status.busy)
    status = { ...status, ...next }
    if (announce || Boolean(status.busy) !== was) document.dispatchEvent(new CustomEvent('chat:status', { detail: { busy: Boolean(status.busy) } }))
  }
  function renderStatus() {
    if (!box) return
    $('#fcName', head).textContent = status.name
    $('#fcModel', head).textContent = modelLabel(status.model) + modeLabel(status)
    const st = stateNow()
    $('#fcDot', head).className = 'fc-dot ' + (st === 'working' ? 'busy' : st)
    $('#fcState', head).innerHTML = `<dfn data-term="${st}" tabindex="0">${STATE_WORD[st]}</dfn>`
    $('#fcStop', head).hidden = !status.busy
    // nothing to start from without a forkFrom
    $('#fcNewFork', head).hidden = !status.forkFrom
    $('#fcSend', box).disabled = status.busy
    const forksNext = !status.sessionId && status.forkFrom && (status.nextFork || status.mode === 'fork')
    $('#fcHint', box).textContent = status.busy ? `${status.name} is working…` : forksNext ? 'The first message copies the session in (slower, costs more).' : ''
    window.FactoryChat.name = status.name
  }
  const modelLabel = m => (m || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^\w/, c => c.toUpperCase())
  /** ` · light` or ` · forked` (the chat.mjs modes brief and fork), or ` · forked next` once Start from my session is chosen. */
  const modeLabel = s => (s.nextFork ? ' · forked next' : s.mode === 'fork' ? ' · forked' : s.mode === 'brief' ? ' · light' : '')

  function item(e) {
    if (e.role === 'user') return `<div class="fc-msg user">${esc(e.text)}${e.fork ? '<span class="fc-note">copying the session in…</span>' : ''}</div>`
    if (e.role === 'assistant') return `<div class="fc-msg ai">${md(e.text)}</div>`
    if (e.role === 'tool') {
      const res = log.find(x => x.role === 'tool_result' && x.id === e.id)
      return `<details class="fc-tool ${res ? (res.ok ? 'ok' : 'bad') : 'run'}"><summary><span class="fc-tname">${esc(prettyTool(e.name))}</span> <span class="fc-tsum">${esc(e.summary)}</span></summary>${res ? `<pre>${esc(res.preview)}</pre>` : '<pre>running…</pre>'}</details>`
    }
    if (e.role === 'done') return `<div class="fc-done">${e.seconds}s${e.cost ? ` · $${e.cost.toFixed(2)}` : ''}</div>${flowButtons(e.flows)}`
    if (e.role === 'error') return `<div class="fc-msg err">${esc(e.text)}</div>`
    if (e.role === 'meta') return `<div class="fc-meta">${esc(e.text)}</div>`
    return ''
  }
  /**
   * The flows a turn wrote (chat.mjs changedFlows, on its done line): one
   * "Open flow: <title>" button each, opened through FlowsView.gotoFlow (the
   * Flows page with that flow's chart and evidence). Never opened by itself.
   */
  const flowButtons = flows =>
    Array.isArray(flows) && flows.length
      ? `<div class="fc-flows">${flows.map(f => `<button type="button" class="link fc-flow" data-flow="${esc(f.id)}">Open flow: ${esc(f.title || f.id)}</button>`).join('')}</div>`
      : ''
  const prettyTool = n => n.replace('mcp__switchboard-claude__', 'Switchboard ').replace(/_/g, ' ')

  function renderLog() {
    if (!box) return
    const el = $('#fcLog', box)
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    const shown = log.filter(e => e.role !== 'tool_result').slice(-250)
    el.innerHTML = shown.length || live
      ? shown.map(item).join('') + (live ? `<div class="fc-msg ai live">${md(live)}</div>` : status.busy ? '<div class="fc-thinking"><i></i><i></i><i></i></div>' : '')
      : `<div class="fc-empty"><b>${esc(status.name)}</b> is a Claude Code session you can talk to here. It can read the code and Switchboard, review tickets and record the result on the table, add decisions for you, and pass tasks to other agents. Select any text on the page to ask about it.</div>`
    if (atBottom || status.busy) el.scrollTop = el.scrollHeight
  }

  function onEvent(e) {
    if (e.role === 'status') { setStatus(e); renderStatus(); renderLog(); return }
    if (e.role === 'delta') { live += e.text; renderLog(); return }
    if (e.role === 'assistant') live = ''
    if (e.role === 'done') { live = ''; window.FactoryView?.reload() }
    if (e.role === 'tool_result' && /factory\.mjs/.test(log.find(x => x.id === e.id)?.summary || '')) window.FactoryView?.reload()
    log.push(e)
    renderLog()
  }

  /** Opens the drawer when it is closed; the shell mounts the chat on its first open. */
  function show() {
    const drawer = window.Shell?.drawer
    if (drawer && !drawer.isOpen) drawer.open()
  }

  async function send(text) {
    text = String(text || '').trim()
    if (!text) return false
    show()
    // The server does not replay events, so a turn started before the stream
    // opens would lose its first lines: wait for the mount to finish.
    await ready
    if (status.busy) { alert(`${status.name} is still answering. Wait or press Stop.`); return false }
    const r = await fetch('/api/chat/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
    if (!r.ok) { alert((await r.json().catch(() => ({}))).error || 'Could not send.'); return false }
    if (box) $('#fcInput', box).value = ''
    return true
  }

  /**
   * Puts `text` in the input and focuses it, without sending; opens the drawer
   * first (spec 7). A draft already typed there is KEPT: the text goes on a
   * new line under it, and an empty `text` leaves the input as it was.
   */
  function prefill(text) {
    show()
    const input = box && $('#fcInput', box)
    if (!input) return false
    const add = String(text ?? '')
    const draft = String(input.value ?? '').replace(/\s+$/, '')
    if (add) input.value = draft ? `${draft}\n${add}` : add
    input.focus()
    return true
  }

  window.FactoryChat = {
    name: 'Independent',
    /** Mounts the transcript and form in `el` and the head line in `headEl`; a second call is a no-op. */
    mount(el, headEl) {
      if (box) return ready
      box = el
      head = headEl
      frame() // synchronous, so a prefill straight after the drawer opens finds the input
      // waiting comes with the pulse (notify.js dispatches each one on document)
      document.addEventListener('pulse', e => {
        pulseState = e.detail?.chat?.state || 'idle'
        renderStatus()
      })
      ready = (async () => {
        try {
          const r = await fetch('/api/chat')
          const j = await r.json()
          log = j.log || []
          setStatus(j, true)
        } catch {}
        renderStatus()
        renderLog()
        es = new EventSource('/api/chat/events')
        es.onmessage = m => { try { onEvent(JSON.parse(m.data)) } catch {} }
        await new Promise(done => { es.addEventListener('open', done, { once: true }); es.addEventListener('error', done, { once: true }) })
      })()
      return ready
    },
    get mounted() {
      return Boolean(box)
    },
    send,
    prefill,
    md,
  }
})()
