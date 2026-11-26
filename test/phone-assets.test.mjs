// Tests for the phone page's own files being cacheable (phone-assets.mjs, served by phone-server.mjs). The page loads
// eight scripts, a stylesheet, a font, a manifest and icons: about fifteen requests a load against the listener's
// per-address limit of 120 a minute, and a 429 on a script left a blank page. Now the page links each file with a
// version of its content (?v=<hash>), a versioned file is cached for a year, the page itself is revalidated with its
// ETag, and a 304 is NOT counted against the per-address limit (only against its own, far higher, ceiling). The API
// stays no-store and counted as before. Every answer keeps every other security header.
// A real http server on 127.0.0.1 port 0, as in phone-server.test.mjs; the actions are stubs.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-assets-test-'))
const HERE = path.dirname(fileURLToPath(import.meta.url))
const P = await import('../phone-server.mjs')
const { PHONE_LIMITS } = await import('../phone-limits.mjs')
const { makeAuthStore } = await import('../phone-auth.mjs')
const { hashPin } = await import('../send-pin.mjs')

const PIN = '5038172946'
const HASH = hashPin(PIN, { N: 1024 })
const dir = process.env.FACTORY_DATA_DIR
const clock = { t: Date.parse('2026-11-26T09:00:00Z') }
const ok = async () => ({ status: 200, body: { ok: true } })
const actions = { summary: ok, orchestration: ok, flow: ok, answer: ok, tick: ok, complete: ok, talk: ok, talkSend: ok }
let server
let own
let current
let auth

// a private copy of the phone files, so a test can change one
const pub = path.join(dir, 'public')
fs.mkdirSync(path.join(pub, 'fonts'), { recursive: true })
for (const file of new Set(Object.values(P.ASSETS).map(a => a[0]))) fs.copyFileSync(path.join(HERE, '..', 'public', file), path.join(pub, file))

function handler(limits = PHONE_LIMITS) {
  return P.makePhoneHandler({
    settings: () => ({ enabled: true, bind: '127.0.0.1', port: own.port, pinHash: HASH, sessionHours: 12 }),
    own: () => own, auth, actions, limits, now: () => clock.t, publicDir: pub,
  })
}
before(async () => {
  server = http.createServer((req, res) => current(req, res))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  own = { bind: '127.0.0.1', port: server.address().port }
})
after(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  auth = makeAuthStore({ file: path.join(dir, `auth-${Math.random().toString(36).slice(2)}.json`), now: () => clock.t, log: () => {} })
  current = handler()
})

