// Tests for the SCRIPT context store (script-context.mjs): the defaults, the limits, the pure validator and
// the note changes, and a missing or broken file reading as the defaults. FACTORY_DATA_DIR points at a fresh
// temp folder BEFORE the import, so the real data/ folder is never touched.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'script-context-test-'))
const C = await import('../script-context.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const NOW = '2026-11-24T10:00:00.000Z'
const LATER = '2026-11-24T11:00:00.000Z'
let n = 0
const fresh = () => path.join(process.env.FACTORY_DATA_DIR, `ctx-${++n}.json`)

test('the file lives in the data dir that FACTORY_DATA_DIR moves', () => {
  assert.equal(C.CONTEXT_FILE, path.join(process.env.FACTORY_DATA_DIR, 'script-context.json'))
})

test('the defaults: the orchestration on, no session, no notes; the limits as agreed', () => {
  assert.deepEqual(C.defaults(), { orchestration: true, session: null, notes: [] })
  assert.deepEqual({ ...C.LIMITS }, { titleMax: 80, textMax: 20_000, notesMax: 40, totalMax: 60_000, briefMax: 8_000, sessionMax: 12_000 })
})

test('a missing file, a file that is not JSON, and a file of the wrong shape all read as the defaults', () => {
  assert.deepEqual(C.readContext(fresh()), C.defaults())
  const broken = fresh()
  fs.writeFileSync(broken, '{not json')
  assert.deepEqual(C.readContext(broken), C.defaults())
  const wrong = fresh()
  fs.writeFileSync(wrong, JSON.stringify({ orchestration: 'yes', notes: 'none' }))
  assert.deepEqual(C.readContext(wrong), C.defaults())
})

test('the validator lists each problem in one line, and a good context has none', () => {
  assert.deepEqual(C.validateContext(C.defaults()), [])
  const good = { orchestration: false, session: 'Agent 1', notes: [{ id: 'n-1', title: 'T', text: 'x', on: true, addedAt: NOW, updatedAt: NOW }] }
  assert.deepEqual(C.validateContext(good), [])
  assert.ok(C.validateContext(null).length)
  assert.ok(C.validateContext({ ...good, orchestration: 1 }).some(p => /orchestration/.test(p)))
  assert.ok(C.validateContext({ ...good, session: 'bad\nlabel' }).some(p => /session/.test(p)))
  assert.ok(C.validateContext({ ...good, notes: [{ ...good.notes[0], title: '' }] }).some(p => /title/.test(p)))
  assert.ok(C.validateContext({ ...good, notes: [{ ...good.notes[0], text: 'x'.repeat(20_001) }] }).some(p => /text/.test(p)))
  assert.ok(C.validateContext({ ...good, notes: [{ ...good.notes[0], on: 'yes' }] }).some(p => /on/.test(p)))
  assert.ok(C.validateContext({ ...good, notes: [good.notes[0], good.notes[0]] }).some(p => /twice/.test(p)))
  const many = Array.from({ length: 41 }, (_, i) => ({ ...good.notes[0], id: `n-${i}` }))
  assert.ok(C.validateContext({ ...good, notes: many }).some(p => /40/.test(p)))
})

test('a note is added with a title of 1 to 80 characters and a text of 1 to 20,000, on, with its times', () => {
  const ctx = C.defaults()
  const r = C.addNote(ctx, { title: '  Our product  ', text: 'Lumen is a reading app.' }, { now: NOW, id: 'n-abc' })
  assert.deepEqual(r.note, { id: 'n-abc', title: 'Our product', text: 'Lumen is a reading app.', on: true, addedAt: NOW, updatedAt: NOW })
  assert.equal(ctx.notes.length, 1)
  for (const [body, re] of [
    [{ title: '', text: 'x' }, /title/i],
    [{ title: 'x'.repeat(81), text: 'x' }, /80/],
    [{ title: 'T', text: '   ' }, /text/i],
    [{ title: 'T', text: 'x'.repeat(20_001) }, /20,000/],
    [{ title: 42, text: 'x' }, /title/i],
  ]) {
    const bad = C.addNote(C.defaults(), body, { now: NOW, id: 'n-x' })
    assert.match(bad.error, re, JSON.stringify(body).slice(0, 40))
  }
  // a title is one line
  assert.equal(C.addNote(C.defaults(), { title: 'Two\nlines', text: 'x' }, { now: NOW, id: 'n-y' }).note.title, 'Two lines')
})

test('at most 40 notes: the 41st is refused with a plain reason', () => {
  const ctx = C.defaults()
  for (let i = 0; i < 40; i++) assert.ok(C.addNote(ctx, { title: `T${i}`, text: 'x' }, { now: NOW, id: `n-${i}` }).note)
  assert.match(C.addNote(ctx, { title: 'one more', text: 'x' }, { now: NOW, id: 'n-41' }).error, /40/)
})

test('a note is edited by id (title, text, on) and its updatedAt moves; an unknown id is a 404', () => {
  const ctx = C.defaults()
  C.addNote(ctx, { title: 'T', text: 'old' }, { now: NOW, id: 'n-1' })
  const r = C.editNote(ctx, 'n-1', { text: 'new', on: false }, { now: LATER })
  assert.deepEqual(r.note, { id: 'n-1', title: 'T', text: 'new', on: false, addedAt: NOW, updatedAt: LATER })
  assert.equal(C.editNote(ctx, 'nope', { on: true }, { now: LATER }).status, 404)
  assert.match(C.editNote(ctx, 'n-1', { on: 'yes' }, { now: LATER }).error, /on/)
  assert.match(C.editNote(ctx, 'n-1', { title: '' }, { now: LATER }).error, /title/i)
  assert.match(C.editNote(ctx, 'n-1', {}, { now: LATER }).error, /Nothing/)
})

test('a note is removed by id; an unknown id is a 404', () => {
  const ctx = C.defaults()
  C.addNote(ctx, { title: 'T', text: 'x' }, { now: NOW, id: 'n-1' })
  assert.equal(C.removeNote(ctx, 'nope').status, 404)
  assert.deepEqual(C.removeNote(ctx, 'n-1'), { ok: true })
  assert.deepEqual(ctx.notes, [])
})

test('the options: orchestration a boolean, session a label or null', () => {
  const ctx = C.defaults()
  assert.deepEqual(C.setOptions(ctx, { orchestration: false, session: 'Master' }), { ok: true })
  assert.equal(ctx.orchestration, false)
  assert.equal(ctx.session, 'Master')
  assert.deepEqual(C.setOptions(ctx, { session: null }), { ok: true })
  assert.equal(ctx.session, null)
  assert.match(C.setOptions(ctx, { orchestration: 'on' }).error, /orchestration/)
  assert.match(C.setOptions(ctx, { session: 'x'.repeat(41) }).error, /session/i)
  assert.match(C.setOptions(ctx, {}).error, /Nothing/)
})

test('updateContext reads, changes and writes atomically; a refused change writes nothing', () => {
  const file = fresh()
  const r = C.updateContext(ctx => C.addNote(ctx, { title: 'T', text: 'x' }, { now: NOW, id: 'n-1' }), file)
  assert.equal(r.note.id, 'n-1')
  assert.equal(C.readContext(file).notes.length, 1)
  const before = fs.readFileSync(file, 'utf8')
  const bad = C.updateContext(ctx => C.addNote(ctx, { title: '', text: 'x' }, { now: NOW, id: 'n-2' }), file)
  assert.ok(bad.error)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), [])
})

test('writeContext refuses a context the validator rejects, so a bad shape never replaces a good file', () => {
  const file = fresh()
  C.writeContext(C.defaults(), file)
  assert.throws(() => C.writeContext({ orchestration: 'x', session: null, notes: [] }, file))
  assert.deepEqual(C.readContext(file), C.defaults())
})

test('new ids are short, unique and safe in a URL', () => {
  const ids = new Set(Array.from({ length: 200 }, () => C.newId()))
  assert.equal(ids.size, 200)
  for (const id of ids) assert.match(id, /^n-[a-z0-9]{8,}$/)
})
