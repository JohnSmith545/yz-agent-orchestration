// The desktop side of phone access: the Phone card on the Settings page (public/phone-card.js). These routes are on
// the desktop's own 127.0.0.1 listener only (server.mjs mounts them); the phone listener never answers /api/*.
//
//   GET  /api/phone              { remote, signedIn, lockedFor, events }: on or off and why, the address to open,
//                                whether a PIN is set and when (never the PIN, never its hash), how many phones are
//                                signed in, the time left on a sign-in lock, and the newest sign-ins, wrong PINs,
//                                lockouts and sign-outs
//   POST /api/phone/signout-all  { ok, count }: Sign out everywhere (phone-auth.mjs signOutEverywhere)
//   POST /api/phone/off          { ok, changed }: remote.enabled false in config.json, every other byte as it was
//                                (config-write.mjs); the phone listener answers "off" from the next request
//                                (phone-server.mjs re-reads the block). A config with no remote block is left alone.
//
// Both POSTs need the dashboard page's Origin PRESENT and its own (local-origin.mjs), like Completed and the by-hand
// tick: curl or a page on another site is refused. There is deliberately NO route that turns phone access ON or sets
// its PIN: opening a network door is done in a terminal (tools/phone-cli.mjs), where a page driver cannot reach.
//
//   makePhoneDesktopRoute({ port, settings, auth, configFile })   async (req, res, url) -> true when it answered

import { readFileSync } from 'node:fs'

import { CONFIG_FILE } from './config.mjs'
import { writeConfigKeys } from './config-write.mjs'
import { originAllowed } from './local-origin.mjs'
import { makeAuthStore } from './phone-auth.mjs'
import { remoteSummary } from './phone-bind.mjs'
import { remoteNow } from './phone-wiring.mjs'

const EVENTS_SHOWN = 12

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function makePhoneDesktopRoute({ port, settings = remoteNow, auth = makeAuthStore(), configFile = CONFIG_FILE } = {}) {
  const pageOnly = req => !!req.headers.origin && originAllowed(req.headers.origin, port)

  function summary() {
    const s = settings()
    const sessions = auth.read().sessions.filter(x => Date.now() < Math.min(Date.parse(x.expiresAt), Date.parse(x.createdAt) + s.sessionHours * 3600_000))
    return {
      remote: remoteSummary(s),
      signedIn: sessions.length,
      lockedFor: auth.lockedFor(),
      events: auth.events().slice(0, EVENTS_SHOWN).map(e => ({ at: e.at, kind: e.kind, address: e.address, ...(e.count !== undefined ? { count: e.count } : {}) })),
    }
  }

  function turnOff() {
    let raw
    try {
      raw = JSON.parse(readFileSync(configFile, 'utf8')).remote
    } catch {
      return { ok: false, error: 'config.json could not be read.' }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.enabled === false) return { ok: true, changed: false }
    writeConfigKeys(configFile, { 'remote.enabled': false })
    settings.invalidate?.()
    return { ok: true, changed: true }
  }

  return async function phoneDesktopRoute(req, res, url) {
    const p = url.pathname
    if (p !== '/api/phone' && !p.startsWith('/api/phone/')) return false
    if (p === '/api/phone' && req.method === 'GET') return json(res, 200, summary()), true
    if (req.method === 'POST' && (p === '/api/phone/signout-all' || p === '/api/phone/off')) {
      if (!pageOnly(req)) return json(res, 403, { error: 'Only from the dashboard page itself.' }), true
      if (p === '/api/phone/signout-all') return json(res, 200, { ok: true, count: auth.signOutEverywhere() }), true
      const r = turnOff()
      return json(res, r.ok ? 200 : 500, r), true
    }
    return json(res, 404, { error: 'not found' }), true
  }
}
