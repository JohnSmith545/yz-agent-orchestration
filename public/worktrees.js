// The worktree table, as pure HTML from the /api/status `worktrees` rows. It
// left Home (spec 5) and becomes a folded section at the bottom of Tickets
// (Task 3 mounts it there with Worktrees.html(data.worktrees)).
//
// Needs app.js first (window.UI).
;(function () {
  const HEAD = ['Worktree', 'Branch', 'Agent', 'Uncommitted', 'vs its remote', 'vs dev', 'followup', 'dev', 'stage', 'Last commit']

  /** Agent worktrees first, then by name; one row each. */
  function html(rows) {
    const { esc, chip } = window.UI
    const ab = x => (x ? `<span class="num">${x.ahead}↑ ${x.behind}↓</span>` : '<span class="faint">—</span>')
    const body = (rows || [])
      .slice()
      .sort((a, b) => Number(b.isAgentTree) - Number(a.isAgentTree) || a.name.localeCompare(b.name))
      .map(
        w => `<tr>
      <td class="mono">${esc(w.name)}</td><td><span class="branch">${esc(w.branch)}</span></td><td>${esc(w.agent || '—')}</td>
      <td>${w.dirty ? `<span class="warn">${w.dirty} files</span>` : w.dirty === 0 ? '<span class="faint">clean</span>' : '?'}</td>
      <td>${w.upstream ? `${ab(w.vsUpstream)}<span class="sub branch">${esc(w.upstream)}</span>` : '<span class="faint">no remote</span>'}</td>
      <td>${ab(w.vsDev)}</td><td>${chip(w.followup)}</td><td>${chip(w.dev)}</td><td>${chip(w.stage)}</td>
      <td class="small"><span class="mono">${esc(w.last.sha)}</span> ${esc(window.Shell.ago(w.last.when))}<span class="sub subj" title="${esc(w.last.subject)}">${esc(w.last.subject)}</span></td>
    </tr>`
      )
      .join('')
    return `<table class="wt-table"><thead><tr>${HEAD.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`
  }

  window.Worktrees = { html }
})()
