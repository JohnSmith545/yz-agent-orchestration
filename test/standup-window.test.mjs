// Tests for standup-window.mjs: the time a stand-up covers, worked out from an injected clock in the server's local
// time. Daily starts at 00:00 of the last working day (Saturday and Sunday skipped, so a Monday starts on Friday)
// and runs until now; This week starts at 00:00 six days ago. Checked across a Monday, a Sunday, a month end and a
// year end.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dayLabel, lastWorkingDay, localDay, rangeLabel, standupWindow } from '../standup-window.mjs'

/** A local time: 2026-11-25 is a Wednesday. Months are 1-based here, unlike Date. */
const at = (y, mo, d, h = 10, mi = 12) => new Date(y, mo - 1, d, h, mi)
const midnight = (y, mo, d) => new Date(y, mo - 1, d).toISOString()

test('localDay is the local calendar day as YYYY-MM-DD, and dayLabel the short name the page uses', () => {
  assert.equal(localDay(at(2026, 11, 25, 0, 30)), '2026-11-25', 'just after midnight is the new day')
  assert.equal(localDay(at(2026, 1, 5)), '2026-01-05', 'padded')
  assert.equal(dayLabel(at(2026, 11, 24)), 'Tue 24 Nov')
  assert.equal(dayLabel(at(2026, 1, 1)), 'Thu 1 Jan')
})

test('lastWorkingDay: the day before, skipping Saturday and Sunday', () => {
  assert.equal(localDay(lastWorkingDay(at(2026, 11, 25))), '2026-11-24', 'Wednesday -> Tuesday')
  assert.equal(localDay(lastWorkingDay(at(2026, 11, 23))), '2026-11-20', 'Monday -> Friday')
  assert.equal(localDay(lastWorkingDay(at(2026, 11, 22))), '2026-11-20', 'Sunday -> Friday')
  assert.equal(localDay(lastWorkingDay(at(2026, 11, 21))), '2026-11-20', 'Saturday -> Friday')
  assert.equal(lastWorkingDay(at(2026, 11, 25)).getHours(), 0, 'at 00:00')
})

test('daily on a Wednesday: Tuesday 00:00 until now, named after Tuesday', () => {
  const now = at(2026, 11, 25)
  const w = standupWindow('daily', now)
  assert.equal(w.mode, 'daily')
  assert.equal(w.from, midnight(2026, 11, 24))
  assert.equal(w.to, now.toISOString())
  assert.equal(w.today, '2026-11-25')
  assert.equal(w.heading, 'Stand up, Tue 24 Nov')
  assert.equal(w.label, 'Covers Tue 24 Nov to now')
})

test('daily on a Monday starts on Friday; on a Sunday too', () => {
  const mon = standupWindow('daily', at(2026, 11, 23, 9))
  assert.equal(mon.from, midnight(2026, 11, 20))
  assert.equal(mon.heading, 'Stand up, Fri 20 Nov')
  assert.equal(mon.label, 'Covers Fri 20 Nov to now')
  assert.equal(standupWindow('daily', at(2026, 11, 22)).from, midnight(2026, 11, 20))
})

test('daily across a month end and a year end', () => {
  assert.equal(standupWindow('daily', at(2026, 12, 1)).from, midnight(2026, 11, 30), 'Tuesday 1 Dec -> Monday 30 Nov')
  const jan = standupWindow('daily', at(2027, 1, 1)) // a Friday
  assert.equal(jan.from, midnight(2026, 12, 31))
  assert.equal(jan.heading, 'Stand up, Thu 31 Dec')
  assert.equal(standupWindow('daily', at(2027, 1, 4)).from, midnight(2027, 1, 1), 'Monday 4 Jan -> Friday 1 Jan')
})

test('week: 00:00 six days ago until now, with the done dates and the next seven days', () => {
  const now = at(2026, 11, 25)
  const w = standupWindow('week', now)
  assert.equal(w.mode, 'week')
  assert.equal(w.from, midnight(2026, 11, 19))
  assert.equal(w.to, now.toISOString())
  assert.equal(w.label, 'Covers Thu 19 Nov to Wed 25 Nov')
  assert.equal(w.dates, 'Nov 19–25')
  assert.equal(w.next, 'Nov 26–Dec 2', 'the next seven days start tomorrow, across the month end')
  assert.equal(w.heading, 'This week — done:')
})

test('week across a month end and a year end', () => {
  const dec = standupWindow('week', at(2026, 12, 2))
  assert.equal(dec.from, midnight(2026, 11, 26))
  assert.equal(dec.dates, 'Nov 26–Dec 2')
  const jan = standupWindow('week', at(2027, 1, 3)) // a Sunday
  assert.equal(jan.from, midnight(2026, 12, 28))
  assert.equal(jan.dates, 'Dec 28–Jan 3')
  assert.equal(jan.next, 'Jan 4–10')
})

test('rangeLabel: one month says it once; two months say both', () => {
  assert.equal(rangeLabel(at(2026, 11, 18), at(2026, 11, 24)), 'Nov 18–24')
  assert.equal(rangeLabel(at(2026, 11, 28), at(2026, 12, 4)), 'Nov 28–Dec 4')
})

test('a mode that is not daily or week throws: the route checks it first', () => {
  assert.throws(() => standupWindow('month', at(2026, 11, 25)), /daily or week/)
})
