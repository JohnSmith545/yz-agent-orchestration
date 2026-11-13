// Tests for the reminders setting in config.mjs (spec F5): no reminders by default, and
// the validation that drops a bad entry with a warning instead of failing startup.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { reminderList, DEFAULT_REMINDERS } = await import('../config.mjs')

const TIMERS = { at: '17:55', days: 'weekdays', text: 'Wrap up: commit or park your work.' }

test('left out, there are no reminders: a fresh config raises nothing', () => {
  assert.deepEqual(DEFAULT_REMINDERS, [])
  const warned = []
  assert.deepEqual(reminderList(undefined, m => warned.push(m)), [])
  assert.deepEqual(warned, [])
})

test('an empty list turns reminders off', () => {
  assert.deepEqual(reminderList([], () => {}), [])
})

test('good entries are kept, with only at, days and text', () => {
  const daily = { at: '07:00', days: 'daily', text: 'Stand-up.', extra: 1 }
  assert.deepEqual(reminderList([TIMERS, daily], () => {}), [TIMERS, { at: '07:00', days: 'daily', text: 'Stand-up.' }])
})

test('each bad entry is dropped with a warning naming it', () => {
  const warned = []
  const list = reminderList([
    { ...TIMERS, at: '5:55' },
    { ...TIMERS, at: '17-55' },
    { ...TIMERS, at: '25:99' },
    { ...TIMERS, at: '24:00' },
    { ...TIMERS, at: '17:60' },
    { ...TIMERS, days: 'weekends' },
    { ...TIMERS, text: '' },
    { ...TIMERS, text: '  ' },
    { ...TIMERS, text: 3 },
    null,
    'x',
    TIMERS,
  ], m => warned.push(m))
  assert.deepEqual(list, [TIMERS])
  assert.equal(warned.length, 11)
  assert.ok(warned.every(m => /reminders\[\d+\]/.test(m)))
})

test('a reminders value that is not a list warns and turns reminders off', () => {
  const warned = []
  assert.deepEqual(reminderList({ at: '17:55' }, m => warned.push(m)), [])
  assert.equal(warned.length, 1)
})

test('the edges of the clock are kept: 00:00 and 23:59', () => {
  const warned = []
  const list = reminderList([{ ...TIMERS, at: '00:00' }, { ...TIMERS, at: '23:59' }], m => warned.push(m))
  assert.deepEqual(list.map(r => r.at), ['00:00', '23:59'])
  assert.deepEqual(warned, [])
})

test('a second entry at the same time is dropped with a warning, its text not merged', () => {
  const warned = []
  const list = reminderList([TIMERS, { at: '17:55', days: 'daily', text: 'Something else.' }], m => warned.push(m))
  assert.deepEqual(list, [TIMERS])
  assert.equal(warned.length, 1)
  assert.match(warned[0], /reminders\[1\].*17:55/)
})

test('the time rule is one named constant, and the page keeps the same literal (it cannot import)', async () => {
  const { REMINDER_TIME } = await import('../config.mjs')
  assert.ok(REMINDER_TIME instanceof RegExp)
  for (const ok of ['00:00', '09:30', '23:59']) assert.ok(REMINDER_TIME.test(ok), ok)
  for (const bad of ['24:00', '17:60', '9:30', '25:99']) assert.ok(!REMINDER_TIME.test(bad), bad)
  const fs = await import('node:fs')
  const page = fs.readFileSync(new URL('../public/reminders.js', import.meta.url), 'utf8')
  assert.ok(page.includes(`const REMINDER_TIME = ${REMINDER_TIME}`), 'public/reminders.js duplicates the literal under the same name')
  assert.match(page, /REMINDER_TIME in config\.mjs/)
})

// ═══ ticketPrefixes ═══

const { ticketPrefixList } = await import('../config.mjs')

test('ticketPrefixes left out stays undefined: the prefixes come from the collections and sources', () => {
  const warned = []
  assert.equal(ticketPrefixList(undefined, m => warned.push(m)), undefined)
  assert.deepEqual(warned, [])
})

test('ticketPrefixes: kept in order and upper-cased; [] asks for the generic shape', () => {
  assert.deepEqual(ticketPrefixList(['abc', 'XYZ'], () => {}), ['ABC', 'XYZ'])
  assert.deepEqual(ticketPrefixList([], () => {}), [])
})

test('ticketPrefixes: a bad entry is dropped with a warning, a non-list is ignored with one', () => {
  const warned = []
  assert.deepEqual(ticketPrefixList(['ABC', 'AB-C', '', 7, '1X', 'OPS'], m => warned.push(m)), ['ABC', 'OPS'])
  assert.equal(warned.length, 4)
  assert.match(warned[0], /ticketPrefixes\[1\]/)
  const w2 = []
  assert.equal(ticketPrefixList('ABC', m => w2.push(m)), undefined)
  assert.match(w2[0], /should be a list/)
})

// ═══ pr: Send to the base branch (off by default, and only with a send PIN) ═══

const { prSettings, DEFAULT_PR, levelSettings, DEFAULT_LEVELS } = await import('../config.mjs')
const { hashPin } = await import('../send-pin.mjs')
const PIN_HASH = hashPin('123456', { N: 1024 })
const PROTECT = ['main', 'master', 'stage', 'prod', 'production', 'release/*', 'release-*']

