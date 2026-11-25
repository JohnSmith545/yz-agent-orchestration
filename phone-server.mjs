// The phone listener: a SECOND http server, on the one private address the remote block names (phone-bind.mjs),
// that serves the phone page and nothing else. The desktop dashboard keeps its own listener on 127.0.0.1 and is
// never reachable from here: no desktop route, no evidence file, no config, no other file of public/.
//
// WHAT IT SERVES (every other method and path is a 404, before any session is even looked at):
//   GET  /phone, /phone/          the phone page (public/phone.html)
//   GET  /phone/<asset>           its own assets, from a FIXED map (ASSETS): never a path built from the request
//   POST /phone/login             { pin }: sign in (phone-auth.mjs), sets the session cookie, answers { csrf, expiresAt }
//   POST /phone/logout            sign this phone out
//   GET  /phone/api/me            { csrf, expiresAt }: a reloaded page gets its CSRF token back
//   GET  /phone/api/summary       \
//   GET  /phone/api/talk           |  the allowlist (phone-actions.mjs): each a named action, never a forwarded path
//   POST /phone/api/answer         |
//   POST /phone/api/tick           |
//   POST /phone/api/complete       |
//   POST /phone/api/talk          /
//
// THE CHECKS, in this order, each answered with one plain sentence:
//   1. Phone access is still on, for THIS address and port (the block is re-read when config.json changes), else
//      a 503 to that request and the listener closes (onOff): turning it off shuts the door without a restart.
//   2. The Host is exactly <bind>:<port> (a website that rebinds its name to this address is refused), else 403.
//   3. The address has not passed its rate limit (phone-limits.mjs), else 429.
//   4. The path and method are on the list above, else 404.
//   5. /phone/api/* and logout: a live session cookie (else 401, and the cookie is cleared), then the session's
//      rate limit (429).
//   6. Every POST: an Origin equal to http://<bind>:<port> and, when the browser says, Sec-Fetch-Site same-origin
//      (403); every POST but sign-in: the session's CSRF token in X-Phone-CSRF (403); a JSON content type (415); a
//      body of at most BODY_MAX bytes (413) that is a JSON object (400).
// Every answer, a 404 included, carries no-store, a self-only Content-Security-Policy with no inline script or
// style, nosniff, no referrer and no framing (SECURITY_HEADERS).
//
// ⚠️ Plain HTTP on a private network, on purpose (README, Phone access): no TLS, no tunnel, nothing public. The
// PIN, the cookie and the pages cross the network as they are; Tailscale encrypts that link, and home Wi-Fi with
// WPA2 or better encrypts the air. Never forward this port on a router.
//
//   makePhoneHandler({ settings, own, auth, actions, limits?, now?, publicDir? })   (req, res) => void
//   startPhoneListener({ settings, handler, createServer?, log? })   the server, or null when nothing should listen

import { createServer as httpCreateServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { clearCookie, csrfOk, sessionCookie, tokensFromCookie } from './phone-auth.mjs'
import { makeLimiter, PHONE_LIMITS } from './phone-limits.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, 'public')
export const BODY_MAX = 8 * 1024
export const CSRF_HEADER = 'x-phone-csrf'

export const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
})

/** The phone page's files: request path -> [file under public/, content type]. Nothing else of public/ is served. */
export const ASSETS = Object.freeze({
  '/phone': ['phone.html', 'text/html; charset=utf-8'],
  '/phone/': ['phone.html', 'text/html; charset=utf-8'],
  '/phone/phone.css': ['phone.css', 'text/css; charset=utf-8'],
  '/phone/phone-state.js': ['phone-state.js', 'text/javascript; charset=utf-8'],
  '/phone/phone-view.js': ['phone-view.js', 'text/javascript; charset=utf-8'],
  '/phone/phone-app.js': ['phone-app.js', 'text/javascript; charset=utf-8'],
  '/phone/manifest.webmanifest': ['phone-manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/phone/icon.svg': ['phone-icon.svg', 'image/svg+xml'],
  '/phone/icon-180.png': ['phone-icon-180.png', 'image/png'],
  '/phone/inter.woff2': ['fonts/inter-latin-wght-normal.woff2', 'font/woff2'],
})

/** The API: 'METHOD path' -> the action's name in phone-actions.mjs. */
const API = Object.freeze({
  'GET /phone/api/summary': 'summary',
  'GET /phone/api/talk': 'talk',
  'POST /phone/api/answer': 'answer',
  'POST /phone/api/tick': 'tick',
  'POST /phone/api/complete': 'complete',
  'POST /phone/api/talk': 'talkSend',
})

const OFF = 'Phone access is off.'

function send(res, status, body, extra = {}) {
  const isText = typeof body === 'string'
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...extra })
  res.end(isText ? body : JSON.stringify(body))
}

/** The request body as a JSON object; throws { status, message } in plain words. */
async function jsonBody(req) {
  let size = 0
  const parts = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_MAX) throw Object.assign(new Error('That is too much to send at once.'), { status: 413 })
    parts.push(chunk)
  }
  let value
  try {
    value = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('That request could not be read.'), { status: 400 })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('That request could not be read.'), { status: 400 })
  return value
}

