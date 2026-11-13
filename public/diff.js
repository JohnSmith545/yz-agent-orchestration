// Diffs, coloured: additions green, removals red. Used by the agent view for
// each Edit / Write in the live feed and for the worktree's uncommitted
// `git diff`, and by the Flow popover for its +N −N counts.
//
// A removed line that is followed by its replacement (a run of − lines then
// a run of + lines) is paired up, and the part that changed inside each pair
// gets a stronger mark, so a one-word edit reads as one word.
//
// Needs app.js first (window.UI.esc).
;(() => {
  const { esc } = window.UI

  // '' is no lines, not one empty line: an edit that only inserts has no "old".
  const lines = t => (t == null || t === '' ? [] : String(t).split('\n'))

  const line = (cls, sign, html) => `<span class="ln ${cls}"><span class="sg">${sign}</span>${html}</span>`

  /** Two versions of a line: mark the middle that differs, when most of it is shared. */
  function pairMarks(a, b) {
    const max = Math.min(a.length, b.length)
    let p = 0
    while (p < max && a[p] === b[p]) p++
    let s = 0
    while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
    // Under ~a third shared, the line was rewritten: marking it all is just noise.
    if (p + s < Math.max(a.length, b.length) * 0.34) return [esc(a), esc(b)]
    const mark = t => {
      const mid = t.slice(p, t.length - s)
      return `${esc(t.slice(0, p))}${mid ? `<mark>${esc(mid)}</mark>` : ''}${esc(t.slice(t.length - s))}`
    }
    return [mark(a), mark(b)]
  }

  /** A run of removed then added lines, paired line by line. */
  function block(dels, adds) {
    const out = []
    const pairs = Math.min(dels.length, adds.length)
    const delHtml = dels.map(esc)
    const addHtml = adds.map(esc)
    for (let i = 0; i < pairs; i++) [delHtml[i], addHtml[i]] = pairMarks(dels[i], adds[i])
    delHtml.forEach(h => out.push(line('d', '−', h)))
    addHtml.forEach(h => out.push(line('a', '+', h)))
    return out
  }

  /** An Edit: old -> new, with at most 2 unchanged lines either side. */
  function edit(oldText, newText) {
    const a = lines(oldText)
    const b = lines(newText)
    let pre = 0
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
    let suf = 0
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
    const dels = a.slice(pre, a.length - suf)
    const adds = b.slice(pre, b.length - suf)
    const out = [
      ...a.slice(Math.max(0, pre - 2), pre).map(l => line('c', '', esc(l))),
      ...block(dels, adds),
      ...a.slice(a.length - suf, a.length - suf + 2).map(l => line('c', '', esc(l))),
    ]
    return { html: `<pre class="diff">${out.join('')}</pre>`, add: adds.length, del: dels.length }
  }

  /** A Write: every line is an addition. Shows the first `max` lines. */
  function write(content, max = 80) {
    const all = lines(content)
    const more = all.length > max ? `<span class="more">… ${all.length - max} more lines</span>` : ''
    return { html: `<pre class="diff">${all.slice(0, max).map(l => line('a', '+', esc(l))).join('')}${more}</pre>`, add: all.length, del: 0 }
  }

  /**
   * A `git diff` patch. Returns the HTML, the counts per file (path -> {add,
   * del}) and the totals. File headers carry their own counts.
   */
  function patch(text) {
    const files = new Map()
    const out = []
    let cur = null
    let header = false
    let dels = []
    let adds = []
    const flush = () => {
      if (dels.length || adds.length) out.push(...block(dels, adds))
      dels = []
      adds = []
    }
    for (const l of String(text || '').split('\n')) {
      if (l.startsWith('diff --git ')) {
        flush()
        const m = / b\/(.+)$/.exec(l)
        cur = { add: 0, del: 0, at: out.length }
        files.set(m ? m[1] : l.slice(11), cur)
        out.push(null) // the file header, filled in once its counts are known
        header = true
        continue
      }
      if (l.startsWith('@@')) {
        flush()
        header = false
        out.push(line('h', '', esc(l)))
        continue
      }
      if (header || !cur) {
        if (l) out.push(line('m', '', esc(l)))
        continue
      }
      if (l.startsWith('-')) {
        if (adds.length) flush()
        dels.push(l.slice(1))
        cur.del++
      } else if (l.startsWith('+')) {
        adds.push(l.slice(1))
        cur.add++
      } else {
        flush()
        if (l.startsWith('\\')) out.push(line('m', '', esc(l)))
        else if (l) out.push(line('c', '', esc(l.slice(1))))
      }
    }
    flush()
    let add = 0
    let del = 0
    for (const [file, c] of files) {
      add += c.add
      del += c.del
      out[c.at] = `<span class="ln f"><span>${esc(file)}</span>${counts(c.add, c.del)}</span>`
    }
    return { html: out.length ? `<pre class="diff">${out.join('')}</pre>` : '', files, add, del }
  }

  /** "+12 −4" plus a five-cell bar of the same split. Empty when nothing changed. */
  function counts(add, del) {
    if (!add && !del) return ''
    const total = add + del
    const green = Math.round((5 * add) / total)
    const cells = Array.from({ length: 5 }, (_, i) => `<i class="${i < green ? 'p' : 'm'}"></i>`).join('')
    return `<span class="delta" title="${add} added, ${del} removed">${add ? `<span class="plus">+${add}</span>` : ''}${del ? `<span class="minus">−${del}</span>` : ''}<span class="cells" aria-hidden="true">${cells}</span></span>`
  }

  /** A porcelain status code (" M", "A ", "??", "R "...) -> its letter and kind. */
  function status(code) {
    const c = String(code || '')
    if (c.includes('?')) return { letter: 'N', kind: 'new', title: 'New file, not tracked yet' }
    if (c.includes('D')) return { letter: 'D', kind: 'del', title: 'Deleted' }
    if (c.includes('A')) return { letter: 'A', kind: 'add', title: 'Added' }
    if (c.includes('R')) return { letter: 'R', kind: 'ren', title: 'Renamed' }
    return { letter: 'M', kind: 'mod', title: 'Modified' }
  }

  window.Diff = { edit, write, patch, counts, status }
})()
