// Tests for `node tools/factory.mjs context …` (tools/context-cli.mjs), run as an agent runs it: add a note
// from --text or --file, list what SCRIPT is told, remove a note. This is how the user "asks Master": Master
// runs the command. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports and goes to each child.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'context-cli-test-'))
const C = await import('../script-context.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'context-cli-files-'))
after(() => {
  fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
})

const cli = (...argv) => spawnSync(process.execPath, ['tools/factory.mjs', 'context', ...argv], {
  cwd: ROOT, env: { ...process.env, FACTORY_DATA_DIR: process.env.FACTORY_DATA_DIR, FACTORY_BY: '' }, encoding: 'utf8',
})
const reset = () => fs.rmSync(C.CONTEXT_FILE, { force: true })

test('add --text saves a note, on, and says so in one line', () => {
  reset()
  const r = cli('add', 'Release plan', '--text', 'We ship on Friday to stage first.')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^Added n-[a-z0-9]+ "Release plan" \(33 characters\)/)
  const notes = C.readContext().notes
  assert.deepEqual(notes.map(n => [n.title, n.text, n.on]), [['Release plan', 'We ship on Friday to stage first.', true]])
})

test('add --file reads a text file; a missing, empty, binary or oversized file is refused with a plain line', () => {
  reset()
  const good = path.join(TMP, 'notes.md')
  fs.writeFileSync(good, '# Our rules\nAgent 1 owns the web app.\n')
  assert.equal(cli('add', 'Rules', '--file', good).status, 0)
  assert.equal(C.readContext().notes[0].text, '# Our rules\nAgent 1 owns the web app.\n')
  const bin = path.join(TMP, 'pic.png')
  fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
  const big = path.join(TMP, 'big.txt')
  fs.writeFileSync(big, 'x'.repeat(20_001))
  for (const [file, re] of [[path.join(TMP, 'nope.txt'), /could not be read/], [bin, /not a text file/], [big, /20,000/]]) {
    const r = cli('add', 'T', '--file', file)
    assert.equal(r.status, 1, file)
    assert.match(r.stderr, re)
  }
  assert.equal(C.readContext().notes.length, 1)
})

test('add needs a title and exactly one of --text or --file', () => {
  reset()
  for (const argv of [['add'], ['add', 'T'], ['add', 'T', '--text', 'a', '--file', 'b'], ['add', '', '--text', 'a']]) {
    const r = cli(...argv)
    assert.equal(r.status, 1, argv.join(' '))
    assert.ok(r.stderr.trim(), argv.join(' '))
  }
  assert.equal(C.readContext().notes.length, 0)
})

test('list shows the brief switch, the session and each note with its id, switch and size', () => {
  reset()
  cli('add', 'Product', '--text', 'Lumen.')
  const ctx = C.readContext()
  ctx.session = 'Master'
  C.writeContext(ctx)
  const r = cli('list')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Orchestration brief: on/)
  assert.match(r.stdout, /Live session: Master/)
  assert.match(r.stdout, new RegExp(`${ctx.notes[0].id}\\s+on\\s+6 characters\\s+Product`))
})

test('list with nothing yet says so', () => {
  reset()
  assert.match(cli('list').stdout, /No notes yet/)
})

test('remove takes a note away; an unknown id is a plain failure', () => {
  reset()
  cli('add', 'Gone soon', '--text', 'x')
  const id = C.readContext().notes[0].id
  const r = cli('remove', id)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Removed/)
  assert.equal(C.readContext().notes.length, 0)
  const again = cli('remove', id)
  assert.equal(again.status, 1)
  assert.match(again.stderr, /gone/)
})

test('no subcommand prints the usage; the factory usage names the context commands', () => {
  const r = cli()
  assert.equal(r.status, 1)
  assert.match(r.stderr, /context add "<title>" \(--text "\.\.\." \| --file <path>\)/)
  const top = spawnSync(process.execPath, ['tools/factory.mjs'], { cwd: ROOT, env: { ...process.env, FACTORY_DATA_DIR: process.env.FACTORY_DATA_DIR }, encoding: 'utf8' })
  assert.match(top.stdout, /context add/)
})
