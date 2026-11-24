// The QA page (#/qa): the tickets QA passed, and one opened at #/qa/<flow id>
// (qa-view.js draws both). The shell calls open(id) as the route comes and goes
// (id null for the list) and close() when it leaves; this file fetches, mounts
// and writes the page head (`QA · N`, N the tickets that passed).
//
// It reads GET /api/qa?status=passed every 30 s while it shows. A ticket opened
// by link that is not in that list (one that failed, opened from the Explain tab)
// is read from GET /api/qa, every status, and kept until the page closes.
//
//   window.QaPage = { open(id), close(), update(), gotoFlow(flowId) }
//   gotoFlow  from any page (the Agents page, the Explain tab): goes to #/qa/<id>,
//             and opens it once the page has mounted (Shell.whenReady, as FlowsView does)
;(() => {
  const POLL_MS = 30_000
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const view = () => document.getElementById('qaView')
  let box = null // the page's one box, while mounted
  let timer = null
  let gen = 0
  let data = null // the last /api/qa?status=passed
  let extra = new Map() // flow id -> a flow read from /api/qa (all) because the passed list lacks it; null: not found
  let error = ''
  let selected = null
  let drawn = ''

  const find = id => (data?.flows || []).find(f => f.id === id) || extra.get(id) || null

  async function get(url) {
    const r = await fetch(url)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
    return j
  }

  async function load() {
    const mine = ++gen
    try {
      const j = await get('/api/qa?status=passed')
      if (mine !== gen || !box) return
      data = j
      error = ''
      if (selected && !find(selected) && !extra.has(selected)) await loadOne(selected, mine)
    } catch (e) {
      if (mine !== gen || !box) return
      error = String(e?.message || e)
    }
    render()
    paint()
  }
  /** A ticket the passed list leaves out: read every QA record and keep it (null: QA has none for it). */
  async function loadOne(id, mine) {
    try {
      const all = await get('/api/qa')
      if (mine !== gen || !box) return
      extra.set(id, (all.flows || []).find(f => f.id === id) || null)
    } catch {
      extra.set(id, null)
    }
  }

  function render() {
    if (!box) return
    let html
    if (selected) {
      const f = find(selected)
      html = f ? window.QaView.detailHtml(f)
        : !data || !extra.has(selected) ? (error ? `<p class="small warn">QA: ${esc(error)}</p>` : '<p class="small faint">Loading…</p>')
        : `<section class="card qa-open"><div class="qa-open-top"><a class="link" href="#/qa">← QA</a></div><p class="small warn">QA has no record of ${esc(selected)}.</p></section>`
    } else {
      html = error && !data ? `<p class="small warn">QA: ${esc(error)}</p>` : data ? window.QaView.listHtml(data) : '<p class="small faint">Loading…</p>'
    }
    if (html === drawn) return
    drawn = html
    box.innerHTML = html
    if (!selected) window.Motion?.enterList?.(box, '.qa-row') // the first render with rows only, never a poll
  }

  function paint() {
    if (!box || window.Shell.current?.view !== 'qa') return
    const n = data ? window.QaView.rows(data.flows).length : null
    window.Shell.setTitle('QA', 'qa', n)
    if (!data) return window.Shell.setStatus(error ? 'not loaded' : 'Loading…')
    window.Shell.setStatus(`updated ${window.Shell.ago(data.builtAt)}`,
      `<p>The number is the tickets QA passed: <b>${n}</b>. QA is the last stage before a push: it tests the change, writes a report, and pushes the branch at the commit it tested.</p>` +
      '<p>Open one for the report, the screenshots and the steps to test it yourself. <b>Explain in Flows</b> walks through the whole ticket.</p>' +
      '<p>The page reads them again every 30 seconds.</p>')
  }

  function onClick(e) {
    const x = e.target.closest('[data-qa-explain]')
    if (x) window.FlowsView?.explain(x.dataset.qaExplain)
  }

  function open(id) {
    const next = id || null
    const moved = next !== selected
    selected = next
    if (!box) {
      box = document.createElement('div')
      box.className = 'qa-box'
      view().replaceChildren(box)
      box.addEventListener('click', onClick)
      window.Lightbox.bind(box)
      timer = setInterval(load, POLL_MS)
      drawn = ''
      void load()
    } else if (selected && !find(selected) && data && !extra.has(selected)) {
      void loadOne(selected, gen).then(() => { render(); paint() })
    }
    render()
    paint()
    if (moved) {
      window.scrollTo?.({ top: 0 })
      box.querySelector('.qa-title')?.focus({ preventScroll: true })
    }
  }

  function close() {
    if (!box) return
    clearInterval(timer)
    timer = null
    gen++ // a load in flight lands nowhere
    box.removeEventListener('click', onClick)
    box = null
    view().innerHTML = ''
    extra = new Map()
    drawn = ''
    selected = null
  }

  /** Read again now (a Retry on a rework line, flow-qa-line.js). */
  function update() {
    if (box) void load()
  }

  function gotoFlow(flowId) {
    if (!flowId) return window.Shell.go('#/qa')
    window.Shell.go(`#/qa/${encodeURIComponent(flowId)}`)
    window.Shell.whenReady('#qaView .qa-box', () => { if (selected !== flowId) open(flowId) })
  }

  window.QaPage = { open, close, update, gotoFlow }
})()
