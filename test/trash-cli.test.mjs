// Tests for what an agent's CLI does with Archive and the Trash, run through tools/factory.mjs as an
// agent runs it: any command on a flow in the Trash fails with ONE plain line telling it to stop,
// `flow new` refuses a trashed id, and `flow list` leaves archived flows out unless --archived.
// FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports and is handed to each child.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-cli-test-'))
const F = await import('../flows.mjs')
const { moveToTrash } = await import('../trash.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-cli-files-'))
after(() => {
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const cli = (...argv) => spawnSync(process.execPath, ['tools/factory.mjs', ...argv], {
  cwd: ROOT, env: { ...process.env, FACTORY_DATA_DIR: F.DATA_DIR, FACTORY_BY: '' }, encoding: 'utf8',
})
const STOP = id => `Flow ${id} is in the Trash: the user deleted it. Stop work on it; it can be restored from the Trash for 24 hours.`
const lines = s => s.split(/\r?\n/).filter(Boolean)

test('any command on a flow in the Trash exits 1 with ONE plain line telling the agent to stop', () => {
  F.createFlow({ id: 'gone', title: 'Add a dark mode toggle', agent: 'Agent 3' })
  const file = path.join(TMP, 'gone.json')
  fs.writeFileSync(file, JSON.stringify(F.readFlow('gone')))
  moveToTrash('gone')
  for (const argv of [
    ['flow', 'step', 'gone', 'Write the toggle', '--by', 'Agent 3'],
    ['flow', 'status', 'gone', 'n1', 'done'],
    ['flow', 'show', 'gone'],
    ['flow', 'say', 'gone', 'Wrote the toggle', '--by', 'Agent 3'],
    ['flow', 'write', file, '--by', 'Agent 3'],
    ['decide', '--question', 'Ship it?', '--why', 'It is ready.', '--flow', 'gone', '--by', 'Agent 3'],
  ]) {
    const r = cli(...argv)
    assert.equal(r.status, 1, argv.join(' '))
    assert.deepEqual(lines(r.stderr), [STOP('gone')], argv.join(' '))
    assert.equal(r.stdout, '', argv.join(' '))
  }
  assert.equal(F.readFlow('gone'), null, 'nothing was written back')
})

test('the CLI guard matches the server: an entry left behind beside a live flow of that id does not refuse it', () => {
  F.createFlow({ id: 'twice', title: 'First', agent: 'Agent 3' })
  moveToTrash('twice')
  F.createFlow({ id: 'twice', title: 'Second', agent: 'Agent 3' }) // live again, the entry still there
  const r = cli('flow', 'step', 'twice', 'Write the toggle', '--by', 'Agent 3')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(F.readFlow('twice').nodes.length, 1)
})

test('flow new on an id in the Trash says to pick another', () => {
  F.createFlow({ id: 'taken', title: 'Old', agent: 'Agent 3' })
  moveToTrash('taken')
  const r = cli('flow', 'new', 'taken', 'New', '--type', 'build', '--by', 'Agent 3')
  assert.equal(r.status, 1)
  assert.deepEqual(lines(r.stderr), ['Flow taken is in the Trash. Pick another id.'])
  assert.equal(F.readFlow('taken'), null)
})

test('flow list leaves archived flows out; --archived lists only them and never swallows the next flag', () => {
  F.createFlow({ id: 'shown', title: 'Shown', agent: 'Agent 1' })
  F.writeFlow({ ...F.readFlow('shown'), id: 'put-away', title: 'Put away', archivedAt: '2026-11-14T09:00:00.000Z' })
  F.writeFlow({ ...F.readFlow('shown'), id: 'put-away-2', title: 'Put away too', agent: 'Agent 2', archivedAt: '2026-11-14T09:00:00.000Z' })
  const ids = r => lines(r.stdout).map(l => l.split('  ')[0])
  const plainList = cli('flow', 'list')
  assert.equal(plainList.status, 0, plainList.stderr)
  assert.ok(ids(plainList).includes('shown'))
  assert.ok(!ids(plainList).some(id => id.startsWith('put-away')), plainList.stdout)
  const archived = cli('flow', 'list', '--archived', '--by', 'Agent 1')
  assert.equal(archived.status, 0, archived.stderr)
  assert.deepEqual(ids(archived).sort(), ['put-away', 'put-away-2'])
  assert.deepEqual(ids(cli('flow', 'list', '--archived', '--agent', 'Agent 2')), ['put-away-2'], 'the filter after it still applies')
  const badName = cli('flow', 'list', '--archived', '--by', 'A"B')
  assert.equal(badName.status, 1, '--by was read as the name, not eaten by --archived')
  assert.match(badName.stderr, /--by must be/)
})
