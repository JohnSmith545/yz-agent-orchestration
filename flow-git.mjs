// The Flow view's git facts (flow.mjs draws them): for each task on screen, its
// branches, when each landed on followup, origin/dev and origin/stage, and the
// commits naming its tickets in the window.
//
// READ ONLY: for-each-ref, rev-parse, log, rev-list and merge-base. Results are
// cached by commit id, so a refresh only asks git about what moved.

import { CONFIG } from './config.mjs'
import path from 'node:path'

import { idsInBranch, idsInText } from './transcripts.mjs'

// The branches come from config levels (config.mjs levelSettings); the keys stay as the page knows them.
const { work, dev, stage } = CONFIG.levels
export const LEVELS = [
  { key: 'followup', ref: work, done: `Merged into ${work}`, todo: `Not in ${work} yet` },
  { key: 'dev', ref: dev, done: 'On dev', todo: 'Not on dev yet' },
  { key: 'stage', ref: stage, done: 'On stage', todo: 'Not on stage yet' },
]

const DAY = 86_400_000
const ms = iso => (iso ? new Date(iso).getTime() : NaN)
const clip = (s, n) => {
  s = String(s ?? '').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// ─── git ──────────────────────────────────────────────────────────────────────

const landingCache = new Map() // `${tip}|${levelTip}` -> { sha, t, subject } | 'old' | null
const firstParentCache = new Map() // `${levelTip}|${sinceDay}` -> [{ sha, t, subject }] oldest first

async function firstParents(git, ref, tip, sinceIso) {
  const key = `${tip}|${sinceIso.slice(0, 10)}`
  if (!firstParentCache.has(key)) {
    const r = await git(['log', '--first-parent', ref, `--since=${sinceIso}`, '--format=%H%x09%cI%x09%s'])
    const list = r.ok
      ? r.out
          .split('\n')
          .filter(Boolean)
          .map(l => {
            const [sha, t, subject] = l.split('\t')
            return { sha, t, subject }
          })
          .reverse()
      : []
    firstParentCache.set(key, list)
  }
  return firstParentCache.get(key)
}

/** Where a branch tip entered a level: the oldest first-parent commit of the level that descends from it. */
async function landing(git, tip, level, levelTip, fp, sinceIso) {
  const key = `${tip}|${levelTip}`
  if (landingCache.has(key)) return landingCache.get(key)
  let hit = null
  if (tip === levelTip) hit = fp[fp.length - 1] || 'old'
  else {
    const r = await git(['rev-list', '--ancestry-path', `--since=${sinceIso}`, `${tip}..${level.ref}`])
    const desc = new Set(r.ok ? r.out.split('\n').filter(Boolean) : [])
    if (desc.size) hit = fp.find(c => desc.has(c.sha)) || null
    // Merged before the window of first-parent history we read: landed, time unknown.
    if (!hit && (await git(['merge-base', '--is-ancestor', tip, level.ref])).ok) hit = 'old'
  }
  landingCache.set(key, hit)
  return hit
}

async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

/**
 * Git facts for the tasks on screen: each task's branches, when each landed on
 * followup / dev / stage, and commits naming its tickets in the window.
 */
export async function gitFacts(git, tasks, from, worktrees) {
  const sinceIso = new Date(from - 30 * DAY).toISOString()
  const [refsOut, tipsOut, logOut] = await Promise.all([
    git(['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)']),
    git(['rev-parse', ...LEVELS.map(l => l.ref)]),
    git(['log', '--all', '--no-merges', `--since=${new Date(from).toISOString()}`, '--format=%H%x09%cI%x09%s']),
  ])
  const refs = refsOut.out
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [name, sha, at] = l.split('\t')
      return { name, sha, at, ids: idsInBranch(name) }
    })
  const levelTips = tipsOut.ok ? tipsOut.out.split('\n') : []
  const fps = await Promise.all(LEVELS.map((l, i) => (levelTips[i] ? firstParents(git, l.ref, levelTips[i], sinceIso) : [])))

  const commitsById = new Map()
  const seenSubjects = new Set()
  for (const line of logOut.out.split('\n').filter(Boolean)) {
    const [sha, t, subject = ''] = line.split('\t')
    if (seenSubjects.has(subject)) continue // the same commit cherry-picked onto another branch
    seenSubjects.add(subject)
    for (const id of idsInText(subject)) {
      if (!commitsById.has(id)) commitsById.set(id, [])
      commitsById.get(id).push({ sha: sha.slice(0, 9), subject: clip(subject, 160), t, branch: '' })
    }
  }

  const facts = new Map()
  await pool(tasks, 4, async task => {
    const wtBranch = task.key.startsWith('wt:') ? worktrees.find(w => path.basename(w.path) === task.key.slice(3))?.branch : ''
    const oldest = task.firstT - 3 * DAY
    const branches = refs.filter(r => (wtBranch ? r.name === wtBranch : r.ids.some(id => task.ids.includes(id))) && ms(r.at) >= oldest).sort((a, b) => ms(b.at) - ms(a.at))
    const landings = []
    const reached = {}
    for (const b of branches) {
      reached[b.name] = {}
      for (const [i, level] of LEVELS.entries()) {
        if (!levelTips[i]) continue
        const hit = await landing(git, b.sha, level, levelTips[i], fps[i], sinceIso)
        reached[b.name][level.key] = Boolean(hit)
        if (hit && hit !== 'old' && ms(hit.t) >= from) landings.push({ type: 'land', level: level.key, t: hit.t, branch: b.name, sha: hit.sha, subject: hit.subject })
      }
    }
    // Commits naming the ticket, plus the newest branch's own commits when it is not merged yet.
    const commits = task.ids.flatMap(id => commitsById.get(id) || [])
    const newest = branches[0]
    if (newest && !reached[newest.name]?.followup && !reached[newest.name]?.dev) {
      const r = await git(['log', '--no-merges', `--since=${new Date(from).toISOString()}`, '--format=%H%x09%cI%x09%s', newest.sha, '^followup', '^origin/dev'])
      for (const line of r.ok ? r.out.split('\n').filter(Boolean) : []) {
        const [sha, t, subject] = line.split('\t')
        if (!commits.some(c => c.subject === subject)) commits.push({ sha: sha.slice(0, 9), subject: clip(subject, 160), t, branch: newest.name })
      }
    }
    facts.set(task.key, { branches, newest, reached: newest ? reached[newest.name] : null, landings, commits })
  })
  return facts
}
