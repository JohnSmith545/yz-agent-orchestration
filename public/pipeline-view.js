// The Agents page diagram (#/agents) in the page: HTML boxes over one SVG of arrows, placed by
// pipeline-layout.js, with each box's ticket chips from pipeline-tickets.js.
//
//   PipelineView.create(box, { onNode, onChip })   -> { update(data), setPath(h), setNode(id) }
//     update({ graph, tickets, agents })  draws or patches: the boxes and arrows are built ONCE per graph and
//                                         after that only moved and refilled, so a refresh never flickers and
//                                         never loses focus; a new width (ResizeObserver) lays out again
//     setPath({ nodes, edges } | null)    one ticket's path in the accent colour, the rest dimmed
//     setNode(id | null)                  the box whose details show below
//   PipelineView.nodeInner(node, opts)    PURE: the inside of one box (its name, a red mark for pushes
//                                         outside QA, +N, the chips), for the tests
//
// A click on a chip is onChip(ticketId) (the page opens its explanation on Flows); a click anywhere else on
// a box is onNode(nodeId). Each box's name is a button, so Tab and Enter reach every node.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const cls = s => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '')

  /** Pure: one box's inside. `list` is the tickets standing on it, `pushes` its pushes outside QA today. */
  function nodeInner(node, { list = [], labels = {}, pushes = 0 } = {}) {
    const T = window.PipelineTickets
    const { shown, more } = T.chips(list)
    const n = list.length
    const mark = pushes > 0 ? `<i class="pl-mark" title="${esc(window.PipelineDetails.pushLine(pushes))}"></i>` : ''
    const said = `${node.label}, ${n ? `${n} ticket${n === 1 ? '' : 's'}` : 'no tickets'}${pushes > 0 ? `, ${window.PipelineDetails.pushLine(pushes)}` : ''}. Show details.`
    return `<button type="button" class="pl-node-head" aria-label="${esc(said)}"><span class="pl-name">${esc(node.label)}</span>${mark}` +
      `${more ? `<span class="pl-more" title="${more} more here">+${more}</span>` : ''}</button>` +
      (shown.length ? `<div class="pl-chips">${shown.map(t => T.chipHtml(t, labels)).join('')}</div>` : '')
  }

  const signature = g => JSON.stringify([(g?.nodes || []).map(n => [n.id, n.label, n.kind, n.role]), (g?.edges || []).map(e => [e.from, e.to, e.kind, e.label || ''])])

  function labelSvg(l) {
    const rot = l.rotate ? ` transform="rotate(${l.rotate} ${l.x} ${l.y})"` : ''
    return `<text class="pl-label" x="${l.x}" y="${l.y}" text-anchor="${l.anchor}"${rot} data-edges="${l.edges.join(' ')}">${esc(l.text)}</text>`
  }

  function create(box, { onNode = () => {}, onChip = () => {} } = {}) {
    const st = { sig: '', graph: null, rows: 0, width: 0, canvas: null, svg: null, nodes: new Map(), edges: new Map(), labels: null, labelsHtml: '', inner: new Map(), path: null, node: null }

    box.addEventListener('click', e => {
      const chip = e.target.closest('[data-ticket]')
      if (chip && box.contains(chip)) return onChip(chip.dataset.ticket)
      const n = e.target.closest('[data-node]')
      if (n && box.contains(n)) onNode(n.dataset.node)
    })

    function build(graph) {
      const lay = window.PipelineLayout.layout(graph, { width: box.clientWidth || 1000, rows: st.rows })
      box.innerHTML = `<div class="pl-canvas" role="group" aria-label="Who hands work to whom, from the request to the outcome">` +
        `<svg class="pl-svg" aria-hidden="true" focusable="false"><g class="pl-edges">${lay.edges
          .map(e => `<g class="pl-edge k-${cls(e.kind)}" data-edge="${e.i}"><path class="pl-line"/><path class="pl-head"/></g>`)
          .join('')}</g><g class="pl-labels"></g></svg>` +
        `${(graph.nodes || []).map(n => `<div class="pl-node r-${cls(n.role)} n-${cls(n.kind)}" data-node="${esc(n.id)}"></div>`).join('')}</div>`
      st.canvas = box.querySelector('.pl-canvas')
      st.svg = box.querySelector('.pl-svg')
      st.labels = box.querySelector('.pl-labels')
      st.labelsHtml = ''
      st.nodes = new Map([...box.querySelectorAll('.pl-node')].map(el => [el.dataset.node, el]))
      st.edges = new Map([...box.querySelectorAll('.pl-edge')].map(el => [Number(el.dataset.edge), el]))
      st.inner = new Map()
      st.width = 0
    }

    /** Lay out at the box's width and move everything into place; nothing is rebuilt. */
    function draw(force) {
      if (!st.graph || !st.canvas) return
      const width = box.clientWidth
      if (!width || (!force && width === st.width)) return
      st.width = width
      const lay = window.PipelineLayout.layout(st.graph, { width, rows: st.rows })
      st.canvas.style.width = `${lay.width}px`
      st.canvas.style.height = `${lay.height}px`
      st.canvas.dataset.dir = lay.dir
      st.svg.setAttribute('width', lay.width)
      st.svg.setAttribute('height', lay.height)
      st.svg.setAttribute('viewBox', `0 0 ${lay.width} ${lay.height}`)
      for (const b of lay.nodes) {
        const el = st.nodes.get(b.id)
        if (el) Object.assign(el.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` })
      }
      for (const e of lay.edges) {
        const g = st.edges.get(e.i)
        if (!g) continue
        g.firstChild.setAttribute('d', e.d)
        g.lastChild.setAttribute('d', e.head)
      }
      const html = lay.labels.map(labelSvg).join('')
      if (html !== st.labelsHtml) {
        st.labels.innerHTML = html
        st.labelsHtml = html
      }
      paint()
    }

    /** The selected path and node, as classes: the canvas dims what is off the path. */
    function paint() {
      if (!st.canvas) return
      const h = st.path
      const onNodes = new Set(h?.nodes || [])
      const onEdges = new Set(h?.edges || [])
      st.canvas.classList.toggle('has-path', !!h)
      for (const [id, el] of st.nodes) {
        el.classList.toggle('on', onNodes.has(id))
        el.classList.toggle('sel', id === st.node)
        el.querySelector('.pl-node-head')?.setAttribute('aria-pressed', String(id === st.node))
      }
      for (const [i, g] of st.edges) g.classList.toggle('on', onEdges.has(i))
      for (const t of st.labels?.querySelectorAll('text') || []) t.classList.toggle('on', t.dataset.edges.split(' ').some(i => onEdges.has(Number(i))))
    }

    function update({ graph, tickets = [], agents = [] }) {
      if (!graph) return
      const T = window.PipelineTickets
      const groups = T.byNode(tickets)
      const rows = T.chipRows(groups)
      const sig = signature(graph)
      let relayout = rows !== st.rows
      st.rows = rows
      st.graph = graph
      if (sig !== st.sig) {
        st.sig = sig
        build(graph)
        relayout = true
      }
      const labels = T.labelsOf(graph)
      for (const n of graph.nodes || []) {
        const el = st.nodes.get(n.id)
        if (!el) continue
        const agent = n.kind === 'agent' ? agents.find(a => a.label === n.label) : null
        const html = nodeInner(n, { list: groups[n.id] || [], labels, pushes: window.PipelineDetails.pushes(agent) })
        if (st.inner.get(n.id) !== html) {
          el.innerHTML = html
          st.inner.set(n.id, html)
        }
        el.classList.toggle('busy', !!(groups[n.id] || []).length)
      }
      draw(relayout)
      paint()
    }

    if ('ResizeObserver' in window) new ResizeObserver(() => draw(false)).observe(box)
    else window.addEventListener('resize', () => draw(false))

    return {
      update,
      setPath(h) {
        st.path = h && (h.nodes?.length || h.edges?.length) ? h : null
        paint()
      },
      setNode(id) {
        st.node = id || null
        paint()
      },
    }
  }

  window.PipelineView = { create, nodeInner, signature }
})()
