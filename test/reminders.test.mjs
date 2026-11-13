// Tests for the end-of-day reminder (public/reminders.js, spec F5). The pure rule
// Reminders.due(list, now, seen) runs in a vm with a bare window and FIXED local
// clocks (new Date(y, m, d, h, min) is local time, so the tests hold in any zone).
// start() runs in a vm with a stub document, Notifier, localStorage and clock.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'public', 'reminders.js'), 'utf8')
const bare = {}
vm.runInNewContext(SRC, { window: bare })
const { due } = bare.Reminders
/** Objects made inside the vm have its prototypes, so strict deepEqual needs plain copies. */
const plain = v => JSON.parse(JSON.stringify(v))

const TIMERS = { at: '17:55', days: 'weekdays', text: 'Wrap up: commit or park your work.' }
const DAILY = { at: '17:55', days: 'daily', text: 'Daily check.' }
// 2026-11-11 is a Wednesday, 2026-11-14 a Saturday (months count from 0)
const wed = (h, m) => new Date(2026, 10, 11, h, m)
const thu = (h, m) => new Date(2026, 10, 12, h, m)
const sat = (h, m) => new Date(2026, 10, 14, h, m)
const keys = r => plain(r).map(e => e.key)

test('fires at 17:55 on a Wednesday once, keyed by the local date and time', () => {
  const r = plain(due([TIMERS], wed(17, 55), []))
  assert.deepEqual(r, [{ ...TIMERS, key: 'reminder.2026-11-11.17:55' }])
})

test('does not fire twice the same day (seen as an array or a Set)', () => {
  assert.deepEqual(keys(due([TIMERS], wed(17, 56), ['reminder.2026-11-11.17:55'])), [])
  assert.deepEqual(keys(due([TIMERS], wed(23, 59), new Set(['reminder.2026-11-11.17:55']))), [])
})

test('17:54 does not fire', () => {
  assert.deepEqual(keys(due([TIMERS], wed(17, 54), [])), [])
})

test('does not fire on Saturday for weekdays', () => {
  assert.deepEqual(keys(due([TIMERS], sat(17, 55), [])), [])
  assert.deepEqual(keys(due([TIMERS], new Date(2026, 10, 15, 18, 0), [])), []) // Sunday
})

test('fires on Saturday for daily', () => {
  assert.deepEqual(keys(due([DAILY], sat(17, 55), [])), ['reminder.2026-11-14.17:55'])
})

test('a page open across midnight fires again the next day, not at 00:00', () => {
  const seen = new Set(keys(due([TIMERS], wed(17, 55), [])))
  assert.deepEqual([...seen], ['reminder.2026-11-11.17:55'])
  assert.deepEqual(keys(due([TIMERS], thu(0, 0), seen)), [])
  assert.deepEqual(keys(due([TIMERS], thu(17, 54), seen)), [])
  assert.deepEqual(keys(due([TIMERS], thu(17, 55), seen)), ['reminder.2026-11-12.17:55'])
})

test('a malformed entry is ignored, the good ones still fire', () => {
  const bad = [
    null, 'x', {}, { ...TIMERS, at: '5:55' }, { ...TIMERS, at: '17:55pm' }, { ...TIMERS, at: '25:99' }, { ...TIMERS, at: '17:60' },
    { ...TIMERS, days: 'weekends' },
    { ...TIMERS, text: '' }, { ...TIMERS, text: '   ' }, { ...TIMERS, text: 7 },
  ]
  assert.deepEqual(keys(due([...bad, TIMERS], wed(18, 0), [])), ['reminder.2026-11-11.17:55'])
  assert.deepEqual(keys(due('not a list', wed(18, 0), [])), [])
  assert.deepEqual(keys(due(undefined, wed(18, 0), undefined)), [])
})

test('two entries the same day fire on their own times', () => {
  const lunch = { at: '12:30', days: 'daily', text: 'Lunch.' }
  assert.deepEqual(keys(due([lunch, TIMERS], wed(13, 0), [])), ['reminder.2026-11-11.12:30'])
  assert.deepEqual(keys(due([lunch, TIMERS], wed(18, 0), ['reminder.2026-11-11.12:30'])), ['reminder.2026-11-11.17:55'])
})

