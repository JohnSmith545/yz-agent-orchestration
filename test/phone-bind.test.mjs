// Tests for phone-bind.mjs: where the phone listener may listen. It must be ONE private address of this PC
// (10/8, 172.16/12, 192.168/16) or its Tailscale address (100.64/10), on a local interface right now; every
// other class of address is refused with one plain sentence, and the remote block as a whole is OFF unless
// every part of it is right. The interfaces are injected, so no test depends on this machine's network.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const B = await import('../phone-bind.mjs')

/** A machine with a home Wi-Fi address, a work VPN, a Docker bridge, Tailscale, loopback and IPv6. */
const IFACES = {
  'Wi-Fi': [
    { address: '192.168.1.36', family: 'IPv4', internal: false, mac: '34:6f:24:c7:c9:dd', cidr: '192.168.1.36/24' },
    { address: 'fe80::7aaa:283c:498c:e7f4', family: 'IPv6', internal: false },
    { address: '2001:4453:691:c00::1', family: 'IPv6', internal: false },
  ],
  Ethernet: [{ address: '10.20.30.40', family: 'IPv4', internal: false }],
  'vEthernet (WSL)': [{ address: '172.20.0.1', family: 4, internal: false }], // Node 18 says 4, not 'IPv4'
  Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', cidr: '100.101.102.103/32' }, { address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false }],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
  Odd: [{ address: '8.8.4.4', family: 'IPv4', internal: false }, { address: '169.254.1.1', family: 'IPv4', internal: false }],
}

test('each good class of address is accepted when it is on a local interface right now', () => {
  for (const a of ['192.168.1.36', '10.20.30.40', '172.20.0.1', '100.101.102.103']) assert.equal(B.bindProblem(a, IFACES), null, a)
})

test('every address, never one: 0.0.0.0, :: and their spellings are refused', () => {
  for (const a of ['0.0.0.0', '::', '[::]', '0', '*', '::0', '0:0:0:0:0:0:0:0']) {
    assert.match(B.bindProblem(a, IFACES), /never every address|one address/i, a)
  }
})

test('a public, loopback, link-local, multicast or broadcast address is refused even when it is on an interface', () => {
  assert.match(B.bindProblem('8.8.4.4', IFACES), /not a private address/)
  assert.match(B.bindProblem('127.0.0.1', IFACES), /this PC only/)
  assert.match(B.bindProblem('127.5.5.5', IFACES), /this PC only/)
  assert.match(B.bindProblem('169.254.1.1', IFACES), /not a private address/)
  assert.match(B.bindProblem('224.0.0.1', IFACES), /not a private address/)
  assert.match(B.bindProblem('255.255.255.255', IFACES), /not a private address/)
})

