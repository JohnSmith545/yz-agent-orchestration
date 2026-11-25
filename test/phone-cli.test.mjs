// Tests for tools/phone-cli.mjs: `phone-pin` (the phone PIN, typed in a terminal, kept only as its scrypt hash) and
// `phone-setup` (pick one of this PC's private or Tailscale addresses and write remote.bind and remote.enabled after
// a typed yes). The keyboard is a scripted stand-in and config.json a temp copy; nothing touches the real one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-cli-test-'))
const C = await import('../tools/phone-cli.mjs')
const { makeAuthStore } = await import('../phone-auth.mjs')
const { hashPin, verifyPin } = await import('../send-pin.mjs')
const { remoteSettings } = await import('../phone-bind.mjs')

const dir = process.env.FACTORY_DATA_DIR
let n = 0
const BASE = '{\n  "repo": "C:/work/repo",\n  "port": 4317,\n  "pr": { "enabled": false }\n}\n'
function config(text = BASE) {
  const file = path.join(dir, `config-${n++}.json`)
  fs.writeFileSync(file, text)
  return file
}
/** A keyboard that answers each prompt in turn and records what was printed. */
function keyboard(answers, { isTTY = true } = {}) {
  const queue = [...answers]
  const prompts = []
  const next = async p => (prompts.push(p), queue.length ? queue.shift() : null)
  return { isTTY, hidden: next, line: next, prompts }
}
const IFACES = {
  'Wi-Fi': [{ address: '192.168.1.36', family: 'IPv4', internal: false, mac: '34:6f:24:c7:c9:dd', cidr: '192.168.1.36/24' }],
  Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', cidr: '100.101.102.103/32' }],
  Public: [{ address: '8.8.4.4', family: 'IPv4', internal: false }],
}

// ═══ phone-pin ═══

test('phone-pin refuses when it is not typed in a terminal: a PIN piped in is what an agent could do', async () => {
  const file = config()
  const r = await C.runPhonePin({ io: keyboard(['12345678', '12345678'], { isTTY: false }), configFile: file })
  assert.equal(r.code, 1)
  assert.match(r.out, /type it yourself in a terminal/)
  assert.equal(fs.readFileSync(file, 'utf8'), BASE)
})

test('phone-pin writes only the salted scrypt hash and when it was set, never the PIN, and signs every phone out', async () => {
  const file = config()
  const auth = makeAuthStore({ file: path.join(dir, `auth-${n++}.json`) })
  const old = hashPin('99999999', { N: 1024 })
  const before = auth.login({ pin: '99999999', pinHash: old, address: 'x', sessionHours: 12 })
  const r = await C.runPhonePin({ io: keyboard(['4829105736', '4829105736']), configFile: file, auth, now: () => new Date('2026-11-25T10:00:00Z') })
  assert.equal(r.code, 0)
  assert.match(r.out, /Phone PIN set/)
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(text.includes('4829105736'), false)
  assert.equal(r.out.includes('4829105736'), false)
  const cfg = JSON.parse(text)
  assert.equal(verifyPin('4829105736', cfg.remote.pinHash), true)
  assert.equal(cfg.remote.pinSetAt, '2026-11-25T10:00:00.000Z')
  assert.equal(cfg.remote.pinDigits, 10, 'the length is kept, so a PIN from before the 8-digit rule can be told apart')
  assert.equal(cfg.remote.enabled, false, 'a new block starts off: phone-setup turns it on')
  assert.deepEqual(cfg.pr, { enabled: false }, 'the rest of the file as it was')
  assert.equal(auth.session(before.token, 12), null, 'a phone signed in with the old PIN is signed out')
})

test('phone-pin keeps an existing remote block and changes only its hash and time', async () => {
  const file = config('{\n  "repo": "C:/work/repo",\n  "remote": {\n    "enabled": true,\n    "bind": "192.168.1.36",\n    "port": 4320,\n    "sessionHours": 4\n  }\n}\n')
  const r = await C.runPhonePin({ io: keyboard(['4829105736', '4829105736']), configFile: file, auth: makeAuthStore({ file: path.join(dir, `auth-${n++}.json`) }) })
  assert.equal(r.code, 0)
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual([cfg.remote.enabled, cfg.remote.bind, cfg.remote.port, cfg.remote.sessionHours], [true, '192.168.1.36', 4320, 4])
  assert.ok(cfg.remote.pinHash)
})

test('phone-pin refuses a PIN that is short, not digits, typed differently twice, or the same as the send PIN', async () => {
  const send = hashPin('55556666', { N: 1024 })
  const withSend = `{\n  "repo": "C:/work/repo",\n  "pr": { "enabled": true, "pinHash": "${send}" }\n}\n`
  const cases = [
    [['12345'], /at least 8 digits/],
    [['1234567'], /at least 8 digits/],
    [['12ab5678'], /only digits/],
    [['1'.repeat(13)], /at most 12 digits/],
    [['48291057', '48291058'], /differ/],
    [[null], /Cancelled/],
    [['55556666', '55556666'], /differs from your send PIN/],
  ]
  for (const [keys, why] of cases) {
    const file = config(withSend)
    const r = await C.runPhonePin({ io: keyboard(keys), configFile: file, auth: makeAuthStore({ file: path.join(dir, `auth-${n++}.json`) }) })
    assert.equal(r.code, 1, String(keys))
    assert.match(r.out, why)
    assert.equal(fs.readFileSync(file, 'utf8'), withSend, 'nothing written')
  }
})

