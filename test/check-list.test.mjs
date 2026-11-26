// npm run check: the list of source files lives in package.json `checkList` and tools/check.mjs
// runs `node --check` on each. The list used to be the `check` script itself, one long
// `node --check a && node --check b ...` line; with every feature's files on it the line
// passed 8,191 characters, which is as long as a Windows command line may be, and
// `npm run check` stopped with "The command line is too long" before checking anything.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseCheckList, checkFiles } from '../tools/check.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the check script stays short enough for a Windows command line', () => {
  assert.ok(pkg.scripts.check.length < 1000, pkg.scripts.check)
  assert.equal(pkg.scripts.check, 'node tools/check.mjs')
})

test('checkList keeps the old line format and checks itself', () => {
  assert.match(pkg.checkList, /^node --check server\.mjs && /)
  assert.ok(pkg.checkList.includes('node --check tools/check.mjs'))
})

test('parseCheckList: the files in order, no duplicates', () => {
  assert.deepEqual(parseCheckList('node --check a.mjs && node --check public/b.js && node --check a.mjs'), ['a.mjs', 'public/b.js'])
})

test('parseCheckList: an entry that is not node --check <file> is refused with its text', () => {
  assert.throws(() => parseCheckList('node --check a.mjs && rm -rf x'), /rm -rf x/)
  assert.throws(() => parseCheckList(''), /empty/)
  assert.throws(() => parseCheckList(undefined), /empty/)
})

test('every file on the list exists', () => {
  const root = new URL('..', import.meta.url)
  for (const f of parseCheckList(pkg.checkList)) assert.doesNotThrow(() => readFileSync(new URL(f, root)), f)
})

test('checkFiles: good files pass, a syntax error is named, a missing file is named', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-list-'))
  writeFileSync(path.join(dir, 'good.mjs'), 'export const a = 1\n')
  writeFileSync(path.join(dir, 'bad.mjs'), 'export const = \n')
  assert.deepEqual(await checkFiles(['good.mjs'], { cwd: dir }), [])
  const failures = await checkFiles(['good.mjs', 'bad.mjs', 'gone.mjs'], { cwd: dir })
  assert.deepEqual(failures.map((f) => f.file), ['bad.mjs', 'gone.mjs'])
  assert.ok(failures.every((f) => f.output.length > 0))
})
