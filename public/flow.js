// Timeline (#/timeline): a flowchart of what each agent did on each task (data: /api/flow, built
// by flow.mjs). One swimlane per agent; inside it one row per task and one per
// subagent; each row a chain of operation nodes on a shared, compressed time
// axis. Cross-lane arrows are hand-offs: briefs, messages, subagents spawned
// and reporting back, a `git merge` landing a branch in followup.
//
// Layout: nodes are placed in time order. A node never sits left of an earlier
// node (so arrows between lanes run forward), never overlaps its row's previous
// node, and quiet stretches over 30 minutes collapse into a marked break.
// Drawn as plain SVG; no library, so it works offline.

;(() => {
  const { esc, hhmm, stateChip } = window.UI

  const NODE_W = 176
  const NODE_H = 44
  const GAP = 36 // between nodes in a row, room for the arrow
  const ROW_H = 64
  const LANE_H = 38
  const AXIS_H = 34
  const PAD = 24
  const labelWidth = () => (window.innerWidth < 900 ? 196 : 268)
  const BREAK_MS = 30 * 60_000
  const BREAK_W = 84
  const POLL_MS = 60_000
  // Zoom (flow-zoom.js) scales the chart: widths and row heights, not the lane
  // headers or the axis text. Below MINI_BELOW node text is too small to read,
  // so nodes become coloured blocks; rows shorter than TIGHT_ROW keep one label line.
  const MINI_BELOW = 0.75
  const TIGHT_ROW = 48
  const MIN_ROW = 24
  const WINDOWS = [
    { h: 2, label: '2h' },
    { h: 8, label: '8h' },
    { h: 24, label: '24h' },
    { h: 0, label: 'Everything buffered' },
  ]
  const TYPES = [
    ['brief', 'Briefed'],
    ['heard', 'Heard from'],
    ['explore', 'Explored'],
    ['edit', 'Edited'],
    ['test', 'Tested'],
    ['message', 'Messaged'],
    ['spawn', 'Spawned subagent'],
    ['commit', 'Committed'],
    ['merge', 'git merge'],
    ['push', 'Pushed'],
    ['land', 'Landed: followup, dev, stage'],
    ['pending', 'Not there yet'],
  ]
  // The legend is behind the toolbar ? (spec 6), never a row on the page.
  const LEGEND = '<p>One lane per agent, one row per task; time runs left to right. The bar on a node is its kind:</p>' +
    `<div class="flow-legend">${TYPES.map(([t, l]) => `<span><i style="--c: var(--t-${t})"></i>${l}</span>`).join('')}` +
    '<span class="dot yes">passed</span><span class="dot" style="--dot: var(--bad)">failed</span><span class="dot partly">in progress</span>' +
    '<span><b class="delta"><span class="plus">+N</span><span class="minus">−N</span></b>lines added, removed</span></div>' +
    '<p>Hover a node for its details, click to pin them. Drag the background to pan; Ctrl and scroll zooms.</p>'
  const LINK_KINDS = { brief: 'brief', message: 'message', spawn: 'spawn', report: 'report', merge: 'merge' }
  const VERDICT = { pass: 'passed', fail: 'failed', running: 'still running', unknown: 'no clear result', pending: 'not there yet' }

  const saved = (k, fallback) => {
    try {
      const v = localStorage.getItem(k)
      return v == null ? fallback : JSON.parse(v)
    } catch {
      return fallback
    }
  }
  const save = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {}
  }

  const st = {
    open: false,
    built: false,
    hours: saved('flow.hours', 24),
    ticket: '', // not remembered: a stale ticket filter on the next visit would hide everything else
    subs: saved('flow.subs', true),
    explore: saved('flow.explore', true),
    compact: saved('flow.compact', false),
    data: null,
    timer: null,
    req: 0,
    pinned: null,
    hoverTimer: null,
    jumpToEnd: true,
    layout: null,
    zoom: saved('flow.zoom', 1), // a number, or 'fit'
    z: 1, // the scale in effect after resolving 'fit'
  }

  const ms = iso => (iso ? new Date(iso).getTime() : NaN)
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  const when = iso => {
    if (!iso) return ''
    const d = new Date(iso)
    const today = new Date().toDateString() === d.toDateString()
    return today ? hhmm(iso) : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${hhmm(iso)}`
  }
  const span = dt => {
    const m = Math.round(dt / 60_000)
    return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.round(m / 1440)}d`
  }

  // ─── text fitting ───────────────────────────────────────────────────────────

  let measureCtx = null
  function fit(text, px, weight, max) {
    text = String(text || '')
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
    measureCtx.font = `${weight} ${px}px ${getComputedStyle(document.body).fontFamily}`
    if (measureCtx.measureText(text).width <= max) return text
    let lo = 0
    let hi = text.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (measureCtx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid
      else hi = mid - 1
    }
    return `${text.slice(0, lo).trimEnd()}…`
  }

  // ─── shell ──────────────────────────────────────────────────────────────────

  function build() {
    const root = document.getElementById('flowView')
    root.innerHTML = `
      <div class="flow-tools">
        <div class="group" role="group" aria-label="Time window"><span class="lbl">Window</span>
          ${WINDOWS.map(w => `<button class="link" data-hours="${w.h}" aria-pressed="${w.h === st.hours}">${w.label}</button>`).join('')}
        </div>
        <div class="group"><label class="lbl" for="flowTicket">Ticket</label><select id="flowTicket"><option value="">All tickets</option></select></div>
        <label class="check"><input type="checkbox" id="flowSubs"${st.subs ? ' checked' : ''}> Subagents</label>
        <label class="check"><input type="checkbox" id="flowExplore"${st.explore ? ' checked' : ''}> Exploring steps</label>
        <div class="group" role="group" aria-label="Layout"><span class="lbl">Layout</span>
          <button class="link" data-compact="0" aria-pressed="${!st.compact}" title="One time axis for every lane: hand-offs line up">By time</button>
          <button class="link" data-compact="1" aria-pressed="${st.compact}" title="Each row packed from the left, in its own order">Compact</button>
        </div>
        ${window.FlowZoom.controls()}
        <button type="button" class="help meta-r" aria-label="What the chart shows">?</button>
      </div>
      <div class="card flow-card"><div class="flow-scroll scroll" id="flowScroll" data-fade="rb"><div class="empty">Loading…</div></div></div>`
    window.Help.attach(root.querySelector('.flow-tools .help'), LEGEND)
    root.querySelector('.flow-tools').addEventListener('click', e => {
      const c = e.target.closest('button[data-compact]')
      if (c) {
        st.compact = c.dataset.compact === '1'
        save('flow.compact', st.compact)
        root.querySelectorAll('button[data-compact]').forEach(x => x.setAttribute('aria-pressed', String((x.dataset.compact === '1') === st.compact)))
        st.jumpToEnd = !st.compact
        if (st.compact) {
          const sc = document.getElementById('flowScroll')
          if (sc) sc.scrollLeft = 0
        }
        render()
        return
      }
      const b = e.target.closest('button[data-hours]')
      if (!b) return
      st.hours = Number(b.dataset.hours)
      save('flow.hours', st.hours)
      root.querySelectorAll('button[data-hours]').forEach(x => x.setAttribute('aria-pressed', String(Number(x.dataset.hours) === st.hours)))
      st.jumpToEnd = true
      fetchFlow(false)
    })
    root.querySelector('#flowTicket').addEventListener('change', e => setTicket(e.target.value))
    root.querySelector('#flowSubs').addEventListener('change', e => {
      st.subs = e.target.checked
      save('flow.subs', st.subs)
      render()
    })
    root.querySelector('#flowExplore').addEventListener('change', e => {
      st.explore = e.target.checked
      save('flow.explore', st.explore)
      render()
    })
    const scroller = root.querySelector('#flowScroll')
    window.UI.fade(scroller)
    scroller.addEventListener('pointerover', e => {
      const g = e.target.closest?.('.fn')
      if (!g || st.pinned) return
      clearTimeout(st.hoverTimer)
      st.hoverTimer = setTimeout(() => show(g, false), 90)
    })
    scroller.addEventListener('pointerout', e => {
      const g = e.target.closest?.('.fn')
      if (!g || st.pinned || g.contains(e.relatedTarget)) return
      clearTimeout(st.hoverTimer)
      hide()
    })
    scroller.addEventListener('click', e => {
      const g = e.target.closest('.fn')
      if (g) return togglePin(g)
      const id = e.target.closest('[data-key]')
      if (id) setTicket(st.ticket === id.dataset.key ? '' : id.dataset.key)
    })
    scroller.addEventListener('focusin', e => {
      const g = e.target.closest('.fn')
      if (g && !st.pinned) show(g, false)
    })
    scroller.addEventListener('focusout', e => {
      if (e.target.closest('.fn') && !st.pinned) hide()
    })
    scroller.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      const g = e.target.closest('.fn')
      const id = e.target.closest('[data-key]')
      if (!g && !id) return
      e.preventDefault()
      if (g) togglePin(g)
      else setTicket(st.ticket === id.dataset.key ? '' : id.dataset.key)
    })
    scroller.addEventListener('scroll', () => st.pinned && hide(true), { passive: true })
    const tools = root.querySelector('.flow-tools')
    window.FlowZoom.attach(tools, scroller, {
      current: () => st.z,
      active: () => st.open,
      apply: (next, anchor) => {
        st.zoom = next
        save('flow.zoom', next)
        render(anchor)
      },
    })
    // Fit follows the window: re-fit when the chart area changes width.
    let lastW = 0
    new ResizeObserver(() => {
      if (st.zoom !== 'fit' || !st.open || scroller.clientWidth === lastW) return
      lastW = scroller.clientWidth
      render()
    }).observe(scroller)
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !st.open || !document.querySelector('.popover')) return
      e.preventDefault() // the shell then leaves the chat drawer open: one Escape closes one thing
      const back = st.pinned
      hide(true)
      back?.focus()
    })
    document.addEventListener('pointerdown', e => {
      if (st.pinned && !e.target.closest('.popover') && !e.target.closest('.fn')) hide(true)
    })
    st.built = true
  }

  function setTicket(key) {
    st.ticket = key
    const sel = document.getElementById('flowTicket')
    if (sel) sel.value = key
    st.jumpToEnd = true
    render()
  }

  // ─── data ───────────────────────────────────────────────────────────────────

  async function fetchFlow(force) {
    const req = ++st.req
    if (!st.data) window.Shell.setStatus('Loading…')
    try {
      const r = await fetch(`/api/flow?hours=${st.hours}${force ? '&refresh=1' : ''}`)
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      if (req !== st.req || !st.open) return
      st.data = d
      render()
    } catch (e) {
      if (req !== st.req) return
      if (st.open) window.Shell.setStatus(`<span class="warn">Could not load the timeline: ${esc(String(e.message).slice(0, 200))}</span>`)
    }
  }

  // ─── layout ─────────────────────────────────────────────────────────────────

  function visible(d) {
    const rows = d.rows
      .filter(r => (!st.ticket || r.task.key === st.ticket) && (st.subs || !r.sub))
      .map(r => ({ ...r, nodes: r.nodes.filter(n => st.explore || n.type !== 'explore') }))
      .filter(r => r.nodes.length)
    const lanes = d.lanes
      .map(l => ({ ...l, rows: rows.filter(r => r.lane === l.index) }))
      .filter(l => l.rows.length || !st.ticket)
    return { lanes, rows }
  }

  /** The sizes at zoom z: nodes, gaps and rows scale; lane headers do not. */
  const dims = z => {
    const rowH = Math.max(MIN_ROW, Math.round(ROW_H * z))
    // Far out, a block keeps a readable height even as it narrows to a few px.
    const nodeH = Math.min(rowH - 6, z < MINI_BELOW ? Math.max(NODE_H * z, 14) : NODE_H * z)
    return { z, nodeW: NODE_W * z, nodeH, rowH, gap: GAP * z, breakW: BREAK_W * Math.max(z, 0.25), nudge: 18 * z }
  }

  function layout(lanes, D) {
    const { nodeW: NODE_W, nodeH: NODE_H, rowH: ROW_H, gap: GAP, breakW: BREAK_W, nudge } = D
    let y = 0
    const rowList = []
    for (const l of lanes) {
      l.y = y
      y += LANE_H
      if (!l.rows.length) {
        l.emptyY = y
        y += ROW_H
      }
      for (const r of l.rows) {
        r.y = y
        rowList.push(r)
        y += ROW_H
      }
    }
    const height = Math.max(y, 120)

    const placed = []
    rowList.forEach((r, ri) => r.nodes.forEach((n, i) => n.t && placed.push({ n, r, ri, i })))
    placed.sort((a, b) => ms(a.n.t) - ms(b.n.t) || a.ri - b.ri || a.i - b.i)

    const rowEnd = new Map()
    const gaps = []
    const ticks = []
    let cursor = PAD
    let prevT = null
    let maxEnd = PAD
    let lastTick = null
    for (const p of placed) {
      const t = ms(p.n.t)
      if (st.compact) {
        // Each row on its own: packed from the left, no shared time axis.
        const x = rowEnd.get(p.r.id) ?? PAD
        p.n.x = x
        p.n.y = p.r.y + (ROW_H - NODE_H) / 2
        rowEnd.set(p.r.id, x + NODE_W + GAP)
        maxEnd = Math.max(maxEnd, x + NODE_W)
        continue
      }
      let base = cursor
      if (prevT != null) {
        const dt = t - prevT
        if (dt > BREAK_MS) {
          gaps.push({ x: maxEnd + BREAK_W / 2, dt })
          base = maxEnd + BREAK_W
        } else if (dt > 90_000) base = cursor + nudge
      }
      const x = Math.max(rowEnd.get(p.r.id) ?? PAD, base)
      p.n.x = x
      p.n.y = p.r.y + (ROW_H - NODE_H) / 2
      rowEnd.set(p.r.id, x + NODE_W + GAP)
      maxEnd = Math.max(maxEnd, x + NODE_W)
      cursor = x
      prevT = t
      const bucket = Math.floor(t / (10 * 60_000))
      if (!lastTick || (x - lastTick.x >= 96 && bucket !== lastTick.bucket)) {
        const day = new Date(t).toDateString()
        ticks.push({ x, t: p.n.t, day: !lastTick || lastTick.day !== day, dayKey: day })
        lastTick = { x, bucket, day }
      }
    }
    // Ghosts (the next level not reached) close their row.
    for (const r of rowList) {
      for (const n of r.nodes.filter(n => !n.t)) {
        const x = rowEnd.get(r.id) ?? PAD
        n.x = x
        n.y = r.y + (ROW_H - NODE_H) / 2
        rowEnd.set(r.id, x + NODE_W + GAP)
        maxEnd = Math.max(maxEnd, x + NODE_W)
      }
    }
    return { width: Math.max(maxEnd + PAD, 600), height, rowList, gaps, ticks, D }
  }

  /**
   * The layout for the zoom asked for. 'fit' finds the scale at which the
   * whole window fits the chart's width (never above 100%): widths are near
   * linear in z, so one estimate plus one correction lands it.
   */
  function layoutFor(lanes, scroller) {
    if (st.zoom !== 'fit') return layout(lanes, dims(window.FlowZoom.clamp(Number(st.zoom) || 1)))
    const avail = scroller.clientWidth - labelWidth() - 2
    const full = layout(lanes, dims(1))
    if (full.width <= avail) return full
    let z = window.FlowZoom.clamp((avail - 2 * PAD) / Math.max(1, full.width - 2 * PAD))
    let L = layout(lanes, dims(z))
    if (L.width > avail && z > window.FlowZoom.MIN) {
      z = window.FlowZoom.clamp(z * (avail / L.width))
      L = layout(lanes, dims(z))
    }
    return L
  }

  // ─── drawing ────────────────────────────────────────────────────────────────

  const MARKERS = ['row', 'brief', 'message', 'spawn', 'report', 'merge']
    .map(k => `<marker id="fm-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="m-${k}" d="M0,1.5 L9,5 L0,8.5 z"/></marker>`)
    .join('')

  // The second line: an edit shows its lines added and removed, in colour.
  function line2(n, time) {
    const delta = n.add || n.del ? `${n.add ? `+${n.add}` : ''}${n.add && n.del ? ' ' : ''}${n.del ? `−${n.del}` : ''}` : ''
    const text = fit([time, delta ? '' : n.sub].filter(Boolean).join(' · '), 11.5, 400, NODE_W - 22 - (delta ? 70 : 0))
    if (!delta) return esc(text)
    const plus = n.add ? `<tspan class="plus">+${n.add}</tspan>` : ''
    const minus = n.del ? `<tspan class="minus">−${n.del}</tspan>` : ''
    return `${esc(text)}${text ? ' · ' : ''}${plus}${plus && minus ? ' ' : ''}${minus}`
  }

  // Drawn at 100% and scaled by the zoom, so text and box shrink together.
  function nodeSvg(n, r, lane, z) {
    const hasMark = n.status && n.status !== 'pending'
    const time = n.t ? hhmm(n.t) : ''
    const l1 = fit(n.label, 12.5, 600, NODE_W - 13 - (hasMark ? 20 : 10))
    const delta = n.add || n.del ? `, ${n.add || 0} lines added, ${n.del || 0} removed` : ''
    const aria = `${lane.label}, ${r.sub ? `subagent ${r.sub.description}` : r.task.label}: ${n.label}${n.sub ? `, ${n.sub}` : ''}${delta}${time ? `, at ${time}` : ''}${n.status ? `, ${VERDICT[n.status] || n.status}` : ''}`
    const h = n.h / z
    return `<g class="fn t-${n.type}${n.status ? ` s-${n.status}` : ''}${n.ghost ? ' ghost' : ''}" data-id="${n.id}" transform="translate(${n.x},${n.y}) scale(${z})" tabindex="0" role="button" aria-label="${esc(aria)}">
      <rect class="box" width="${NODE_W}" height="${h}" rx="5"/>
      ${n.ghost ? '' : `<rect class="bar" width="3" height="${h}" clip-path="url(#fn-clip)"/>`}
      <text class="l1" x="13" y="19">${esc(l1)}</text>
      <text class="l2" x="13" y="34">${line2(n, time)}</text>
      ${hasMark ? `<circle class="mark" cx="${NODE_W - 12}" cy="14" r="3.5"/>` : ''}
    </g>`
  }

  function linkPath(a, b, D) {
    const { nodeW: NODE_W, nodeH: NODE_H } = D
    const ax = a.x + NODE_W / 2
    const bx = b.x + NODE_W / 2
    if (b.y > a.y) {
      const ay = a.y + NODE_H
      const by = b.y - 1
      const dy = Math.max(24, (by - ay) / 2)
      return `M${ax},${ay} C${ax},${ay + dy} ${bx},${by - dy} ${bx},${by}`
    }
    const ay = a.y
    const by = b.y + NODE_H + 1
    const dy = Math.max(24, (ay - by) / 2)
    return `M${ax},${ay} C${ax},${ay - dy} ${bx},${by + dy} ${bx},${by}`
  }

  /**
   * The time axis: tick times, day changes and the +gap of each break. Zoomed
   * out they crowd, so a label is kept only where it does not overlap one
   * already placed; days win, then breaks, then plain times.
   */
  function axisLabels(L) {
    const y = AXIS_H - 12
    const items = [
      ...L.ticks.map(t => ({ x: t.x, text: t.day ? when(t.t) : hhmm(t.t), cls: t.day ? 'day' : '', mid: false, rank: t.day ? 0 : 2, tick: true })),
      ...L.gaps.map(g => ({ x: g.x, text: `+${span(g.dt)}`, cls: 'gap', mid: true, rank: 1 })),
    ]
    const kept = []
    for (const it of items.slice().sort((a, b) => a.rank - b.rank || a.x - b.x)) {
      const w = it.text.length * 7
      it.a = it.mid ? it.x - w / 2 : it.x
      it.b = it.a + w
      if (kept.every(k => it.b + 8 < k.a || it.a > k.b + 8)) kept.push(it)
    }
    return kept
      .map(
        it =>
          `${it.tick ? `<line class="tick" x1="${it.x}" x2="${it.x}" y1="${AXIS_H - 6}" y2="${AXIS_H}"/>` : ''}<text class="${it.cls}" x="${it.x}" y="${y}"${it.mid ? ' text-anchor="middle"' : ''}>${esc(it.text)}</text>`
      )
      .join('')
  }

  /** What sits under a screen point, to keep it there across a zoom. */
  function anchorAt(scroller, anchor) {
    if (!anchor || !st.layout) return null
    const r = scroller.getBoundingClientRect()
    const sx = anchor.x - r.left
    const sy = anchor.y - r.top
    const x = scroller.scrollLeft + sx - labelWidth()
    const y = scroller.scrollTop + sy - AXIS_H
    // The nearest drawn node in time, and how far right of its left edge we were.
    let best = null
    for (const row of st.layout.rowList)
      for (const n of row.nodes) if (n.t && (!best || Math.abs(n.x - x) < Math.abs(best.x - x))) best = n
    return { sx, sy, id: best?.id, dx: best ? (x - best.x) / st.z : 0, fy: y / Math.max(1, st.layout.height) }
  }

  function restoreAnchor(scroller, a) {
    if (!a) return false
    const n = a.id && st.layout.rowList.flatMap(r => r.nodes).find(x => x.id === a.id)
    if (n) scroller.scrollLeft = n.x + a.dx * st.z + labelWidth() - a.sx
    scroller.scrollTop = a.fy * st.layout.height + AXIS_H - a.sy
    return true
  }

  function render(anchor) {
    if (!st.open || !st.data) return
    const d = st.data
    const scroller = document.getElementById('flowScroll')
    if (!scroller) return
    hide(true)
    fillTicketSelect(d)

    const { lanes, rows } = visible(d)
    const nodeCount = rows.reduce((n, r) => n + r.nodes.length, 0)
    // The chip is when it was built; the counts and the window are behind its ? (spec 5).
    window.Shell.setStatus(`built ${window.Shell.ago(d.builtAt) || '—'}`,
      `<p><b>${plural(rows.length, 'row')}</b> and <b>${plural(nodeCount, 'step')}</b>, from ${esc(when(d.from))}.</p>` +
      '<p>Built from the session transcripts and git, read again every minute while this page is open; Refresh rebuilds it now.</p>')
    if (!rows.length && st.ticket) {
      scroller.innerHTML = '<div class="empty">Nothing for this ticket in this window. <button class="link" data-key="">Show all tickets</button></div>'
      return
    }

    const keep = anchorAt(scroller, anchor)
    const L = layoutFor(lanes, scroller)
    const D = L.D
    st.layout = L
    st.z = D.z
    for (const r of L.rowList) for (const n of r.nodes) n.h = D.nodeH
    window.FlowZoom.show(document.querySelector('.flow-tools'), D.z, st.zoom === 'fit')
    const { nodeW: NODE_W, nodeH: NODE_H, rowH: ROW_H } = D
    const byId = new Map()
    for (const r of rows) for (const n of r.nodes) byId.set(n.id, { n, r })
    const laneOf = r => d.lanes[r.lane]

    const bands = lanes.map(l => `<rect class="lane-band" x="0" y="${l.y}" width="${L.width}" height="${LANE_H}"/>`).join('')
    const lines = [
      ...lanes.flatMap(l => [l.y + LANE_H, ...(l.emptyY != null ? [l.emptyY + ROW_H] : [])]),
      ...L.rowList.map(r => r.y + ROW_H),
    ]
      .map(y => `<line class="row-line" x1="0" x2="${L.width}" y1="${y - 0.5}" y2="${y - 0.5}"/>`)
      .join('')
    const gaps = L.gaps.map(g => `<line class="gap-line" x1="${g.x}" x2="${g.x}" y1="0" y2="${L.height}"/>`).join('')
    const edges = L.rowList
      .flatMap(r =>
        r.nodes.slice(1).map((n, i) => {
          const a = r.nodes[i]
          const y = a.y + NODE_H / 2
          return `<path class="edge${n.ghost ? ' ghost' : ''}" d="M${a.x + NODE_W},${y} L${n.x - 2},${y}" marker-end="url(#fm-row)"/>`
        })
      )
      .join('')
    const links = d.links
      .filter(k => byId.has(k.from) && byId.has(k.to))
      .map(k => {
        const kind = LINK_KINDS[k.kind] || 'message'
        return `<path class="link k-${kind}" data-from="${k.from}" data-to="${k.to}" d="${linkPath(byId.get(k.from).n, byId.get(k.to).n, D)}" marker-end="url(#fm-${kind})"/>`
      })
      .join('')
    const nodes = L.rowList.map(r => r.nodes.map(n => nodeSvg(n, r, laneOf(r), D.z)).join('')).join('')

    const axis = st.compact
      ? `<text x="${PAD}" y="${AXIS_H - 12}">Each row in its own time order, packed from the left. Times are on the nodes.</text>`
      : axisLabels(L)

    const labels = lanes
      .map(l => {
        const head = `<div class="lane-h" style="height:${LANE_H}px"><a href="#/agent/${encodeURIComponent(l.sessionId)}" title="Watch ${esc(l.label)} live">${esc(l.label)}</a>${stateChip(l.state || 'idle')}</div>`
        const empty = l.rows.length ? '' : `<div class="row-l" style="height:${ROW_H}px"><span class="empty-row">Nothing in this window</span></div>`
        return head + empty + l.rows.map(r => rowLabel(r, ROW_H)).join('')
      })
      .join('')

    const prev = { left: scroller.scrollLeft, top: scroller.scrollTop }
    scroller.innerHTML = `<div class="flow-grid${ROW_H < TIGHT_ROW ? ' tight' : ''}" style="grid-template-columns:${labelWidth()}px ${L.width}px">
      <div class="flow-corner" style="height:${AXIS_H}px">Agent · task</div>
      <div class="flow-axis" style="height:${AXIS_H}px"><svg class="axis" width="${L.width}" height="${AXIS_H}" aria-hidden="true">${axis}</svg></div>
      <div class="flow-labels">${labels}</div>
      <svg class="flow${D.z < MINI_BELOW ? ' mini' : ''}" width="${L.width}" height="${L.height}" role="group" aria-label="Timeline of agent operations">
        <defs>${MARKERS}<clipPath id="fn-clip"><rect width="${NODE_W / D.z}" height="${NODE_H / D.z}" rx="5"/></clipPath></defs>
        ${bands}${lines}${gaps}${edges}${links}${nodes}
      </svg>
    </div>`
    if (restoreAnchor(scroller, keep)) {
      st.jumpToEnd = false
    } else if (st.zoom === 'fit' && anchor === null) {
      // Fit just turned on: show it from the start.
      scroller.scrollLeft = 0
    } else if (st.jumpToEnd) {
      scroller.scrollLeft = scroller.scrollWidth
      scroller.scrollTop = 0
      st.jumpToEnd = false
    } else {
      scroller.scrollLeft = prev.left
      scroller.scrollTop = prev.top
    }
    window.UI.fade(scroller)
  }

  function rowLabel(r, ROW_H) {
    const pad = 16 + (r.depth || 0) * 16
    if (r.sub) {
      return `<div class="row-l sub" style="height:${ROW_H}px;padding-left:${pad}px" title="${esc(r.sub.description)}">
        <div class="k"><span class="faint">↳</span><span class="ttl">${esc(r.sub.description)}</span></div>
        <span class="small">subagent${r.sub.agentType ? ` · ${esc(r.sub.agentType)}` : ''}${r.sub.model ? ` · ${esc(r.sub.model)}` : ''}</span>
      </div>`
    }
    const t = r.task
    const key =
      t.key === 'none'
        ? `<span class="small">No ticket</span>`
        : `<span class="id" data-key="${esc(t.key)}" role="button" tabindex="0" title="${st.ticket ? 'Show all tickets' : 'Show only this ticket'}">${esc(t.label)}</span>`
    return `<div class="row-l" style="height:${ROW_H}px;padding-left:${pad}px" title="${esc(t.title || t.label)}">
      <div class="k">${key}${t.branch ? `<span class="branch ttl">${esc(t.branch)}</span>` : ''}</div>
      <span class="ttl">${esc(t.title || (t.key === 'none' ? 'names no ticket or worktree' : ''))}</span>
    </div>`
  }

  function fillTicketSelect(d) {
    const sel = document.getElementById('flowTicket')
    if (!sel) return
    const tasks = d.tasks.filter(t => t.key !== 'none')
    const missing = st.ticket && !tasks.some(t => t.key === st.ticket)
    sel.innerHTML =
      `<option value="">All tickets</option>` +
      tasks.map(t => `<option value="${esc(t.key)}">${esc(t.label)}${t.title ? ` · ${esc(t.title.slice(0, 48))}` : ''}</option>`).join('') +
      (missing ? `<option value="${esc(st.ticket)}">${esc(st.ticket)} (not in this window)</option>` : '')
    sel.value = st.ticket
  }

  // ─── popover ────────────────────────────────────────────────────────────────

  function detailHtml(n) {
    const d = n.detail || {}
    const out = []
    const quote = t => (t ? `<div class="quote">${esc(t)}</div>` : '')
    const kv = pairs =>
      `<dl class="kv">${pairs
        .filter(([, v]) => v)
        .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
        .join('')}</dl>`
    switch (n.type) {
      case 'brief':
      case 'heard':
        out.push(kv([['From', esc(d.from)]]), quote(d.text))
        break
      case 'message':
        out.push(kv([['To', esc(d.to)]]), quote(d.text))
        break
      case 'spawn':
        out.push(kv([['Subagent', esc(d.description)]]), d.text ? `<div class="sec">Its brief</div>${quote(d.text)}` : '')
        break
      case 'explore':
        out.push(
          `<div class="sec">${plural(d.total || 0, 'step')}${d.total > (d.items || []).length ? `, the last ${d.items.length}` : ''}</div>
          <ul>${(d.items || []).map(i => `<li><span class="faint">${hhmm(i.t)}</span> ${esc(i.what)} <span class="mono">${esc(i.text)}</span></li>`).join('')}</ul>`
        )
        break
      case 'edit':
        if (n.add || n.del) out.push(`<div class="pop-delta">${window.Diff.counts(n.add, n.del)}<span class="faint">lines added and removed</span></div>`)
        if (d.files?.length)
          out.push(
            `<div class="sec">Files</div><ul class="pop-files">${d.files
              .map(f => `<li><span class="mono">${esc(f.file)}</span> <span class="faint">${plural(f.count, 'edit')}</span> ${window.Diff.counts(f.add || 0, f.del || 0)}</li>`)
              .join('')}</ul>`
          )
        if (d.shell?.length) out.push(`<div class="sec">Edited from the shell</div>${d.shell.map(c => `<pre>${esc(c)}</pre>`).join('')}`)
        if (d.errors) out.push(`<div class="warn small">${plural(d.errors, 'edit')} failed and had to be redone</div>`)
        break
      case 'test':
        out.push(
          `<div class="sec">${plural(d.total || 0, 'run')}${d.total > (d.runs || []).length ? `, the last ${d.runs.length}` : ''}</div>` +
            (d.runs || [])
              .map(
                r => `<div><span class="dot ${r.verdict === 'pass' ? 'yes' : r.verdict === 'running' ? 'partly' : 'no'}"${r.verdict === 'fail' ? ' style="--dot: var(--bad)"' : ''}>${esc(VERDICT[r.verdict] || r.verdict)}</span>
                <span class="faint small">${hhmm(r.t)}</span> ${esc(r.summary)}</div>
                <pre>${esc(r.command)}</pre>${r.tail ? `<pre>${esc(r.tail)}</pre>` : ''}`
              )
              .join('')
        )
        break
      case 'commit':
        out.push(
          `<ul>${(d.commits || []).map(c => `<li>${c.sha ? `<span class="mono">${esc(c.sha.slice(0, 9))}</span> ` : ''}${esc(c.subject)}${c.branch ? ` <span class="branch">${esc(c.branch)}</span>` : ''}</li>`).join('')}</ul>`,
          d.fromGit ? '<div class="small">From git: no transcript in this window shows the commit being made.</div>' : '',
          d.pushed ? '<div class="small">Pushed in the same command.</div>' : ''
        )
        break
      case 'merge':
        out.push(`<div class="sec">Branches</div><ul>${(d.branches || []).map(b => `<li class="branch">${esc(b)}</li>`).join('')}</ul>`, d.command ? `<pre>${esc(d.command)}</pre>` : '', d.pushed ? '<div class="small">Pushed in the same command.</div>' : '')
        break
      case 'push':
        out.push(`<ul>${(d.refs || []).map(b => `<li class="branch">${esc(b)}</li>`).join('')}</ul>`)
        break
      case 'land':
        out.push(
          `<ul>${(d.landings || []).map(l => `<li><span class="branch">${esc(l.branch)}</span> via <span class="mono">${esc(l.sha)}</span> at ${esc(when(l.t))}<div class="small">${esc(l.subject)}</div></li>`).join('')}</ul>`,
          '<div class="small">From git: the first commit on that branch line that contains the work.</div>'
        )
        break
      case 'pending':
        if (d.dirty) out.push(`<div>${plural(d.dirty, 'file')} not committed yet in <span class="mono">${esc(d.worktree)}</span>.</div>`)
        else {
          const r = d.reached || {}
          out.push(
            `<div>The newest branch for this task, <span class="branch">${esc(d.branch)}</span>, is not there yet.</div>`,
            kv([
              ['followup', `<span class="dot ${r.followup ? 'yes' : 'no'}">${r.followup ? 'yes' : 'no'}</span>`],
              ['dev', `<span class="dot ${r.dev ? 'yes' : 'no'}">${r.dev ? 'yes' : 'no'}</span>`],
              ['stage', `<span class="dot ${r.stage ? 'yes' : 'no'}">${r.stage ? 'yes' : 'no'}</span>`],
            ])
          )
        }
        break
    }
    if (d.note) out.push(`<div class="sec">Its latest note</div>${quote(d.note)}`)
    return out.join('')
  }

  function show(g, pin) {
    const hit = findNode(g.dataset.id)
    if (!hit) return
    const { n, r } = hit
    hide(true)
    const lane = st.data.lanes[r.lane]
    const pop = document.createElement('div')
    pop.className = 'popover'
    pop.setAttribute('role', 'dialog')
    pop.setAttribute('aria-label', n.label)
    pop.style.setProperty('--c', `var(--t-${n.type})`)
    const range = n.t ? `${when(n.t)}${n.t2 ? ` to ${hhmm(n.t2)}` : ''}` : 'not yet'
    pop.innerHTML = `<div class="ph"><span class="bar"></span><div><div class="ttl">${esc(n.label)}</div>
        <div class="when">${esc(range)} · ${esc(lane.label)} · ${esc(r.sub ? `subagent: ${r.sub.description}` : r.task.label)}</div></div>
        ${pin ? '<button aria-label="Close" title="Close (Esc)">×</button>' : ''}</div>
      <div class="pb scroll" data-fade="tb">${detailHtml(n) || `<div class="small">${esc(n.sub)}</div>`}</div>`
    document.body.appendChild(pop)
    pop.querySelector('.ph button')?.addEventListener('click', () => {
      const back = st.pinned
      hide(true)
      back?.focus()
    })
    place(pop, g)
    window.UI.fade(pop.querySelector('.pb'))
    // Highlight the node's hand-offs.
    const svg = g.ownerSVGElement
    const id = g.dataset.id
    const linked = svg.querySelectorAll(`.link[data-from="${id}"], .link[data-to="${id}"]`)
    if (linked.length) {
      svg.classList.add('has-hl')
      linked.forEach(l => {
        l.classList.add('hl')
        const other = l.dataset.from === id ? l.dataset.to : l.dataset.from
        svg.querySelector(`.fn[data-id="${other}"]`)?.classList.add('hl')
      })
    }
    if (pin) {
      st.pinned = g
      g.classList.add('pinned')
    }
  }

  function place(pop, g) {
    const b = g.getBoundingClientRect()
    const p = pop.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    let top = b.bottom + 8
    if (top + p.height > vh - 8 && b.top - p.height - 8 > 8) top = b.top - p.height - 8
    top = Math.max(8, Math.min(top, vh - p.height - 8))
    const left = Math.max(8, Math.min(b.left, vw - p.width - 8))
    pop.style.top = `${top}px`
    pop.style.left = `${left}px`
  }

  function hide(all) {
    clearTimeout(st.hoverTimer)
    document.querySelectorAll('.popover').forEach(p => p.remove())
    document.querySelectorAll('svg.flow .hl, svg.flow .pinned').forEach(el => el.classList.remove('hl', 'pinned'))
    document.querySelector('svg.flow')?.classList.remove('has-hl')
    if (all) st.pinned = null
  }

  function togglePin(g) {
    if (st.pinned === g) {
      hide(true)
      return
    }
    show(g, true)
  }

  function findNode(id) {
    for (const r of st.data?.rows || []) {
      const n = r.nodes.find(x => x.id === id)
      if (n) return { n, r }
    }
    return null
  }

  // ─── open / close ───────────────────────────────────────────────────────────

  function open() {
    if (!st.built) build()
    if (st.open) return
    st.open = true
    st.jumpToEnd = true
    if (st.data) render()
    fetchFlow(false)
    st.timer = setInterval(() => document.visibilityState === 'visible' && fetchFlow(false), POLL_MS)
  }

  function close() {
    if (!st.open) return
    st.open = false
    clearInterval(st.timer)
    hide(true)
  }

  window.FlowView = { open, close, refresh: force => st.open && fetchFlow(force) }
})()
