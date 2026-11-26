// Tests for phone-desktop-routes.mjs, the desktop side of phone access (Settings, the Phone card): what it shows
// (on or off, the address, when the PIN was set, never the PIN or its hash, the recent sign-ins and lockouts), Sign
// out everywhere, and Turn off; both writes need the dashboard page's own Origin. And the Log gets each lockout.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-desktop-test-'))
const { makePhoneDesktopRoute } = await import('../phone-desktop-routes.mjs')
const { makeAuthStore } = await import('../phone-auth.mjs')
const { hashPin } = await import('../send-pin.mjs')
const { logGet } = await import('../score-routes.mjs')

const dir = process.env.FACTORY_DATA_DIR
const PIN = '7305182946'
const HASH = hashPin(PIN, { N: 1024 })
const PORT = 4999
let auth
let settings
let configFile
let server
let base
let route

before(async () => {
  server = createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, 'http://localhost')))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  auth = makeAuthStore({ file: path.join(dir, `auth-${Math.random().toString(36).slice(2)}.json`), log: () => {} })
  configFile = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(configFile, JSON.stringify({ repo: 'C:/r', remote: { enabled: true, bind: '192.168.1.36', port: 4318, pinHash: HASH, pinSetAt: '2026-11-25T08:00:00.000Z', sessionHours: 12 } }, null, 2))
  settings = { configured: true, enabled: true, off: null, bind: '192.168.1.36', port: 4318, url: 'http://192.168.1.36:4318/phone', pinHash: HASH, pinSetAt: '2026-11-25T08:00:00.000Z', sessionHours: 12 }
  route = makePhoneDesktopRoute({ port: PORT, settings: Object.assign(() => settings, { invalidate() {} }), auth, configFile })
})

const OWN = { origin: `http://127.0.0.1:${PORT}` }
const post = (p, headers = OWN) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })

test('GET /api/phone: on, the address, when the PIN was set, who signed in; never the PIN or its hash', async () => {
  const s = auth.login({ pin: PIN, pinHash: HASH, address: '100.64.1.2', sessionHours: 12 })
  auth.login({ pin: '000000', pinHash: HASH, address: '192.168.1.77', sessionHours: 12 })
  const r = await fetch(`${base}/api/phone`)
  assert.equal(r.status, 200)
  const raw = await r.text()
  assert.equal(raw.includes(HASH), false)
  assert.equal(raw.includes(PIN), false)
  assert.equal(raw.includes(s.token), false)
  const j = JSON.parse(raw)
  assert.equal(j.remote.enabled, true)
  assert.equal(j.remote.url, 'http://192.168.1.36:4318/phone')
  assert.equal(j.remote.hasPin, true)
  assert.equal(j.remote.pinSetAt, '2026-11-25T08:00:00.000Z')
  assert.equal(j.signedIn, 1)
  assert.equal(j.lockedFor, 0)
  assert.deepEqual(j.events.map(e => [e.kind, e.address]), [['wrong', '192.168.1.77'], ['login', '100.64.1.2']])
})

test('Sign out everywhere ends every phone session, and only from the dashboard page itself', async () => {
  const s = auth.login({ pin: PIN, pinHash: HASH, address: 'x', sessionHours: 12 })
  for (const headers of [{}, { origin: 'http://evil.example' }, { origin: 'http://192.168.1.36:4318' }]) {
    assert.equal((await post('/api/phone/signout-all', headers)).status, 403)
  }
  assert.ok(auth.session(s.token, 12))
  const r = await post('/api/phone/signout-all')
  assert.equal(r.status, 200)
  assert.equal((await r.json()).count, 1)
  assert.equal(auth.session(s.token, 12), null)
})

test('Turn off writes remote.enabled false and nothing else, only from the dashboard page; it never turns it on', async () => {
  const before = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.equal((await post('/api/phone/off', {})).status, 403)
  assert.equal((await post('/api/phone/off', { origin: 'http://192.168.1.36:4318' })).status, 403)
  const r = await post('/api/phone/off')
  assert.equal(r.status, 200)
  const after = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.equal(after.remote.enabled, false)
  assert.deepEqual({ ...after, remote: { ...after.remote, enabled: true } }, before)
  assert.equal((await post('/api/phone/on')).status, 404, 'there is no way to turn it on from a page')
})

test('Turn off with no remote block writes nothing', async () => {
  fs.writeFileSync(configFile, '{ "repo": "C:/r" }\n')
  const r = await post('/api/phone/off')
  assert.equal(r.status, 200)
  assert.equal(fs.readFileSync(configFile, 'utf8'), '{ "repo": "C:/r" }\n')
})

test('only GET /api/phone and the two POSTs are answered here', async () => {
  assert.equal((await fetch(`${base}/api/phone/x`)).status, 404)
  assert.equal((await fetch(`${base}/api/phone/signout-all`)).status, 404)
  assert.equal((await post('/api/phone')).status, 404)
})

test('each lockout is one line in the Log (score-routes.mjs logGet, by default), with no flow', () => {
  const store = makeAuthStore({ log: () => {} }) // the real file name, inside FACTORY_DATA_DIR
  for (let i = 0; i < 5; i++) store.login({ pin: '000000', pinHash: HASH, address: '192.168.1.99', sessionHours: 12 })
  const { body } = logGet({})
  const line = body.events.find(e => e.kind === 'phone')
  assert.ok(line)
  assert.equal(line.flow, null)
  assert.match(line.text, /locked for 15 minutes after 5 wrong PINs \(the last from 192\.168\.1\.99\)/)
})
