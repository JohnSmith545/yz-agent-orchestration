// The pipeline scorecard on the Agents page, the PURE half: what each tile says, the one line shown when the strip
// is collapsed, the How it is counted HTML, the strip's fixed skeleton, and what a remembered choice means. No DOM,
// no fetch, no storage (score-strip.js does those), so test/score-view.test.mjs runs it in a vm with a bare window.
//
//   ScoreView.tiles(score, beta)   [{ key, name, number, fraction, meaning, empty }] for the five tiles, in order
//   ScoreView.line(score, beta)    'Precision 100% · Recall 56% · F1 71% · Accuracy 71% · Correctness 50%'
//   ScoreView.howHtml(score)       the four boxes with live counts, the flows behind them, the sums, By agent
//   ScoreView.skeleton()           the strip's markup, built once (the numbers go in later as text)
//   ScoreView.windowOf(v), betaOf(v)   a stored choice as '7' | '30' | 'all' and 1 | 4, with safe defaults
//
// Rules: a score with no data is 'Not enough data yet', never 0%, not-a-number or a dash; every number sits beside its plain
// meaning; every value from the server goes through UI.esc; no em dashes in the copy. `score` is /api/score's body
// (score.mjs scoreOf). MEANING MUST CHANGE IN LOCKSTEP with score.mjs MEANING (the test compares them).
;(() => {
  const MEANING = Object.freeze({
    precision: 'Of everything delivered, how much was checked and right.',
    recall: 'Of everything that should have been delivered, how much was.',
    f: 'Precision and recall in one number.',
    accuracy: 'How often the pipeline made the right call.',
    correctness: 'How often the work was right the first time.',
  })
  const WINDOWS = Object.freeze([
    Object.freeze({ key: '7', label: '7 days' }),
    Object.freeze({ key: '30', label: '30 days' }),
    Object.freeze({ key: 'all', label: 'All' }),
  ])
  const NAMES = Object.freeze({ precision: 'Precision', recall: 'Recall', f: 'F-score', accuracy: 'Accuracy', correctness: 'Correctness' })
  const ORDER = Object.freeze(['precision', 'recall', 'f', 'accuracy', 'correctness'])
  const F_SAYS = Object.freeze({ 1: 'Both count the same.', 4: 'Missed work counts far more.' })
  const NONE = 'Not enough data yet'

  const esc = s => window.UI.esc(s)
  const pct = v => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : null)
  const windowOf = v => (WINDOWS.some(w => w.key === v) ? v : '30')
  const betaOf = v => (v === '4' ? 4 : 1)
  const spanOf = score => (score?.window?.days ? `the last ${score.window.days} days` : 'all time')
  const stallOf = score => score?.window?.stallDays ?? 7

  /** Each score as { value, top, bottom }, the F-score at the chosen beta and correctness included. */
  function ratios(score, beta) {
    const c = score.correctness || {}
    return {
      precision: score.precision,
      recall: score.recall,
      f: { value: score.f?.[beta]?.value ?? null, top: null, bottom: null },
      accuracy: score.accuracy,
      correctness: { value: c.value ?? null, top: c.right, bottom: c.judged },
    }
  }

  function tiles(score, beta) {
    const r = ratios(score, beta)
    return ORDER.map(key => {
      const value = pct(r[key]?.value)
      const fraction = key === 'f' || value === null ? '' : `${r[key].top} of ${r[key].bottom}`
      const meaning = key === 'f' ? `${MEANING.f} ${F_SAYS[beta]}` : MEANING[key]
      return { key, name: NAMES[key], number: value ?? NONE, fraction, meaning, empty: value === null }
    })
  }

  function line(score, beta) {
    const r = ratios(score, beta)
    if (ORDER.every(k => pct(r[k]?.value) === null)) return `${NONE} for any score.`
    return ORDER.map(k => `${k === 'f' ? `F${beta}` : NAMES[k]} ${pct(r[k]?.value) ?? 'not enough data'}`).join(' · ')
  }

  // ═══ How it is counted ═══

  const WHY = { dropped: () => 'Dropped', stopped: () => 'Stopped at QA', stalled: days => `No update for ${days} days` }

  function flowList(items, stall) {
    if (!items?.length) return '<p class="psc-none">None.</p>'
    return `<ul class="psc-flows">${items
      .map(f => {
        const why = WHY[f.why] ? ` <span class="psc-why">${esc(WHY[f.why](stall))}</span>` : ''
        return `<li><button type="button" class="link" data-score-flow="${esc(f.id)}">${esc(f.title || f.id)}</button>${why}</li>`
      })
      .join('')}</ul>`
  }

  function agentsTable(agents) {
    if (!agents?.length) return '<p class="psc-none">Nothing was handed to QA in this window.</p>'
    const rows = agents
      .map(a => `<tr><th scope="row">${esc(a.label)}</th><td class="num">${Number(a.handed) || 0}</td><td class="num">${Number(a.firstTime) || 0}</td><td class="num">${Number(a.sentBack) || 0}</td></tr>`)
      .join('')
    return '<div class="psc-scroll"><table class="psc-agents"><thead><tr><th scope="col">Agent</th><th scope="col">Handed to QA</th><th scope="col">Passed first time</th><th scope="col">Sent back</th></tr></thead>' +
      `<tbody>${rows}</tbody></table></div>` +
      '<p class="psc-foot">Handed to QA: times its work went to QA. Passed first time: flows QA passed with no failure on the way. Sent back: times QA or Security failed its work.</p>'
  }

  function howHtml(score) {
    const n = score.counts || {}
    const stall = stallOf(score)
    const c = score.correctness || {}
    const num = v => Number(v) || 0
    // each count links to the events behind it (pipeline-panel.js opens its Log with that filter)
    const cell = (count, name, says, filter) => `<td><b class="psc-n">${num(count)}</b> ${name}<span class="psc-says">${says}</span>` +
      `<button type="button" class="link psc-seelog" data-log-filter="${filter}">See these in the log</button></td>`
    const way = num(score.inFlight) === 1 ? '1 flow is still on its way, so it is not counted yet.' : `${num(score.inFlight)} flows are still on their way, so they are not counted yet.`
    return `<p class="psc-lede">The pipeline makes one call on each piece of work: let it through to the Output, or hold it back. Counted over ${esc(spanOf(score))}.</p>` +
      '<div class="psc-scroll"><table class="psc-four"><caption class="psc-sr">The four counts</caption>' +
      '<thead><tr><td></td><th scope="col">The work was good</th><th scope="col">The work was not good</th></tr></thead><tbody>' +
      `<tr><th scope="row">Went to the Output</th>${cell(n.delivered, 'Right, delivered', 'QA passed it (and Security, when it is on the pipeline), or it finished with no code changes.', 'delivered')}${cell(n.slipped, 'Wrong, slipped through', 'It finished with code changes QA never tested, or that Security never passed.', 'slipped')}</tr>` +
      `<tr><th scope="row">Held back</th>${cell(n.missed, 'Wrong, missed', `Dropped, stopped at QA or Security, or no update for ${stall} days.`, 'missed')}${cell(n.caught, 'Right, caught', 'Each time QA or Security failed the work and held it back.', 'caught')}</tr>` +
      '</tbody></table></div>' +
      `<p class="psc-way">${way}</p>` +
      `<div class="psc-lists"><div><h4 class="psc-h">Slipped through</h4>${flowList(score.lists?.slipped, stall)}</div>` +
      `<div><h4 class="psc-h">Missed</h4>${flowList(score.lists?.missed, stall)}</div></div>` +
      '<h4 class="psc-h">The sums</h4><ul class="psc-sums">' +
      `<li>Precision: ${num(n.delivered)} ÷ (${num(n.delivered)} + ${num(n.slipped)}), right delivered over everything delivered.</li>` +
      `<li>Recall: ${num(n.delivered)} ÷ (${num(n.delivered)} + ${num(n.missed)}), right delivered over everything that should have been.</li>` +
      '<li>F-score: precision and recall together. F1 weighs them the same; F4 treats recall as 4 times as important.</li>' +
      `<li>Accuracy: (${num(n.delivered)} + ${num(n.caught)}) ÷ ${num(n.delivered) + num(n.slipped) + num(n.missed) + num(n.caught)}, the right calls over all four counts.</li>` +
      `<li>Correctness: ${num(c.right)} ÷ ${num(c.judged)}, flows passed (by QA, and by Security when it is on the pipeline) with no failure on the way, over flows passed or stopped.</li></ul>` +
      `<h4 class="psc-h">By agent</h4>${agentsTable(score.agents)}` +
      '<p class="psc-foot">Archived flows count. Flows in the Trash do not.</p>'
  }

  // ═══ the fixed markup ═══

  const CHEVRON = '<svg class="psc-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>'

  function skeleton() {
    const windows = WINDOWS.map(w => `<button type="button" data-window="${w.key}" aria-pressed="false">${w.label}</button>`).join('')
    const tileHtml = ORDER.map(key => {
      const side = key === 'f'
        ? '<span class="psc-seg psc-beta" role="group" aria-label="Which F-score"><button type="button" data-beta="1" aria-pressed="false">F1</button><button type="button" data-beta="4" aria-pressed="false">F4</button></span>'
        : '<span class="psc-frac num"></span>'
      return `<div class="psc-tile" role="group" aria-labelledby="pscName-${key}" data-tile="${key}">` +
        `<div class="psc-top"><span class="psc-name" id="pscName-${key}">${NAMES[key]}</span>${side}</div>` +
        '<div class="psc-num num"></div><p class="psc-mean"></p></div>'
    }).join('')
    return '<div class="psc-head">' +
      `<button type="button" class="psc-toggle" aria-expanded="true" aria-controls="pscBody">${CHEVRON}<span class="psc-title">Pipeline score</span></button>` +
      '<span class="psc-line num"></span>' +
      `<span class="psc-seg psc-window" role="group" aria-label="Count over">${windows}</span>` +
      '</div>' +
      '<div class="psc-body" id="pscBody">' +
      `<div class="psc-tiles" role="group" aria-label="Scores" tabindex="0">${tileHtml}</div>` +
      '<details class="psc-how"><summary>How it is counted</summary><div class="psc-how-body"></div></details>' +
      '</div>' +
      '<p class="psc-note" role="status" hidden></p>'
  }

  window.ScoreView = { MEANING, WINDOWS, NONE, windowOf, betaOf, pct, tiles, line, howHtml, skeleton }
})()
