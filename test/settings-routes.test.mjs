// Tests for the Settings page routes (settings-routes.mjs, through factoryRoute),
// the live `pr` settings reader and the `pr`-block writer of config.json. A temp
// config file stands in for config.json, and a stub stands in for the system
// confirmation window (native-confirm.mjs): no window opens, no real file changes.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'))
const { factoryRoute } = await import('../factory-routes.mjs')
const { makePrReader } = await import('../config.mjs')
const { withPrKeys } = await import('../config-write.mjs')
const { hashPin, verifyPin, sharedLock } = await import('../send-pin.mjs')

const FILE = path.join(process.env.FACTORY_DATA_DIR, 'config.json')
const BASE_TEXT = `{
  "repo": "C:/path/to/your-repo",
  "port": 4317,
  "ticketPrefixes": ["ABC"],
  "pr": {
    "enabled": false,
    "remote": "origin",
    "bases": ["dev"],
    "gh": "gh"
  },
  "reminders": []
}
`
/** The text outside the pr block: what must stay byte for byte. */
const outside = text => { const a = text.indexOf('"pr"'); const b = text.indexOf('}', a); return [text.slice(0, a), text.slice(b + 1)] }

const asked = []
let reply = 'yes'
const confirm = async q => (asked.push(q), reply)
let reader
let server
let base
let port
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await factoryRoute(req, res, url, { port, relay: {}, settings: { configFile: FILE, confirm, prNow: () => reader() } }))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  base = `http://127.0.0.1:${port}`
})
after(() => {
  server.close()
  fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true })
})
beforeEach(() => {
  fs.writeFileSync(FILE, BASE_TEXT)
  reader = makePrReader(FILE, { warn: () => {} })
  asked.length = 0
  reply = 'yes'
  sharedLock.reset()
})

const post = (p, body, origin = base) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
const fileNow = () => fs.readFileSync(FILE, 'utf8')
const prNow = () => JSON.parse(fileNow()).pr
const setPin = pin => { const t = withPrKeys(fileNow(), { pinHash: hashPin(pin, { N: 1024 }) }); fs.writeFileSync(FILE, t); reader.invalidate() }

// ═══ the writer and the live reader ═══

test('withPrKeys changes only the pr block; every byte outside it stays', () => {
  const t = withPrKeys(BASE_TEXT, { enabled: true, bases: ['dev', 'main'], pinHash: 'scrypt$1024$8$1$c2FsdA==$aGFzaA==' })
  assert.deepEqual(JSON.parse(t).pr, { enabled: true, remote: 'origin', bases: ['dev', 'main'], gh: 'gh', pinHash: 'scrypt$1024$8$1$c2FsdA==$aGFzaA==' })
  assert.deepEqual(outside(t), outside(BASE_TEXT))
  const none = '{\n  "repo": "x"\n}\n'
  assert.deepEqual(JSON.parse(withPrKeys(none, { enabled: false })), { repo: 'x', pr: { enabled: false } })
})

test('the live reader sees a change to the pr block without a restart', () => {
  assert.equal(reader().bases[0], 'dev')
  fs.writeFileSync(FILE, withPrKeys(fileNow(), { bases: ['main'] }))
  const t = new Date(Date.now() + 5000)
  fs.utimesSync(FILE, t, t)
  assert.deepEqual(reader().bases, ['main'])
})

// ═══ GET ═══

test('GET /api/settings: the read-only summary and the sending state, never the hash', async () => {
  setPin('246810')
  const r = await fetch(`${base}/api/settings`)
  assert.equal(r.status, 200)
  const text = await r.text()
  const j = JSON.parse(text)
  assert.deepEqual(j.pr, { enabled: false, wanted: false, bases: ['dev'], remote: 'origin', hasPin: true })
  assert.ok(j.setup && typeof j.setup.repo === 'string' && 'configPath' in j.setup && Array.isArray(j.setup.ticketPrefixes))
  assert.doesNotMatch(text, /scrypt|pinHash/)
})

// ═══ who may change it ═══

test('POSTs need the dashboard page Origin: none or another is 403, and nothing is written', async () => {
  for (const origin of [null, 'http://evil.example']) {
    assert.equal((await post('/api/settings/pin', { next: '246810' }, origin)).status, 403)
    assert.equal((await post('/api/settings/send', { enabled: true }, origin)).status, 403)
  }
  assert.equal(fileNow(), BASE_TEXT)
  assert.deepEqual(asked, [])
})

// ═══ the PIN ═══

