// Pipeline time: how long the orchestration's work takes and how much of it finishes per day and per hour, for the
// block under the Pipeline score on the Agents page (public/time-view.js, public/time-strip.js, GET /api/time).
// Built like the scorecard (score.mjs) and its Log (score-log.mjs): ONLY from times the flow files really store.
//
//   timeStats(flows, graph, { now, days, stallDays })   the whole block's numbers, below
//   periodOf(now, days, firstStart)                     the period: { from (ms or null), dayCount, bucket }
//
// THE RULES
// - FINISHED is the scorecard's delivered cell, taken from score.mjs cellOf itself, so the two blocks can never
//   disagree on what finished: pushed after QA (and Security, and Senior, where they apply), or done with no code
//   changes. Its FINISH time is the time the scorecard counts the delivery at; its START is createdAt. Slipped
//   through, dropped, stopped and stalled flows are not finished: left out of every time and counted in `left`.
//   Archived flows count; deleted ones have no file and never reach here (the route reads every flow file).
// - A TICKET is a tracker id on a finished flow (flow.tickets): a flow with two counts two; a flow with none is ONE
//   other job. A ticket finished by two flows in the period counts once, at its LAST finish (its day, its agent).
// - THE PERIOD is whole days in the server's LOCAL time: 7 days is today and the 6 days before it, from local
//   midnight; 30 days the same; All starts at local midnight of the day the first thing happened (the earliest
//   event of the Log). ⚠️ So it can start up to a day later than the score's window (the last 7 times 24 hours).
//   A flow belongs to the day it FINISHED. The bars are per day, per week (from Monday) for All.
// - PER DAY divides by the days in the period (dayCount, today included as a day begun). PER HOUR divides by the
//   ACTIVE hours: the clock hours in the period in which at least one flow file recorded an event (the Log's
//   events: started, planned, handed, a verdict, pushed, done, dropped), so nights and weekends with no work do not
//   dilute the rate. A stall is no event (it is the absence of one). The plain clock rate is given beside it.
// - Headline numbers are MEDIANS (one three-day wait must not hide ten 20-minute tickets), the mean beside them.
//   With fewer than 3 finished flows `fewer` is true (the page says too few to trust); with none, every number is
//   null, never a zero that reads as a result.
// - Where the time went and the wait on the user, per flow: time-stages.mjs. Each stage's median is over the flows
//   that went through it and can date it; `undated` counts those that went through it and cannot.
// - Times sent back, per agent, are the scorecard's own sentBack (scoreOf) over this period.
//
// ⚠️ PURE like score.mjs: no file, no git, no config; the clock is passed in.

import { DAY, cellOf, scoreOf } from './score.mjs'
import { orchestrationLog } from './score-log.mjs'
import { STAGES, stagesOf, waitingOf } from './time-stages.mjs'

const HOUR = 3_600_000
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const timeOf = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}
const iso = t => (t === null ? null : new Date(t).toISOString())

// ═══ local days ═══

/** Local midnight of the day `t` falls on, `plus` days later (the Date constructor keeps it right across a clock change). */
const dayStart = (t, plus = 0) => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus).getTime()
}
/** Local midnight of the Monday of `t`'s week. */
const weekStart = t => dayStart(t, -((new Date(t).getDay() + 6) % 7))
const pad = n => String(n).padStart(2, '0')
/** 'YYYY-MM-DD' of the local day `t` falls on. */
const dayKey = t => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const hourKey = t => `${dayKey(t)}T${pad(new Date(t).getHours())}`

/** The period: 7 or 30 whole local days to today, or All from the day of `firstStart` (null: nothing ever happened). */
export function periodOf(now, days, firstStart) {
  if (Number.isFinite(days) && days > 0) return { from: dayStart(now, -(days - 1)), dayCount: days, bucket: 'day' }
  if (firstStart === null || !Number.isFinite(firstStart)) return { from: null, dayCount: 0, bucket: 'week' }
  const from = dayStart(Math.min(firstStart, now))
  return { from, dayCount: Math.round((dayStart(now) - from) / DAY) + 1, bucket: 'week' }
}

// ═══ small sums ═══

