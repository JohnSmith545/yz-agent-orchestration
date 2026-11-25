// The time a stand-up covers (the Standup creator on #/generators, standup-routes.mjs). Pure: the clock is
// passed in, so the tests can stand on any day.
//
//   Daily       from 00:00 of the last working day (the day before today, Saturday and Sunday skipped, so on a
//               Monday it starts on Friday) until now. Its heading names that day: Stand up, Tue 24 Nov.
//   This week   from 00:00 six days ago until now (seven calendar days, today included), with the dates it was
//               done in (Nov 19–25) and the next seven days, from tomorrow, that it commits to (Nov 26–Dec 2).
//
// Rules this file keeps:
// - ⚠️ LOCAL time of the server machine, never UTC: a stand-up belongs to the day the user lives in, and "today"
//   (which stand-up the page shows after a reload) is the same local day spend.mjs counts in.
// - Days are built with new Date(y, m, d), so a clock change (BST) never shifts midnight by an hour.
// - `from` and `to` go out as ISO strings: the route hands them to git (--since, --until) and to the page.

export const MODES = Object.freeze(['daily', 'week'])

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = n => String(n).padStart(2, '0')

/** 00:00 of `d`'s local day, `days` days later (negative for earlier). */
const startOf = (d, days = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)

/** The local calendar day as YYYY-MM-DD: the key "today" is compared by. */
export const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** The short name of a day, as the page and the heading say it: Tue 24 Nov. */
export const dayLabel = d => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`

/** 00:00 of the day before `now`, stepping back over Saturday and Sunday. */
export function lastWorkingDay(now) {
  let d = startOf(now, -1)
  while (d.getDay() === 0 || d.getDay() === 6) d = startOf(d, -1)
  return d
}

/** Two days as the weekly template writes them: Nov 18–24 in one month, Nov 28–Dec 4 across two. */
export function rangeLabel(a, b) {
  const first = `${MONTHS[a.getMonth()]} ${a.getDate()}`
  return a.getMonth() === b.getMonth() ? `${first}–${b.getDate()}` : `${first}–${MONTHS[b.getMonth()]} ${b.getDate()}`
}

/**
 * What a stand-up of `mode` covers at `now`:
 *   { mode, from, to, today, label, heading, dates?, next? }
 * `label` is the page's one line (Covers Tue 24 Nov to now); `heading` the stand-up's first line for daily, the
 * done line for the week; `dates` and `next` (week only) fill the weekly template. Throws for any other mode.
 */
export function standupWindow(mode, now = new Date()) {
  if (!MODES.includes(mode)) throw new Error('A stand-up is daily or week.')
  const base = { mode, to: now.toISOString(), today: localDay(now) }
  if (mode === 'daily') {
    const from = lastWorkingDay(now)
    return { ...base, from: from.toISOString(), label: `Covers ${dayLabel(from)} to now`, heading: `Stand up, ${dayLabel(from)}` }
  }
  const from = startOf(now, -6)
  return {
    ...base, from: from.toISOString(), label: `Covers ${dayLabel(from)} to ${dayLabel(now)}`, heading: 'This week — done:',
    dates: rangeLabel(from, now), next: rangeLabel(startOf(now, 1), startOf(now, 7)),
  }
}
