// The quality marks on a flow (quality-routes.mjs GET /api/quality/flow/<id>, and the flow's own `risk`):
//
//   on the opened flow, above the views (flows.js fills the .fl-quality slot on every redraw):
//     [High risk]  It touches sign-in or sessions. It asks for a Security review and a deeper QA pass.
//     This task asks for a Security review, but there is no Security agent on the pipeline.     (only when one is missing)
//     Self-check by Agent 1: 6 ok, 1 no            each item with ok or no, and the note of a no
//     Second opinion on the plan: concerns         its points, its cost and age, that it never blocks, and the
//                                                  Second opinion button (quality.critic manual or auto, with a plan)
//   on a Flows board card: a Medium risk or High risk chip, its reasons in the tooltip (flow-board.js)
//   on the Agents diagram: the chip's tooltip gets one more line, `High risk: <reasons>` (pipeline-tickets.js)
// A low-risk flow with no self-check, no plan and nothing missing draws nothing: the panel is there when it has
// something to say. A read-only (archived or deleted) flow hides the button (quality.css).
//
//   chip(f), tip(t), panelHtml(data, state)   PURE
//   fill(el, f)                               fetch the panel's data when the flow changed, draw it, run the button
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const LEVEL = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' }
  /** MUST CHANGE IN LOCKSTEP with quality-risk.mjs NEED_WORDS. */
  const NEED = { security: 'a Security review', senior: 'a Senior review', 'deep-qa': 'a deeper QA pass' }
  const joinAnd = parts => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`)
  const isRisk = r => !!r && typeof r === 'object' && !!LEVEL[r.level]

  /** The reasons and what it asks for, as one plain line. */
  function riskLine(r) {
    const needs = (r.needs || []).map(n => NEED[n]).filter(Boolean)
    return [...(r.reasons || []), ...(needs.length ? [`It asks for ${joinAnd(needs)}.`] : [])].join(' ')
  }

  /** The Flows board card's chip: medium and high only. */
  function chip(f) {
    const r = f?.risk
    if (!isRisk(r) || r.level === 'low') return ''
    return `<span class="fl-chip qf-risk is-${esc(r.level)}" title="${esc(riskLine(r))}">${LEVEL[r.level]}</span>`
  }

  /** One more line for the diagram chip's tooltip, or ''. */
  function tip(t) {
    const r = t?.risk
    if (!isRisk(r) || r.level === 'low') return ''
    return `${LEVEL[r.level]}: ${(r.reasons || []).join(' ')}`
  }

  function selfcheckHtml(s) {
    if (!s || !Array.isArray(s.items)) return '<div class="qf-block"><h4 class="qf-h">Self-check</h4><p class="qf-line">No self-check yet. The builder runs <code>flow self-check</code> before it hands the flow to QA.</p></div>'
    const no = s.items.filter(it => it.ok === false).length
    const items = s.items.map(it => `<li class="${it.ok ? 'is-ok' : 'is-no'}"><span class="qf-tick">${it.ok ? 'ok' : 'no'}</span><span>${esc(it.text || it.lesson)}` +
      `${!it.ok && it.note ? `<span class="qf-note">${esc(it.note)}</span>` : ''}</span></li>`).join('')
    return `<div class="qf-block"><h4 class="qf-h">Self-check by ${esc(s.by)}: ${s.items.length - no} ok, ${no} no <span class="faint">· ${esc(window.Shell?.ago(s.at) || '')}</span></h4>` +
      `<ul class="qf-checks">${items}</ul><p class="qf-line faint">The builder's own claims before QA. QA still tests everything.</p></div>`
  }

  function criticHtml(d, state) {
    const c = d.critic
    const can = d.hasPlan && d.criticMode !== 'off'
    if (!c && !can) return ''
    const btn = can ? `<button type="button" data-qf-critic${state.running ? ' disabled' : ''}>${state.running ? 'Writing…' : c && d.criticCurrent ? 'Ask again' : 'Second opinion'}</button>` : ''
    const body = c
      ? `<h4 class="qf-h">Second opinion on the plan: ${esc(c.verdict)}</h4>` +
        (c.points?.length ? `<ul class="qf-points">${c.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : '<p class="qf-line">No concerns.</p>') +
        `<p class="qf-line faint">${d.criticCurrent ? '' : 'This second opinion is on an earlier plan. '}${typeof c.cost === 'number' ? `Cost $${c.cost.toFixed(2)} · ` : ''}${esc(window.Shell?.ago(c.at) || '')} · It never blocks: weigh it before the code is written.</p>`
      : '<h4 class="qf-h">Second opinion on the plan</h4><p class="qf-line">A cheap model run (about $0.01) reads the plan and lists what may be missing, before any code is written. It never blocks.</p>'
    return `<div class="qf-block">${body}${btn ? `<p class="qf-acts">${btn}${state.error ? `<span class="small warn" role="alert">${esc(state.error)}</span>` : ''}</p>` : ''}</div>`
  }

  /** The panel for one flow, or '' when there is nothing to say. `data` is GET /api/quality/flow/<id>'s answer. */
  function panelHtml(d, state = {}) {
    if (!d || !isRisk(d.risk)) return ''
    const quiet = d.risk.level === 'low' && !d.selfcheck && !d.critic && !d.hasPlan && !(d.missing || []).length
    if (quiet) return ''
    const line = riskLine(d.risk)
    return `<section class="qf" aria-label="Quality">` +
      `<div class="qf-risk-row"><span class="fl-chip qf-risk is-${esc(d.risk.level)}">${LEVEL[d.risk.level]}</span>${line ? `<span class="qf-why">${esc(line)}</span>` : '<span class="qf-why faint">Nothing it touches needs an extra review.</span>'}</div>` +
      (d.missingLine ? `<p class="qf-missing">${esc(d.missingLine)}</p>` : '') +
      `<div class="qf-blocks">${selfcheckHtml(d.selfcheck)}${criticHtml(d, state)}</div></section>`
  }

  window.QualityFlow = { chip, tip, panelHtml, riskLine }
  if (!window.document) return

  // ═══ the opened flow ═══

  const cache = new Map() // flow id -> { key, data }
  const state = { running: null, error: '' }
  const keyOf = f => JSON.stringify([f.id, f.updatedAt, f.risk, f.selfcheck?.at, f.critic?.at, f.plan?.file])

  async function load(f) {
    const r = await fetch(`/api/quality/flow/${encodeURIComponent(f.id)}`)
    if (!r.ok) return null
    return r.json()
  }

  function draw(el, id) {
    const hit = cache.get(id)
    const html = hit?.data ? panelHtml(hit.data, { running: state.running === id, error: state.running === id || state.errorFor === id ? state.error : '' }) : ''
    el.hidden = !html
    if (el.innerHTML !== html) el.innerHTML = html
  }

  /** Draw the panel for flow `f` into `el`; fetch again only when the flow changed. */
  async function fill(el, f) {
    if (!el || !f) return
    el.dataset.flow = f.id
    if (!el.dataset.bound) {
      el.dataset.bound = '1'
      el.addEventListener('click', e => {
        if (e.target.closest('[data-qf-critic]')) void ask(el, el.dataset.flow)
      })
    }
    const key = keyOf(f)
    const hit = cache.get(f.id)
    if (hit?.key === key) return draw(el, f.id)
    cache.set(f.id, { key, data: hit?.data || null })
    draw(el, f.id)
    try {
      const data = await load(f)
      if (cache.get(f.id)?.key !== key) return // a newer redraw is on its way
      cache.set(f.id, { key, data })
    } catch {
      // the panel stays as it was; the next redraw tries again
      cache.delete(f.id)
    }
    if (el.dataset.flow === f.id) draw(el, f.id)
  }

  async function ask(el, id) {
    if (state.running) return
    Object.assign(state, { running: id, error: '', errorFor: null })
    draw(el, id)
    let r
    try {
      const res = await fetch(`/api/quality/critic/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      r = { ok: res.ok, j: await res.json().catch(() => ({})) }
    } catch (e) {
      r = { ok: false, j: { error: e?.message || String(e) } }
    }
    Object.assign(state, { running: null, error: r.ok ? '' : r.j?.error || 'The second opinion could not be written.', errorFor: r.ok ? null : id })
    cache.delete(id)
    window.FlowsView?.load?.() // the flow file has the critic now: the redraw fetches the panel again
    const hit = await load({ id }).catch(() => null)
    if (hit) cache.set(id, { key: null, data: hit })
    if (el.dataset.flow === id) draw(el, id)
  }

  window.QualityFlow = { chip, tip, panelHtml, riskLine, fill }
})()
