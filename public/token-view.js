// Pipeline tokens on the Agents page, the PURE half: token counts and dollars as the block shows them, the five
// tiles, the collapsed line, the note while the first build runs, the bars per day in tokens or dollars and their
// text list, the by agent and by model tables, the How it is counted HTML and the block's fixed skeleton. No DOM, no
// fetch, no storage (token-strip.js does those), so test/token-view.test.mjs runs it in a vm with a bare window.
// `stats` is /api/tokens' body (token-usage.mjs tokenStats, token-routes.mjs).
//
//   TokenView.count(n) / exact(n)     '12.4K', '3.1M', '1.2B' (whole below 1,000); exact: '1,698,815,232'
//   TokenView.usd(v)                  '$4.66' under $100, '$212' from $100, 'under $0.01' for a trace
//   TokenView.tiles(stats)            [{ key, name, side, number, title, line, empty }] for the five tiles, in order
//   TokenView.line(stats) / note(stats)   the collapsed line; the building note ('' when built)
//   TokenView.barModel / chartHtml    the bars per day (per week for All) in tokens or dollars, and as a list
//   TokenView.agentsHtml / modelsHtml / howHtml   the two tables and the help
//   TokenView.skeleton()              the block's markup, built once; measureOf(v) a stored measure, safe default
//
// Rules: every dollar figure is an ESTIMATE at API prices and says so, except the dashboard's own runs, which are
// exact and never added to it; with no price for any model there is no dollar figure at all, not a $0; nothing in
// the period is an honest empty state, never a 0 that reads as a result; every count has its exact number to hover;
// every value from the server goes through UI.esc; no em dashes in the copy. The tiles reuse the score's tile classes
// (score.css psc-) and the panels and bars Pipeline time's (time.css ptm-), so the three rows line up.
;(() => {
  const NAMES = Object.freeze({ tokens: 'Tokens used', cost: 'Estimated cost', perJob: 'Per finished job', cache: 'Cache share', spend: 'The dashboard\'s own runs' })
  const ORDER = Object.freeze(['tokens', 'cost', 'perJob', 'cache', 'spend'])
  const MEASURES = Object.freeze([Object.freeze({ key: 'tokens', label: 'Tokens' }), Object.freeze({ key: 'usd', label: 'Dollars' })])
  const NONE = 'Not enough data yet'
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const UNITS = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]

  const esc = s => window.UI.esc(s)
  const isNum = v => typeof v === 'number' && Number.isFinite(v)
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const grouped = v => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const measureOf = v => (MEASURES.some(m => m.key === v) ? v : 'tokens')

  /** A value in a unit: whole from 100, else one decimal with a trailing .0 dropped. */
  const short = v => (v >= 100 ? grouped(v) : String(Math.round(v * 10) / 10))

  /** Tokens as the block shows them: whole below 1,000, then K, M, B; a value that rounds to 1,000 moves up a unit. */
  function count(n) {
    if (!isNum(n)) return ''
    if (Math.abs(n) < 1000) return grouped(n)
    for (let i = UNITS.length - 1; i >= 0; i--) {
      const [size, unit] = UNITS[i]
      const next = UNITS[i - 1]
      if (Math.abs(n) < size * 1000 || !next) {
        const text = short(Math.abs(n) / size)
        if (next && Number(text.replace(/,/g, '')) >= 1000) continue
        return `${n < 0 ? '-' : ''}${text}${unit}`
      }
    }
    return grouped(n)
  }
  const exact = n => (isNum(n) ? grouped(n) : '')

  /** Dollars: two places under $100, whole dollars from $100. */
  function usd(v) {
    if (!isNum(v)) return ''
    if (v > 0 && v < 0.005) return 'under $0.01'
    const cents = Math.round(v * 100) / 100
    return cents < 100 ? `$${cents.toFixed(2)}` : `$${grouped(v)}`
  }
  /** A price per million: '$4', '$0.20', '$12.50', '$0.125'. */
  const rate = v => (Number.isInteger(v) ? `$${v}` : Number.isInteger(Math.round(v * 1e6) / 1e4) ? `$${v.toFixed(2)}` : `$${v}`)
  /** A share with one decimal; a sliver that would read 0% says so. */
  const pct = v => (v > 0 && v < 0.0005 ? 'under 0.1%' : `${Math.round(v * 1000) / 10}%`)

  const spanOf = stats => (stats?.window?.days ? `in the last ${stats.window.days} days` : 'yet')
  const priced = stats => isNum(stats?.cost?.usd)
  const tokensNow = stats => Number(stats?.totals?.all) > 0

  /** The unpriced models in a few words: named when one or two, counted when more. */
  function unpricedWords(c) {
    const list = Array.isArray(c?.unpriced) ? c.unpriced : []
    if (!list.length) return ''
    return list.length <= 2 ? `${plural(list.length, 'model')} with no price set: ${list.join(', ')}` : `${list.length} models with no price set`
  }

  function tiles(stats) {
    const tile = (key, number, line, { side = '', title = '', empty = false } = {}) => ({ key, name: NAMES[key], side, number: number ?? NONE, title, line, empty: empty || number == null })
    const t = stats?.totals || {}
    const all = Number(t.all) || 0
    const c = stats?.cost || {}
    const job = stats?.perJob
    const spend = stats?.spend || { usd: 0, turns: 0 }
    const out = []
    if (!all) {
      out.push(tile('tokens', 'No tokens yet', stats?.building ? 'Still reading the transcripts.' : `No Claude Code session of this project replied ${spanOf(stats)}.`, { empty: true }))
      const wait = stats?.building ? 'Still reading the transcripts.' : ''
      out.push(tile('cost', 'Nothing to price', wait || 'No tokens in this period.', { empty: true }))
      out.push(tile('perJob', null, wait || 'It needs tokens and a finished job.'))
      out.push(tile('cache', null, wait || 'No input in this period.'))
    } else {
      out.push(tile('tokens', count(all), `New input ${count(t.input)}, output ${count(t.output)}, cache writes ${count(t.cacheWrite)}, cache reads ${count(t.cacheRead)}.`, { title: `${exact(all)} tokens` }))
      const left = unpricedWords(c)
      out.push(priced(stats)
        ? tile('cost', `about ${usd(c.usd)}`, `What these tokens would cost at API prices; a subscription is not charged per token.${left ? ` Leaves out ${left}.` : ''}`, { side: 'estimate', title: `about $${c.usd.toFixed(2)}` })
        : tile('cost', 'No prices set', `${left ? `${left[0].toUpperCase()}${left.slice(1)}. ` : ''}Add prices to config.json (tokens.prices) to see an estimate.`, { empty: true }))
      out.push(job
        ? tile('perJob', count(job.tokens), `${isNum(job.usd) ? `About ${usd(job.usd)} a job. ` : ''}All tokens over ${plural(job.jobs, 'job')}: ${plural(job.tickets, 'ticket')} and ${plural(job.otherJobs, 'other job')}, as Pipeline time counts them.`, { side: 'average', title: `${exact(job.tokens)} tokens a job` })
        : tile('perJob', 'Nothing finished yet', 'No ticket or other job finished in this period, so there is nothing to divide by.', { empty: true }))
      out.push(isNum(stats.cacheShare)
        ? tile('cache', pct(stats.cacheShare), 'Of all input, read back from the prompt cache. Cached input costs a tenth of new input or less, so a high share keeps the cost down.')
        : tile('cache', null, 'No input in this period.'))
    }
    out.push(tile('spend', usd(Number(spend.usd) || 0), `Exact: ${plural(Number(spend.turns) || 0, 'run')} of its chat, relay, refreshes and Generators. The tiles before it are estimates.`, { title: `$${(Number(spend.usd) || 0).toFixed(4)}` }))
    return out
  }

  function line(stats) {
    if (!tokensNow(stats)) return stats?.window?.days ? `No tokens in the last ${stats.window.days} days.` : 'No tokens yet.'
    return [
      `${count(stats.totals.all)} tokens`,
      priced(stats) ? `about ${usd(stats.cost.usd)} at API prices` : null,
      stats.perJob ? `${count(stats.perJob.tokens)} a job` : null,
      isNum(stats.cacheShare) ? `${pct(stats.cacheShare)} from the cache` : null,
      stats.spend ? `${usd(stats.spend.usd)} own runs` : null,
    ].filter(Boolean).join(' · ')
  }

  function note(stats) {
    if (!stats?.building) return ''
    return `Reading the transcripts for the first time: ${Math.floor((Number(stats.progress) || 0) * 100)}% done. The numbers so far are partial.`
  }

  // ═══ the bars per day (per week for All) ═══

  function dayLabel(key, week) {
    const [y, m, d] = String(key).split('-').map(Number)
    if (!y || !m || !d) return String(key)
    const s = `${d} ${MONTHS[m - 1]}`
    return week ? `Week of ${s}` : `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${s}`
  }

  function barModel(stats, measure) {
    const m = measure === 'usd' && priced(stats) ? 'usd' : 'tokens'
    const bars = Array.isArray(stats?.bars) ? stats.bars : []
    const week = stats?.window?.bucket === 'week'
    const value = b => Number(m === 'usd' ? b.usd : b.tokens) || 0
    const max = Math.max(0, ...bars.map(value))
    return bars.map(b => {
      const v = value(b)
      const label = dayLabel(b.day, week)
      return { day: b.day, label, value: v, height: max ? Math.round((v / max) * 10000) / 100 : 0, says: `${label}: ${m === 'usd' ? `about ${usd(v)}` : `${count(v)} tokens`}`, title: m === 'usd' ? `$${v.toFixed(2)}` : `${exact(v)} tokens` }
    })
  }

  const EMPTY_PERIOD = '<p class="psc-none ptm-none">No tokens in this period.</p>'
  const READING = '<p class="psc-none ptm-none">Still reading the transcripts.</p>'
  /** The empty text of a panel: still reading while the first build runs, else none in this period. */
  const emptyOf = stats => (stats?.building ? READING : EMPTY_PERIOD)

  function chartHtml(stats, measure) {
    const bars = barModel(stats, measure)
    if (!tokensNow(stats) || !bars.length) return emptyOf(stats)
    const per = stats.window?.bucket === 'week' ? 'week' : 'day'
    const what = measure === 'usd' && priced(stats) ? 'Estimated dollars' : 'Tokens'
    const n = bars.length
    const tickOf = (b, i) => (n <= 8 ? b.label.split(' ')[0] : i === 0 || i === n - 1 ? b.label.replace('Week of ', '') : '')
    const cols = bars.map((b, i) => `<li class="ptm-col" tabindex="${i === n - 1 ? 0 : -1}" aria-label="${esc(b.says)}" title="${esc(b.title)}" data-bar="${i}">` +
      `<span class="ptm-well"><span class="ptm-fill${b.value ? '' : ' zero'}" style="height:${b.height}%"></span></span>` +
      `<span class="ptm-tick" aria-hidden="true">${esc(tickOf(b, i))}</span><span class="ptm-tip" aria-hidden="true">${esc(b.says)}</span></li>`).join('')
    const list = bars.map(b => `<li>${esc(b.says)}</li>`).join('')
    return `<ol class="ptm-chart" aria-label="${what} per ${per}; use the arrow keys to move along the bars">${cols}</ol>` +
      `<details class="ptm-list"><summary>As a list</summary><ul>${list}</ul></details>`
  }

  // ═══ the tables ═══

  const num = v => `<td class="num" title="${esc(exact(v))}">${esc(count(v))}</td>`
  const money = (v, partly) => `<td class="num"${isNum(v) ? ` title="${esc(`$${v.toFixed(2)}`)}"` : ''}>${isNum(v) ? `${esc(usd(v))}${partly ? '<span class="ptk-part" title="Part of these tokens has no price set, so the estimate leaves them out">*</span>' : ''}` : '<span class="ptk-noprice">no price set</span>'}</td>`
  const KIND_HEAD = '<th scope="col">New input</th><th scope="col">Output</th><th scope="col">Cache writes</th><th scope="col">Cache reads</th><th scope="col">Total</th>'
  const kindCells = r => num(r.input) + num(r.output) + num(r.cacheWrite) + num(r.cacheRead) + num(r.all)

  function agentsHtml(stats) {
    const agents = Array.isArray(stats?.agents) ? stats.agents : []
    if (!agents.length) return stats?.building ? READING : '<p class="psc-none">No session of this project used tokens in this period.</p>'
    const all = Number(stats.totals?.all) || 0
    const rows = agents.map(a => {
      const main = `<tr><th scope="row">${esc(a.label)}</th>${kindCells(a)}${money(a.usd, a.unpriced && isNum(a.usd))}<td class="num">${isNum(a.share) ? esc(pct(a.share)) : ''}</td><td class="ptk-models">${(a.models || []).map(m => `<span class="ptk-nw">${esc(m)}</span>`).join(', ')}</td></tr>`
      const s = a.subs || {}
      if (!(Number(s.all) > 0)) return main
      return main + `<tr class="ptk-sub"><th scope="row">of which subagents (${Number(s.files) || 0})</th>${kindCells(s)}${money(s.usd, false)}<td class="num">${all ? esc(pct(s.all / all)) : ''}</td><td></td></tr>`
    }).join('')
    const partly = agents.some(a => a.unpriced && isNum(a.usd))
    return `<div class="psc-scroll"><table class="ptm-table ptk-table"><thead><tr><th scope="col">Agent</th>${KIND_HEAD}<th scope="col">Estimated cost</th><th scope="col">Share of tokens</th><th scope="col">Models</th></tr></thead>` +
      `<tbody>${rows}</tbody></table></div>` +
      '<p class="psc-foot">Each row is a session the dashboard shows, by its label: its own replies and those of the subagents it started. <i>Of which subagents</i> is the subagents&#39; part of the row above it. Hover a number for the exact count.' +
      `${partly ? ' * Part of that row&#39;s tokens has no price set, so the estimate leaves them out.' : ''}</p>`
  }

  function priceWords(p) {
    if (!p) return '<span class="ptk-noprice">no price set</span>'
    const words = [`${rate(p.input)} in`, `${rate(p.output)} out`, `${rate(p.cacheWrite)} write`, ...(isNum(p.cacheWrite1h) ? [`${rate(p.cacheWrite1h)} 1 hour write`] : []), `${rate(p.cacheRead)} read`]
    return esc(words.join(' · '))
  }

  function modelsHtml(stats) {
    const models = Array.isArray(stats?.models) ? stats.models : []
    if (!models.length) return emptyOf(stats)
    // the price used goes on a line of its own under each model, so the table fits half the page
    const rows = models.map(m => `<tr><th scope="row">${esc(m.model)}</th>${kindCells(m)}${money(m.usd, false)}</tr>` +
      `<tr class="ptk-sub ptk-price"><td colspan="7">${m.price ? 'Price used: ' : ''}${priceWords(m.price)}${m.price && m.price.match !== m.model ? ` <span class="ptk-as">(as ${esc(m.price.match)})</span>` : ''}</td></tr>`).join('')
    return `<div class="psc-scroll ptm-scroll"><table class="ptm-table ptk-table"><thead><tr><th scope="col">Model</th>${KIND_HEAD}<th scope="col">Estimated cost</th></tr></thead>` +
      `<tbody>${rows}</tbody></table></div>` +
      '<p class="psc-foot ptm-foot">Prices are dollars per million tokens.</p>'
  }

  // ═══ How it is counted ═══

  function howHtml(stats) {
    const w = stats?.window || {}
    const n = v => Number(v) || 0
    const src = stats?.prices?.source || {}
    const errors = Array.isArray(stats?.prices?.errors) ? stats.prices.errors : []
    const period = w.days ? `today and the ${w.days - 1} days before it, from local midnight` : 'every day since local midnight of the first day with tokens, in weeks from Monday'
    return '<p class="psc-lede">Counted from the Claude Code transcripts of this project, read only. Nothing is guessed: a reply whose numbers are missing is left out and counted below.</p>' +
      '<ul class="psc-sums">' +
      '<li><b>What counts</b>: every reply of a session whose working folder is in this project (sessions in its worktrees too, and the second account&#39;s), and of every subagent those sessions started. A subagent counts under the session that started it.</li>' +
      '<li><b>Each reply counts once</b>. Claude Code writes one reply as several records with the same message id, and sometimes a partial one first while it streams: the final numbers count, once. A session moved to the other account&#39;s folder or forked carries a copy of its history: the copy is not counted again.</li>' +
      '<li><b>The four kinds</b>: <i>new input</i> is input read fresh, <i>output</i> what the model wrote (its thinking included), <i>cache writes</i> input stored in the prompt cache, <i>cache reads</i> input read back from it.</li>' +
      `<li><b>The period</b> is whole days in this computer&#39;s local time: ${period}. A reply counts on the day of its own time, the same days Pipeline time uses.</li>` +
      '<li><b>Each agent</b> is the label the dashboard shows: a session the config maps keeps that label; any other takes the name it was given (a renamed session keeps one row, under its latest name). A session with no name at all is under Unnamed sessions.</li>' +
      '<li><b>Estimated cost</b> is what the API would charge for these tokens, at the prices per model (an exact model id, or the longest id it starts with). On a subscription plan nothing is charged per token, so this is a yardstick, not a bill. Cache writes that last an hour cost more than 5 minute ones and are priced apart.' +
      `${stats?.cost?.w1hAtWriteRate ? ' A price with no 1 hour rate prices those writes at the 5 minute rate, so the estimate is low there.' : ''}</li>` +
      '<li><b>Per finished job</b> is every token in the period divided by the tickets and other jobs Pipeline time counts as finished in it, so work not finished yet and sessions outside the flows are in it too. It is an average, not what one job cost.</li>' +
      '<li><b>Cache share</b> is cache reads over all input (new input, cache writes and cache reads).</li>' +
      '<li><b>The dashboard&#39;s own runs</b> are its chat, answer relay, explainer, refreshes and Generators, in real dollars as Claude Code reported them (the rail&#39;s spend). They are exact; the rest is an estimate, and the two are never added together, since a run in this project&#39;s folder can be in both.</li>' +
      '</ul>' +
      `<p class="psc-way"><b>Prices</b>: dollars per million tokens. The defaults are from <a href="${esc(src.url || '')}" target="_blank" rel="noopener">${esc(src.url || 'the public pricing page')}</a>, read on ${esc(src.read || 'an unknown date')}, for the models these transcripts use. Prices change: set your own in config.json under tokens.prices, then restart the dashboard.` +
      `${errors.length ? ` Left out because a rate is missing or not a number: ${errors.map(esc).join(', ')}.` : ''}</p>` +
      '<h4 class="psc-h">Not counted</h4><ul class="psc-sums">' +
      `<li>${plural(n(stats?.skipped), 'record')} with no usage or no time ${n(stats?.skipped) === 1 ? 'was' : 'were'} skipped.</li>` +
      `<li>${grouped(n(stats?.dupes))} records repeated a reply already counted from another transcript.</li>` +
      '<li>Small calls Claude Code makes on its own (naming a session, short checks) are not written in the transcripts.</li>' +
      '<li>Web searches ($10 per 1,000 on the API) are not priced.</li>' +
      (n(stats?.special)
        ? `<li>${plural(n(stats.special), 'reply', 'replies')} in this period used fast mode or US only inference, which cost more than the standard prices used here, so the estimate is low for those.</li>`
        : '<li>Fast mode and US only inference cost more than the standard prices used here; no reply in this period used them.</li>') +
      '<li>Prices that depend on the prompt length (Claude Haiku 5.5 over 100,000 tokens) cannot be one rate, so that model has no default price.</li>' +
      '</ul>' +
      `<p class="psc-foot">Read from ${plural(n(stats?.files), 'transcript')}.</p>`
  }

  // ═══ the fixed markup ═══

  const CHEVRON = '<svg class="psc-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>'

  function skeleton() {
    const measures = MEASURES.map(m => `<button type="button" data-measure="${m.key}" aria-pressed="false">${m.label}</button>`).join('')
    const tileHtml = ORDER.map(key => `<div class="psc-tile" role="group" aria-labelledby="ptkName-${key}" data-tile="${key}">` +
      `<div class="psc-top"><span class="psc-name" id="ptkName-${key}">${esc(NAMES[key])}</span><span class="psc-frac num"></span></div>` +
      '<div class="psc-num ptm-num num"></div><p class="psc-mean"></p></div>').join('')
    return '<div class="psc-head">' +
      `<button type="button" class="psc-toggle" aria-expanded="true" aria-controls="ptkBody">${CHEVRON}<span class="psc-title">Pipeline tokens</span></button>` +
      '<span class="psc-line ptk-line num"></span>' +
      '<span class="ptm-span ptk-span"></span>' +
      '</div>' +
      '<p class="ptk-building" role="status" hidden></p>' +
      '<div class="psc-body" id="ptkBody">' +
      `<div class="psc-tiles" role="group" aria-label="Tokens" tabindex="0">${tileHtml}</div>` +
      '<div class="ptm-row ptk-row">' +
      '<section class="ptm-panel" aria-labelledby="ptkDaysH"><div class="ptk-panel-head"><h4 class="psc-h ptm-h" id="ptkDaysH">Per day</h4>' +
      `<span class="psc-seg ptk-measure" role="group" aria-label="Show the bars in">${measures}</span></div><div class="ptk-days"></div></section>` +
      '<section class="ptm-panel" aria-labelledby="ptkModelsH"><h4 class="psc-h ptm-h" id="ptkModelsH">By model</h4><div class="ptk-models-box"></div></section>' +
      '</div>' +
      '<details class="psc-how ptk-agents-box" open><summary>By agent</summary><div class="psc-how-body ptk-agents"></div></details>' +
      '<details class="psc-how"><summary>How it is counted</summary><div class="psc-how-body ptk-how"></div></details>' +
      '</div>' +
      '<p class="psc-note" role="status" hidden></p>'
  }

  window.TokenView = { MEASURES, NONE, measureOf, count, exact, usd, tiles, line, note, barModel, chartHtml, agentsHtml, modelsHtml, howHtml, skeleton }
})()
