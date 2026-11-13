// The Flow view's nodes: a row's items (classified events and git facts, in
// time order) collapsed into operation nodes, each with a label, a second line,
// a status mark (pass, fail, running, pending) and the details its popover shows.

import { LEVELS } from './flow-git.mjs'
import { testOutcome } from './report.mjs'

/** report.mjs's test outcome -> the node's status mark. */
export const OUTCOME = { passed: 'pass', failed: 'fail', 'still running': 'running', 'started in the background': 'background' }
// Runs of these kinds collapse into one node; briefs, messages and spawns stay one each (they carry arrows).
const COLLAPSE = new Set(['explore', 'edit', 'test', 'commit', 'push', 'merge', 'land'])
// A tool call with no result after this long was interrupted, not running.
const RUNNING_FOR_MS = 30 * 60_000

const clip = (s, n) => {
  s = String(s ?? '').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
const firstLine = s => String(s || '').trim().split('\n')[0]
const ms = iso => (iso ? new Date(iso).getTime() : NaN)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// '' is no lines, not one empty line: an edit that only inserts has no old text.
const lines = t => (t == null || t === '' ? [] : String(t).split('\n'))

/**
 * Lines one Edit / Write call added and removed, trimming the unchanged lines
 * either side (the same rule public/diff.js draws with). A Write counts every
 * line as added: the transcript does not keep what the file held before.
 */
export function lineDelta(ev) {
  if (ev.isError) return { add: 0, del: 0 }
  if (ev.tool === 'Write' || ev.tool === 'NotebookEdit') return { add: lines(ev.content).length, del: 0 }
  let add = 0
  let del = 0
  for (const e of ev.edits || []) {
    const a = lines(e.old)
    const b = lines(e.new)
    let pre = 0
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
    let suf = 0
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
    del += a.length - pre - suf
    add += b.length - pre - suf
  }
  return { add, del }
}

// ─── nodes ────────────────────────────────────────────────────────────────────

function testVerdict(ev, now) {
  if (ev._later) return ev._later.verdict
  const o = OUTCOME[testOutcome(ev)] || 'unknown'
  if (o === 'running' && now - ms(ev.t) > RUNNING_FOR_MS) return 'unknown'
  return o === 'background' ? 'unknown' : o
}

export function finalize(n, ctx) {
  const items = n.items
  const last = items[items.length - 1]
  const node = { id: n.id, type: n.type, t: n.t, t2: n.t2 !== n.t ? n.t2 : null, label: '', sub: '', status: null, detail: {} }
  if (n.note) node.detail.note = clip(n.note, 420)
  const running = last.ev?.kind === 'tool' && last.ev.result == null && !last.ev.doneAt && ctx.now - ms(last.t) < RUNNING_FOR_MS
  if (running) node.status = 'running'
  switch (n.type) {
    case 'brief':
    case 'heard': {
      node.label = n.type === 'brief' ? `Briefed by ${last.from}` : `From ${last.from}`
      node.sub = clip(firstLine(last.text), 60)
      node.detail.from = last.from
      node.detail.text = clip(last.text, 900)
      break
    }
    case 'message': {
      node.label = last.handback ? `Reported to ${last.to}` : `Messaged ${last.to}`
      node.sub = clip(firstLine(last.text), 60)
      node.detail.to = last.to
      node.detail.text = clip(last.text, 900)
      break
    }
    case 'spawn': {
      node.label = 'Spawned subagent'
      node.sub = clip(last.ev.summary, 60)
      node.detail.description = last.ev.summary
      node.detail.text = clip(last.ev.text, 700)
      break
    }
    case 'explore': {
      const count = { read: 0, search: 0, command: 0, web: 0, browser: 0, other: 0 }
      for (const it of items) count[it.what]++
      const words = { read: 'read', search: 'search', command: 'command', web: 'web call', browser: 'browser step', other: 'tool call' }
      node.label = 'Explored'
      node.sub = Object.entries(count)
        .filter(([, v]) => v)
        .map(([k, v]) => plural(v, words[k]).replace('searchs', 'searches'))
        .join(' · ')
      node.detail.items = items.slice(-14).map(it => ({ t: it.t, what: it.ev.tool, text: clip(ctx.short(it.ev.file) || firstLine(it.ev.command) || it.ev.summary, 160) }))
      node.detail.total = items.length
      break
    }
    case 'edit': {
      const files = new Map() // path -> { count, add, del }
      let shell = 0
      for (const it of items) {
        if (it.shell) {
          shell++
          continue
        }
        const f = files.get(ctx.short(it.file)) || { count: 0, add: 0, del: 0 }
        const d = lineDelta(it.ev)
        f.count += it.n
        f.add += d.add
        f.del += d.del
        files.set(ctx.short(it.file), f)
      }
      const all = [...files.values()]
      const edits = all.reduce((a, f) => a + f.count, 0)
      node.add = all.reduce((a, f) => a + f.add, 0)
      node.del = all.reduce((a, f) => a + f.del, 0)
      node.label = files.size ? `Edited ${plural(files.size, 'file')}` : 'Edited via shell'
      node.sub = [edits ? plural(edits, 'edit') : '', shell ? `${shell} via shell` : ''].filter(Boolean).join(' · ')
      node.detail.files = [...files.entries()].map(([file, f]) => ({ file, ...f })).slice(0, 30)
      node.detail.shell = items.filter(it => it.shell).slice(-4).map(it => clip(firstLine(it.ev.command), 160))
      if (items.some(it => it.ev.isError)) node.detail.errors = items.filter(it => it.ev.isError).length
      break
    }
    case 'test': {
      const runs = items.map(it => ({
        t: it.t,
        command: clip(firstLine(String(it.ev.command).replace(/^cd\s+("[^"]*"|\S+)\s*&&\s*/, '')), 200),
        summary: it.ev.summary || '',
        verdict: testVerdict(it.ev, ctx.now),
        tail: clip(
          String(it.ev._later?.result ?? it.ev.result ?? '')
            .trim()
            .split('\n')
            .slice(-8)
            .join('\n'),
          700
        ),
      }))
      const pass = runs.filter(r => r.verdict === 'pass').length
      const fail = runs.filter(r => r.verdict === 'fail').length
      node.status = runs[runs.length - 1].verdict
      node.label = node.status === 'pass' ? 'Tests passed' : node.status === 'fail' ? 'Tests failed' : node.status === 'running' ? 'Testing' : 'Tested'
      node.sub = runs.length > 1 ? `${plural(runs.length, 'run')} · ${pass} pass · ${fail} fail` : clip(runs[0].summary || runs[0].command, 60)
      node.detail.runs = runs.slice(-6)
      node.detail.total = runs.length
      break
    }
    case 'commit': {
      const commits = items.flatMap(it => (it.git ? [it.commit] : it.commits.length ? it.commits : [{ sha: '', subject: firstLine(it.ev.command), branch: '' }]))
      node.label = commits.length > 1 ? `Committed ${commits.length}` : 'Committed'
      node.sub = commits[0].sha ? `${commits[0].sha.slice(0, 9)} ${commits[0].subject}` : 'git commit'
      node.detail.commits = commits.slice(0, 12)
      node.detail.fromGit = items.every(it => it.git)
      if (items.some(it => it.pushed)) node.detail.pushed = true
      if (items.some(it => it.ev?.isError)) node.status = 'fail'
      break
    }
    case 'merge': {
      const branches = [...new Set(items.flatMap(it => it.branches))]
      node.label = branches.length === 1 ? 'Merged a branch' : `Merged ${plural(branches.length, 'branch')}`.replace('branchs', 'branches')
      node.sub = clip(branches.join(', ') || 'git merge', 60)
      node.detail.branches = branches
      node.detail.command = clip(firstLine(last.ev.command), 200)
      if (items.some(it => it.pushed)) node.detail.pushed = true
      if (items.some(it => it.ev.isError)) node.status = 'fail'
      node._branches = branches
      break
    }
    case 'push': {
      const refs = [...new Set(items.flatMap(it => it.refs))]
      node.label = 'Pushed'
      node.sub = clip(refs.join(', ') || 'git push', 60)
      node.detail.refs = refs
      if (items.some(it => it.ev.isError)) node.status = 'fail'
      break
    }
    case 'land': {
      const level = LEVELS.find(l => l.key === n.level)
      node.level = n.level
      node.label = level.done
      node.sub = clip(items.map(it => it.branch).join(', '), 60)
      node.detail.landings = items.map(it => ({ branch: it.branch, sha: it.sha.slice(0, 9), subject: clip(it.subject, 160), t: it.t }))
      node.detail.fromGit = true
      node._branches = items.map(it => it.branch)
      break
    }
    case 'pending': {
      node.label = n.label
      node.sub = n.sub
      node.status = 'pending'
      node.ghost = true
      node.detail = n.detail
      break
    }
  }
  return node
}

/** Items (classified events plus git facts) in time order -> collapsed nodes. */
export function toNodes(items, ctx) {
  const nodes = []
  let last = null
  for (const it of items) {
    if (it.type === 'note') {
      if (last) last.note = it.text
      continue
    }
    const same = last && last.type === it.type && COLLAPSE.has(it.type) && (it.type !== 'land' || last.level === it.level)
    if (same) {
      last.items.push(it)
      last.t2 = it.t
    } else {
      last = { id: ctx.nextId(), type: it.type, level: it.level, t: it.t, t2: it.t, items: [it] }
      nodes.push(last)
    }
    if (it.ev) ctx.nodeOfEvent.set(it.ev, last.id)
  }
  return nodes
}
