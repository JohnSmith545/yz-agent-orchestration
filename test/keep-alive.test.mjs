// tools/keep-alive.cmd restarts the server AT ONCE when it exits with 75 (restart.mjs, a project switch).
// ⚠️ cmd.exe reads a RUNNING batch file from the byte where it left off. A keep-alive window already running the
// older file is waiting on its node line; when that server exits, cmd reads on from that byte offset in the NEW
// file. So every byte up to and including the node line must stay exactly as it was, and the new line must come
// right after it. These tests hold that.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'keep-alive.cmd')
const lines = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n').split('\n')

/** The file as it was before the restart code, up to and including the node line: never to change. */
const BEFORE = [
  '@echo off',
  'rem Keeps Yz Agent Orchestration running (Windows). Starts node server.mjs from the',
  'rem repo root, and starts it again 5 seconds after it stops, for whatever reason.',
  'rem Output is appended to %LOCALAPPDATA%\\yz-agent-orchestration\\server.log.',
  'rem Stop it by closing its window, or Ctrl+C then Y.',
  'rem To start it at login: put a shortcut to this file in the folder that shell:startup opens.',
  'setlocal',
  'set "ROOT=%~dp0.."',
  'set "LOGDIR=%LOCALAPPDATA%\\yz-agent-orchestration"',
  'if not exist "%LOGDIR%" mkdir "%LOGDIR%"',
  'cd /d "%ROOT%"',
  ':loop',
  'echo [%date% %time%] starting node server.mjs>>"%LOGDIR%\\server.log"',
  'node server.mjs >>"%LOGDIR%\\server.log" 2>&1',
]

test('every line up to the node line is exactly as before, so a running window picks up the change safely', () => {
  assert.deepEqual(lines.slice(0, BEFORE.length), BEFORE)
})

test('right after the node line, exit code 75 goes straight back to the loop; any other exit still waits', () => {
  const next = lines[BEFORE.length]
  assert.match(next, /^if %errorlevel%==75 \(.*& goto loop\)$/)
  const rest = lines.slice(BEFORE.length + 1).join('\n')
  assert.match(rest, /ping -n 6 127\.0\.0\.1 >nul\ngoto loop/)
})