test('pr left out is off, with origin, dev, gh and the protected list', () => {
  const warned = []
  assert.deepEqual(prSettings(undefined, m => warned.push(m)),
    { enabled: false, wanted: false, off: 'Sending is off: turn it on in Settings.', remote: 'origin', bases: ['dev'], gh: 'gh', protect: PROTECT, pinHash: '' })
  assert.deepEqual({ ...DEFAULT_PR, bases: [...DEFAULT_PR.bases], protect: [...DEFAULT_PR.protect] }, { enabled: false, remote: 'origin', bases: ['dev'], gh: 'gh', protect: PROTECT, pinHash: '' })
  assert.deepEqual(warned, [])
})

test('pr: enabled is honoured ONLY with a valid send PIN; without one it is off and says so', () => {
  const on = prSettings({ enabled: true, remote: 'upstream', bases: ['main', 'release/1.2'], gh: 'C:/tools/gh.exe', pinHash: PIN_HASH }, () => {})
  assert.deepEqual(on, { enabled: true, wanted: true, off: null, remote: 'upstream', bases: ['main', 'release/1.2'], gh: 'C:/tools/gh.exe', protect: PROTECT, pinHash: PIN_HASH })
  for (const pinHash of [undefined, '', 'plain', 'scrypt$1$8$1$x$y', 3]) {
    const s = prSettings({ enabled: true, pinHash }, () => {})
    assert.equal(s.enabled, false, String(pinHash))
    assert.equal(s.off, 'Sending is off: set a send PIN in Settings.')
  }
  assert.equal(prSettings({ enabled: 'yes', pinHash: PIN_HASH }, () => {}).enabled, false)
  assert.deepEqual(prSettings({ enabled: true, pinHash: PIN_HASH, protect: ['hotfix/*'] }, () => {}).protect, ['hotfix/*'])
})

test('pr: a bad remote (dots only too), base list, protect list or gh turns it off with a warning naming the key', () => {
  for (const [bad, key] of [[{ remote: '-x' }, 'remote'], [{ remote: 'a b' }, 'remote'], [{ remote: '..' }, 'remote'], [{ remote: '.' }, 'remote'],
    [{ bases: [] }, 'bases'], [{ bases: ['dev', 'a..b'] }, 'bases'], [{ bases: 'dev' }, 'bases'], [{ gh: '' }, 'gh'], [{ gh: 3 }, 'gh'],
    [{ protect: 'main' }, 'protect'], [{ protect: ['ma in'] }, 'protect']]) {
    const warned = []
    const s = prSettings({ enabled: true, pinHash: PIN_HASH, ...bad }, m => warned.push(m))
    assert.equal(s.enabled, false, JSON.stringify(bad))
    assert.equal(warned.length, 1)
    assert.match(warned[0], new RegExp(`pr\\.${key}`))
  }
  const warned = []
  assert.equal(prSettings('on', m => warned.push(m)).enabled, false)
  assert.match(warned[0], /"pr" should be an object/)
})

test('the example config and the README agree: Send off, into dev, no PIN', async () => {
  const fs = await import('node:fs')
  const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'))
  assert.deepEqual(example.pr, { enabled: false, remote: 'origin', bases: ['dev'], gh: 'gh' })
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /`\{ "enabled": false, "remote": "origin", "bases": \["dev"\], "gh": "gh" \}`/)
})

// ═══ levels: the branches the grid compares (server.mjs) ═══

test('levels left out are the old fixed names; a good setting is kept; a bad one warns and keeps the default for that key', () => {
  assert.deepEqual({ ...DEFAULT_LEVELS }, { work: 'followup', dev: 'origin/dev', stage: 'origin/stage', prod: 'origin/main' })
  assert.deepEqual(levelSettings(undefined, () => {}), { work: 'followup', dev: 'origin/dev', stage: 'origin/stage', prod: 'origin/main' })
  assert.deepEqual(levelSettings({ work: 'integration', dev: 'upstream/dev' }, () => {}), { work: 'integration', dev: 'upstream/dev', stage: 'origin/stage', prod: 'origin/main' })
  const warned = []
  assert.deepEqual(levelSettings({ work: '-x', stage: 'a..b' }, m => warned.push(m)), { ...DEFAULT_LEVELS })
  assert.equal(warned.length, 2)
  assert.match(warned[0], /levels\.work/)
})

test('server.mjs names no level branch itself: they all come from config levels', async () => {
  const fs = await import('node:fs')
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const code = server.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  assert.doesNotMatch(code, /'followup'|'origin\/dev'|'origin\/stage'|'origin\/main'|\w\.\.followup|origin\/dev\.\.\w|origin\/stage\.\.\w/)
  assert.match(server, /CONFIG\.levels/)
})

test('A5: orchestration and the Timeline read their branches from config levels too, and the README no longer calls them fixed', async () => {
  const fs = await import('node:fs')
  const code = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  for (const f of ['orchestration.mjs', 'flow-git.mjs']) {
    assert.doesNotMatch(code(f), /'origin\/main'|'origin\/stage'|'origin\/dev'|ref: 'followup'/, f)
    assert.match(code(f), /CONFIG\.levels/, f)
  }
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.doesNotMatch(readme, /The integration branch is `followup`, and the remote levels are/)
})