// ═══ phone-setup ═══

test('phone-setup lists each private and Tailscale address of this PC, marks Tailscale, and never a public one', async () => {
  const io = keyboard([''])
  const r = await C.runPhoneSetup({ io, configFile: config(), interfaces: IFACES })
  const shown = io.prompts.join('\n') + r.out
  assert.match(shown, /1\. 100\.101\.102\.103 \(Tailscale\) - recommended: it encrypts the link and follows you between networks/)
  assert.match(shown, /2\. 192\.168\.1\.36 \(Wi-Fi\)/)
  assert.equal(shown.includes('8.8.4.4'), false)
  assert.match(r.out, /Cancelled/)
})

test('phone-setup writes remote.enabled and remote.bind only after a typed yes, and prints the address to open', async () => {
  const file = config()
  const r = await C.runPhoneSetup({ io: keyboard(['1', 'yes']), configFile: file, interfaces: IFACES })
  assert.equal(r.code, 0)
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual([cfg.remote.enabled, cfg.remote.bind, cfg.remote.port], [true, '100.101.102.103', 4318])
  assert.deepEqual([cfg.remote.iface, cfg.remote.mac, cfg.remote.cidr], ['Tailscale', '00:00:00:00:00:00', '100.101.102.103/32'], 'the network it was set up on')
  assert.match(r.out, /http:\/\/100\.101\.102\.103:4318\/phone/)
  assert.match(r.out, /phone-pin/, 'no PIN yet: it says to set one')
  assert.match(r.out, /no restart needed/i)
  assert.equal(cfg.repo, 'C:/work/repo')
})

test('phone-setup says what it opens before the yes: plain HTTP, the PIN guards a coding agent, never forward the port', async () => {
  const io = keyboard(['1', 'no'])
  const file = config()
  const r = await C.runPhoneSetup({ io, configFile: file, interfaces: IFACES })
  const said = io.prompts.join('\n')
  assert.match(said, /plain HTTP/)
  assert.match(said, /PIN guards the ability to instruct a coding agent/)
  assert.match(said, /Never forward/)
  assert.equal(r.code, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), BASE, 'anything but yes writes nothing')
})

test('phone-setup refuses without a terminal, a bad pick, and a PC with no eligible address', async () => {
  const file = config()
  assert.match((await C.runPhoneSetup({ io: keyboard(['1', 'yes'], { isTTY: false }), configFile: file, interfaces: IFACES })).out, /in a terminal/)
  assert.match((await C.runPhoneSetup({ io: keyboard(['9']), configFile: file, interfaces: IFACES })).out, /not on the list/)
  assert.match((await C.runPhoneSetup({ io: keyboard(['1.5']), configFile: file, interfaces: IFACES })).out, /not on the list/)
  const none = await C.runPhoneSetup({ io: keyboard([]), configFile: file, interfaces: { Public: IFACES.Public } })
  assert.equal(none.code, 1)
  assert.match(none.out, /no private or Tailscale address/)
  assert.equal(fs.readFileSync(file, 'utf8'), BASE)
})

test('what phone-setup and phone-pin write is a block the server accepts', async () => {
  const file = config()
  await C.runPhonePin({ io: keyboard(['4829105736', '4829105736']), configFile: file, auth: makeAuthStore({ file: path.join(dir, `auth-${n++}.json`) }) })
  await C.runPhoneSetup({ io: keyboard(['2', 'yes']), configFile: file, interfaces: IFACES })
  const s = remoteSettings(JSON.parse(fs.readFileSync(file, 'utf8')).remote, { interfaces: IFACES, mainPort: 4317, warn: () => {} })
  assert.equal(s.enabled, true)
  assert.equal(s.url, 'http://192.168.1.36:4318/phone')
})

test('factory.mjs phone-pin and phone-setup refuse a piped keyboard and leave config.json as it was', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const cfg = path.join(root, 'config.json')
  const before = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : null
  for (const cmd of ['phone-pin', 'phone-setup']) {
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'factory.mjs'), cmd], { input: '48291057\n48291057\nyes\n', encoding: 'utf8', env: { ...process.env } })
    assert.equal(r.status, 1, cmd)
    assert.match(r.stderr, /type it yourself in a terminal/, cmd)
  }
  assert.equal(fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : null, before)
})

test('phone-pin marks the new hash for the change watcher, so the PIN change reads as made with phone-pin', async () => {
  const file = config()
  const auth = makeAuthStore({ file: path.join(dir, `auth-${n++}.json`) })
  auth.noteRemote({ wanted: false, bind: '', pinHash: '' })
  await C.runPhonePin({ io: keyboard(['4829105736', '4829105736']), configFile: file, auth })
  const hash = JSON.parse(fs.readFileSync(file, 'utf8')).remote.pinHash
  const said = auth.noteRemote({ wanted: false, bind: '', pinHash: hash })
  assert.deepEqual(said.map(e => e.text), ['The phone PIN was changed with phone-pin.'])
})

test('phone-setup states the honest limits in plain words before the yes', async () => {
  const io = keyboard(['2', 'no'])
  await C.runPhoneSetup({ io, configFile: config(), interfaces: IFACES })
  const said = io.prompts.join('\n')
  assert.match(said, /over home Wi-Fi the PIN and the session can be read by someone who can see the traffic/i)
  assert.match(said, /Tailscale removes that/)
  assert.match(said, /the PIN guards the ability to instruct a coding agent: treat it like a password/i)
})