test('two entries at the same time never yield two entries with one key: the config keeps the first, and so does due', async () => {
  const { reminderList } = await import('../config.mjs')
  const twin = { at: '17:55', days: 'daily', text: 'Twin.' }
  const validated = reminderList([TIMERS, twin], () => {})
  assert.deepEqual(plain(due(validated, wed(18, 0), [])).map(e => e.text), [TIMERS.text])
  // a list that skipped the config (built by hand) still gives one entry per key
  const raw = plain(due([TIMERS, twin], wed(18, 0), []))
  assert.deepEqual(raw.map(e => e.key), ['reminder.2026-11-11.17:55'])
  assert.equal(raw[0].text, TIMERS.text)
})

// ═══ start(): the page ═══

/**
 * reminders.js loaded with a document, a Notifier that records toasts and desktop alerts,
 * a localStorage (`storage`: a Map, or 'throw'), a clock `now()` and captured setInterval.
 */
function page({ storage = new Map(), clock }) {
  const toasts = []
  const desktops = []
  const intervals = []
  const listeners = {}
  const localStorage = storage === 'throw'
    ? { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
    : { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) }
  const document = { addEventListener: (t, fn) => ((listeners[t] ||= []).push(fn)) }
  class FixedDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.now) }
  }
  const window = {
    document,
    localStorage,
    Notifier: { toast: (html, opts) => toasts.push({ html, opts }), desktop: (title, body) => desktops.push({ title, body }) },
  }
  vm.runInNewContext(SRC, { window, document, localStorage, Date: FixedDate, setInterval: (fn, ms) => intervals.push({ fn, ms }) })
  const pulse = detail => (listeners.pulse || []).forEach(fn => fn({ detail }))
  const tick = () => intervals.forEach(i => i.fn())
  return { toasts, desktops, intervals, pulse, tick, start: () => window.Reminders.start() }
}

test('start polls once a minute and fires once from the pulse list: a sticky reminder toast and a desktop alert', () => {
  const clock = { now: wed(17, 50).getTime() }
  const storage = new Map()
  const p = page({ storage, clock })
  assert.deepEqual(p.intervals.map(i => i.ms), [60_000])
  p.pulse({ reminders: [TIMERS] })
  p.tick()
  assert.equal(p.toasts.length, 0)
  clock.now = wed(17, 55).getTime()
  p.tick()
  p.tick()
  p.pulse({ reminders: [TIMERS] })
  assert.equal(p.toasts.length, 1)
  assert.match(p.toasts[0].html, /Wrap up: commit or park your work\./)
  assert.deepEqual(plain(p.toasts[0].opts), { kind: 'reminder', sticky: true })
  assert.deepEqual(plain(p.desktops), [{ title: 'Reminder', body: 'Wrap up: commit or park your work.' }])
  assert.ok(storage.has('reminder.2026-11-11.17:55'))
})

test('a reload after it fired does not fire again (the key is in localStorage)', () => {
  const clock = { now: wed(18, 10).getTime() }
  const storage = new Map([['reminder.2026-11-11.17:55', '1']])
  const p = page({ storage, clock })
  p.pulse({ reminders: [TIMERS] })
  p.tick()
  assert.equal(p.toasts.length, 0)
})

test('a throwing localStorage still fires once per page life', () => {
  const clock = { now: wed(17, 55).getTime() }
  const p = page({ storage: 'throw', clock })
  p.pulse({ reminders: [TIMERS] })
  p.tick()
  p.tick()
  assert.equal(p.toasts.length, 1)
})

test('a second start() is a no-op: one listener, one interval, one toast', () => {
  const clock = { now: wed(17, 55).getTime() }
  const p = page({ clock })
  p.start()
  assert.equal(p.intervals.length, 1)
  p.pulse({ reminders: [TIMERS] })
  assert.equal(p.toasts.length, 1)
})

test('the text is escaped in the toast', () => {
  const clock = { now: wed(17, 55).getTime() }
  const p = page({ clock })
  p.pulse({ reminders: [{ ...TIMERS, text: '<img src=x onerror=alert(1)>' }] })
  assert.doesNotMatch(p.toasts[0].html, /<img/)
  assert.match(p.toasts[0].html, /&lt;img/)
})

test('a pulse without reminders keeps the list it had', () => {
  const clock = { now: wed(17, 50).getTime() }
  const p = page({ clock })
  p.pulse({ reminders: [TIMERS] })
  p.pulse({})
  clock.now = wed(17, 55).getTime()
  p.tick()
  assert.equal(p.toasts.length, 1)
})
