// The self-checked count on the scorecard, the PURE words (score-view.js asks for them when this script is on the
// page; GET /api/score carries the numbers as selfCheck, quality-score.mjs): right first time for the flows whose
// producer recorded a self-check before QA, against the flows with none. Under 5 judged flows on a side it says Too few
// to trust, never a confident number. Plain text: score-strip.js writes it with textContent.
//
//   QualityScore.line(split)   'Self-checked: 80% right first time (4 of 5). Not self-checked: 33% (2 of 6).'
//   QualityScore.HOW           the one sentence for How it is counted
;(() => {
  const FEW = 'Too few to trust'
  const pct = v => `${Math.round(v * 100)}%`
  const side = (s, first) => {
    if (!s || !s.trust || !Number.isFinite(s.value)) return `${FEW} (${Number(s?.judged) || 0})`
    return `${pct(s.value)}${first ? ' right first time' : ''} (${s.right} of ${s.judged})`
  }
  function line(split) {
    if (!split || typeof split !== 'object') return ''
    return `Self-checked: ${side(split.with, true)}. Not self-checked: ${side(split.without, false)}.`
  }
  const HOW = 'Self-checked splits correctness by whether the builder recorded a self-check before QA (flow self-check); with fewer than 5 flows on a side it says Too few to trust.'
  window.QualityScore = { line, HOW, FEW }
})()
