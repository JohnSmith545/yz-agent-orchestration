// The Human task box of the Agents diagram (#/agents): the user's own step (pipeline.mjs node `human`), where work
// with no code changes passes and a flow with by-hand steps waits. It is the user, not an agent: no settings window,
// no model pill. pipeline-view.js draws its inside with this file instead of an agent's:
//
//   ┌ Human task          +2 ┐
//   │ ● 8 questions           │   what waits on you, the Human review list's own split (human-review.js), one
//   │ ● 2 by hand             │   line each so it reads whole in a narrow box (the list's head says it in one line)
//   │ [Rotate the deploy key] │   up to three of the flows standing here (their current step is Human task),
//   │ [Turn on Cloud Armor  ] │   newest need first, then +N in the head
//   └─────────────────────────┘
//
// A click on it, or Enter on its name, scrolls to the Human review list under the diagram and focuses its heading
// (agents-page.js pickNode calls HumanReview.show); a chip opens its flow's explanation like every chip. The list
// itself stays where it is. Pure: a node and what is known in, HTML out (test/pipeline-human.test.mjs).
//
//   inner(node, { list, labels, counts })   the box's inside. counts: the live Human review's, null while it is still
//                                           loading (Loading…), or left out for a saved orchestration (the bank page,
//                                           QA B-5): then no count line at all, as there is no live list behind it
//   rows(list, counts)                      the chip rows it needs: its count lines, then its chips
//   countParts(counts) / countText(counts)  ['8 questions', '2 by hand'] / `8 questions · 2 by hand`; empty when
//                                           nothing keeps an agent waiting
;(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const MAX = 3
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

  /** What keeps an agent waiting on the user, as the Human review head splits it: questions, then by-hand work. */
  const countParts = counts => [[counts?.ask, 'question', 'questions'], [counts?.hand, 'by hand', 'by hand']]
    .filter(([v]) => Number(v) > 0).map(([v, one, many]) => plural(Number(v), one, many))
  const countText = counts => countParts(counts).join(' · ')

  /** One line per kind waiting (one that says nothing waits, or Loading), none with no counts; then up to MAX chips. */
  const rows = (list, counts) => (counts === undefined ? 0 : Math.max(1, countParts(counts).length)) + Math.min(MAX, Array.isArray(list) ? list.length : 0)

  function inner(node, { list = [], labels = {}, counts } = {}) {
    const T = window.PipelineTickets
    const shown = list.slice(0, MAX)
    const more = list.length - shown.length
    const text = countText(counts)
    const parts = countParts(counts)
    const saved = counts === undefined
    const lines = saved ? [] : parts.length ? parts : [counts ? 'Nothing waits on you' : 'Loading…']
    const here = list.length ? `, ${plural(list.length, 'flow', 'flows')} waiting here` : ''
    const said = saved ? `${node.label}${here}.` : `${node.label}: ${counts ? text || 'nothing waits on you' : 'loading'}${here}. Show Human review.`
    return `<button type="button" class="pl-node-head" aria-label="${esc(said)}"><span class="pl-name">${esc(node.label)}</span>` +
      `${more ? `<span class="pl-more" title="${more} more here">+${more}</span>` : ''}</button>` +
      lines.map(l => `<p class="pl-human-count${text ? '' : ' is-calm'}"><i class="hr-dot${text ? '' : ' is-calm'}" aria-hidden="true"></i>${esc(l)}</p>`).join('') +
      (shown.length ? `<div class="pl-chips">${shown.map(t => T.chipHtml(t, labels)).join('')}</div>` : '')
  }

  window.PipelineHuman = { inner, rows, countParts, countText, MAX }
})()