function request(method, p, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const all = { host: `127.0.0.1:${own.port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin: `http://127.0.0.1:${own.port}` } : {}), ...headers }
    const req = http.request({ host: '127.0.0.1', port: own.port, method, path: p, headers: all }, res => {
      const parts = []
      res.on('data', c => parts.push(c))
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { json = null }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}
async function signIn() {
  const r = await request('POST', '/phone/login', {}, { pin: PIN })
  return (r.headers['set-cookie'] || [])[0]?.split(';')[0] || ''
}
/** Every security header but cache-control, which is what this change sets per answer. */
function secure(r, label) {
  for (const [name, value] of Object.entries(P.SECURITY_HEADERS)) {
    if (name === 'cache-control') continue
    assert.equal(r.headers[name], value, `${label}: ${name}`)
  }
}
const linksOf = text => [...text.matchAll(/(?:src|href)="(\/phone\/[^"]+)"/g)].map(m => m[1])

test('the page links every file with a version of its content, and a versioned file is cached for a year', async () => {
  const page = await request('GET', '/phone')
  assert.equal(page.status, 200)
  const links = linksOf(page.text)
  assert.ok(links.length >= 12, `${links.length} links`)
  for (const link of links) {
    const [p, q] = link.split('?')
    assert.ok(P.ASSETS[p], `${p} is in the fixed map`)
    assert.match(q || '', /^v=[0-9a-f]{16}$/, `${link} carries a version`)
    const r = await request('GET', link)
    assert.equal(r.status, 200, link)
    assert.equal(r.headers['cache-control'], 'private, max-age=31536000, immutable', link)
    assert.equal(r.headers.etag, `"${q.slice(2)}"`, link)
    secure(r, link)
  }
})

test('the stylesheet versions its font, and the manifest its icons', async () => {
  const page = await request('GET', '/phone')
  const css = await request('GET', linksOf(page.text).find(l => l.startsWith('/phone/phone.css')))
  assert.match(css.text, /url\("\/phone\/inter\.woff2\?v=[0-9a-f]{16}"\)/)
  const manifest = await request('GET', linksOf(page.text).find(l => l.startsWith('/phone/manifest.webmanifest')))
  assert.match(manifest.text, /"\/phone\/icon\.svg\?v=[0-9a-f]{16}"/)
  assert.doesNotThrow(() => JSON.parse(manifest.text))
})

test('the page itself, and a file asked for without its version or with an old one, is revalidated: no-cache with an ETag', async () => {
  for (const p of ['/phone', '/phone/', '/phone/phone-app.js', '/phone/phone-app.js?v=0000000000000000', '/phone/icon-180.png']) {
    const r = await request('GET', p)
    assert.equal(r.status, 200, p)
    assert.equal(r.headers['cache-control'], 'no-cache', p)
    assert.match(r.headers.etag, /^"[0-9a-f]{16}"$/, p)
    secure(r, p)
  }
})

test('a matching If-None-Match is a 304 with no body and every security header; a weak or listed one matches too', async () => {
  const first = await request('GET', '/phone')
  for (const inm of [first.headers.etag, `W/${first.headers.etag}`, `"nope", ${first.headers.etag}`]) {
    const r = await request('GET', '/phone', { 'if-none-match': inm })
    assert.equal(r.status, 304, inm)
    assert.equal(r.text, '')
    assert.equal(r.headers.etag, first.headers.etag)
    assert.equal(r.headers['cache-control'], 'no-cache')
    secure(r, `304 ${inm}`)
  }
  for (const inm of ['"0000000000000000"', '*', '']) assert.equal((await request('GET', '/phone', { 'if-none-match': inm })).status, 200, `not a match: ${inm}`)
})

test('a changed file gets a new version, and the page links the new one', async () => {
  const before = await request('GET', '/phone')
  const oldLink = linksOf(before.text).find(l => l.startsWith('/phone/phone-agents.js'))
  const file = path.join(pub, 'phone-agents.js')
  const original = fs.readFileSync(file)
  try {
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n// changed\n')]))
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(file, later, later)
    const after = await request('GET', '/phone')
    const newLink = linksOf(after.text).find(l => l.startsWith('/phone/phone-agents.js'))
    assert.notEqual(newLink, oldLink)
    assert.notEqual(after.headers.etag, before.headers.etag, 'the page changed with it')
    assert.equal((await request('GET', '/phone', { 'if-none-match': before.headers.etag })).status, 200, 'the old page is not reused')
    assert.equal((await request('GET', oldLink)).headers['cache-control'], 'no-cache', 'an old version is never cached for a year')
  } finally {
    fs.writeFileSync(file, original)
  }
})

test('a 304 is not counted against the per-address limit; a full answer still is', async () => {
  current = handler({ ...PHONE_LIMITS, address: { max: 4, ms: 60_000 } })
  const { etag } = (await request('GET', '/phone')).headers // 1 counted
  for (let i = 0; i < 30; i++) assert.equal((await request('GET', '/phone', { 'if-none-match': etag })).status, 304, `304 number ${i + 1}`)
  for (let i = 0; i < 3; i++) assert.equal((await request('GET', '/phone/phone-app.js')).status, 200) // 2, 3, 4
  assert.equal((await request('GET', '/phone/phone-app.js')).status, 429, 'the fifth full answer is over the limit')
  assert.equal((await request('GET', '/phone', { 'if-none-match': etag })).status, 304, 'a revalidation still works')
})

test('revalidations have their own ceiling: past it they count against the address limit as before', async () => {
  current = handler({ ...PHONE_LIMITS, address: { max: 3, ms: 60_000 }, revalidate: { max: 2, ms: 60_000 } })
  const { etag } = (await request('GET', '/phone')).headers // 1 counted
  assert.equal((await request('GET', '/phone', { 'if-none-match': etag })).status, 304)
  assert.equal((await request('GET', '/phone', { 'if-none-match': etag })).status, 304)
  assert.equal((await request('GET', '/phone', { 'if-none-match': etag })).status, 200, 'past its ceiling: a counted full answer') // 2
  assert.equal((await request('GET', '/phone')).status, 200) // 3
  assert.equal((await request('GET', '/phone', { 'if-none-match': etag })).status, 429)
  assert.ok(PHONE_LIMITS.revalidate.max >= 5 * PHONE_LIMITS.address.max, 'the default ceiling is far above the address limit')
})

test('the API stays no-store, carries no ETag, and is counted per address as today', async () => {
  current = handler({ ...PHONE_LIMITS, address: { max: 4, ms: 60_000 } })
  const cookie = await signIn() // 1
  for (let i = 0; i < 3; i++) {
    const r = await request('GET', '/phone/api/summary', { cookie, 'if-none-match': '*' }) // 2, 3, 4
    assert.equal(r.status, 200)
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.equal(r.headers.etag, undefined)
    secure(r, 'api')
  }
  assert.equal((await request('GET', '/phone/api/summary', { cookie })).status, 429)
  for (const p of ['/nope', '/phone/api/summary']) assert.equal((await request('GET', p)).headers['cache-control'], 'no-store', p)
})

/**
 * A browser loading the page `loads` times: the page (revalidated with its ETag), each file it links (from its cache
 * when it holds that exact link and `trustCache`, else asked again, revalidating when it has an ETag), then the
 * three API reads the page makes on start (me, then summary and the Agents tab). Every status it saw, by path.
 */
async function browse(loads, { trustCache }) {
  const cookie = await signIn()
  const cache = new Map() // link -> etag
  const seen = []
  const get = async (link, headers = {}) => {
    const r = await request('GET', link, { ...headers, ...(cache.has(link) ? { 'if-none-match': cache.get(link) } : {}) })
    seen.push([link, r.status])
    if (r.status === 200 && r.headers.etag) cache.set(link, r.headers.etag)
    return r
  }
  let page = ''
  for (let i = 0; i < loads; i++) {
    const r = await get('/phone')
    if (r.status === 200) page = r.text
    for (const link of linksOf(page)) {
      if (trustCache && cache.has(link)) continue // a year-long immutable file: the browser does not ask
      await get(link)
    }
    for (const api of ['/phone/api/me', '/phone/api/summary', '/phone/api/orchestration']) {
      const a = await request('GET', api, { cookie })
      seen.push([api, a.status])
    }
  }
  return seen
}

test('20 page loads in a minute from one address stay under the limit, and no file is ever a 429', async () => {
  const seen = await browse(20, { trustCache: true })
  assert.deepEqual(seen.filter(([, s]) => s === 429), [])
  assert.ok(seen.filter(([p]) => !p.startsWith('/phone/api/')).every(([, s]) => s === 200 || s === 304))
})

test('even a browser that asks again for every file on every load gets no 429 in 20 loads', async () => {
  const seen = await browse(20, { trustCache: false })
  assert.deepEqual(seen.filter(([, s]) => s === 429), [])
  const files = seen.filter(([p]) => !p.startsWith('/phone/api/'))
  assert.ok(files.length > 20 * 12, `${files.length} file requests`)
  assert.ok(files.filter(([, s]) => s === 304).length >= 19 * 12, 'after the first load, files come back as 304')
})
