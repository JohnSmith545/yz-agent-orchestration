// Where the phone listener may listen (the `remote` block of config.json), checked before anything opens.
//
// The desktop dashboard listens on 127.0.0.1 only and stays that way. Phone access is a SECOND listener that a
// phone on the same home network, or on the same Tailscale network, can reach. That opens a door, so the
// address it listens on is held to the narrowest thing that still works:
//
//   - ONE specific address, never every address: 0.0.0.0 and :: (in any spelling) are refused, so a new
//     network the PC joins (a café, a hotel, a work VPN) never gets the door too.
//   - A PRIVATE IPv4 address: 10/8, 172.16/12, 192.168/16, or Tailscale's 100.64/10. A public address, loopback
//     (127/8: the phone could not reach it anyway), link-local (169.254/16), multicast and broadcast are
//     refused. IPv6 is refused outright: it is not needed, and an IPv6 address is far more often reachable
//     from the internet than a private IPv4 one.
//   - An address that is on a local, non-internal interface RIGHT NOW (os.networkInterfaces, injected so the
//     tests never depend on this machine). A typo or an old address from another network is refused.
//   - Only the plain dotted spelling (192.168.1.36): no name, no port, no mask, no leading zeros (which some
//     parsers read as octal), no hex, no single number, no whitespace.
//
// With no `remote` block nothing is said and nothing listens. With a block that is off or wrong in any way,
// the listener never starts and ONE plain warning says why (`warn`); a typo must never open the door, and it
// must not stop the desktop dashboard either.
//
//   parseIPv4(s)                       [a, b, c, d] for a canonical dotted address, else null
//   rangeOf(octets)                    'private' | 'tailscale' | null
//   bindProblem(addr, interfaces)      null when `addr` may be listened on, else one plain sentence
//   eligibleAddresses(interfaces)      [{ address, name, tailscale }]: what phone-setup offers
//   remoteSettings(raw, { interfaces, mainPort, warn })   the block, checked: { configured, enabled, off, ... }
//   remoteSummary(settings)            the same for a page: never the PIN hash, only `hasPin`
//   makeRemoteReader(file, opts)       the block as config.json says NOW (re-read when the file changes)

import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'

import { PIN_MIN } from './phone-auth.mjs'
import { validPinHash } from './send-pin.mjs'

export const REMOTE_DEFAULTS = Object.freeze({ enabled: false, bind: '', port: 4318, pinHash: '', pinSetAt: null, sessionHours: 4 })
/** A session lasts 1 hour to 7 days: a phone left signed in for longer should ask for the PIN again. */
export const SESSION_HOURS = Object.freeze({ min: 1, max: 168 })

const OCTET = /^(0|[1-9]\d{0,2})$/

export function parseIPv4(s) {
  if (typeof s !== 'string') return null
  const parts = s.split('.')
  if (parts.length !== 4 || !parts.every(p => OCTET.test(p))) return null
  const n = parts.map(Number)
  return n.every(x => x <= 255) ? n : null
}

export function rangeOf(o) {
  if (!Array.isArray(o)) return null
  const [a, b] = o
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale' // the shared address space Tailscale hands out (RFC 6598)
  return null
}

const ipv4Of = entry => entry && (entry.family === 'IPv4' || entry.family === 4)

/** Every non-internal IPv4 address on this PC now, with its interface name. */
function localAddresses(interfaces) {
  const out = []
  for (const [name, list] of Object.entries(interfaces && typeof interfaces === 'object' ? interfaces : {})) {
    for (const e of Array.isArray(list) ? list : []) if (ipv4Of(e) && !e.internal && typeof e.address === 'string') out.push({ address: e.address, name })
  }
  return out
}

const EVERY = new Set(['0.0.0.0', '0', '*', '::', '[::]', '::0', '0:0:0:0:0:0:0:0'])

export function bindProblem(addr, interfaces = os.networkInterfaces()) {
  if (typeof addr !== 'string' || !addr) return 'remote.bind needs one IP address of this PC, such as 192.168.1.20.'
  if (EVERY.has(addr.trim())) return 'remote.bind must be one address, never every address (0.0.0.0 or ::).'
  if (addr.includes(':') && !/^\d+\.\d+\.\d+\.\d+:\d+$/.test(addr)) return 'remote.bind must be an IPv4 address such as 192.168.1.20: IPv6 is not used.'
  const o = parseIPv4(addr)
  if (!o) return `remote.bind must be a plain IP address such as 192.168.1.20 (no name, port, mask or spaces).`
  if (o[0] === 127) return 'remote.bind 127.x is this PC only: the phone could not reach it, and the desktop page already listens there.'
  if (!rangeOf(o)) return `remote.bind ${addr} is not a private address: only 10.x, 172.16-31.x, 192.168.x and Tailscale 100.64-127.x are allowed.`
  if (!localAddresses(interfaces).some(l => l.address === addr)) return `remote.bind ${addr} is not an address of this PC right now. Run node tools/factory.mjs phone-setup to pick one.`
  return null
}

