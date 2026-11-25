// Tests for the lessons library (quality-lessons.mjs, quality-areas.mjs) and the quality settings
// (quality-config.mjs): a lesson's shape and limits; a candidate waits for the user (Accept, Edit, Reject) and only an
// accepted one is active; a `same as` candidate raises the count of the lesson it names instead of adding a duplicate;
// Retire and Restore; listLessons (the contract feat/smart-learn reads); lessonsFor picks by the task's areas, most hit
// first, then general, at most 7, each with why. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-lessons-test-'))
const L = await import('../quality-lessons.mjs')
const { DEFAULT_AREAS, taskAreas } = await import('../quality-areas.mjs')
const { qualitySettings, DEFAULT_QUALITY } = await import('../quality-config.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

let n = 0
const opts = { areas: DEFAULT_AREAS, now: () => '2026-11-25T10:00:00.000Z', newId: () => `t${++n}` }
const fresh = () => L.emptyStore('2026-11-25T09:00:00.000Z')

test('the lessons file follows FACTORY_DATA_DIR, and a missing or broken file reads empty', () => {
  assert.equal(L.LESSONS_FILE, path.join(process.env.FACTORY_DATA_DIR, 'lessons.json'))
  const file = path.join(process.env.FACTORY_DATA_DIR, 'nope.json')
  assert.deepEqual(L.readLessons(file).lessons, [])
  fs.writeFileSync(file, '{ torn')
  const s = L.readLessons(file)
  assert.deepEqual([s.lessons, s.candidates], [[], []])
})

test('a lesson: one plain sentence of at most 160 characters, in a known area', () => {
  assert.equal(L.checkLesson({ text: 'Write the failing test before the code.', area: 'tests' }, DEFAULT_AREAS).error, undefined)
  assert.match(L.checkLesson({ text: '', area: 'tests' }, DEFAULT_AREAS).error, /Write the lesson/)
  assert.match(L.checkLesson({ text: 'x'.repeat(161), area: 'tests' }, DEFAULT_AREAS).error, /160 characters/)
  assert.match(L.checkLesson({ text: 'Stop the server.\nThen check the port.', area: 'infra' }, DEFAULT_AREAS).error, /one sentence/)
  assert.match(L.checkLesson({ text: 'Stop the server. Then check the port.', area: 'infra' }, DEFAULT_AREAS).error, /one sentence/)
  assert.match(L.checkLesson({ text: 'Stop the server.', area: 'cooking' }, DEFAULT_AREAS).error, /area/)
  assert.match(L.checkLesson({ text: 42, area: 'tests' }, DEFAULT_AREAS).error, /text/)
  const ok = L.checkLesson({ text: '  Stop   the server you started  ', area: 'infra' }, DEFAULT_AREAS)
  assert.deepEqual(ok, { text: 'Stop the server you started', area: 'infra' }, 'spaces folded, no full stop added')
})

test('a lesson the user types is active at once, with count 1 and no sources', () => {
  const s = fresh()
  const r = L.addLesson(s, { text: 'Stop the preview server you started.', area: 'infra', by: 'you' }, opts)
  assert.equal(r.error, undefined)
  assert.deepEqual(r.lesson, { id: r.lesson.id, text: 'Stop the preview server you started.', area: 'infra', sources: [], count: 1, status: 'active', by: 'you', at: '2026-11-25T10:00:00.000Z' })
  assert.match(L.addLesson(s, { text: 'Stop the preview server you started.', area: 'ui', by: 'you' }, opts).error, /already/, 'the same text twice is refused')
})

const source = { flow: 'login-page', at: '2026-11-25T08:00:00.000Z', gate: 'qa' }

test('candidates wait for the user: only an accepted one is active, a rejected one is gone', () => {
  const s = fresh()
  const made = L.addCandidates(s, { key: 'login-page:qa:1', ...source }, [{ kind: 'new', text: 'Write the failing test first.', area: 'tests' }, { kind: 'new', text: 'Look at the page in the dark theme.', area: 'ui' }], opts)
  assert.equal(made.length, 2)
  assert.equal(s.lessons.length, 0, 'nothing is a lesson before the user accepts it')
  assert.equal(L.listLessons({}, null, s).length, 0)
  const [a, b] = made
  const acc = L.acceptCandidate(s, a.id, {}, opts)
  assert.equal(acc.lesson.status, 'active')
  assert.equal(acc.lesson.by, 'model')
  assert.deepEqual(acc.lesson.sources, [{ flow: 'login-page', at: source.at, gate: 'qa' }])
  assert.equal(s.candidates.length, 1)
  assert.equal(L.rejectCandidate(s, b.id).ok, true)
  assert.equal(s.candidates.length, 0)
  assert.equal(s.lessons.length, 1)
  assert.match(L.rejectCandidate(s, 'nope').error, /No candidate/)
})

test('Edit: the user rewrites a candidate as they accept it, under the same limits', () => {
  const s = fresh()
  const [c] = L.addCandidates(s, { key: 'k', ...source }, [{ kind: 'new', text: 'Test it.', area: 'tests' }], opts)
  assert.match(L.acceptCandidate(s, c.id, { text: 'x'.repeat(200) }, opts).error, /160/)
  assert.equal(s.candidates.length, 1, 'a refused edit leaves the candidate waiting')
  const r = L.acceptCandidate(s, c.id, { text: 'Run the whole test suite on the last commit.', area: 'process' }, opts)
  assert.equal(r.lesson.text, 'Run the whole test suite on the last commit.')
  assert.equal(r.lesson.area, 'process')
})

test('a same-as candidate raises the named lesson count and adds its source, never a duplicate', () => {
  const s = fresh()
  const { lesson } = L.addLesson(s, { text: 'Stop the preview server you started.', area: 'infra', by: 'you' }, opts)
  const [c] = L.addCandidates(s, { key: 'k2', ...source }, [{ kind: 'same', id: lesson.id }], opts)
  assert.equal(c.kind, 'same')
  assert.equal(c.text, lesson.text, 'the page shows the lesson it repeats')
  assert.equal(s.lessons[0].count, 1, 'not before the user accepts it')
  const r = L.acceptCandidate(s, c.id, {}, opts)
  assert.equal(r.lesson.id, lesson.id)
  assert.equal(s.lessons.length, 1)
  assert.equal(s.lessons[0].count, 2)
  assert.deepEqual(s.lessons[0].sources, [{ flow: 'login-page', at: source.at, gate: 'qa' }])
  // a same-as naming a lesson that is not there is dropped
  assert.deepEqual(L.addCandidates(s, { key: 'k3', ...source }, [{ kind: 'same', id: 'L999' }], opts), [])
})

test('a candidate whose text matches a lesson exactly becomes a same-as', () => {
  const s = fresh()
  const { lesson } = L.addLesson(s, { text: 'Stop the preview server you started.', area: 'infra', by: 'you' }, opts)
  const [c] = L.addCandidates(s, { key: 'k', ...source }, [{ kind: 'new', text: 'stop the preview server you started', area: 'infra' }], opts)
  assert.equal(c.kind, 'same')
  assert.equal(c.lesson, lesson.id)
})

test('Retire takes a lesson out of the briefs; Restore brings it back', () => {
  const s = fresh()
  const { lesson } = L.addLesson(s, { text: 'Write the failing test first.', area: 'tests', by: 'you' }, opts)
  assert.equal(L.setStatus(s, lesson.id, 'retired').ok, true)
  assert.equal(L.lessonsFor({ title: 'Add a test' }, { store: s, areas: DEFAULT_AREAS }).length, 0)
  assert.equal(L.setStatus(s, lesson.id, 'active').ok, true)
  assert.equal(L.lessonsFor({ title: 'Add a test' }, { store: s, areas: DEFAULT_AREAS }).length, 1)
  assert.match(L.setStatus(s, 'nope', 'retired').error, /No lesson/)
  assert.match(L.setStatus(s, lesson.id, 'gone').error, /active or retired/)
})

test('listLessons({ since, area }): the contract feat/smart-learn reads, newest source or creation counts for since', () => {
  const s = fresh()
  L.addLesson(s, { text: 'Write the failing test first.', area: 'tests', by: 'you' }, { areas: DEFAULT_AREAS, now: () => '2026-11-01T00:00:00.000Z' })
  L.addLesson(s, { text: 'Look at the page in the dark theme.', area: 'ui', by: 'you' }, { areas: DEFAULT_AREAS, now: () => '2026-11-20T00:00:00.000Z' })
  assert.equal(L.listLessons({}, null, s).length, 2)
  assert.deepEqual(L.listLessons({ area: 'ui' }, null, s).map(l => l.area), ['ui'])
  assert.deepEqual(L.listLessons({ since: '2026-11-10T00:00:00.000Z' }, null, s).map(l => l.area), ['ui'])
  const file = path.join(process.env.FACTORY_DATA_DIR, 'contract.json')
  L.writeLessons(s, file)
  assert.equal(L.listLessons({ area: 'tests' }, file).length, 1, 'read from the file when no store is given')
})

const ALL = DEFAULT_AREAS
function many() {
  const s = fresh()
  const add = (text, area, count) => {
    const { lesson } = L.addLesson(s, { text, area, by: 'you' }, opts)
    lesson.count = count
  }
  add('Write the failing test first.', 'tests', 5)
  add('Run the whole suite on the last commit.', 'tests', 2)
  add('Cover the empty and too long cases.', 'tests', 9)
  add('Look at the page in the dark theme.', 'ui', 4)
  add('Check the page at phone width.', 'ui', 7)
  add('Keep the route checks to one plain sentence.', 'routes', 3)
  add('Say in the docs when behaviour changes.', 'docs', 1)
  add('Hand the flow over with a self-check.', 'general', 6)
  add('Name the flow in every message.', 'general', 2)
  add('Stop the preview server you started.', 'infra', 8)
  return s
}

test('taskAreas: from the title, the labels and the files, each with why', () => {
  const a = taskAreas({ title: 'Add a dark mode button to the settings page', files: ['test/settings.test.mjs'], labels: ['Docs'] }, ALL)
  assert.ok(a.get('ui'))
  assert.ok(a.get('tests'))
  assert.ok(a.get('docs'))
  assert.match(a.get('tests'), /test\/settings\.test\.mjs/)
  assert.match(a.get('ui'), /names/)
  assert.equal(a.has('general'), false, 'general is never matched: it is the fallback')
})

test('lessonsFor: matching areas first, most hit first, then general, at most 7, each with why', () => {
  const picked = L.lessonsFor({ title: 'Fix the settings page in the dark theme', files: ['public/settings.css'] }, { store: many(), areas: ALL })
  assert.ok(picked.length <= 7)
  assert.deepEqual(picked.slice(0, 2).map(l => l.text), ['Check the page at phone width.', 'Look at the page in the dark theme.'], 'ui, most hit first')
  const gen = picked.filter(l => l.area === 'general').map(l => l.text)
  assert.deepEqual(gen, ['Hand the flow over with a self-check.', 'Name the flow in every message.'], 'general after the matches, most hit first')
  assert.ok(picked.every(l => typeof l.why === 'string' && l.why))
  assert.ok(picked.findIndex(l => l.area === 'general') > picked.findLastIndex(l => l.area === 'ui'))
})

test('lessonsFor: the cap of 7 holds when many areas match', () => {
  const picked = L.lessonsFor({ title: 'Add a route and a page with tests, update the docs and the config' }, { store: many(), areas: ALL })
  assert.equal(picked.length, 7)
  assert.deepEqual(picked.slice(0, 3).map(l => l.count), [9, 8, 7])
})

test('lessonsFor: nothing matches, only the general lessons; nothing active, nothing', () => {
  const picked = L.lessonsFor({ title: 'Rename a variable' }, { store: many(), areas: ALL })
  assert.deepEqual(picked.map(l => l.area), ['general', 'general'])
  assert.deepEqual(L.lessonsFor({ title: 'Anything' }, { store: fresh(), areas: ALL }), [])
})

test('lessonsBlock: the lines printed after an agent rules, each with its area and why', () => {
  const picked = L.lessonsFor({ title: 'Fix the dark theme page' }, { store: many(), areas: ALL })
  const text = L.lessonsBlock(picked)
  assert.match(text, /^Lessons from earlier work/)
  assert.match(text, /\n1\. Check the page at phone width\. \(ui: /)
  assert.match(text, /\(general: /)
  assert.equal(L.lessonsBlock([]), '')
})

test('qualitySettings: defaults, the switches, extra areas, the pipeline require switch; bad values warn and keep defaults', () => {
  assert.deepEqual(DEFAULT_QUALITY.critic, 'manual')
  const d = qualitySettings(undefined, undefined, () => {})
  assert.equal(d.autoLessons, true)
  assert.equal(d.critic, 'manual')
  assert.equal(d.requireSelfCheck, false)
  assert.deepEqual(d.areas, [...DEFAULT_AREAS])
  const warns = []
  const s = qualitySettings({ autoLessons: false, critic: 'auto', areas: ['billing', 'Tests', 'bad area!'] }, { requireSelfCheck: true }, m => warns.push(m))
  assert.equal(s.autoLessons, false)
  assert.equal(s.critic, 'auto')
  assert.equal(s.requireSelfCheck, true)
  assert.ok(s.areas.includes('billing'))
  assert.equal(s.areas.filter(a => a === 'tests').length, 1)
  assert.equal(s.areas.at(-1), 'general', 'general stays last')
  assert.equal(warns.length, 1, 'one warning for the bad area')
  const w2 = []
  const bad = qualitySettings({ autoLessons: 'yes', critic: 'always' }, { requireSelfCheck: 'on' }, m => w2.push(m))
  assert.deepEqual([bad.autoLessons, bad.critic, bad.requireSelfCheck], [true, 'manual', false])
  assert.equal(w2.length, 3)
})
