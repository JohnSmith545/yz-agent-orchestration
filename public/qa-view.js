// The QA page's markup (qa-page.js mounts it, #/qa): the tickets that passed QA,
// and one ticket opened. Everything here is a string from the /api/qa data
// (pipeline-routes.mjs qaGet); nothing touches the DOM, so the tests run it.
//
//   the list    one row per ticket that passed, newest QA result first, each a link to
//               #/qa/<flow id>: a green dot and the word Passed (colour is never the only
//               signal), the title, the ticket ids, the agent, the tested commit's short
//               sha, and when QA pushed it (or not pushed yet)
//   one ticket  ← QA and Explain in Flows; the title; one meta line (the QA state, the
//               attempt, the agent, the tickets, the commit and the branch, linked to
//               GitHub in a new tab when the remote is GitHub, else as plain text, and the
//               push); the rework line when QA failed (flow-qa-line.js); QA's summary; the
//               report (through FlowDrawer.md, the one safe Markdown renderer: nothing in
//               it is ever rendered as HTML); the screenshots as thumbnails that open in the
//               lightbox; How to test, QA's steps as the same cards Output draws (flow-steps.js
//               look, no checklist: QA did the testing); the earlier attempts, one line each
//
//   a ticket QA never saw  neutral, never red (red means QA failed it): why QA has no record (it
//               changed no code, is still being worked on, waits for QA, was dropped), and its
//               How to test and Explain in Flows
//
//   rows(flows)              PURE: the passed ones, newest first
//   listHtml(data, now?)     the list, or its one-line empty state
//   detailHtml(flow, now?)   one ticket
//   missingHtml(id, flow)    a ticket with no QA record; `flow` (GET /api/flows/<id>) or null
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const chips = s => (window.Terms ? window.Terms.html(s) : s)
  const enc = encodeURIComponent
  const SEP = '<span class="fl-sep" aria-hidden="true">·</span>'
  const short = sha => String(sha || '').slice(0, 7)
  // only a GitHub page from the server (pipeline-routes.mjs webUrlOf) is ever a link
  const safe = url => (typeof url === 'string' && /^https:\/\//.test(url) ? url : null)
  const out = (url, inner) => (safe(url) ? `<a class="link" href="${esc(url)}" target="_blank" rel="noopener">${inner}</a>` : inner)
  const when = f => String(f.qa?.at || f.updatedAt || '')
  // the page's words for a state: Passed and Failed read as the result; the rest keep FlowQa's
  const WORD = { passed: 'Passed', failed: 'Failed' }
  const mark = f => window.FlowQa.mark(f, WORD[window.FlowQa.state(f)?.key])

  const rows = flows => (Array.isArray(flows) ? flows : []).filter(f => f?.qa?.status === 'passed').sort((a, b) => when(b).localeCompare(when(a)))

  function pushed(f, now) {
    if (f.qa?.pushedAt) return `pushed ${window.Shell.ago(f.qa.pushedAt, now)}`
    if (f.qa?.pushError) return `<span class="warn" title="${esc(f.qa.pushError)}">push refused</span>`
    return f.qa?.status === 'passed' ? 'not pushed yet' : ''
  }
  const ids = f => (f.tickets || []).map(t => `<span class="id">${esc(t)}</span>`).join(' ')

  function row(f, now) {
    const meta = [ids(f), esc(f.agent), f.qa?.commit ? `<code>${esc(short(f.qa.commit))}</code>` : '', pushed(f, now)].filter(Boolean).join(' · ')
    return `<li><a class="qa-row" href="#/qa/${esc(enc(f.id))}">${mark(f)}<span class="qa-row-title">${esc(f.title)}</span>` +
      `<span class="qa-row-meta">${meta}</span></a></li>`
  }

  function listHtml(data, now = Date.now()) {
    const list = rows(data?.flows)
    if (!list.length) return '<p class="small faint qa-empty">Nothing has passed QA yet. A ticket lands here once QA has tested its change and recorded a pass.</p>'
    return `<ol class="qa-list">${list.map(f => row(f, now)).join('')}</ol>`
  }

  // ═══ one ticket ═══

  const picture = (ref, alt) => window.FlowDrawer.evidenceBody({ kind: 'shot', ref, label: alt })
  const block = (name, n, body) => `<section class="qa-block" aria-label="${name}"><h3 class="qa-h">${name}${n ? ` <span class="faint">· ${n}</span>` : ''}</h3>${body}</section>`

  function report(r) {
    if (!r) return block('Report', 0, '<p class="small faint">No report.</p>')
    if (r.text == null) return block('Report', 0, '<p class="small faint">The report file is missing.</p>')
    const cut = r.truncated ? `<p class="small faint">The report is longer than 64 KB: only the start shows. ${out(r.url, 'Open the full report')}</p>` : ''
    return block('Report', 0, `<div class="qa-report">${window.FlowDrawer.md(r.text)}</div>${cut}`)
  }

  function step(s, i) {
    const pic = s.shot ? picture(s.shot, `Step ${i + 1}`) : '<div class="ts-tile" aria-hidden="true"></div>'
    return `<li class="ts-card qa-step"><div class="ts-pic"><b class="ts-num">${i + 1}</b>${pic}</div>` +
      `<p class="ts-do">${chips(esc(s.do))}</p><p class="ts-expect"><span>Expect</span> ${chips(esc(s.expect))}</p></li>`
  }

  function detailHtml(f, now = Date.now()) {
    const qa = f.qa || {}
    const links = f.links || {}
    const meta = [
      mark(f), qa.attempt ? `attempt ${esc(qa.attempt)}` : '', `<b>${esc(f.agent)}</b>`, ids(f),
      qa.commit ? out(links.commit, `<code>${esc(short(qa.commit))}</code>`) : '',
      qa.branch ? out(links.branch, `<code>${esc(qa.branch)}</code>`) : '', pushed(f, now),
    ].filter(Boolean).join(SEP)
    const shots = f.shots || []
    const steps = Array.isArray(qa.steps) ? qa.steps : []
    const earlier = Array.isArray(qa.attempts) ? qa.attempts : []
    const attempt = a => `<li>Attempt ${esc(a.attempt)} · ${esc(a.status)}${a.commit ? ` · <code>${esc(short(a.commit))}</code>` : ''}${a.summary ? ` · ${esc(a.summary)}` : ''}</li>`
    return `<section class="card qa-open" data-qa-flow="${esc(f.id)}">` +
      `<div class="qa-open-top"><a class="link" href="#/qa">← QA</a><button type="button" class="link" data-qa-explain="${esc(f.id)}">Explain in Flows</button></div>` +
      `<h2 class="qa-title" tabindex="-1">${esc(f.title)}</h2><p class="qa-meta">${meta}</p>${window.FlowQa.reworkHtml(f)}` +
      (qa.summary ? `<div class="qa-summary">${window.FlowDrawer.md(qa.summary)}</div>` : '') +
      report(f.report) +
      (shots.length ? block('Screenshots', shots.length, `<ul class="pv-film qa-shots">${shots.map(s => `<li>${picture(s.ref, 'QA screenshot')}</li>`).join('')}</ul>`) : '') +
      (steps.length ? block('How to test', steps.length, `<ol class="ts-row">${steps.map(step).join('')}</ol>`) : '') +
      (earlier.length ? block('Earlier attempts', earlier.length, `<ul class="qa-attempts small">${earlier.map(attempt).join('')}</ul>`) : '') +
      '</section>'
  }

  // ═══ a ticket QA never saw ═══
  // Not a failure, so nothing here is red (red means QA failed it): it says in plain words why QA has
  // no record, and sends you to the flow, whose Output tab has its own How to test.

  function missingWhy(f) {
    if (!f) return 'QA tests a ticket only when it changes code, so this one may have changed none, or not reached QA yet.'
    if (f.status === 'dropped') return 'It was dropped before it reached QA.'
    if (!window.FlowQa.codeProducing(f)) return 'It changed no code, so it skipped QA: QA tests only changes to code.'
    if (f.status === 'done') return 'It changed code and is waiting for QA.'
    return 'It is still being worked on: QA tests it once the change is finished.'
  }

  /** `flow` is the flow itself (GET /api/flows/<id>) for its title and status, or null when it could not be read. */
  function missingHtml(id, flow) {
    return `<section class="card qa-open qa-missing" data-qa-flow="${esc(id)}">` +
      '<div class="qa-open-top"><a class="link" href="#/qa">← QA</a></div>' +
      `<h2 class="qa-title" tabindex="-1">${esc(flow?.title || id)}</h2>` +
      `<p class="qa-missing-why">This ticket has not been through QA. ${esc(missingWhy(flow))}</p>` +
      '<p class="small qa-missing-next">Its flow has its own How to test, on the Output tab.</p>' +
      `<p class="qa-missing-acts"><button type="button" class="link" data-qa-output="${esc(id)}">How to test in Flows</button>` +
      `<button type="button" class="link" data-qa-explain="${esc(id)}">Explain in Flows</button></p></section>`
  }

  window.QaView = { rows, listHtml, detailHtml, missingHtml }
})()