test('the edges of each range: just outside is refused, the first and last inside are private', () => {
  for (const a of ['172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '192.167.1.1', '192.169.0.1', '11.0.0.1', '9.255.255.255']) {
    assert.match(B.bindProblem(a, IFACES), /not a private address/, a)
  }
  for (const a of ['10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.0', '192.168.255.255', '100.64.0.0', '100.127.255.255']) {
    assert.ok(B.rangeOf(B.parseIPv4(a)), a)
  }
  assert.equal(B.rangeOf(B.parseIPv4('100.64.0.1')), 'tailscale')
  assert.equal(B.rangeOf(B.parseIPv4('192.168.0.1')), 'private')
})

test('a private address that is NOT on this PC now is refused', () => {
  assert.match(B.bindProblem('192.168.1.99', IFACES), /not an address of this PC/)
  assert.match(B.bindProblem('10.0.0.1', IFACES), /not an address of this PC/)
})

test('IPv6 of any kind is refused, the Tailscale and unique local ones included', () => {
  for (const a of ['fd7a:115c:a1e0::1', 'fe80::7aaa:283c:498c:e7f4', '2001:4453:691:c00::1', '::1', '::ffff:192.168.1.36', '[fd7a:115c:a1e0::1]']) {
    assert.match(B.bindProblem(a, IFACES), /IPv4/, a)
  }
})

test('names, ports, masks, padding and other spellings are refused: only a plain dotted address counts', () => {
  for (const a of ['localhost', 'my-pc', 'my-pc.local', '192.168.1.36:4318', '192.168.1.36/24', ' 192.168.1.36', '192.168.1.36 ', '192.168.001.036',
    '0xc0.0xa8.1.36', '3232235812', '192.168.1', '192.168.1.36.1', '192.168.1.256', '192.168.1.-1', '１９２.168.1.36', '192.168.1.36\n']) {
    const why = B.bindProblem(a, IFACES)
    assert.ok(why, `${JSON.stringify(a)} must be refused`)
  }
  for (const v of [undefined, null, '', 3232235812, ['192.168.1.36'], { a: 1 }, true]) assert.match(B.bindProblem(v, IFACES), /one IP address/, String(v))
})

test('an address on an internal (loopback) interface never counts as on this PC', () => {
  const ifaces = { lo: [{ address: '10.1.1.1', family: 'IPv4', internal: true }] }
  assert.match(B.bindProblem('10.1.1.1', ifaces), /not an address of this PC/)
})

test('eligibleAddresses lists each private and Tailscale address with its network, Tailscale FIRST and marked, nothing else', () => {
  assert.deepEqual(B.eligibleAddresses(IFACES), [
    { address: '100.101.102.103', name: 'Tailscale', tailscale: true, mac: '00:00:00:00:00:00', cidr: '100.101.102.103/32' },
    { address: '192.168.1.36', name: 'Wi-Fi', tailscale: false, mac: '34:6f:24:c7:c9:dd', cidr: '192.168.1.36/24' },
    { address: '10.20.30.40', name: 'Ethernet', tailscale: false, mac: '', cidr: '' },
    { address: '172.20.0.1', name: 'vEthernet (WSL)', tailscale: false, mac: '', cidr: '' },
  ])
  assert.deepEqual(B.eligibleAddresses({}), [])
  assert.deepEqual(B.eligibleAddresses(null), [])
})

// ═══ the remote block ═══

const HASH = 'scrypt$16384$8$1$c2FsdHNhbHQ=$' + Buffer.alloc(32, 7).toString('base64')
const NET = { iface: 'Wi-Fi', mac: '34:6f:24:c7:c9:dd', cidr: '192.168.1.36/24' }
const GOOD = { enabled: true, bind: '192.168.1.36', port: 4318, pinHash: HASH, pinDigits: 10, sessionHours: 12, ...NET }
const settings = (raw, extra = {}) => {
  const warned = []
  const s = B.remoteSettings(raw, { interfaces: IFACES, mainPort: 4317, warn: w => warned.push(w), ...extra })
  return { s, warned }
}

test('no remote block: not set up, off, and not one word of warning', () => {
  const { s, warned } = settings(undefined)
  assert.equal(s.enabled, false)
  assert.equal(s.configured, false)
  assert.deepEqual(warned, [])
})

test('a good block is on, with its address, port and hours', () => {
  const { s, warned } = settings(GOOD)
  assert.equal(s.enabled, true)
  assert.equal(s.off, null)
  assert.equal(s.bind, '192.168.1.36')
  assert.equal(s.port, 4318)
  assert.equal(s.sessionHours, 12)
  assert.equal(s.url, 'http://192.168.1.36:4318/phone')
  assert.deepEqual(warned, [])
})

test('enabled false: off, with one plain line and no listener', () => {
  const { s, warned } = settings({ ...GOOD, enabled: false })
  assert.equal(s.enabled, false)
  assert.equal(warned.length, 1)
  assert.match(warned[0], /Phone access is off/)
})

test('only the value true turns it on', () => {
  for (const v of ['true', 1, 'yes', null]) assert.equal(settings({ ...GOOD, enabled: v }).s.enabled, false, String(v))
})

test('a bad block is OFF with one plain warning, whatever is wrong with it', () => {
  const bad = [
    ['not an object', 'on'],
    ['a list', ['192.168.1.36']],
    ['every address', { ...GOOD, bind: '0.0.0.0' }],
    ['a public address', { ...GOOD, bind: '8.8.4.4' }],
    ['not on this PC', { ...GOOD, bind: '192.168.7.7' }],
    ['the desktop port', { ...GOOD, port: 4317 }],
    ['a low port', { ...GOOD, port: 80 }],
    ['a port as text', { ...GOOD, port: '4318' }],
    ['a port too high', { ...GOOD, port: 70000 }],
    ['no PIN', { ...GOOD, pinHash: '' }],
    ['a broken PIN hash', { ...GOOD, pinHash: 'scrypt$1$1$1$x$y' }],
    ['zero hours', { ...GOOD, sessionHours: 0 }],
    ['too many hours', { ...GOOD, sessionHours: 1000 }],
    ['hours as text', { ...GOOD, sessionHours: '12' }],
  ]
  for (const [why, raw] of bad) {
    const { s, warned } = settings(raw)
    assert.equal(s.enabled, false, why)
    assert.equal(warned.length, 1, `${why}: one warning`)
    assert.match(warned[0], /^config\.json: /, why)
    assert.ok(s.off, why)
  }
})

test('the port and hours fall back to 4318 and 4 when left out', () => {
  const { s } = settings({ enabled: true, bind: '192.168.1.36', pinHash: HASH, pinDigits: 8, ...NET })
  assert.equal(s.port, 4318)
  assert.equal(s.sessionHours, 4)
  assert.equal(s.enabled, true)
})

test('the PIN hash never leaves through the summary for the page', () => {
  const sum = B.remoteSummary(settings(GOOD).s)
  assert.equal(JSON.stringify(sum).includes(HASH), false)
  assert.equal(sum.hasPin, true)
})

// ═══ the example config and the docs ═══

test('config.example.json has the remote block, off, and it reads as off with no listener', async () => {
  const fs = await import('node:fs')
  const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'))
  assert.deepEqual(example.remote, { enabled: false, bind: '', port: 4318, pinHash: '', sessionHours: 4 })
  assert.equal(settings(example.remote).s.enabled, false)
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /`"remote": \{ "enabled": false, "bind": "", "port": 4318, "pinHash": "", "sessionHours": 4 \}`/)
  for (const doc of [readme, fs.readFileSync(new URL('../docs/USER_GUIDE.md', import.meta.url), 'utf8')]) {
    for (const s of [/plain HTTP/, /Never forward the port/i, /PIN is the only lock/, /phone-setup/, /phone-pin/, /Tailscale/, /treat it like a password/, /3 lockouts within 24 hours/, /Phone on/, /network it was set up on/, /after your first message/]) assert.match(doc, s)
  }
})

