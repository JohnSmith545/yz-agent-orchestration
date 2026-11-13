// The How to test block of a flow's Output (flow-output.js): the agent's test
// steps (`flow test-step`) as cards in a row joined by small arrows, wrapping
// onto more rows. Each card: a fixed 16:10 picture (the step's screenshot, or a
// quiet numbered placeholder with no text when it has none: the step is said
// once, under it), the step, `Expect` as a quieter second line, and your
// `I saw this` tick at the bottom edge (kept in this browser only,
// flow-output.js checklist).
//
// The request button (posted by flow-output.js) sits where it asks for: in the
// Picture head as Request visuals while the flow has no screenshot and no
// diagram (flow-visual.js), else in this head as Request test steps, or Ask
// again once there are steps or after a failed send. Marked words in a step
// become term chips.
//
//   html(c)      the block; `c` is flow-output.js's render context
//   request(c)   { label, html, form }: the button with what became of the last request, and its note form
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const chips = s => (window.Terms ? window.Terms.html(s) : s)
  const NOTE_MAX = 500 // MUST CHANGE IN LOCKSTEP with factory-routes.mjs NOTE_MAX
  const COST = 'about $0.30' // one relay turn (spec 7.4a)
  const picture = (ref, alt) => window.FlowDrawer.evidenceBody({ kind: 'shot', ref, label: alt })

  function request(c) {
    const { m, flow, asked } = c
    const visuals = m.visual === 'auto'
    const label = visuals ? 'Request visuals' : m.testing.length || asked?.why ? 'Ask again' : 'Request test steps'
    // The chat agent's own flow: the request goes into the Ask drawer for you to send, so it costs a chat turn, not a relay.
    const title = flow.agent && flow.agent === window.FactoryChat?.name ? `Put the request in the Ask drawer for ${flow.agent}, for you to send`
      : visuals ? `Ask ${flow.agent || 'the agent'} for a result screenshot or a diagram of how it works, and the test steps (${COST})`
      : `Ask ${flow.agent || 'the agent'} to drive the app and record each test step with a screenshot (${COST})`
    const said = asked?.why ? `<span class="sb-requested sb-unsent small" title="${esc(asked.why)}">${asked.text}</span>`
      : asked ? `<span class="sb-requested small faint">${asked.text}</span>` : ''
    return {
      label,
      html: `${said}<button type="button" class="link sb-request" data-sb-request aria-expanded="false" title="${esc(title)}">${label}</button>`,
      form: `<form class="sb-req-form" data-sb-form ${c.keyed('tf', flow.id)} hidden>
        <input name="note" maxlength="${NOTE_MAX}" placeholder="A note for the agent (optional)" aria-label="A note for the agent">
        <button type="submit" class="primary">Send</button><button type="button" class="link" data-sb-cancel>Cancel</button>
        <p class="small warn sb-req-error" hidden></p></form>`,
    }
  }

  function card(c, t, i) {
    const tick = c.checklist.of(t)
    const pic = t.shot ? picture(t.shot, `Step ${i + 1}`) : '<div class="ts-tile" aria-hidden="true"></div>'
    return `<li class="ts-card" ${c.keyed(`t:${t.id}`, [t, i])}><div class="ts-pic"><b class="ts-num">${i + 1}</b>${pic}</div>` +
      `<p class="ts-do">${chips(esc(t.do))}</p><p class="ts-expect"><span>Expect</span> ${chips(esc(t.expect))}</p>` +
      `<label class="check ts-saw"><input type="checkbox" data-sb-saw="${esc(tick)}"${c.done.has(tick) ? ' checked' : ''}> I saw this</label></li>`
  }

  function html(c) {
    const { m, flow, ticked, asked } = c
    const here = m.visual !== 'auto' // otherwise the button is in the Picture head
    const req = here ? request(c) : null
    // the count only once you have ticked one: before that it says nothing the cards do not
    const extra = (ticked ? `<span class="sb-count small">${ticked}/${m.testing.length} checked</span>` : '') + (req ? req.html : '')
    const head = `<div class="ts-head" ${c.keyed('th', [m.testing.length, ticked, here && asked, req?.label, flow.agent])}>${c.head('How to test', m.testing.length, '', extra)}</div>`
    return `<section class="ob ob-test" aria-label="How to test">${head}${req ? req.form : ''}` +
      (m.testing.length ? `<ol class="ts-row">${m.testing.map((t, i) => card(c, t, i)).join('')}</ol>` : '<p class="small faint ob-empty">No test steps yet.</p>') +
      '</section>'
  }

  window.FlowSteps = { html, request }
})()
