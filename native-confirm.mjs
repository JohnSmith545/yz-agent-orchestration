// A Yes/No window from the operating system, outside the browser. The send PIN
// stops anything that drives the page (an agent's browser, a rebinding site), so
// a change that would let such a driver send (the first send PIN, a reset,
// turning sending on, the branches) is confirmed here, where a page cannot click
// (settings-routes.mjs).
//
//   confirmNative({ title, message, timeoutMs? }, { platform?, run?, env? })
//     → 'yes' | 'no' | 'unavailable' | 'busy'
//
//   Windows  powershell -NoProfile -NonInteractive -Command <ONE fixed script> <title> <message>, the two
//            texts as base64 UTF-16 arguments the script decodes: never part of the command text.
//            A topmost MessageBox; exit 0 is Yes, 1 is No.
//   macOS    osascript with a fixed script that reads the texts from argv (on run argv).
//   Linux    zenity --question (no markup), else kdialog --yesno, with a display only.
//   Anything else, a timeout, a spawn error or another exit code is 'unavailable', and the caller says
//   how to do it in a terminal instead. One window at a time: a second ask while one is open is 'busy'.
//
// The texts are the caller's fixed sentences with validated values only (never anything from a flow).

import { execFile } from 'node:child_process'

// For an end-to-end check where nobody can click a real window: read ONCE, when the module loads (the
// server's start), so setting it later changes nothing. Not a setting, and documented only here.
const TEST_ANSWER = ['yes', 'no', 'unavailable'].includes(process.env.FACTORY_TEST_CONFIRM) ? process.env.FACTORY_TEST_CONFIRM : null

/** The one PowerShell script: it decodes its two arguments and shows them in a topmost Yes/No box. */
export const WINDOWS_SCRIPT = [
  '& { param($t, $m)',
  'Add-Type -AssemblyName System.Windows.Forms;',
  '$title = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($t));',
  '$text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($m));',
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false };',
  "$answer = [System.Windows.Forms.MessageBox]::Show($owner, $text, $title, 'YesNo', 'Question');",
  "if ($answer -eq 'Yes') { exit 0 } else { exit 1 } }",
].join(' ')

const MAC_SCRIPT = ['on run argv', 'display dialog (item 2 of argv) with title (item 1 of argv) buttons {"No", "Yes"} default button "Yes" cancel button "No"', 'end run']

const b64 = s => Buffer.from(String(s), 'utf16le').toString('base64')

/** The commands to try, in order, for a platform: [{ bin, args }] ([] when there is none). */
export function argvFor(platform, title, message, env = process.env) {
  if (platform === 'win32') return [{ bin: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT, b64(title), b64(message)] }]
  if (platform === 'darwin') return [{ bin: 'osascript', args: [...MAC_SCRIPT.flatMap(l => ['-e', l]), title, message] }]
  if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    return [
      { bin: 'zenity', args: ['--question', '--no-markup', `--title=${title}`, `--text=${message}`] },
      { bin: 'kdialog', args: ['--title', title, '--yesno', message] },
    ]
  }
  return []
}

/** execFile, never a shell: { code } when it ran, { error: 'spawn' | 'timeout' } when it did not. */
function runFile(bin, args, { timeout }) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout, windowsHide: false }, err => {
      if (!err) return resolve({ code: 0 })
      if (err.killed || err.signal) return resolve({ error: 'timeout' })
      if (typeof err.code === 'number') return resolve({ code: err.code })
      resolve({ error: 'spawn' })
    })
  })
}

let open = false

export async function confirmNative({ title, message, timeoutMs = 60_000 }, { platform = process.platform, run = runFile, env = process.env } = {}) {
  if (TEST_ANSWER) return TEST_ANSWER
  if (open) return 'busy'
  open = true
  try {
    for (const { bin, args } of argvFor(platform, title, message, env)) {
      const r = await run(bin, args, { timeout: timeoutMs })
      if (r.error === 'spawn') continue // not installed: the next one
      if (r.error) return 'unavailable'
      return r.code === 0 ? 'yes' : r.code === 1 ? 'no' : 'unavailable'
    }
    return 'unavailable'
  } finally {
    open = false
  }
}