export function makePhoneHandler({ settings, own, auth, actions, limits = PHONE_LIMITS, now = Date.now, publicDir = PUBLIC, onOff = () => {}, onEscalate = () => {} }) {
  let closing = false
  const byAddress = makeLimiter({ ...limits.address, now })
  const bySession = makeLimiter({ ...limits.session, now })
  const byLogin = makeLimiter({ ...limits.login, now })
  const tooMany = (res, r, what = 'Too many requests') => send(res, 429, { error: `${what}. Wait ${r.retryAfter} seconds.` }, { 'retry-after': String(r.retryAfter) })

  /** A POST from the phone page itself: its own Origin, and not a cross-site fetch. */
  function sameSite(req, ownOrigin) {
    if (req.headers.origin !== ownOrigin) return false
    const site = req.headers['sec-fetch-site']
    return site === undefined || site === 'same-origin'
  }
  const isJson = req => /^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] || ''))

  async function login(req, res, s, ownOrigin, address) {
    if (!sameSite(req, ownOrigin)) return send(res, 403, { error: 'Sign in from the phone page itself.' })
    if (!isJson(req)) return send(res, 415, { error: 'That request could not be read.' })
    const limited = byLogin.hit(address)
    if (!limited.ok) return tooMany(res, limited, 'Too many tries from this device')
    const b = await jsonBody(req)
    const r = auth.login({ pin: b.pin, pinHash: s.pinHash, address, sessionHours: s.sessionHours })
    if (r.escalated) onEscalate() // too many lockouts in a day: phone access goes OFF (phone-wiring.mjs)
    if (!r.ok) return send(res, r.status, { error: r.error })
    return send(res, 200, { ok: true, csrf: r.csrf, expiresAt: r.expiresAt }, { 'set-cookie': sessionCookie(r.token, s.sessionHours) })
  }

  return async function phoneHandler(req, res) {
    try {
      const s = settings()
      const me = own()
      if (!s?.enabled || s.bind !== me.bind || s.port !== me.port) {
        // off, or the block now names another address: say so to this request, then stop listening altogether
        if (!closing) { closing = true; onOff() }
        return send(res, 503, OFF, { connection: 'close' })
      }
      const ownHost = `${me.bind}:${me.port}`
      if (req.headers.host !== ownHost) return send(res, 403, 'Unknown host.')
      const address = String(req.socket?.remoteAddress || '')
      const limited = byAddress.hit(address)
      if (!limited.ok) return tooMany(res, limited)

      const pathname = String(req.url || '').split('?')[0]
      const route = `${req.method} ${pathname}`
      const asset = req.method === 'GET' ? ASSETS[pathname] : undefined
      if (asset) {
        const data = await readFile(path.join(publicDir, asset[0]))
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset[1] })
        return res.end(data)
      }
      const ownOrigin = `http://${ownHost}`
      if (route === 'POST /phone/login') return await login(req, res, s, ownOrigin, address)
      const action = API[route]
      const isLogout = route === 'POST /phone/logout'
      if (!action && !isLogout && route !== 'GET /phone/api/me') return send(res, 404, 'Not found.')

      // the first cookie value that is a live session, so one tossed in by another service never hides the real one
      let token = ''
      let session = null
      for (const t of tokensFromCookie(req.headers.cookie)) {
        session = auth.session(t, s.sessionHours)
        if (session) { token = t; break }
      }
      if (!session) return send(res, 401, { error: 'Your phone session has ended. Sign in again.', signedOut: true }, { 'set-cookie': clearCookie() })
      const sessionLimit = bySession.hit(session.id)
      if (!sessionLimit.ok) return tooMany(res, sessionLimit)

      if (req.method === 'POST') {
        if (!sameSite(req, ownOrigin)) return send(res, 403, { error: 'This only works from the phone page itself.' })
        if (!csrfOk(token, req.headers[CSRF_HEADER])) return send(res, 403, { error: 'The page is out of date. Reload it and try again.' })
        if (!isJson(req)) return send(res, 415, { error: 'That request could not be read.' })
      }
      if (route === 'GET /phone/api/me') return send(res, 200, { ok: true, csrf: session.csrf, expiresAt: session.expiresAt })
      if (isLogout) {
        await jsonBody(req)
        auth.logout(token)
        return send(res, 200, { ok: true }, { 'set-cookie': clearCookie() })
      }
      const body = req.method === 'POST' ? await jsonBody(req) : {}
      const r = await actions[action](body)
      return send(res, r.status, r.body)
    } catch (err) {
      if (err?.status) return send(res, err.status, { error: err.message })
      // the phone gave up mid-request (the screen locked, the network went): nothing to answer and nothing to log
      if (err?.code === 'ECONNRESET' || err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || err?.message === 'aborted' || req.destroyed) return void res.destroy()
      console.error(`phone: ${err?.stack || err}`)
      return send(res, 500, { error: 'Something went wrong on the PC.' })
    }
  }
}

/**
 * Open the phone listener when, and only when, the remote block is on (phone-bind.mjs remoteSettings). Off or not
 * set up: no server is even created, and null comes back. `createServer` is injected for the tests.
 */
export function startPhoneListener({ settings, handler, createServer = httpCreateServer, log = m => console.log(m) }) {
  if (!settings?.enabled) return null
  const server = createServer(handler)
  // a slow client cannot hold a connection open: whole request in 20 s, headers in 10 s
  server.requestTimeout = 20_000
  server.headersTimeout = 10_000
  server.on?.('error', err => log(`phone: could not listen on ${settings.bind}:${settings.port} (${err?.code || err?.message || err}). Phone access is off until the dashboard restarts.`))
  server.listen(settings.port, settings.bind, () => log(`Phone access on ${settings.url} (your private network only; see Settings, Phone)`))
  return server
}
