// Pipeline time on the Agents page, the PURE half: durations and rates in the unit the user picked, the five tiles,
// the line shown when the block is collapsed, the stage bar and its table, the per day bars and their text list, the
// per agent table, the How it is counted HTML and the block's fixed skeleton. No DOM, no fetch, no storage
// (time-strip.js does those), so test/time-view.test.mjs runs it in a vm with a bare window. `stats` is /api/time's
// body (time-stats.mjs timeStats): every time in ms, every rate per day or per hour.
//
//   TimeView.duration(ms, unit)       '42 min', '3.5 h', '2.1 days' (Auto), or every value in Minutes, Hours or Days
//   TimeView.rate(perMs, unit, auto)  '3.3 a day', '0.6 an hour', or in Minutes '1 every 95 min'; null for no rate
//   TimeView.tiles(stats, unit)       [{ key, name, side, number, line, empty }] for the five tiles, in order
//   TimeView.line(stats, unit)        the collapsed line
//   TimeView.stageParts / stagesHtml  the stacked bar (widths add to exactly 100) and its table
//   TimeView.barModel / chartHtml     the bars per day (per week for All), and the same as a list
//   TimeView.agentsHtml / howHtml     the per agent table, the help
//   TimeView.skeleton()               the block's markup, built once; unitOf(v) a stored unit with a safe default
//
// Rules: nothing finished is an honest empty state ('Nothing finished yet', 'Not enough data yet'), never a 0 that
// reads as a result; fewer than 3 finished flows says Too few to trust; every value from the server goes through
// UI.esc; no em dashes in the copy. The tiles reuse the score's tile classes (score.css psc-) so the two rows line up.
;(() => {
  const S = 1000
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const UNITS = Object.freeze([
    Object.freeze({ key: 'min', label: 'Minutes' }),
    Object.freeze({ key: 'h', label: 'Hours' }),
    Object.freeze({ key: 'day', label: 'Days' }),
    Object.freeze({ key: 'auto', label: 'Auto' }),
  ])
  const NAMES = Object.freeze({ finished: 'Finished', perDay: 'Per day', perHour: 'Per hour', took: 'Time per ticket', waiting: 'Waiting on you' })
  const ORDER = Object.freeze(['finished', 'perDay', 'perHour', 'took', 'waiting'])
  const NONE = 'Not enough data yet'
  const FEW = 'Too few to trust. '
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  const esc = s => window.UI.esc(s)
  const unitOf = v => (UNITS.some(u => u.key === v) ? v : 'auto')
  const isNum = v => typeof v === 'number' && Number.isFinite(v)
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const round1 = v => Math.round(v * 10) / 10
  const grouped = v => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  /** A number as the block shows it: whole from 10 up, one decimal from 1, two significant digits below 1. */
  const num = v => {
    if (!isNum(v)) return ''
    const a = Math.abs(v)
    if (a === 0) return '0'
    if (a >= 10) return grouped(v)
    if (a >= 1) return String(round1(v))
    return String(Number(v.toPrecision(2)))
  }
  const days = text => `${text} ${text === '1' ? 'day' : 'days'}`

  /** A duration in `unit`: Auto picks the unit that fits (59 s, 42 min, 3.5 h, 2.1 days), rounding up into the next. */
  function duration(ms, unit = 'auto') {
    if (!isNum(ms) || ms < 0) return ''
    if (unit === 'min') return `${num(ms / MIN)} min`
    if (unit === 'h') return `${num(ms / HOUR)} h`
    if (unit === 'day') return days(num(ms / DAY))
    if (ms === 0) return '0 min'
    const s = Math.round(ms / S)
    if (s < 60) return `${s} s`
    const m = Math.round(ms / MIN)
    if (m < 60) return `${m} min`
    const h = round1(ms / HOUR)
    if (h < 24) return `${h} h`
    return days(String(round1(ms / DAY)))
  }

  /** A rate (pieces per ms) in `unit`; Auto reads it per `auto` ('day' or 'h'). Null when there is no rate. */
  function rate(perMs, unit, auto) {
    if (!isNum(perMs) || perMs <= 0) return null
    const u = unit === 'auto' ? auto : unit
    if (u === 'min') return `1 every ${duration(1 / perMs, 'min')}`
    if (u === 'h') return `${num(perMs * HOUR)} an hour`
    return `${num(perMs * DAY)} a day`
  }

  const finishedNow = stats => Number(stats?.finished?.flows) > 0
  const spanOf = stats => (stats?.window?.days ? `in the last ${stats.window.days} days` : 'yet')
  const perDayMs = stats => (isNum(stats?.rates?.perDay) ? stats.rates.perDay / DAY : null)
  const perHourMs = stats => (isNum(stats?.rates?.perHour) ? stats.rates.perHour / HOUR : null)
  const pct = v => `${Math.round(v * 100)}%`

  /** The Finished tile: tickets as the number when there are any, else the other jobs. */
  function finishedTile(f) {
    const tickets = Number(f.tickets) || 0
    const jobs = Number(f.jobs) || 0
    const flows = Number(f.flows) || 0
    const number = tickets ? plural(tickets, 'ticket') : plural(jobs, 'job')
    const from = flows !== tickets + jobs ? `from ${plural(flows, 'flow')}` : ''
    let line
    if (tickets && jobs) line = `And ${plural(jobs, 'other job')}${from ? `, ${from}` : ''}.`
    else if (from) line = `${from[0].toUpperCase()}${from.slice(1)}.`
    else line = tickets ? 'Tickets on flows that finished.' : 'Finished flows with no ticket.'
    return { number, line }
  }

  function tiles(stats, unit) {
    const tile = (key, number, line, side = '') => ({ key, name: NAMES[key], side, number: number ?? NONE, line, empty: number == null })
    if (!finishedNow(stats)) {
      return ORDER.map(key => key === 'finished'
        ? { key, name: NAMES[key], side: '', number: 'Nothing finished yet', line: `No ticket or other job finished ${spanOf(stats)}.`, empty: true }
        : tile(key, null, 'It needs at least one finished flow.'))
    }
    const few = stats.fewer ? FEW : ''
    const w = stats.window || {}
    const d = ms => duration(ms, unit)
    const f = finishedTile(stats.finished)
    const clock = rate(isNum(stats.rates?.perClockHour) ? stats.rates.perClockHour / HOUR : null, unit, 'h')
    const took = stats.took
    const wait = stats.waiting
    const undated = Number(wait?.undated) || 0
    return [
      tile('finished', f.number, f.line),
      tile('perDay', rate(perDayMs(stats), unit, 'day'), `${few}${w.days ? `Over the ${w.days} days, today included.` : `Over ${plural(Number(w.dayCount) || 0, 'day')}, since the first flow started.`}`),
      tile('perHour', rate(perHourMs(stats), unit, 'h'), `${few}Over ${plural(Number(w.activeHours) || 0, 'hour')} with work${clock ? `; ${clock} round the clock` : ''}.`),
      took ? tile('took', d(took.median), `${few}Half took less. Mean ${d(took.mean)}, fastest ${d(took.fastest)}, slowest ${d(took.slowest)}.`) : tile('took', null, 'No finished flow has its start dated.'),
      wait
        ? tile('waiting', d(wait.median), `${few}${wait.mean > 0 ? `Half waited less. Mean ${d(wait.mean)}${isNum(wait.share) ? `, ${pct(wait.share)} of their time` : ''}.` : 'No question or by-hand step held these flows up.'}${undated ? ` ${plural(undated, 'flow')} with an undated question left out.` : ''}`)
        : tile('waiting', null, 'No finished flow has its questions dated.'),
    ]
  }

  function line(stats, unit) {
    if (!finishedNow(stats)) return stats?.window?.days ? `Nothing finished in the last ${stats.window.days} days.` : 'Nothing finished yet.'
    const f = stats.finished
    const what = f.tickets && f.jobs ? `${plural(f.tickets, 'ticket')} and ${plural(f.jobs, 'other job')}` : f.tickets ? plural(f.tickets, 'ticket') : plural(f.jobs, 'job')
    return [
      what,
      rate(perDayMs(stats), unit, 'day'),
      rate(perHourMs(stats), unit, 'h'),
      stats.took ? `${duration(stats.took.median, unit)} a ticket` : null,
      stats.waiting ? `${duration(stats.waiting.median, unit)} waiting on you` : null,
    ].filter(Boolean).join(' · ')
  }

  // ═══ where the time goes ═══

  /** The dated stages as bar parts: { key, label, ms, width, text }; the widths, to 2 decimals, add to exactly 100. */
  function stageParts(stats, unit) {
    const dated = (stats?.stages || []).filter(s => Number(s.flows) > 0 && isNum(s.median) && s.median > 0)
    const total = dated.reduce((t, s) => t + s.median, 0)
    if (!total) return []
    const round2 = v => Math.round(v * 100) / 100
    let used = 0
    return dated.map((s, i) => {
      const width = i === dated.length - 1 ? round2(100 - used) : round2((s.median / total) * 100)
      used = round2(used + width)
      return { key: s.key, label: s.label, ms: s.median, width, text: `${s.label} ${duration(s.median, unit)}` }
    })
  }

  const EMPTY_PERIOD = '<p class="psc-none ptm-none">Nothing finished in this period, so there is no time to show yet.</p>'

  function stagesHtml(stats, unit) {
    const parts = stageParts(stats, unit)
    if (!parts.length) return EMPTY_PERIOD
    const bar = parts.map(p => `<span class="ptm-seg ptm-s-${esc(p.key)}" style="width:${p.width}%" title="${esc(p.text)}"><span class="ptm-seg-text">${esc(p.text)}</span></span>`).join('')
    const dated = (stats.stages || []).filter(s => Number(s.flows) > 0)
    const rows = dated.map(s => `<tr class="ptm-s-${esc(s.key)}"><th scope="row">${esc(s.label)}</th><td class="num">${esc(duration(s.median, unit))}</td><td class="num">${esc(duration(s.mean, unit))}</td><td class="num">${Number(s.flows) || 0}</td></tr>`).join('')
    const undated = (stats.stages || []).filter(s => Number(s.undated) > 0).map(s => `${esc(s.label)} (${plural(Number(s.undated), 'flow')})`)
    return `<div class="ptm-stackbar" role="img" aria-label="${esc(`Median time at each stage: ${parts.map(p => p.text).join(', ')}.`)}">${bar}</div>` +
      '<div class="psc-scroll ptm-scroll"><table class="ptm-table ptm-stage-table"><thead><tr><th scope="col">Stage</th><th scope="col">Median</th><th scope="col">Mean</th><th scope="col">Flows</th></tr></thead>' +
      `<tbody>${rows}</tbody></table></div>` +
      (undated.length ? `<p class="psc-foot ptm-foot">Left out where a time is missing: ${undated.join(', ')}.</p>` : '')
  }

  // ═══ the bars per day (per week for All) ═══

  /** '19 Nov', with the weekday for a day: 'Thu 19 Nov'; 'Week of 16 Nov' for a week. From 'YYYY-MM-DD', no time zone. */
  function dayLabel(key, week) {
    const [y, m, d] = String(key).split('-').map(Number)
    if (!y || !m || !d) return String(key)
    const short = `${d} ${MONTHS[m - 1]}`
    return week ? `Week of ${short}` : `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${short}`
  }

  function barModel(stats) {
    const bars = Array.isArray(stats?.bars) ? stats.bars : []
    const week = stats?.window?.bucket === 'week'
    const max = Math.max(0, ...bars.map(b => Number(b.count) || 0))
    return bars.map(b => {
      const count = Number(b.count) || 0
      const label = dayLabel(b.day, week)
      return { day: b.day, label, count, height: max ? Math.round((count / max) * 10000) / 100 : 0, says: `${label}: ${count} finished` }
    })
  }

  function chartHtml(stats) {
    const bars = barModel(stats)
    if (!finishedNow(stats) || !bars.length) return EMPTY_PERIOD
    const n = bars.length
    // a tick under every bar of a week of days (its weekday), else under the first and the last only
    const tickOf = (b, i) => (n <= 8 ? b.label.split(' ')[0] : i === 0 || i === n - 1 ? b.label.replace('Week of ', '') : '')
    const cols = bars.map((b, i) => `<li class="ptm-col" tabindex="${i === n - 1 ? 0 : -1}" aria-label="${esc(b.says)}" data-bar="${i}">` +
      `<span class="ptm-well"><span class="ptm-fill${b.count ? '' : ' zero'}" style="height:${b.height}%"></span></span>` +
      `<span class="ptm-tick" aria-hidden="true">${esc(tickOf(b, i))}</span><span class="ptm-tip" aria-hidden="true">${esc(b.says)}</span></li>`).join('')
    const list = bars.map(b => `<li>${esc(b.label)}: ${b.count}</li>`).join('')
    return `<ol class="ptm-chart" aria-label="Finished per ${stats.window?.bucket === 'week' ? 'week' : 'day'}; use the arrow keys to move along the bars">${cols}</ol>` +
      `<details class="ptm-list"><summary>As a list</summary><ul>${list}</ul></details>`
  }

  // ═══ by agent ═══

  function agentsHtml(stats, unit) {
    const agents = Array.isArray(stats?.agents) ? stats.agents : []
    if (!agents.length) return '<p class="psc-none">No agent finished work or had work sent back in this period.</p>'
    const rows = agents.map(a => `<tr><th scope="row">${esc(a.label)}</th><td class="num">${Number(a.tickets) || 0}</td><td class="num">${Number(a.jobs) || 0}</td>` +
      `<td class="num">${esc(duration(a.median, unit))}</td><td class="num">${esc(rate(isNum(a.perDay) ? a.perDay / DAY : null, unit, 'day') ?? '')}</td><td class="num">${Number(a.sentBack) || 0}</td></tr>`).join('')
    return '<div class="psc-scroll"><table class="ptm-table ptm-agent-table"><thead><tr><th scope="col">Agent</th><th scope="col">Tickets</th><th scope="col">Other jobs</th>' +
      '<th scope="col">Time per ticket</th><th scope="col">Per day</th><th scope="col">Sent back</th></tr></thead>' +
      `<tbody>${rows}</tbody></table></div>` +
      '<p class="psc-foot">Tickets: finished on that agent&#39;s flows (a ticket finished twice counts for the last one). Time per ticket: the median from start to finish. Sent back: times QA, Security or Senior failed its work in this period, as the score counts it.</p>'
  }

  // ═══ How it is counted ═══

  function howHtml(stats) {
    const w = stats?.window || {}
    const l = stats?.left || {}
    const n = v => Number(v) || 0
    const left = [
      n(l.slipped) && `${n(l.slipped)} slipped through`, n(l.dropped) && `${n(l.dropped)} dropped`,
      n(l.stopped) && `${n(l.stopped)} stopped`, n(l.stalled) && `${n(l.stalled)} stalled`,
    ].filter(Boolean)
    const period = w.days
      ? `today and the ${w.days - 1} days before it, from local midnight`
      : 'every day since local midnight of the day the first flow started'
    return '<p class="psc-lede">Every time here is the gap between two times the flow files store. Nothing is guessed: a time that is missing leaves that number out.</p>' +
      '<ul class="psc-sums">' +
      '<li><b>Finished</b> is what the score calls delivered: QA passed it (and Security and Senior, where they apply) or it finished with no code changes. A flow is counted on the day it finished, at the time the score counts the delivery.</li>' +
      '<li><b>A ticket</b> is a tracker ticket on a finished flow. A flow with two counts two; a flow with none is one other job. A ticket finished by two flows counts once, at its last finish.</li>' +
      `<li><b>The period</b> is whole days in this computer&#39;s local time: ${period}. The score above counts the last 7 or 30 times 24 hours, so near midnight the two can differ by a few hours of work.</li>` +
      `<li><b>Per day</b> divides by ${plural(n(w.dayCount), 'day')}, today included. <b>Per hour</b> divides by ${plural(n(w.activeHours), 'hour')} with work: the clock hours in which at least one flow recorded something (started, planned, handed to QA, a verdict, pushed, finished, dropped). Nights and weekends with no work do not dilute it. Round the clock divides by every hour of the period.</li>` +
      '<li><b>Median</b> is the middle value: half took less, half took more. It is the headline because one three-day wait must not hide ten 20-minute tickets; the mean (the average) is beside it. Fewer than 3 finished flows are too few to trust.</li>' +
      '<li><b>Time per ticket</b> runs from when the flow was started to when it finished. <b>Waiting on you</b> runs from each question to its answer and from each by-hand step to its tick, overlaps counted once.</li>' +
      '<li><b>Where the time goes</b>: Coordinator and planner, start to the planner&#39;s first hand-out; Producer, to the first QA attempt (or the first by-hand step, or the finish when there is no code); QA, each attempt from start to verdict; Security, QA&#39;s pass to Security&#39;s verdict; Human task, the first by-hand step to Senior starting (or the last tick); Senior, each review; Reworks, each failure to the next attempt or review. Each part is the median of the flows that went through it, so the parts do not add up to the time per ticket.</li>' +
      '</ul>' +
      '<h4 class="psc-h">What cannot be dated</h4><ul class="psc-sums">' +
      '<li>Without the planner, the hand-over from the coordinator to a producer has no time in the flow file, so that time counts as the producer&#39;s.</li>' +
      '<li>The wait between the last by-hand tick and Senior starting, and between a pass and the push, belong to no stage. The push comes after the finish the score counts.</li>' +
      '<li>Questions asked before questions carried a time, and questions never answered, cannot be dated: that flow is left out of Waiting on you.</li>' +
      '<li>A flow with no start time is counted as finished but left out of the times.</li></ul>' +
      `<p class="psc-way">Not finished, so left out of every time: ${left.length ? `${left.join(', ')} in this period` : 'none in this period'}. Dropped, stopped, stalled and slipped through work is in the score above.</p>` +
      '<p class="psc-foot">Archived flows count. Deleted flows do not.</p>'
  }

  // ═══ the fixed markup ═══

  const CHEVRON = '<svg class="psc-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>'

  function skeleton() {
    const units = UNITS.map(u => `<button type="button" data-unit="${u.key}" aria-pressed="false">${u.label}</button>`).join('')
    const tileHtml = ORDER.map(key => `<div class="psc-tile" role="group" aria-labelledby="ptmName-${key}" data-tile="${key}">` +
      `<div class="psc-top"><span class="psc-name" id="ptmName-${key}">${NAMES[key]}</span><span class="psc-frac num"></span></div>` +
      '<div class="psc-num ptm-num num"></div><p class="psc-mean"></p></div>').join('')
    return '<div class="psc-head">' +
      `<button type="button" class="psc-toggle" aria-expanded="true" aria-controls="ptmBody">${CHEVRON}<span class="psc-title">Pipeline time</span></button>` +
      '<span class="psc-line ptm-line num"></span>' +
      '<span class="ptm-span"></span>' +
      `<span class="psc-seg ptm-units" role="group" aria-label="Show times in">${units}</span>` +
      '</div>' +
      '<div class="psc-body" id="ptmBody">' +
      `<div class="psc-tiles" role="group" aria-label="Times" tabindex="0">${tileHtml}</div>` +
      '<div class="ptm-row">' +
      '<section class="ptm-panel" aria-labelledby="ptmStagesH"><h4 class="psc-h ptm-h" id="ptmStagesH">Where the time goes</h4><div class="ptm-stages"></div></section>' +
      '<section class="ptm-panel" aria-labelledby="ptmDaysH"><h4 class="psc-h ptm-h" id="ptmDaysH">Finished per day</h4><div class="ptm-days"></div></section>' +
      '</div>' +
      '<details class="psc-how ptm-agents-box"><summary>By agent</summary><div class="psc-how-body ptm-agents"></div></details>' +
      '<details class="psc-how"><summary>How it is counted</summary><div class="psc-how-body ptm-how"></div></details>' +
      '</div>' +
      '<p class="psc-note" role="status" hidden></p>'
  }

  window.TimeView = { UNITS, NONE, unitOf, num, duration, rate, tiles, line, stageParts, stagesHtml, barModel, chartHtml, agentsHtml, howHtml, skeleton }
})()
