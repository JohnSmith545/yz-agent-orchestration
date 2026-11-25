// Tests for agent-settings.mjs, the per-agent settings the agent window on the Agents page saves: the model and
// effort the user wants, and the text files and notes the agent is given; the limits with their plain refusals;
// the change sentences; and the block printed to the agent. Pure functions plus reads and writes of a temp file.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the import.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-settings-test-'))
const S = await import('../agent-settings.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const AT = '2026-11-24T10:00:00.000Z'
const opts = { now: () => AT, newId: (() => { let n = 0; return () => `f${++n}` })() }

test('the models and efforts offered, and the fixed pair for the planner and Security', () => {
  assert.deepEqual(S.MODELS.map(m => [m.id, m.name]), [['claude-fable-5-2', 'Fable 5.2'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']])
  assert.deepEqual(S.EFFORTS, ['low', 'medium', 'high'])
  assert.deepEqual(S.FIXED, { model: 'claude-opus-5-5', effort: 'high' })
  assert.deepEqual(S.FIXED_ROLES, ['planner', 'security', 'senior'])
  assert.deepEqual(S.FILE_LIMITS, { chars: 20000, files: 20, total: 60000, title: 100 })
})

test('checkModel: a listed model and effort, or null to clear; anything else one plain sentence; fixed roles refuse', () => {
  assert.deepEqual(S.checkModel({ model: 'claude-sonnet-5-5', effort: 'medium' }, 'producer'), { model: 'claude-sonnet-5-5', effort: 'medium' })
  assert.deepEqual(S.checkModel({ model: null }, 'qa'), { model: null })
  assert.equal(S.checkModel({ model: 'gpt-5' }, 'producer').error, 'Pick one of the listed models.')
  assert.equal(S.checkModel({ effort: 'max' }, 'producer').error, 'Pick low, medium or high effort.')
  assert.equal(S.checkModel({}, 'producer').error, 'Nothing to save. Send a model or an effort.')
  assert.match(S.checkModel({ model: 'claude-haiku-5-5' }, 'security').error, /always runs on Opus at high effort/)
  assert.match(S.checkModel({ model: 'claude-haiku-5-5', effort: 'low' }, 'senior').error, /always runs on Opus at high effort/)
  assert.match(S.checkModel({ model: 'claude-haiku-5-5' }, 'chat').error, /factory\.chat\.model/)
})

test('checkFile: text only, a title, and the size limits, each refusal one plain sentence', () => {
  const entry = S.entryOf({ agents: {} }, 'Agent 1')
  assert.deepEqual(S.checkFile({ title: ' Notes ', text: 'Use the staging API.', kind: 'note' }, entry), { title: 'Notes', text: 'Use the staging API.', kind: 'note', name: null })
  assert.deepEqual(S.checkFile({ title: 'Spec', text: 'x', kind: 'file', name: 'spec.md' }, entry).name, 'spec.md')
  const refuse = (b, e = entry) => S.checkFile(b, e).error
  assert.equal(refuse({ title: '', text: 'x', kind: 'note' }), 'Give it a title.')
  assert.equal(refuse({ title: 'x'.repeat(101), text: 'x', kind: 'note' }), 'The title is too long. Keep it to 100 characters.')
  assert.equal(refuse({ title: 'T', text: '   ', kind: 'note' }), 'The note is empty. Write something first.')
  assert.equal(refuse({ title: 'T', text: '', kind: 'file', name: 'a.txt' }), 'That file is empty.')
  assert.equal(refuse({ title: 'T', text: 'ab\u0000cd', kind: 'file', name: 'a.bin' }), 'That file is not text, so it cannot be added. Add a text file such as .md or .txt.')
  assert.equal(refuse({ title: 'T', text: 'x'.repeat(20001), kind: 'note' }), 'That is too long. Keep each file or note to 20,000 characters.')
  assert.equal(refuse({ title: 'T', text: 'x', kind: 'image' }), 'Add a text file or a note.')
  const full = { ...entry, files: Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, title: 't', kind: 'note', name: null, text: 'x', on: true, addedAt: AT })) }
  assert.equal(refuse({ title: 'T', text: 'x', kind: 'note' }, full), 'That is the most this agent can have: 20 files and notes. Remove one first.')
  const heavy = { ...entry, files: [0, 1, 2].map(i => ({ id: `h${i}`, title: 't', kind: 'note', name: null, text: 'x'.repeat(20000), on: true, addedAt: AT })) }
  assert.equal(refuse({ title: 'T', text: 'x', kind: 'note' }, heavy), 'That would take this agent past 60,000 characters in all. Remove or shorten another file first.')
})

test('add, switch and remove a file: a new store each time, with a change sentence; the store passed in is not changed', () => {
  const empty = { agents: {} }
  const a = S.addFile(empty, 'Agent 1', { title: 'Spec', text: 'Build it.', kind: 'file', name: 'spec.md' }, opts)
  assert.deepEqual(empty, { agents: {} })
  assert.equal(a.text, 'Agent 1 was given the file Spec.')
  const id = a.store.agents['Agent 1'].files[0].id
  assert.deepEqual(a.store.agents['Agent 1'].files[0], { id, title: 'Spec', kind: 'file', name: 'spec.md', text: 'Build it.', on: true, addedAt: AT })
  const off = S.setFileOn(a.store, 'Agent 1', id, false, opts)
  assert.equal(off.store.agents['Agent 1'].files[0].on, false)
  assert.equal(off.text, 'The file Spec of Agent 1 was switched off.')
  assert.equal(S.setFileOn(off.store, 'Agent 1', id, false, opts).text, null, 'no change, no sentence')
  assert.equal(S.setFileOn(a.store, 'Agent 1', 'nope', true, opts).error, 'There is no such file or note for Agent 1.')
  const gone = S.removeFile(off.store, 'Agent 1', id, opts)
  assert.deepEqual(gone.store.agents['Agent 1'].files, [])
  assert.equal(gone.text, 'The file Spec was removed from Agent 1.')
  assert.equal(S.addFile(empty, 'Agent 2', { title: 'Tip', text: 'Short answers.', kind: 'note' }, opts).text, 'Agent 2 was given the note Tip.')
})

test('applyModel: the change sentence names the model and the effort; the same choice again is no change', () => {
  const r = S.applyModel({ agents: {} }, 'Agent 1', { model: 'claude-sonnet-5-5', effort: 'medium' }, opts)
  assert.equal(r.text, 'Agent 1 is to run on Sonnet 5.5 at medium effort.')
  assert.equal(S.applyModel(r.store, 'Agent 1', { effort: 'high' }, opts).text, 'Agent 1 is to run at high effort.')
  assert.equal(S.applyModel(r.store, 'Agent 1', { model: 'claude-opus-5-5' }, opts).text, 'Agent 1 is to run on Opus 5.5.')
  assert.equal(S.applyModel(r.store, 'Agent 1', { model: null }, opts).text, 'Agent 1 no longer has a model chosen.')
  assert.equal(S.applyModel(r.store, 'Agent 1', { model: 'claude-sonnet-5-5' }, opts).text, null)
})

test('read and write: a missing or broken file is empty; what is not well formed is left out', () => {
  const file = path.join(process.env.FACTORY_DATA_DIR, 'settings.json')
  assert.deepEqual(S.readAgentSettings(file), { agents: {} })
  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(S.readAgentSettings(file), { agents: {} })
  fs.writeFileSync(file, JSON.stringify({ agents: { 'Agent 1': { model: 'gpt', effort: 'high', files: [{ id: 'a', title: 'T', kind: 'note', text: 'x', on: true, addedAt: AT }, { id: 'b' }] }, bad: 5 } }))
  const back = S.readAgentSettings(file)
  assert.deepEqual(Object.keys(back.agents), ['Agent 1'])
  assert.equal(back.agents['Agent 1'].model, null, 'an unknown model is dropped')
  assert.equal(back.agents['Agent 1'].effort, 'high')
  assert.deepEqual(back.agents['Agent 1'].files.map(f => f.id), ['a'])
  const r = S.addFile(back, 'Agent 2', { title: 'N', text: 'y', kind: 'note' }, opts)
  S.writeAgentSettings(r.store, file)
  assert.deepEqual(S.readAgentSettings(file), r.store)
})

test('settingsBlock: the wanted model in one sentence, then each switched-on file under its title; nothing for nothing saved', () => {
  assert.equal(S.settingsBlock({ agents: {} }, 'Agent 1', 'producer'), '')
  let store = S.applyModel({ agents: {} }, 'Agent 1', { model: 'claude-sonnet-5-5', effort: 'medium' }, opts).store
  store = S.addFile(store, 'Agent 1', { title: 'Spec', text: 'Build the login page.', kind: 'file', name: 'spec.md' }, opts).store
  store = S.addFile(store, 'Agent 1', { title: 'Off one', text: 'Hidden.', kind: 'note' }, opts).store
  store = S.setFileOn(store, 'Agent 1', store.agents['Agent 1'].files[1].id, false, opts).store
  const text = S.settingsBlock(store, 'Agent 1', 'producer')
  assert.equal(text, [
    'Settings for Agent 1, set by the user on the dashboard:',
    'The user wants you on Sonnet 5.5 (claude-sonnet-5-5) at medium effort: start your subagents on that model; the user switches this session in the editor.',
    '',
    'File: Spec (spec.md)',
    'Build the login page.',
  ].join('\n'))
  assert.doesNotMatch(text, /Hidden/)
})

test('settingsBlock: the planner and Security always get the fixed Opus line, whatever is saved', () => {
  const text = S.settingsBlock({ agents: {} }, 'Security', 'security')
  // the model is FIXED, not a choice the user made (QA, 2026-11-25): the head says so
  assert.equal(text, 'Settings for Security. Your model is fixed by the dashboard, not chosen by the user:\nYou always run on Opus 5.5 (claude-opus-5-5) at high effort, and so do the subagents you start. If this session runs on another model, tell the user so they can switch it in the editor.')
  const withNote = S.addFile({ agents: {} }, 'Planner', { title: 'Plan template', text: 'Goal, steps, tests.', kind: 'note' }, opts).store
  assert.match(S.settingsBlock(withNote, 'Planner', 'planner'), /^Settings for Planner\. Your model is fixed by the dashboard; the files and notes below are the user's own:\nYou always run on Opus 5\.5[^\n]*\n\nNote: Plan template\nGoal, steps, tests\.$/)
})

test('settingsBlock: a print past 60,000 characters is cut with a visible line saying how much', () => {
  let store = { agents: {} }
  for (let i = 0; i < 3; i++) store = S.addFile(store, 'Agent 1', { title: `Part ${i}`, text: 'y'.repeat(19990), kind: 'note' }, opts).store
  const text = S.settingsBlock(store, 'Agent 1', 'producer')
  const m = /\n\[cut: ([\d,]+) more characters\]$/.exec(text)
  assert.ok(m, text.slice(-80))
  assert.equal(text.length - m[0].length, S.PRINT_MAX)
})

test('the change log: appended after a save, read back newest first per agent; a torn line is skipped', () => {
  const log = path.join(process.env.FACTORY_DATA_DIR, 'settings-log.jsonl')
  assert.equal(S.appendSettingsLog({ at: AT, label: 'Agent 1', text: 'Agent 1 is to run on Opus 5.5.' }, log), true)
  fs.appendFileSync(log, '{torn\n')
  S.appendSettingsLog({ at: '2026-11-24T11:00:00.000Z', label: 'Agent 1', text: 'Agent 1 was given the note Tip.' }, log)
  S.appendSettingsLog({ at: AT, label: 'Agent 2', text: 'x' }, log)
  assert.deepEqual(S.settingsChangesOf(S.readSettingsLog(log), 'Agent 1'), [
    { at: '2026-11-24T11:00:00.000Z', text: 'Agent 1 was given the note Tip.' },
    { at: AT, text: 'Agent 1 is to run on Opus 5.5.' },
  ])
})
