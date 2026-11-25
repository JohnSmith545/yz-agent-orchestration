// Every Learn run, kept: data/learn/<YYYY-MM-DD>.json, one file per local day (the Standup creator's archive does the
// same, standup-archive.mjs), each { day, runs: [run] } with the runs of that day oldest first.
//
//   run = { id, at, ok, error?, cost, ms, window: { from, to, days, widened }, read, left, nothing,
//           proposals: [{ n, target, action, rule, old, flows, evidence, effect, check,
//                         state: open|accepted|rejected, text?, reason?, decidedAt?, note? }], dropped: [{ why }] }
//
//   newRunId(at) / isRunId(id)        `2026-11-25-a1b2c3`: the local day, then 6 hex digits
//   appendRun(run, dir)               add a run to its day's file
//   listRuns(dir, limit)              every run, newest first
//   findRun(id, dir)                  { day, run } or null; the id is checked BEFORE any path is built
//   setProposal(id, n, patch, dir)    what the user did with one proposal; returns the run, or null
//   lastRunAt(dir)                    when the newest GOOD run started: the next window and the reminder count from it
//   rejectedIdeas(dir, limit)         [{ target, rule, reason, at }] newest first, for the next pack
//
// Rules this file keeps: a file is written whole through atomic-write.mjs; a torn or hand-made file reads as no runs
// (never a failed page); `dir` is passed in by every caller, so tests never touch data/.

import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeAtomic } from './atomic-write.mjs'
import { DATA_DIR } from './factory-state.mjs'

export const RUNS_DIR = path.join(DATA_DIR, 'learn')
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/
const RUN_ID = /^(\d{4}-\d{2}-\d{2})-[0-9a-f]{6}$/
const pad = n => String(n).padStart(2, '0')
const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

export const newRunId = (at = new Date()) => `${localDay(at)}-${randomBytes(3).toString('hex')}`
export const isRunId = id => typeof id === 'string' && RUN_ID.test(id)

function readDayFile(day, dir) {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, `${day}.json`), 'utf8'))
    return (Array.isArray(raw?.runs) ? raw.runs : []).filter(r => isObject(r) && isRunId(r.id) && typeof r.at === 'string')
  } catch {
    return []
  }
}
const writeDay = (day, runs, dir) => writeAtomic(path.join(dir, `${day}.json`), JSON.stringify({ day, runs }, null, 1))

export function appendRun(run, dir = RUNS_DIR) {
  const day = RUN_ID.exec(run.id)[1]
  writeDay(day, [...readDayFile(day, dir), run], dir)
}

export function listRuns(dir = RUNS_DIR, limit = 50) {
  let days
  try {
    days = readdirSync(dir).map(f => DAY_FILE.exec(f)?.[1]).filter(Boolean)
  } catch {
    return []
  }
  return days.flatMap(day => readDayFile(day, dir)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit)
}

export function findRun(id, dir = RUNS_DIR) {
  if (!isRunId(id)) return null
  const day = RUN_ID.exec(id)[1]
  const run = readDayFile(day, dir).find(r => r.id === id)
  return run ? { day, run } : null
}

export function setProposal(id, n, patch, dir = RUNS_DIR) {
  const found = findRun(id, dir)
  if (!found) return null
  const runs = readDayFile(found.day, dir)
  const run = runs.find(r => r.id === id)
  const p = (run.proposals || []).find(x => x.n === n)
  if (!p) return null
  Object.assign(p, patch)
  writeDay(found.day, runs, dir)
  return run
}

export function lastRunAt(dir = RUNS_DIR) {
  return listRuns(dir, 500).find(r => r.ok)?.at ?? null
}

export function rejectedIdeas(dir = RUNS_DIR, limit = 30) {
  return listRuns(dir, 500)
    .flatMap(r => (r.proposals || []).filter(p => p?.state === 'rejected').map(p => ({ target: p.target, rule: p.action === 'remove' ? p.old : p.rule, reason: p.reason || '', at: p.decidedAt || r.at, runAt: r.at, n: p.n })))
    .sort((a, b) => Date.parse(b.runAt) - Date.parse(a.runAt) || a.n - b.n)
    .slice(0, limit)
    .map(({ target, rule, reason, at }) => ({ target, rule, reason, at }))
}
