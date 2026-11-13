// One agent, live: what it is doing (prompts, replies, edits as diffs,
// commands and their output) and the uncommitted changes in its worktree.
// Polls /api/agent every 2.5 s with a cursor, and /api/diff every 5 s.

;(() => {
  const { esc, hhmm, tag, stateChip } = window.UI
  const { ago } = window.Shell
  const FEED_MS = 2500
  const DIFF_MS = 5000

  let view = null // { sid, sub, cursor, events: Map, timers, worktree, picked, info }

  // ─── rendering one event ────────────────────────────────────────────────────

  /**
   * A path as the repo sees it: a worktree path keeps its worktree folder,
   * any other loses everything up to the watched repo's folder, `repoName`
   * (from /api/agent, the basename of config.repo).
   */
  function shortPath(p, repoName = view?.repoName || '') {
    let s = String(p || '').replace(/^.*?[\\/]\.claude[\\/]worktrees[\\/]/i, '')
    if (repoName) s = s.replace(new RegExp(`^(?:.*?[\\\\/])?${repoName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]`, 'i'), '')
    return s.replace(/\\/g, '/')
  }

  function result(ev) {
    if (ev.result == null) return ev.doneAt ? '' : '<div class="small">running…</div>'
    if (!ev.result.trim()) return ''
    return `<details class="res"${ev.isError ? ' open' : ''}><summary>${ev.isError ? '<span class="warn">error</span>' : 'output'}</summary><pre>${esc(ev.result)}</pre></details>`
  }

  function toolBody(ev) {
    switch (ev.tool) {
      case 'Edit':
      case 'MultiEdit': {
        const parts = (ev.edits || []).map(e => window.Diff.edit(e.old, e.new))
        const add = parts.reduce((n, p) => n + p.add, 0)
        const del = parts.reduce((n, p) => n + p.del, 0)
        return `<div class="hd"><span class="tool">Edit</span> <code>${esc(shortPath(ev.file))}</code> ${window.Diff.counts(add, del)}${ev.all ? ' <span class="small">(every match)</span>' : ''}</div>${parts.map(p => p.html).join('')}${ev.isError ? result(ev) : ''}`
      }
      case 'Write':
      case 'NotebookEdit': {
        const w = window.Diff.write(ev.content)
        return `<div class="hd"><span class="tool">Write</span> <code>${esc(shortPath(ev.file))}</code> ${window.Diff.counts(w.add, 0)}</div>${w.html}${ev.isError ? result(ev) : ''}`
      }
      case 'Bash':
      case 'PowerShell':
        return `<div class="hd"><span class="tool">${ev.testing ? 'Test' : 'Run'}</span> ${esc(ev.summary)}${ev.background ? ' <span class="small">(background)</span>' : ''}</div><pre class="cmd">${esc(ev.command)}</pre>${result(ev)}`
      case 'Read':
        return `<div class="hd small">Read <code>${esc(shortPath(ev.file))}</code> ${esc(ev.summary)}</div>`
      case 'Grep':
      case 'Glob':
        return `<div class="hd small">${esc(ev.tool)} <code>${esc(ev.summary)}</code></div>`
      case 'Agent':
      case 'Task':
        return `<div class="hd"><span class="tool">Started a subagent:</span> ${esc(ev.summary)}</div><details class="res"><summary>its brief</summary><pre>${esc(ev.text)}</pre></details>`
      case 'SendMessage':
        return `<div class="hd"><span class="tool">Message ${esc(ev.summary)}</span></div><div class="body">${esc(ev.text)}</div>`
      default:
        return `<div class="hd small"><span class="tool">${esc(ev.tool)}</span> ${esc(ev.summary)}</div>${ev.isError ? result(ev) : ''}`
    }
  }

  function eventHtml(ev) {
    const t = `<span class="t">${hhmm(ev.t)}</span>`
    if (ev.kind === 'user') return `<div class="ev user">${t}<b>You</b><div class="body">${esc(ev.text)}</div></div>`
    if (ev.kind === 'msg-in') return `<div class="ev msg-in">${t}<b>From ${esc(ev.from)}</b><div class="body">${esc(ev.text)}</div></div>`
    if (ev.kind === 'text') return `<div class="ev text">${t}<b>${esc(view.info?.title || 'Agent')}</b><div class="body">${esc(ev.text)}</div></div>`
    return `<div class="ev tool">${t}${toolBody(ev)}</div>`
  }

  // ─── panels ─────────────────────────────────────────────────────────────────

  function renderFeed() {
    const box = document.getElementById('feed')
    if (!box) return
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80
    const evs = [...view.events.values()].sort((a, b) => a.seq - b.seq)
    box.innerHTML = evs.length ? evs.map(eventHtml).join('') : '<div class="small">Nothing recorded yet.</div>'
    if (nearBottom || !view.scrolled) {
      // The first jump to the end is instant; later ones glide.
      box.scrollTo({ top: box.scrollHeight, behavior: view.scrolled ? 'smooth' : 'instant' })
      view.scrolled = true
    }
    window.UI.fade(box)
  }

  function renderHead(d) {
    const a = d.agent
    const fromStatus = window.UI.data()?.agents.find(x => x.sessionId === a.sessionId)
    const talk = !d.sub && fromStatus?.talkingWith
    const title = d.sub ? `${a.label} › ${d.sub.description}` : a.label
    view.info = { title, label: a.label }
    document.getElementById('agentTitle').innerHTML = `<span class="nm">${esc(title)}</span>${stateChip(d.state)}`
    const tickets = (d.sub ? d.sub.tickets || [] : a.recentTickets).slice(0, 5)
    // The chip is when it last did something; who it talks to and its tickets are behind the ? (spec 5).
    window.Shell.setStatus(`last active ${ago(d.sub ? d.sub.updatedAt : a.transcriptAt) || '—'}`, [
      talk ? `<p>${talk.direction === 'to' ? 'Talking to' : 'Heard from'} <b>${esc(talk.with)}</b> · ${ago(talk.t)}</p>` : '',
      tickets.length ? `<p>Tickets: <span class="ids">${tickets.map(tag).join(' ')}</span></p>` : '<p>No ticket named yet.</p>',
      '<p>The activity reads the transcript every few seconds; the changes are the uncommitted diff of the worktree picked above them.</p>',
    ].join(''))
    const options = [...new Set([...(d.worktrees || []), 'main'])]
    if (!view.picked) view.worktree = a.name === 'Master' && !d.sub ? 'main' : options[0]
    document.getElementById('wtpick').innerHTML = options
      .map(w => `<button class="link" data-wt="${esc(w)}" aria-pressed="${w === view.worktree}">${w === 'main' ? 'main checkout' : esc(w)}</button>`)
      .join('')
  }

  function renderDiff(d) {
    const box = document.getElementById('changes')
    if (!box) return
    if (!d || d.error) {
      box.innerHTML = `<div class="small">${esc(d?.error || 'Could not read the worktree.')}</div>`
      return
    }
    const p = window.Diff.patch(d.patch)
    const files = d.files.length
      ? `<ul class="files">${d.files
          .map(f => {
            const s = window.Diff.status(f.code)
            const c = p.files.get(f.file)
            return `<li><span class="st ${s.kind}" title="${s.title}">${s.letter}</span><span class="path" title="${esc(f.file)}">${esc(f.file)}</span>${c ? window.Diff.counts(c.add, c.del) : ''}</li>`
          })
          .join('')}</ul>`
      : '<div class="small">No uncommitted changes.</div>'
    const log = d.log.length ? `<h2 style="margin:20px 0 8px">Latest commits</h2><ul class="br">${d.log.map(c => `<li class="small"><code>${esc(c.sha)}</code> ${esc(ago(c.when))}: ${esc(c.subject)}</li>`).join('')}</ul>` : ''
    box.innerHTML = `<div class="small changes-meta"><span class="branch">${esc(d.branch)}</span><span>checked ${ago(d.at) || '—'}</span>${window.Diff.counts(p.add, p.del)}</div>${files}${p.html}${log}`
    window.UI.fade(box)
  }

  // ─── polling ────────────────────────────────────────────────────────────────

  async function pollFeed() {
    if (!view) return
    const v = view
    const q = new URLSearchParams({ session: v.sid, since: String(v.cursor) })
    if (v.sub) q.set('sub', v.sub)
    try {
      const r = await fetch(`/api/agent?${q}`)
      const d = await r.json()
      if (view !== v) return
      if (!r.ok) {
        document.getElementById('feed').innerHTML = `<div class="warn">${esc(d.error || 'This session is no longer running.')}</div>`
        return
      }
      for (const e of d.events) v.events.set(e.seq, e)
      v.cursor = d.cursor
      v.repoName = d.repoName || ''
      renderHead(d)
      renderFeed()
    } catch {
      /* the next poll tries again */
    }
  }

  async function pollDiff() {
    if (!view?.worktree) return
    const v = view
    try {
      const r = await fetch(`/api/diff?worktree=${encodeURIComponent(v.worktree)}`)
      const d = await r.json()
      if (view === v) renderDiff(d)
    } catch {
      /* the next poll tries again */
    }
  }

  // ─── report ─────────────────────────────────────────────────────────────────

  async function draftReport() {
    const modal = document.createElement('div')
    modal.className = 'modal'
    modal.innerHTML = `<div class="card box">
      <div class="card-head"><h3>Draft report: ${esc(view.info?.title || '')}</h3>
        <label class="check">Covering <select id="repHours">
          <option value="1">the last hour</option><option value="2">the last 2 hours</option>
          <option value="4" selected>the last 4 hours</option><option value="8">the last 8 hours</option>
          <option value="24">the last 24 hours</option><option value="0">everything recorded</option>
        </select></label></div>
      <textarea id="repText" spellcheck="true">Drafting…</textarea>
      <div class="actions">
        <span style="margin-right:auto"></span>
        <button id="repClose">Close</button><button id="repDownload">Download .md</button><button id="repCopy" class="primary">Copy</button>
      </div></div>`
    document.body.appendChild(modal)
    const text = modal.querySelector('#repText')
    const fill = async () => {
      text.value = 'Drafting…'
      const q = new URLSearchParams({ session: view.sid, hours: modal.querySelector('#repHours').value })
      if (view.sub) q.set('sub', view.sub)
      const r = await fetch(`/api/report?${q}`)
      text.value = await r.text()
    }
    modal.querySelector('#repHours').addEventListener('change', fill)
    modal.querySelector('#repClose').addEventListener('click', () => modal.remove())
    modal.addEventListener('click', e => e.target === modal && modal.remove())
    // It takes the key, so the shell leaves the chat drawer open (one Escape closes one thing).
    modal.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !modal.isConnected) return
      e.preventDefault()
      modal.remove()
    })
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.querySelector('#repCopy').addEventListener('click', async e => {
      try {
        await navigator.clipboard.writeText(text.value)
        e.target.textContent = 'Copied'
      } catch {
        text.select()
        e.target.textContent = 'Press Ctrl+C'
      }
    })
    modal.querySelector('#repDownload').addEventListener('click', () => {
      const name = `${(view.info?.label || 'agent').replace(/\s+/g, '-').toLowerCase()}-report-${new Date().toISOString().slice(0, 10)}.md`
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([text.value], { type: 'text/markdown' }))
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    })
    text.focus()
    await fill()
  }

  // ─── open / close ───────────────────────────────────────────────────────────

  function close() {
    if (!view) return
    view.timers.forEach(clearInterval)
    view = null
  }

  function open(sid, sub) {
    if (view && view.sid === sid && view.sub === sub) return
    close()
    view = { sid, sub, cursor: 0, events: new Map(), timers: [], worktree: null, picked: false, scrolled: false, info: null }
    const root = document.getElementById('agentView')
    root.innerHTML = `
      <div class="agent-head">
        <a href="#/agents" class="link">← All agents</a>
        <span id="agentTitle"><span class="nm">Loading…</span></span>
        <button id="draftReport" class="primary" style="margin-left:auto">Draft report</button>
      </div>
      <div class="agent-grid">
        <div class="card">
          <div class="card-head"><h3>Live activity</h3></div>
          <div class="feed scroll" id="feed" data-fade="tb"><div class="small">Loading…</div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Uncommitted changes</h3><div class="wtpick" id="wtpick"></div></div>
          <div class="changes scroll" id="changes" data-fade="tb"><div class="small">Loading…</div></div>
        </div>
      </div>`
    root.querySelector('#draftReport').addEventListener('click', draftReport)
    root.querySelector('#wtpick').addEventListener('click', e => {
      const w = e.target.closest('button')?.dataset.wt
      if (!w) return
      view.worktree = w
      view.picked = true
      root.querySelectorAll('#wtpick button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.wt === w)))
      document.getElementById('changes').innerHTML = '<div class="small">Loading…</div>'
      pollDiff()
    })
    pollFeed().then(pollDiff)
    view.timers.push(setInterval(pollFeed, FEED_MS), setInterval(pollDiff, DIFF_MS))
  }

  window.AgentView = { open, close, shortPath }
})()