test('a PIN from before the 8-digit rule (no pinDigits, or fewer than 8) keeps phone access off and says to set a new one', () => {
  for (const pinDigits of [undefined, 6, 7, '10']) {
    const { s, warned } = settings({ ...GOOD, pinDigits })
    assert.equal(s.enabled, false, String(pinDigits))
    assert.match(s.off, /new phone PIN of 8 digits or more/)
    assert.equal(warned.length, 1)
    assert.equal(B.remoteSummary(s).newPinNeeded, true)
  }
  assert.equal(B.remoteSummary(settings(GOOD).s).newPinNeeded, false)
})

// ═══ the network, not only the address (review round) ═══

test('the block must name the network it was set up on: the interface, its MAC and the subnet, all matching now', () => {
  assert.equal(settings(GOOD).s.enabled, true)
  for (const [why, over, re] of [
    ['set up before this rule', { iface: undefined, mac: undefined, cidr: undefined }, /Run node tools\/factory\.mjs phone-setup again/],
    ['another adapter', { mac: 'aa:bb:cc:dd:ee:ff' }, /not on the network phone access was set up on/],
    ['another subnet', { cidr: '192.168.1.36/16' }, /not on the network phone access was set up on/],
    ['another interface name', { iface: 'Ethernet' }, /not on the network phone access was set up on/],
  ]) {
    const { s, warned } = settings({ ...GOOD, ...over })
    assert.equal(s.enabled, false, why)
    assert.match(s.off, re, why)
    assert.equal(warned.length, 1, why)
  }
  assert.equal(settings({ ...GOOD, mac: '34:6F:24:C7:C9:DD' }).s.enabled, true, 'a MAC in capitals is the same MAC')
})

test('the reader re-checks the network on every read, so a running listener sees a change of Wi-Fi', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reader-')), 'config.json')
  fs.writeFileSync(file, JSON.stringify({ remote: GOOD }))
  let ifaces = IFACES
  const read = B.makeRemoteReader(file, { interfaces: () => ifaces, mainPort: 4317, warn: () => {} })
  assert.equal(read().enabled, true)
  ifaces = { ...IFACES, 'Wi-Fi': [{ ...IFACES['Wi-Fi'][0], cidr: '192.168.1.36/16' }] }
  assert.equal(read().enabled, false, 'another network: off with no change to the file')
  ifaces = IFACES
  assert.equal(read().enabled, true, 'back on the network: on again')
})

test('a config.json that does not parse fails CLOSED: phone access is off until it parses again', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reader-')), 'config.json')
  fs.writeFileSync(file, JSON.stringify({ remote: GOOD }))
  const warned = []
  const read = B.makeRemoteReader(file, { interfaces: () => IFACES, mainPort: 4317, warn: w => warned.push(w) })
  assert.equal(read().enabled, true)
  fs.writeFileSync(file, '{ "remote": { "enabled": true,')
  const off = read()
  assert.equal(off.enabled, false)
  assert.match(off.off, /config\.json does not parse/)
  fs.writeFileSync(file, JSON.stringify({ remote: GOOD }) + ' ')
  assert.equal(read().enabled, true, 'parses again: on again')
})