export function eligibleAddresses(interfaces = os.networkInterfaces()) {
  return localAddresses(interfaces)
    .map(l => ({ ...l, range: rangeOf(parseIPv4(l.address)) }))
    .filter(l => l.range)
    .map(({ address, name, range }) => ({ address, name, tailscale: range === 'tailscale' || /tailscale/i.test(name) }))
}

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isPort = p => Number.isInteger(p) && p >= 1024 && p <= 65535

export function remoteSettings(raw, { interfaces = os.networkInterfaces(), mainPort = 4317, warn = console.warn } = {}) {
  const base = { ...REMOTE_DEFAULTS, configured: raw !== undefined, enabled: false, url: '', off: 'Phone access is not set up.' }
  if (raw === undefined) return base
  const off = why => {
    warn(`config.json: ${why} Phone access stays off.`)
    return { ...base, off: why }
  }
  if (!isObject(raw)) return off('"remote" should be an object such as { "enabled": true, "bind": "192.168.1.20" }.')
  const s = { ...REMOTE_DEFAULTS, ...raw }
  const pinHash = validPinHash(s.pinHash) ? s.pinHash : ''
  const shown = {
    ...base,
    bind: typeof s.bind === 'string' ? s.bind : '',
    port: isPort(s.port) ? s.port : REMOTE_DEFAULTS.port,
    pinHash,
    pinSetAt: typeof s.pinSetAt === 'string' && !Number.isNaN(Date.parse(s.pinSetAt)) ? s.pinSetAt : null,
    // phone-pin records how many digits the PIN has; a hash without it predates the 8-digit rule and cannot be told apart
    newPinNeeded: !!pinHash && !(Number.isInteger(s.pinDigits) && s.pinDigits >= PIN_MIN),
    sessionHours: Number.isInteger(s.sessionHours) && s.sessionHours >= SESSION_HOURS.min && s.sessionHours <= SESSION_HOURS.max ? s.sessionHours : REMOTE_DEFAULTS.sessionHours,
  }
  const why = s.enabled !== true ? 'Phone access is off (remote.enabled is not true).'
    : bindProblem(s.bind, interfaces)
    ?? (!isPort(s.port) ? 'remote.port needs a whole number from 1024 to 65535.'
      : s.port === mainPort ? `remote.port must differ from the desktop port ${mainPort}.`
      : !pinHash ? 'Phone access needs a PIN: run node tools/factory.mjs phone-pin in a terminal.'
      : !(Number.isInteger(s.pinDigits) && s.pinDigits >= PIN_MIN) ? `Set a new phone PIN of ${PIN_MIN} digits or more: run node tools/factory.mjs phone-pin in a terminal.`
      : !(Number.isInteger(s.sessionHours) && s.sessionHours >= SESSION_HOURS.min && s.sessionHours <= SESSION_HOURS.max) ? `remote.sessionHours needs a whole number from ${SESSION_HOURS.min} to ${SESSION_HOURS.max}.`
      : null)
  if (why) {
    warn(`config.json: ${why}${why.startsWith('Phone access is off') ? '' : ' Phone access stays off.'}`)
    return { ...shown, off: why }
  }
  return { ...shown, enabled: true, off: null, url: `http://${shown.bind}:${shown.port}/phone` }
}

/** What the desktop Settings page may see: everything but the hash. */
export function remoteSummary(s) {
  return { configured: !!s.configured, enabled: !!s.enabled, off: s.off || null, bind: s.bind || '', port: s.port, url: s.url || '', hasPin: !!s.pinHash, newPinNeeded: !!s.newPinNeeded, pinSetAt: s.pinSetAt || null, sessionHours: s.sessionHours }
}

/**
 * The remote block as config.json says NOW: re-read whenever the file's time or size changes, so a new PIN
 * (phone-pin) takes effect without a restart and turning it off shuts the door at once. Warnings are said once
 * per change of the file, not on every request. A file that does not parse keeps the last good settings.
 */
export function makeRemoteReader(file, { interfaces = () => os.networkInterfaces(), mainPort = 4317, warn = console.warn } = {}) {
  let key = null
  let value = null
  const read = () => {
    let st
    try { st = statSync(file) } catch { return value ?? remoteSettings(undefined) }
    const k = `${st.mtimeMs}:${st.size}`
    if (k !== key || !value) {
      try {
        value = remoteSettings(JSON.parse(readFileSync(file, 'utf8')).remote, { interfaces: interfaces(), mainPort, warn })
        key = k
      } catch {
        value ??= remoteSettings(undefined)
      }
    }
    return value
  }
  return Object.assign(read, { invalidate() { key = null } })
}