const median = list => {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const mean = list => (list.length ? list.reduce((t, v) => t + v, 0) / list.length : null)

/** The whole block's numbers over the period `days` names (7, 30, or null for All) up to `now`. */
export function timeStats(flows, graph, { now = Date.now(), days = 30, stallDays = 7 } = {}) {
  const list = (Array.isArray(flows) ? flows : []).filter(f => isObject(f) && isText(f.id))
  const stallMs = stallDays * DAY
  // every event the flow files date (the Log's), a stall left out: it is the absence of work, not work
  const events = orchestrationLog(list, graph, { now, days: null, stallDays })
    .filter(e => e.kind !== 'stalled')
    .map(e => Date.parse(e.at))
  const period = periodOf(now, days, events.length ? Math.min(...events) : null)
  const inPeriod = t => t !== null && period.from !== null && t >= period.from

  // the finished flows, and the rest counted by why they are not
  const done = []
  const left = { slipped: 0, dropped: 0, stopped: 0, stalled: 0 }
  for (const flow of list) {
    const { cell, why, time } = cellOf(flow, graph, now, stallMs)
    if (!inPeriod(time)) continue
    if (cell === 'delivered') done.push({ flow, start: timeOf(flow.createdAt), finish: time, agent: isText(flow.agent) ? flow.agent : 'Unknown' })
    else if (cell === 'slipped') left.slipped++
    else if (cell === 'missed' && why in left) left[why]++
  }
  done.sort((a, b) => a.finish - b.finish)

  // tickets at their LAST finish in the period; a flow with none is one other job
  const tickets = new Map()
  const jobs = []
  for (const d of done) {
    const ids = Array.isArray(d.flow.tickets) ? d.flow.tickets.filter(isText) : []
    if (!ids.length) jobs.push(d)
    for (const id of ids) tickets.set(id, d)
  }
  const pieces = [...tickets.values(), ...jobs]
  const total = pieces.length

  // the rates
  const hours = new Set(events.filter(t => inPeriod(t) && t <= now).map(hourKey))
  const clockHours = period.from === null ? 0 : Math.max(0, (now - period.from) / HOUR)
  const rates = total === 0
    ? { perDay: null, perHour: null, perClockHour: null }
    : { perDay: period.dayCount ? total / period.dayCount : null, perHour: hours.size ? total / hours.size : null, perClockHour: clockHours ? total / clockHours : null }

  // how long each finished flow took, waited, and where its time went
  const took = []
  const waits = []
  let waitUndated = 0
  let waitSum = 0
  let waitOf = 0
  const stage = new Map(STAGES.map(s => [s.key, { times: [], undated: 0 }]))
  for (const d of done) {
    const ms = d.start !== null && d.finish >= d.start ? d.finish - d.start : null
    d.took = ms
    if (ms !== null) took.push(ms)
    const w = waitingOf(d.flow, { start: d.start, finish: d.finish })
    if (w === null) waitUndated++
    else {
      waits.push(w.ms)
      if (ms !== null) {
        waitSum += w.ms
        waitOf += ms
      }
    }
    const s = stagesOf(d.flow, graph, { start: d.start, finish: d.finish })
    for (const [key, v] of Object.entries(s.times)) stage.get(key).times.push(v)
    for (const key of s.undated) stage.get(key).undated++
  }

  return {
    window: {
      days: period.from !== null && Number.isFinite(days) && days > 0 ? days : null,
      from: iso(period.from),
      to: iso(now),
      dayCount: period.dayCount,
      bucket: period.bucket,
      activeHours: hours.size,
      clockHours,
    },
    finished: { tickets: tickets.size, jobs: jobs.length, flows: done.length },
    rates,
    took: took.length ? { median: median(took), mean: mean(took), fastest: Math.min(...took), slowest: Math.max(...took), flows: took.length } : null,
    waiting: waits.length ? { median: median(waits), mean: mean(waits), share: waitOf > 0 ? waitSum / waitOf : null, flows: waits.length, undated: waitUndated } : null,
    stages: STAGES.map(({ key, label }) => {
      const s = stage.get(key)
      return { key, label, median: median(s.times), mean: mean(s.times), flows: s.times.length, undated: s.undated }
    }).filter(s => s.flows > 0 || s.undated > 0),
    bars: barsOf(period, now, pieces),
    agents: agentsOf(list, graph, { now, days, stallDays, period, done, tickets, jobs }),
    left,
    fewer: done.length < 3,
  }
}

/** The bars: one per local day of the period (per week from Monday for All), each the tickets and jobs finished in it. */
function barsOf(period, now, pieces) {
  if (period.from === null) return []
  const week = period.bucket === 'week'
  const keyOf = t => dayKey(week ? weekStart(t) : dayStart(t))
  const first = week ? weekStart(period.from) : period.from
  const bars = []
  // 2000 bars is a guard against a clock gone wrong: no real period holds that many
  for (let i = 0, t = first; t <= now && i < 2000; i++, t = dayStart(first, week ? 7 * i : i)) bars.push({ day: dayKey(t), count: 0 })
  const at = new Map(bars.map(b => [b.day, b]))
  for (const p of pieces) {
    const bar = at.get(keyOf(p.finish))
    if (bar) bar.count++
  }
  return bars
}

/**
 * The per agent table: for each agent that finished work or had work sent back in the period, its tickets (at their
 * last finish), other jobs, finished flows, median time per flow, per day, and times sent back. The busiest first.
 */
function agentsOf(list, graph, { now, days, stallDays, period, done, tickets, jobs }) {
  const rows = new Map()
  const row = label => {
    if (!rows.has(label)) rows.set(label, { label, tickets: 0, jobs: 0, flows: 0, took: [], sentBack: 0 })
    return rows.get(label)
  }
  for (const d of done) {
    const r = row(d.agent)
    r.flows++
    if (d.took !== null) r.took.push(d.took)
  }
  for (const d of tickets.values()) row(d.agent).tickets++
  for (const d of jobs) row(d.agent).jobs++
  // the scorecard's own sentBack, over this period: its window is `days` days back from now, so pass the period's
  // length in days (a failure at the very millisecond of local midnight could fall either side of the rounding)
  if (period.from !== null) {
    const span = Number.isFinite(days) && days > 0 ? (now - period.from) / DAY : null
    for (const a of scoreOf(list, graph, { now, days: span, stallDays }).agents) if (a.sentBack > 0) row(a.label).sentBack += a.sentBack
  }
  return [...rows.values()]
    .map(({ took, ...r }) => ({ ...r, median: median(took), perDay: period.dayCount ? (r.tickets + r.jobs) / period.dayCount : null }))
    .sort((a, b) => b.tickets + b.jobs - (a.tickets + a.jobs) || a.label.localeCompare(b.label))
    .map(({ label, tickets: t, jobs: j, flows, median: m, perDay, sentBack }) => ({ label, tickets: t, jobs: j, flows, median: m, perDay, sentBack }))
}
