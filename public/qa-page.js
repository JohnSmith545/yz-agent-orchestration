// The QA page (#/qa): the tickets QA passed, and one opened at #/qa/<flow id>
// (qa-view.js draws both). The shell calls open(id) as the route comes and goes
// (id null for the list) and close() when it leaves; this file fetches, mounts
// and writes the page head (`QA · N`, N the tickets that passed).
//
// It reads GET /api/qa?status=passed on every open, and every 30 s while it shows. A ticket opened
// by link that may not be in that list (one that failed, opened from the Explain
// tab, or one QA never saw) is read AT ONCE, beside the list, never after it: GET
// /api/qa (every status) for its QA record and GET /api/flows/<id> for its title.
// ⚠️ Reading them one after the other left a direct load on Loading… for both
// round trips (each /api/qa reads git remotes and every report). With no QA
// record the ticket is drawn neutral, never red (red means QA failed it): why QA
// has not seen it, and its How to test in Flows (QaView.missingHtml).
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
  let gen = 0 // the list loads: a later one wins
  let epoch = 0 // one per mount: a ticket read in flight when the page closes lands nowhere
  let data = null // the last /api/qa?status=passed
  let extra = new Map() // flow id -> { qa: its /api/qa record or null, flow: GET /api/flows/<id> or null }, once read
  const asked = new Set() // flow ids being read now
  let error = ''
  let selected = null
  let drawn = ''

  const find = id => (data?.flows || []).find(f => f.id === id) || extra.get(id)?.qa || null

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
    } catch (e) {
      if (mine !== gen || !box) return
      error = String(e?.message || e)
    }
    render()
    paint()
  }

  /** One ticket the passed list may leave out: its QA record (every status) and the flow, both at once. `again`: read it anew. */
  async function loadOne(id, again = false) {
    if (asked.has(id) || (extra.has(id) && !again)) return
    asked.add(id)
    const mine = epoch
    const [all, flow] = await Promise.allSettled([get('/api/qa'), get(`/api/flows/${encodeURIComponent(id)}`)])
    asked.delete(id)
    if (mine !== epoch || !box) return
    const qa = all.status === 'fulfilled' ? (all.value.flows || []).find(f => f.id === id) || null : null
    extra.set(id, { qa, flow: flow.status === 'fulfilled' ? flow.value : null })
    render()
    paint()
  }

  function render() {
    if (!box) return
    let html
    if (selected) {
      const f = find(selected)
      html = f ? window.QaView.detailHtml(f)
        : extra.has(selected) ? window.QaView.missingHtml(selected, extra.get(selected).flow)
        : error && !asked.has(selected) ? `<p class="small warn">QA: ${esc(error)}</p>` : '<p class="small faint">Loading…</p>'
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
    if (x) return window.FlowsView?.explain(x.dataset.qaExplain)
    const out = e.target.closest('[data-qa-output]') // a ticket QA never saw: its own How to test, on Output
    if (out) window.FlowsView?.gotoFlow(out.dataset.qaOutput, null, 'output')
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
    }
    // EVERY open reads the list again (back from another page, ← QA from a ticket): a ticket may have passed
    // since. The last list (kept across close) shows meanwhile, never an empty one or Loading…
    void load()
    // at once, beside the list: before the list has answered, any ticket; after, only one it lacks
    if (selected && !find(selected)) void loadOne(selected)
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
    epoch++
    box.removeEventListener('click', onClick)
    box = null
    view().innerHTML = ''
    extra = new Map()
    asked.clear()
    drawn = ''
    selected = null
  }

  /** Read again now (a Retry on a rework line, flow-qa-line.js); a ticket read on its own is read again too. */
  function update() {
    if (!box) return
    void load()
    if (selected && extra.has(selected)) void loadOne(selected, true) // what shows stays until the new read lands
  }

  function gotoFlow(flowId) {
    if (!flowId) return window.Shell.go('#/qa')
    window.Shell.go(`#/qa/${encodeURIComponent(flowId)}`)
    window.Shell.whenReady('#qaView .qa-box', () => { if (selected !== flowId) open(flowId) })
  }

  window.QaPage = { open, close, update, gotoFlow }
})()
