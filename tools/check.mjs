#!/usr/bin/env node
// npm run check: `node --check` on every source file named in package.json `checkList`.
//
// The list is the same hand-kept `node --check a && node --check b ...` line it always was; it
// only moved out of the `check` script into its own key. ⚠️ Why: npm runs a script through
// cmd.exe on Windows, and a command line there may be at most 8,191 characters. With every
// feature's files on it the old one-line script passed that, and `npm run check` stopped with
// "The command line is too long" before checking a single file. A new source file still goes
// on the list, exactly as before, just in `checkList`.
//
// Unlike the `&&` chain, it checks every file and then names each one that failed (a syntax
// error, or a file on the list that is not there), so one bad file does not hide the next.
// Exit code 1 when any failed or the list itself is not in the expected shape.

import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ENTRY = /^node --check (\S+)$/
const AT_ONCE = 8 // parallel `node --check` processes: the list is long, each one is quick

/** The files on a `node --check a && node --check b` line, in order, each once. Throws on anything else. */
export function parseCheckList(line) {
  if (typeof line !== 'string' || line.trim() === '') throw new Error('checkList in package.json is empty or missing')
  const files = []
  for (const part of line.split(' && ')) {
    const m = part.trim().match(ENTRY)
    if (!m) throw new Error(`checkList entry is not "node --check <file>": ${part}`)
    if (!files.includes(m[1])) files.push(m[1])
  }
  return files
}

function checkOne(file, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--check', file], { cwd, windowsHide: true }, (err, stdout, stderr) => {
      resolve(err ? { file, output: String(stderr || stdout || err.message).trim() || err.message } : null)
    })
  })
}

/** Runs `node --check` on each file (relative to cwd); resolves to the failures, in list order. */
export async function checkFiles(files, { cwd = process.cwd() } = {}) {
  const results = new Array(files.length)
  let next = 0
  async function worker() {
    while (next < files.length) {
      const i = next++
      results[i] = await checkOne(files[i], cwd)
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, files.length) }, worker))
  return results.filter(Boolean)
}

async function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  let files
  try {
    files = parseCheckList(pkg.checkList)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
  const failures = await checkFiles(files, { cwd: root })
  for (const f of failures) console.error(`${f.file}\n${f.output}\n`)
  if (failures.length) {
    console.error(`${failures.length} of ${files.length} files failed the check.`)
    process.exit(1)
  }
  console.log(`${files.length} files checked.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
