// Home (spec 5): stacked zones. Since you were away (#homeSince, since.js, spec
// F2), Waiting on you (#homeWaiting, the flows strip, drawn by flows.js), both
// mounted here while Home shows, then Agents (agent-cards.js, compact) and Messages.
// Routing lives in shell.js (Shell.resolve): #/ Home, #/agents the full agent
// tree (agents-page.js), #/timeline the flowchart (flow.js), #/tickets the
// ticket factory (factory.js), #/agent/<sessionId>[/<subagentId>] one agent
// (agent.js). Home's status line goes to the page header through
// Shell.setStatus, only while Home is showing.
//
// window.UI and window.App are attached BEFORE any DOM code, and the DOM code
// runs only when there is a document, so test/messages.test.mjs and
// test/agent-cards.test.mjs can load this file in a vm with a bare window.

const REFRESH_MS = 60_000
let data = null

// ─── helpers shared with agent.js and flow.js ─────────────────────────────────

// What a state or level means, on hover instead of as a legend on the page.
// The state words are the spec 6 set (Idle, Working, Waiting, Blocked, Done):
// testing shows as Working, with what it runs in the hover.
const STATE_WORD = { active: 'working', testing: 'working', idle: 'idle', waiting: 'waiting', blocked: 'blocked', done: 'done' }
const STATE_HELP = { testing: 'Working: running tests or checks', active: 'Working: busy right now', idle: 'Not doing anything right now', done: 'Finished' }
const LEVEL_HELP = { yes: 'All of it is there', partly: 'Some commits naming it are there; more are waiting', no: 'Nothing there names it' }

const UI = (window.UI = {
  esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  hhmm: iso => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''),
  /** A ticket id: plain muted monospace. */
  tag: id => `<span class="id">${UI.esc(id)}</span>`,
  /** A level (yes / partly / no, merged / named / no): a coloured dot and the word. */
  chip: (v, text) => {
    const cls = v === 'yes' || v === 'merged' ? 'yes' : v === 'partly' || v === 'named' ? 'partly' : 'no'
    return `<span class="dot ${cls}" title="${LEVEL_HELP[cls]}">${UI.esc(text ?? v)}</span>`
  },
  /** An agent state: a coloured dot and the word; a known state word is a <dfn> the explainer opens (explain.js). */
  stateChip: s => {
    const term = STATE_WORD[s]
    const label = term ? `<dfn data-term="${term}" tabindex="0">${term[0].toUpperCase()}${term.slice(1)}</dfn>` : UI.esc(s)
    return `<span class="dot ${UI.esc(s)}" title="${STATE_HELP[s] || ''}">${label}</span>`
  },
  data: () => data,
  /**
   * Soft fade edges on a scroll area, only where more content runs on. Edges
   * come from data-fade ("tb", "lr", "rb"...). Call again after re-rendering.
   */
  fade(el) {
    if (!el) return
    if (el._fade) return el._fade()
    const edges = el.dataset.fade || 'tb'
    const F = '22px'
    const update = () => {
      const { scrollTop: t, scrollLeft: l, scrollHeight: h, scrollWidth: w, clientHeight: ch, clientWidth: cw } = el
      el.style.setProperty('--fade-t', edges.includes('t') && t > 1 ? F : '0px')
      el.style.setProperty('--fade-b', edges.includes('b') && t + ch < h - 1 ? F : '0px')
      el.style.setProperty('--fade-l', edges.includes('l') && l > 1 ? F : '0px')
      el.style.setProperty('--fade-r', edges.includes('r') && l + cw < w - 1 ? F : '0px')
    }
    el._fade = update
    el.addEventListener('scroll', update, { passive: true })
    if ('ResizeObserver' in window) new ResizeObserver(update).observe(el)
    update()
  },
})
const { esc, hhmm } = UI

// ─── who is talking to whom ───────────────────────────────────────────────────

