// Predict and warn on the page, the PURE half: the words and the HTML, no DOM, no fetch, no storage (predict-alerts.js
// and predict-flow.js do those), so test/predict-view.test.mjs runs it in a vm with a bare window.
//
//   duration(ms) / tokens(n) / usd(n)   MUST CHANGE IN LOCKSTEP with predict-words.mjs: '3 h 20 min', '12.4M', '$4.10'
//   lineHtml(data, { open })            the Alerts line at the top of the Agents page: how many, what kinds, Show
//                                       them, the ? (a group counts as one)
//   groupAlerts(list)                   GROUP_MIN or more Taking long alerts of ONE agent become one group item
//                                       { kind: 'group', key, agent, alerts }, in the place of its first member
//   listHtml(data)                      its rows: the alert in words, Open the flow, Copy handover request (a context
//                                       alert), Snooze for a week (a flow alert), Dismiss for today; a group's row
//                                       with Dismiss all for today and its flows folded under it; how many were
//                                       dismissed today and how many are snoozed
//   homeHtml(data)                      Home's one line: the count and a link to them
//   costHtml(info, { open })            the Cost block of a flow's Output tab: its tokens and dollars, its estimate,
//                                       and estimate against actual once it finished (GET /api/predict/flow)
//   ticketHtml(info)                    a ticket not yet started: its estimate on one line (GET /api/predict/ticket)
//   accuracyHtml(acc)                   how good the estimates have been, inside Pipeline time (GET /api/predict/accuracy)
//   placedText(placed)                  Pipeline tokens' one line: placed on flows and not (GET /api/tokens `placed`)
//   ALERTS_HELP, PLACED_HELP            the help behind the two ?s
//
// Rules: every value from the server goes through esc; nothing is guessed (a missing figure is left out and the words
// say so; under 3 similar flows is never a number, under 5 is Too few to trust); copy for one person, no jargon.
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const isNum = v => typeof v === 'number' && Number.isFinite(v)
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const MIN = 60_000

  // ═══ the words (lockstep with predict-words.mjs) ═══

  function duration(ms) {
    if (!isNum(ms) || ms < 0) return ''
    if (ms < 60_000) return 'under 1 min'
    const min = Math.round(ms / 60_000)
    if (min < 60) return `${min} min`
    if (min < 48 * 60) {
      const h = Math.floor(min / 60)
      const m = min % 60
      return m ? `${h} h ${m} min` : `${h} h`
    }
    return `${Math.round((min / 1440) * 10) / 10} days`
  }
  function tokens(n) {
    if (!isNum(n)) return ''
    const cut = (v, s) => `${Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${s}`
    const a = Math.abs(n)
    if (a >= 1e9) return cut(n / 1e9, 'B')
    if (a >= 1e6) return cut(n / 1e6, 'M')
    if (a >= 1e3) return cut(n / 1e3, 'K')
    return String(Math.round(n))
  }
  function usd(n) {
    if (!isNum(n)) return ''
    return n >= 100 ? `$${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}` : `$${n.toFixed(2)}`
  }
  /** An estimate's dollars: whole from $10, since a median of a few flows has no cents worth saying. */
  const roughUsd = n => (isNum(n) && n >= 10 && n < 100 ? `$${Math.round(n)}` : usd(n))
  const mins = m => duration(m * MIN)
  const pct = v => `${Math.round(v * 100)}%`
  const flowLink = (id, words = 'Open the flow') => `<a class="link" href="#/flows?flow=${encodeURIComponent(id)}">${esc(words)}</a>`

  // ═══ the alerts ═══

  const alertsOf = data => (data?.enabled !== false && Array.isArray(data?.alerts) ? data.alerts : [])

  /**
   * One agent holding many flows past their usual time is one fact, not many: GROUP_MIN or more Taking long alerts
   * (never Waiting on you, which is the user's own, one by one) of the same agent become one group item, placed where
   * its first member was. Each member keeps its own buttons inside the group.
   */
  const GROUP_MIN = 3
  function groupAlerts(list) {
    const by = new Map()
    for (const a of list) if (a.kind === 'stuck' && !a.onYou && a.agent) by.set(a.agent, [...(by.get(a.agent) || []), a])
    const out = []
    const placed = new Set()
    for (const a of list) {
      const members = a.kind === 'stuck' && !a.onYou && a.agent ? by.get(a.agent) : null
      if (!members || members.length < GROUP_MIN) {
        out.push(a)
        continue
      }
      if (placed.has(a.agent)) continue
      placed.add(a.agent)
      out.push({ kind: 'group', key: `group:${a.agent}`, agent: a.agent, alerts: members })
    }
    return out
  }
  const groupText = g => `${g.agent} holds ${g.alerts.length} flows longer than usual`

  /** What kinds of alert there are, in words: `1 flow waiting on you · 2 sessions re-reading a large history`. */
  function kindsText(items) {
    const list = items.filter(a => a.kind !== 'group')
    const n = pred => list.filter(pred).length
    const parts = items.filter(a => a.kind === 'group').map(groupText)
    const you = n(a => a.kind === 'stuck' && a.onYou)
    const slow = n(a => a.kind === 'stuck' && !a.onYou)
    const spike = n(a => a.kind === 'spike')
    const ctx = n(a => a.kind === 'context')
    const daily = n(a => a.kind === 'daily')
    if (you) parts.push(`${plural(you, 'flow')} waiting on you`)
    if (slow) parts.push(`${plural(slow, 'flow')} far past ${slow === 1 ? 'its' : 'their'} usual time`)
    if (spike) parts.push(`${plural(spike, 'session')} using tokens much faster than usual`)
    if (ctx) parts.push(`${plural(ctx, 'session')} re-reading a large history`)
    if (daily) parts.push(daily === 1 ? 'a daily limit passed' : `${daily} daily limits passed`)
    return parts.join(' · ')
  }

  function lineHtml(data, { open = false } = {}) {
    const list = groupAlerts(alertsOf(data))
    if (!list.length) return ''
    return `<p class="pe-line" role="status"><i class="pe-dot" aria-hidden="true"></i><b>${plural(list.length, 'alert')}</b>` +
      `<span class="pe-kinds">${esc(kindsText(list))}</span>` +
      `<span class="pe-line-end"><button type="button" class="link" data-pe-toggle aria-expanded="${open}" aria-controls="peList">${open ? 'Hide them' : 'Show them'}</button>` +
      '<button type="button" class="help" aria-label="How the alerts work">?</button></span></p>'
  }

  const TAG = { stuck: 'Taking long', you: 'Waiting on you', spike: 'Token spike', context: 'Long history', daily: 'Daily limit' }

  function groupHtml(g) {
    const keys = g.alerts.map(a => a.key).join(' ')
    return `<li class="pe-row pe-group k-stuck" data-pe-row="${esc(g.key)}">` +
      `<span class="pe-tags"><span class="pe-tag">${TAG.stuck}</span></span>` +
      `<span class="pe-text">${esc(groupText(g))} for their step. Each is far past the usual time for where it stands.</span>` +
      `<span class="pe-acts"><button type="button" class="link" data-pe-dismiss-all="${esc(keys)}" aria-label="Dismiss all ${g.alerts.length} for today">Dismiss all for today</button></span>` +
      `<details class="pe-fold" data-pe-fold="${esc(g.key)}"><summary>The ${g.alerts.length} flows</summary><ul class="pe-sub">${g.alerts.map(rowHtml).join('')}</ul></details></li>`
  }

  function rowHtml(a) {
    if (a.kind === 'group') return groupHtml(a)
    const tag = a.kind === 'stuck' && a.onYou ? TAG.you : TAG[a.kind] || 'Alert'
    const acts = [
      a.flow ? flowLink(a.flow) : '',
      a.kind === 'stuck' && a.flow ? `<button type="button" class="link" data-pe-snooze="${esc(a.key)}" aria-label="Snooze for a week: ${esc(a.text)}">Snooze for a week</button>` : '',
      a.kind === 'context' && a.handover ? `<button type="button" data-pe-copy="${esc(a.key)}" title="Copies a sentence asking ${esc(a.agent || 'the agent')} to write a handover note. It sends nothing.">Copy handover request</button>` : '',
      `<button type="button" class="link" data-pe-dismiss="${esc(a.key)}" aria-label="Dismiss for today: ${esc(a.text)}">Dismiss for today</button>`,
    ].filter(Boolean).join('')
    return `<li class="pe-row k-${esc(a.kind)}${a.onYou ? ' is-you' : ''}" data-pe-row="${esc(a.key)}">` +
      `<span class="pe-tags"><span class="pe-tag">${tag}</span>${a.returned ? '<span class="pe-tag is-back">Back: it got worse</span>' : ''}</span>` +
      `<span class="pe-text">${esc(a.text)}</span><span class="pe-acts">${acts}</span></li>`
  }

  function listHtml(data) {
    const list = groupAlerts(alertsOf(data))
    const hidden = Number(data?.hidden) || 0
    const snoozed = Number(data?.snoozed) || 0
    const notes = [
      hidden ? `${hidden} dismissed for today. ${hidden === 1 ? 'It comes' : 'They come'} back if ${hidden === 1 ? 'it gets' : 'they get'} half as bad again.` : '',
      snoozed ? `${snoozed} snoozed for a week. ${snoozed === 1 ? 'It comes' : 'They come'} back after 7 days, or at once when the flow moves to another step.` : '',
    ].filter(Boolean)
    const note = notes.length ? `<p class="pe-hidden">${notes.join(' ')}</p>` : ''
    return (list.length ? `<ul class="pe-list-rows">${list.map(rowHtml).join('')}</ul>` : '') + note
  }

  function homeHtml(data) {
    const list = groupAlerts(alertsOf(data))
    if (!list.length) return ''
    return `<p class="pe-line pe-home" role="status"><i class="pe-dot" aria-hidden="true"></i><b>${plural(list.length, 'alert')}</b>` +
      `<span class="pe-kinds">${esc(kindsText(list))}</span><a class="link" href="#/agents?alerts">See them</a></p>`
  }

  const ALERTS_HELP = '<p>Alerts are worked out from what the flow files and the transcripts already record. No model is asked, nothing makes a sound, and nothing pops up.</p>' +
    '<p><b>Taking long</b>: a flow has stood at its step more than 3 times the usual time for that step over the last 30 days, and at least an hour. With fewer than 5 past flows for that step there is no usual time yet, so a plain 24 hour limit applies. A flow with no update for a week is already counted as stalled by the score, and raises nothing here.</p>' +
    '<p><b>Waiting on you</b>: the same, for a question, a blocked flow, steps only you can do, or a flow stopped after too many failures.</p>' +
    '<p><b>Token spike</b>: a session used more than 4 times its usual tokens in the last hour (its median over its active hours of the last 7 days), and more than 20 million.</p>' +
    '<p><b>Long history</b>: a session re-reads its whole conversation every turn. When its last replies each re-read more than 400,000 tokens, a fresh session that starts from a short handover note costs far less. <b>Copy handover request</b> copies a sentence that asks the agent for that note; it sends nothing.</p>' +
    '<p><b>Daily limit</b>: off unless you set alerts.dailyUsd or alerts.dailyTokens in config.json.</p>' +
    '<p>When one agent holds 3 or more flows far past their usual time, they show as ONE alert with the flows folded under it. <b>Dismiss all for today</b> hides them together; each flow keeps its own buttons.</p>' +
    '<p><b>Dismiss for today</b> hides an alert until midnight. It comes back sooner only if it gets half as bad again. Every limit is in the alerts block of config.json.</p>' +
    '<p><b>Snooze for a week</b> is for a flow that is meant to stay open a long time, such as a tracking flow for a production checklist or a wave of tickets: it would otherwise grow worse every hour and keep coming back. It stays quiet for 7 days, and comes back at once if the flow moves to another step.</p>'

  // ═══ a flow's Cost ═══

  function tokensLine(t, open) {
    if (!t || !(t.tokens > 0)) return '<p class="pe-cost-line">No tokens placed on this flow yet.</p>'
    const dollars = isNum(t.usd) ? `, about ${usd(t.usd)}` : ''
    const note = !isNum(t.usd) ? ' <span class="pe-faint">Its model has no price set, so there are no dollars.</span>'
      : t.unpriced ? ' <span class="pe-faint">Some of it is on a model with no price, so the dollars leave that part out.</span>' : ''
    return `<p class="pe-cost-line"><b>Tokens${open ? ' so far' : ''}: ${tokens(t.tokens)}${dollars}</b>${note}</p>`
  }

  /** `about 1 h 10 min and $40, based on 3 similar flows (40 min to 2 h; $10 to $90)`, or null with no estimate. */
  function estimateWords(e, { lead = 'about' } = {}) {
    if (!e || !isNum(e.minutes)) return null
    const cost = isNum(e.usd) ? ` and ${roughUsd(e.usd)}` : ''
    const ranges = [e.spread?.minutes ? `${mins(e.spread.minutes[0])} to ${mins(e.spread.minutes[1])}` : '', e.spread?.usd ? `${roughUsd(e.spread.usd[0])} to ${roughUsd(e.spread.usd[1])}` : ''].filter(Boolean).join('; ')
    const n = Array.isArray(e.basedOn) ? e.basedOn.length : 0
    return `${lead} ${mins(e.minutes)}${cost}, based on ${plural(n, 'similar flow')}${ranges ? ` (${ranges})` : ''}`
  }

  const similarHtml = list => (Array.isArray(list) && list.length
    ? `<details class="pe-similar"><summary>The similar flows</summary><ul>${list.map(s => `<li>${flowLink(s.id, s.title || s.id)}</li>`).join('')}</ul></details>`
    : '')

  const inRange = (v, r) => (r && isNum(v) ? (v >= r[0] && v <= r[1] ? '<span class="pe-in">inside the range</span>' : '<span class="pe-out">outside the range</span>') : '')

  function costHtml(info, { open = true } = {}) {
    if (!info) return ''
    const e = info.estimate
    const head = tokensLine(info.tokens, open)
    if (!e) return head
    const few = e.few || !isNum(e.minutes)
    const stored = info.stored ? '' : ' <span class="pe-faint">Worked out from the flows that had finished before it started.</span>'
    if (!info.actual) {
      if (few) return `${head}<p class="pe-est">No estimate yet: too few similar flows have finished (${(e.basedOn || []).length} so far, 3 needed).</p>`
      return `${head}<p class="pe-est">Estimate: ${esc(estimateWords(e))}.${stored}</p>${similarHtml(info.similar)}`
    }
    if (few) return `${head}<p class="pe-est">There was no estimate: too few similar flows had finished when it started.</p>`
    const a = info.actual
    const row = (name, est, range, actual, words) => `<tr><th scope="row">${name}</th><td>${est}</td><td class="num">${actual || '<span class="pe-faint">not known</span>'}</td><td>${words}</td></tr>`
    const rangeText = (r, f) => (r ? ` <span class="pe-faint">(${f(r[0])} to ${f(r[1])})</span>` : '')
    const rows = [
      row('Time', `about ${mins(e.minutes)}${rangeText(e.spread?.minutes, mins)}`, null, mins(a.minutes), inRange(a.minutes, e.spread?.minutes)),
      isNum(e.usd) ? row('Cost', `about ${roughUsd(e.usd)}${rangeText(e.spread?.usd, roughUsd)}`, null, isNum(a.usd) ? usd(a.usd) : '', inRange(a.usd, e.spread?.usd)) : '',
      isNum(e.tokens) ? row('Tokens', `about ${tokens(e.tokens)}${rangeText(e.spread?.tokens, tokens)}`, null, isNum(a.tokens) ? tokens(a.tokens) : '', inRange(a.tokens, e.spread?.tokens)) : '',
    ].join('')
    const said = info.stored ? 'Said when the flow started' : 'Worked out afterwards: no estimate was stored when it started, so this is what the flows finished before it would have said'
    return `${head}<div class="pe-scroll"><table class="pe-vs"><caption>${esc(said)}, from ${plural((e.basedOn || []).length, 'similar flow')}.</caption>` +
      `<thead><tr><th scope="col"></th><th scope="col">Estimate</th><th scope="col">Actual</th><th scope="col"></th></tr></thead><tbody>${rows}</tbody></table></div>${similarHtml(info.similar)}`
  }

  // ═══ a ticket not yet started ═══

  function ticketHtml(info) {
    if (!info) return ''
    if (info.enabled === false) return 'Estimates are off (estimates.enabled in config.json).'
    if (info.flow && info.flowDone) return `Already done in a flow: its Cost block has the estimate against what it took. ${flowLink(info.flow)}`
    if (info.flow) return `Started: its flow keeps its own estimate. ${flowLink(info.flow)}`
    const e = info.estimate
    if (!e || e.few || !isNum(e.minutes)) return 'No estimate yet: too few similar flows.'
    const w = estimateWords(e, { lead: 'About' })
    return `${esc(w)}.${similarHtml(info.similar)}`
  }

  // ═══ how good the estimates have been ═══

  function accuracyHtml(acc) {
    if (!acc) return ''
    const cell = s => {
      if (!s || !s.flows) return '<td class="pe-faint">None yet</td><td></td>'
      const err = s.few ? `<span class="pe-faint">Too few to trust</span> (${pct(s.median)})` : pct(s.median)
      return `<td class="num">${err}</td><td class="num">${s.ranged ? `${s.inRange} of ${s.ranged}` : ''}</td>`
    }
    const row = (name, s) => `<tr><th scope="row">${name}</th><td class="num">${s?.flows || 0}</td>${cell(s)}</tr>`
    return '<p>How far the real time and cost were from the estimate, as a share of the estimate (50% is half as much again, or half). Under 5 flows is too few to trust.</p>' +
      '<div class="pe-scroll"><table class="pe-acc-table"><thead><tr><th scope="col">Estimate</th><th scope="col">Flows</th><th scope="col">Median error</th><th scope="col">Inside the range</th></tr></thead><tbody>' +
      row('Time, said when the flow started', acc.stored?.minutes) + row('Cost, said when the flow started', acc.stored?.usd) +
      row('Time, worked out afterwards', acc.afterwards?.minutes) + row('Cost, worked out afterwards', acc.afterwards?.usd) +
      '</tbody></table></div>' +
      '<p class="pe-faint">Worked out afterwards: for a finished flow that had no estimate stored when it started (most finished before estimates existed), the same rule run on the flows that had finished before it started.</p>'
  }

  // ═══ Pipeline tokens' placed line ═══

  function placedText(p) {
    const on = p?.placed
    const off = p?.unplaced
    const all = (on?.tokens || 0) + (off?.tokens || 0)
    if (!(all > 0)) return ''
    const part = (x, words) => `${words}: ${tokens(x.tokens)}${words === 'On flows' ? ' tokens' : ''} (${pct(x.tokens / all)})${isNum(x.usd) ? `, about ${usd(x.usd)}` : ''}`
    return `${part(on, 'On flows')}. ${part(off, 'Not on any flow')}.`
  }
  const PLACED_HELP = '<p><b>On flows</b> is what a flow can claim: a reply counts for a flow when its agent was working on that flow at the time (the agent\'s own stretch on it: the producer until QA starts, QA while it tests, a fix after a failure, and so on), shared evenly when the agent had several flows open at once. A subagent counts with the session that started it.</p>' +
    '<p>The transcripts are counted by the hour, so a reply\'s exact minute is not known: an hour is taken as spent evenly, and a flow open for a quarter of it takes a quarter.</p>' +
    '<p><b>Not on any flow</b> is the rest: the chat, sessions on no flow, unnamed sessions, and the time between flows. It is shown, not hidden.</p>'

  window.PredictView = { duration, tokens, usd, groupAlerts, lineHtml, listHtml, homeHtml, costHtml, ticketHtml, accuracyHtml, placedText, kindsText, ALERTS_HELP, PLACED_HELP }
})()
