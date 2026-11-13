// Tests for native-confirm.mjs, the system Yes/No window that confirms, outside
// the browser, a change that could let something driving the page send (the
// first send PIN, a reset, turning sending on, the branches). A stub runner
// stands in for powershell, osascript, zenity and kdialog: no window opens here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const N = await import('../native-confirm.mjs')

const TITLE = 'Yz Agent Orchestration'
const NASTY = 'Set a new send PIN"; Remove-Item -Recurse C:\\ ; $(calc) `whoami` \'x\''
const b64 = s => Buffer.from(s, 'utf16le').toString('base64')
/** A runner that records each call and answers with `codes` in turn (a code, or 'spawn' / 'timeout'). */
function runner(...codes) {
  const calls = []
  const run = async (bin, args, opts) => {
    calls.push({ bin, args, opts })
    const c = codes.length > 1 ? codes.shift() : codes[0]
    return c === 'spawn' ? { error: 'spawn' } : c === 'timeout' ? { error: 'timeout' } : { code: c }
  }
  return Object.assign(run, { calls })
}

test('Windows: powershell runs ONE fixed script; the title and text go as base64 UTF-16 arguments, never into the command text', async () => {
  const run = runner(0)
  assert.equal(await N.confirmNative({ title: TITLE, message: NASTY }, { platform: 'win32', run }), 'yes')
  const [{ bin, args, opts }] = run.calls
  assert.equal(bin, 'powershell')
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
  assert.equal(args[3], N.WINDOWS_SCRIPT)
  assert.deepEqual(args.slice(4), [b64(TITLE), b64(NASTY)])
  assert.ok(!args.join(' ').includes('Remove-Item') && !args.join(' ').includes('send PIN'), 'the text is never in the command')
  assert.match(N.WINDOWS_SCRIPT, /System\.Windows\.Forms/)
  assert.match(N.WINDOWS_SCRIPT, /FromBase64String/)
  assert.match(N.WINDOWS_SCRIPT, /TopMost/)
  assert.equal(opts.timeout, 60_000)
})

test('macOS: osascript with a fixed script that reads the title and text from argv', async () => {
  const run = runner(1)
  assert.equal(await N.confirmNative({ title: TITLE, message: NASTY }, { platform: 'darwin', run }), 'no')
  const [{ bin, args }] = run.calls
  assert.equal(bin, 'osascript')
  const script = args.filter((a, i) => args[i - 1] === '-e')
  assert.equal(script[0], 'on run argv')
  assert.ok(script.every(l => !l.includes('send PIN')), 'the text is not in the script')
  assert.deepEqual(args.slice(-2), [TITLE, NASTY])
})

test('Linux: zenity, then kdialog when zenity is missing; no display at all is unavailable without running anything', async () => {
  const env = { DISPLAY: ':0' }
  const z = runner(0)
  assert.equal(await N.confirmNative({ title: TITLE, message: 'Turn on sending?' }, { platform: 'linux', run: z, env }), 'yes')
  assert.equal(z.calls[0].bin, 'zenity')
  assert.ok(z.calls[0].args.includes('--no-markup'))
  const k = runner('spawn', 1)
  assert.equal(await N.confirmNative({ title: TITLE, message: 'x' }, { platform: 'linux', run: k, env }), 'no')
  assert.deepEqual(k.calls.map(c => c.bin), ['zenity', 'kdialog'])
  const none = runner(0)
  assert.equal(await N.confirmNative({ title: TITLE, message: 'x' }, { platform: 'linux', run: none, env: {} }), 'unavailable')
  assert.equal(none.calls.length, 0)
})

test('exit 0 is yes, 1 is no, anything else, a timeout, a spawn error or another platform is unavailable', async () => {
  const one = async (code, platform = 'win32') => N.confirmNative({ title: TITLE, message: 'x', timeoutMs: 5 }, { platform, run: runner(code) })
  assert.equal(await one(0), 'yes')
  assert.equal(await one(1), 'no')
  assert.equal(await one(2), 'unavailable')
  assert.equal(await one('timeout'), 'unavailable')
  assert.equal(await one('spawn'), 'unavailable')
  assert.equal(await one(0, 'aix'), 'unavailable')
})

test('one window at a time: a second ask while one is open is busy', async () => {
  let answer
  const run = () => new Promise(r => { answer = r })
  const first = N.confirmNative({ title: TITLE, message: 'x' }, { platform: 'win32', run })
  assert.equal(await N.confirmNative({ title: TITLE, message: 'y' }, { platform: 'win32', run: runner(0) }), 'busy')
  answer({ code: 0 })
  assert.equal(await first, 'yes')
  assert.equal(await N.confirmNative({ title: TITLE, message: 'z' }, { platform: 'win32', run: runner(1) }), 'no', 'free again')
})

test('FACTORY_TEST_CONFIRM is honoured only when set before the module loads (at server start), never later', async () => {
  const code = "import('./native-confirm.mjs').then(m => m.confirmNative({ title: 't', message: 'm' })).then(a => process.stdout.write(a))"
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: { ...process.env, FACTORY_TEST_CONFIRM: 'unavailable' }, encoding: 'utf8' })
  assert.equal(r.stdout, 'unavailable')
  process.env.FACTORY_TEST_CONFIRM = 'yes'
  try {
    assert.equal(await N.confirmNative({ title: TITLE, message: 'x' }, { platform: 'win32', run: runner(1) }), 'no', 'set after load: ignored')
  } finally {
    delete process.env.FACTORY_TEST_CONFIRM
  }
})