test('the first PIN needs a Yes in the system window: yes writes only its hash; no, unavailable and busy write nothing', async () => {
  reply = 'no'
  const no = await post('/api/settings/pin', { next: '246810' })
  assert.deepEqual([no.status, await no.json()], [409, { error: 'Declined.' }])
  reply = 'unavailable'
  const un = await post('/api/settings/pin', { next: '246810' })
  assert.deepEqual([un.status, (await un.json()).error], [409, 'Could not open a confirmation window here. Run this in a terminal instead: node tools/factory.mjs pr-pin'])
  reply = 'busy'
  assert.equal((await (await post('/api/settings/pin', { next: '246810' })).json()).error, 'A confirmation is already open.')
  assert.equal(fileNow(), BASE_TEXT)
  reply = 'yes'
  const ok = await post('/api/settings/pin', { next: '246810' })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).pr.hasPin, true)
  assert.equal(verifyPin('246810', prNow().pinHash), true)
  assert.doesNotMatch(fileNow(), /246810/)
  assert.deepEqual(outside(fileNow()), outside(BASE_TEXT))
  assert.deepEqual(asked.at(-1), { title: 'Yz Agent Orchestration', message: 'Set a new send PIN for Yz Agent Orchestration?' })
})

test('changing the PIN with the right current one needs no window; a wrong one counts toward the same lock as sending', async () => {
  setPin('246810')
  const ok = await post('/api/settings/pin', { current: '246810', next: '135799' })
  assert.equal(ok.status, 200)
  assert.equal(verifyPin('135799', prNow().pinHash), true)
  assert.deepEqual(asked, [])
  for (let i = 0; i < 4; i++) {
    const r = await post('/api/settings/pin', { current: '000000', next: '111111' })
    assert.deepEqual([r.status, (await r.json()).error], [403, 'Wrong current PIN.'])
  }
  await post('/api/settings/pin', { current: '000000', next: '111111' })
  assert.ok(sharedLock.get().locked() > 0, 'the lock sending uses')
  assert.equal((await post('/api/settings/pin', { current: '135799', next: '111111' })).status, 429)
  assert.equal(verifyPin('135799', prNow().pinHash), true)
})

test('a forgotten PIN is reset only with a Yes in the system window; a short PIN is refused before any window', async () => {
  setPin('246810')
  assert.equal((await post('/api/settings/pin', { next: '111111' })).status, 400, 'with a PIN set: the current one, or a reset')
  reply = 'no'
  assert.equal((await post('/api/settings/pin', { reset: true, next: '111111' })).status, 409)
  assert.equal(verifyPin('246810', prNow().pinHash), true)
  reply = 'yes'
  assert.equal((await post('/api/settings/pin', { reset: true, next: '111111' })).status, 200)
  assert.equal(verifyPin('111111', prNow().pinHash), true)
  assert.equal(asked.at(-1).message, 'Reset the send PIN for Yz Agent Orchestration? The old PIN stops working.')
  asked.length = 0
  const short = await post('/api/settings/pin', { reset: true, next: '123' })
  assert.deepEqual([short.status, (await short.json()).error], [400, 'A send PIN needs at least 6 characters.'])
  assert.deepEqual(asked, [])
})

// ═══ sending on, off, and its branches ═══

test('turning sending on needs a Yes; turning it off does not', async () => {
  reply = 'no'
  assert.equal((await post('/api/settings/send', { enabled: true })).status, 409)
  assert.equal(prNow().enabled, false)
  reply = 'yes'
  const on = await post('/api/settings/send', { enabled: true })
  assert.equal(on.status, 200)
  assert.equal(prNow().enabled, true)
  assert.equal(asked.at(-1).message, 'Turn on sending pull requests into: dev?')
  asked.length = 0
  assert.equal((await post('/api/settings/send', { enabled: false })).status, 200)
  assert.equal(prNow().enabled, false)
  assert.deepEqual(asked, [])
  assert.deepEqual(outside(fileNow()), outside(BASE_TEXT))
})

test('the branches are validated, need a Yes when they change, and say so plainly when no window can open', async () => {
  for (const bad of [[], ['a..b'], ['-x'], 'dev', [3]]) assert.equal((await post('/api/settings/send', { bases: bad })).status, 400, JSON.stringify(bad))
  assert.deepEqual(asked, [])
  const ok = await post('/api/settings/send', { bases: ['dev', 'release-train'] })
  assert.equal(ok.status, 200)
  assert.deepEqual(prNow().bases, ['dev', 'release-train'])
  assert.equal(asked.at(-1).message, 'Let Yz Agent Orchestration open pull requests into: dev, release-train?')
  assert.deepEqual((await (await fetch(`${base}/api/settings`)).json()).pr.bases, ['dev', 'release-train'], 'live, without a restart')
  reply = 'unavailable'
  const un = await post('/api/settings/send', { bases: ['dev'] })
  assert.equal((await un.json()).error, 'Could not open a confirmation window here. Edit the pr block in config.json instead.')
})