/**
 * Pure: the message rows with each run of 2 or more CONSECUTIVE subagent
 * dispatches from one parent folded into one row,
 * { kind: 'dispatches', from, count, t (the first row's), rows }. A lone
 * dispatch and every other row pass through as the same objects.
 */
function collapseDispatches(rows) {
  const out = []
  for (const c of rows || []) {
    const last = out[out.length - 1]
    const run = last && (last.kind === 'dispatches' ? last.rows : [last])
    if (c.via === 'subagent' && run && run[0].via === 'subagent' && run[0].from === c.from) {
      if (last.kind === 'dispatches') {
        last.rows.push(c)
        last.count++
      } else out[out.length - 1] = { kind: 'dispatches', from: c.from, count: 2, t: last.t, rows: [last, c] }
    } else out.push(c)
  }
  return out
}
// agents(): the last /api/status agents ([] until it answers), for the command palette (palette.js).
window.App = { collapseDispatches, banners: bannersFor, agents: () => data?.agents || [] }

// A message to or from a subagent names it by its id; show its brief instead.
function subagentNames() {
  const names = new Map()
  for (const a of data.agents) for (const s of a.subagents) names.set(s.id, `subagent: ${s.description}`)
  return names
}

// The dispatch groups you opened stay open across the 60 s reload.
const openDispatches = new Set()
const groupKey = g => `${g.from}|${g.t}`

function renderTalk() {
  const names = subagentNames()
  const who = n => esc(names.get(n) || n)
  const line = c => `<div class="row">
          <div class="line1"><span class="small">${hhmm(c.t)}</span>
          <span class="who">${who(c.from)}</span><span class="arrow">→</span><span class="who">${who(c.to)}</span>
          <span class="via">${esc(c.via)}</span></div>
          <span class="txt" title="${esc(c.text)}">${esc(c.text)}</span>
        </div>`
  const group = g => {
    const key = groupKey(g)
    const open = openDispatches.has(key)
    return `<div class="row disp">
          <button type="button" class="line1 disp-head" aria-expanded="${open}" data-key="${esc(key)}"><span class="small">${hhmm(g.t)}</span>
          <span class="who">${who(g.from)}</span><span class="arrow">→</span><span class="disp-count">${g.count} dispatches</span>
          <span class="via">subagent</span></button>
          <div class="disp-rows"${open ? '' : ' hidden'}>${g.rows.map(line).join('')}</div>
        </div>`
  }
  const rows = collapseDispatches(data.conversations).slice(0, 40)
  window.Motion.countUp(document.getElementById('talkCount'), data.conversations.length)
  const box = document.getElementById('talk')
  box.innerHTML = rows.length ? rows.map(r => (r.kind === 'dispatches' ? group(r) : line(r))).join('') : '<div class="empty">No messages yet.</div>'
  if (rows.length) window.Motion.enterList(box)
  UI.fade(box)
}

// ─── header status and banners ────────────────────────────────────────────────

/**
 * The banners for a /api/status payload, as HTML strings. A repo folder that does not exist is
 * said plainly and replaces the git banners it causes (a fetch there fails with spawn git ENOENT).
 */
function bannersFor(d) {
  if (d.repoOk === false) return [`The repo folder in config.json does not exist: ${esc(d.repo)}`]
  const banners = []
  if (d.fetch.ok === false) banners.push(`git fetch failed, so dev and stage may be stale: ${esc(d.fetch.err)}`)
  if (!d.remotesOk.dev || !d.remotesOk.stage) banners.push('origin/dev or origin/stage could not be read.')
  if (d.ticketSnapshotAt && Date.now() - new Date(d.ticketSnapshotAt) > 6 * 3600_000)
    banners.push('The ticket snapshot is over 6 hours old. Ask the Independent agent to refresh it.')
  return banners
}

