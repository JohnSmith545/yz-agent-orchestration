// The Picture block of a flow's Output (flow-output.js). A visual is a must, so
// it always shows ONE picture, full width of the block and centred, picked the
// way flows.mjs visualOf picks (MUST CHANGE IN LOCKSTEP):
//   shots    the result screenshots (`flow result`, else the latest screenshots in the
//            flow's evidence): one big image, the others as small thumbnails under it
//   diagram  the agent's `flow diagram`, drawn by diagram.js
//   auto     a summary chart the page draws from the flow (flow-picture.js), with the
//            one line of counts under it (`7 done · 5 left · 2 decisions`); a click on
//            a box opens that step on Status (data-goto, flows.js); its head carries the
//            Request visuals button, since that is what is missing
// The before and after is flow-compare.js: a before and after pair in place of the one big
// image, a Compare view, and the diagram of how it worked before beside the diagram (the
// Before / Now lines are their own block, flow-output.js). A small switch `Screens | Compare |
// How it works` offers the views that exist (FlowCompare.views), remembered in this browser
// (localStorage flows.picture). The block has no head, no label and no auto chip: the picture
// speaks for itself, with the switch (several views) or the Request visuals link in its corner.
//
//   html(c)      the block; `c` is flow-output.js's render context ({ m, keyed, head, chart })
//   pref         get / set the switch: 'screens' (the default), 'compare' or 'how'
//   shows(m)     what the block shows: 'screens', 'compare', 'how' or 'auto'
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const KEY = 'flows.picture'
  const VIEWS = ['screens', 'compare', 'how']
  const LABELS = { screens: 'Screens', compare: 'Compare', how: 'How it works' }
  const pref = {
    get() {
      try { const v = JSON.parse(localStorage.getItem(KEY)); return VIEWS.includes(v) ? v : 'screens' } catch { return 'screens' }
    },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(VIEWS.includes(v) ? v : 'screens')) } catch {} },
  }
  const C = () => window.FlowCompare
  const picture = (ref, alt) => window.FlowDrawer.evidenceBody({ kind: 'shot', ref, label: alt })

  function screens(m) {
    const [hero, ...film] = m.result
    if (!hero) return ''
    return `<figure class="pv-hero">${picture(hero.ref, hero.caption || 'The result')}${hero.caption ? `<figcaption>${esc(hero.caption)}</figcaption>` : ''}</figure>` +
      (film.length ? `<ul class="pv-film">${film.map(s => `<li title="${esc(s.caption)}">${picture(s.ref, s.caption || 'The result')}</li>`).join('')}</ul>` : '')
  }

  /** What the block shows: 'screens', 'compare', 'how' (the agent diagram) or 'auto' (the summary chart). */
  function shows(m) {
    if (m.visual === 'auto') return 'auto'
    if (m.visual === 'diagram') return 'how'
    const p = pref.get()
    return C().views(m).includes(p) ? p : 'screens'
  }

  function html(c) {
    const { m } = c
    const views = C().views(m)
    const show = shows(m)
    const seg = views.length > 1 ? `<div class="ob-seg" role="group" aria-label="Show">${views
      .map(v => `<button type="button" data-pic="${v}" aria-pressed="${show === v}">${LABELS[v]}</button>`).join('')}</div>` : ''
    const body = show === 'screens' ? (C().screens(c, screens) ?? screens(m))
      : show === 'compare' ? C().compare(c)
      : show === 'how' ? C().how(c)
      : c.chart('picture', m.picture, 'What happened') + (m.picture.line ? `<p class="pv-line small">${esc(m.picture.line)}</p>` : '')
    // no visual from the agent: the request for one is here, where it is missing (flow-steps.js request)
    const req = show === 'auto' ? window.FlowSteps.request(c) : null
    const sig = [show, m.result, m.before, m.diagram, m.diagramBefore, m.picture, m.source.result, C().step.raw(c.flow.id), req && [req.label, c.asked, c.flow.agent]]
    // no label and no auto chip: the picture speaks for itself; the switch (several views) or the request in the corner
    const corner = (views.length > 1 ? seg : '') + (req ? req.html : '')
    const top = corner ? `<span class="ob-corner">${corner}</span>` : ''
    return `<section class="ob ob-picture" aria-label="Picture" ${c.keyed('picture', sig)}>` +
      top + (req ? req.form : '') + `<div class="pv-body pv-${show}">${body}</div></section>`
  }

  window.FlowVisual = { html, pref, shows }
})()