function renderMeta() {
  const banners = bannersFor(data)
  document.getElementById('banners').innerHTML = banners.map(b => `<div class="banner">${b}</div>`).join('')
  // The header chip belongs to whichever page is showing; Home writes it only while Home shows.
  if (window.Shell.current?.view !== 'home') return
  const f = data.followup
  const { ago } = window.Shell
  // The chip is one short line; the rest of the meta is behind its ? (help.js).
  const more = [
    `<p><b>${f.vsDev ? f.vsDev.ahead : '?'}</b> commits on followup are ahead of dev, with <b>${f.unpushedTickets.length}</b> tickets waiting.</p>`,
    `<p>Fetched is when git last fetched the remotes${data.fetch.at ? ` (${ago(data.fetch.at)})` : ''}. ${data.ticketSnapshotAt ? `The ticket snapshot is ${ago(data.ticketSnapshotAt)} old.` : 'The ticket snapshot was never read.'}</p>`,
    '<p class="faint">The page rebuilds itself every minute; Refresh rebuilds it now.</p>',
  ].join('')
  window.Shell.setStatus(data.fetch.at ? `fetched ${ago(data.fetch.at)}` : 'not fetched', more)
}

function renderHome() {
  renderMeta()
  window.AgentCards?.render(data, { compact: true, root: 'agentCards' })
  window.Motion.countUp(document.getElementById('agentsCount'), data.agents.length)
  renderTalk()
  document.querySelectorAll('#home .scroll').forEach(UI.fade)
}

// ─── load ─────────────────────────────────────────────────────────────────────

async function load(force) {
  const btn = document.getElementById('refresh')
  btn.disabled = true
  btn.textContent = 'Refreshing…'
  try {
    const r = await fetch('/api/status' + (force ? '?refresh=1' : ''))
    if (!r.ok) throw new Error(await r.text())
    data = await r.json()
    renderHome()
    window.AgentsPage?.update(data)
  } catch (e) {
    // This poll runs on every page, but the chip belongs to the page showing: only Home and
    // Agents show this data, so elsewhere a failure says nothing (the next poll tries again).
    const view = window.Shell.current?.view
    if (view === 'home' || view === 'agents') window.Shell.setStatus(`<span class="warn">Could not load: ${esc(e.message)}</span>`)
  } finally {
    btn.disabled = false
    btn.textContent = 'Refresh'
  }
}

function boot() {
  document.getElementById('refresh').addEventListener('click', () => {
    load(true)
    if (window.Shell.current?.view === 'timeline') window.FlowView.refresh(true)
  })
  document.getElementById('talk').addEventListener('click', e => {
    const b = e.target.closest('.disp-head')
    if (!b) return
    const open = b.getAttribute('aria-expanded') !== 'true'
    if (open) openDispatches.add(b.dataset.key)
    else openDispatches.delete(b.dataset.key)
    b.setAttribute('aria-expanded', String(open))
    b.nextElementSibling.hidden = !open
    UI.fade(document.getElementById('talk'))
  })
  // The header chip is shared by every page; coming back Home puts Home's status line back.
  // The Waiting on you strip (flows.js) polls only while Home shows; the Flows page mounts its own.
  const strip = document.getElementById('homeWaiting')
  const since = document.getElementById('homeSince')
  window.Shell.onRoute(r => {
    if (r.view !== 'home') {
      window.Since?.unmount(since)
      return window.FlowsView?.unmountStrip(strip)
    }
    window.Since?.mount(since)
    window.FlowsView?.mountStrip(strip)
    if (data) renderMeta()
    else window.Shell.setStatus('Loading…')
  })
  setInterval(() => load(false), REFRESH_MS)
  setInterval(() => {
    if (!data) return
    renderMeta()
    window.AgentsPage?.update(data)
  }, 15_000)
  // shell.js routes on DOMContentLoaded, so the Timeline page does not wait for the status build.
  window.addEventListener('DOMContentLoaded', () => load(false))
}
if (window.document) boot()
