// Tests for phone-door.mjs: the phone listener open exactly while the live remote block says on, for its address
// and port. The watcher's tick closes it on any change (off, another address, another network) and opens it again
// when the block is good again. And, on REAL sockets, startPhone opens nothing at all with no remote block, and
// exactly one listener with an enabled one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-door-test-'))
const { makeDoor } = await import('../phone-door.mjs')
const { startPhone } = await import('../phone-wiring.mjs')

const ON = { enabled: true, bind: '192.168.1.36', port: 4318, url: 'http://192.168.1.36:4318/phone' }

function rig(start) {
  let s = start
  const events = []
  const door = makeDoor({
    settings: () => s,
    open: x => { events.push(`open ${x.bind}:${x.port}`); return { close: () => events.push(`close ${x.bind}:${x.port}`) } },
    log: () => {},
  })
  return { door, events, set: v => { s = v } }
}

test('on: one tick opens it once; more ticks change nothing', () => {
  const { door, events } = rig(ON)
  door.tick(); door.tick(); door.tick()
  assert.deepEqual(events, ['open 192.168.1.36:4318'])
  assert.deepEqual(door.address(), { bind: '192.168.1.36', port: 4318 })
})

test('off, then on again (the network came back): it closes, then opens again', () => {
  const { door, events, set } = rig(ON)
  door.tick()
  set({ ...ON, enabled: false, off: 'This PC is not on the network phone access was set up on' })
  door.tick()
  assert.equal(door.address(), null)
  door.tick()
  set(ON)
  door.tick()
  assert.deepEqual(events, ['open 192.168.1.36:4318', 'close 192.168.1.36:4318', 'open 192.168.1.36:4318'])
})

test('another address or port: the old listener closes before the new one opens', () => {
  const { door, events, set } = rig(ON)
  door.tick()
  set({ ...ON, bind: '100.101.102.103' })
  door.tick()
  assert.deepEqual(events, ['open 192.168.1.36:4318', 'close 192.168.1.36:4318', 'open 100.101.102.103:4318'])
})

test('a listener that fails to open is tried again on the next tick, never twice at once', () => {
  let tries = 0
  const door = makeDoor({ settings: () => ON, open: () => { tries++; throw new Error('EADDRNOTAVAIL') }, log: () => {} })
  door.tick()
  door.tick()
  assert.equal(tries, 2)
  assert.equal(door.address(), null)
})

const listening = () => process.getActiveResourcesInfo().filter(r => r === 'TCPServerWrap').length
const deps = { getStatus: async () => ({ agents: [] }), relay: { queue() {} }, run: async () => ({ ok: false }), sessions: async () => [], transcriptFile: async () => null }

test('REAL sockets: with no remote block startPhone opens nothing (only the change watcher looks at config.json)', () => {
  const before = listening()
  const r = startPhone(deps, { reader: Object.assign(() => ({ configured: false, enabled: false, wanted: false, bind: '', pinHash: '' }), { invalidate() {} }) })
  assert.equal(r, null)
  assert.equal(listening(), before)
})

test('REAL sockets: an enabled block opens exactly one listener, and stop closes it', async () => {
  const before = listening()
  const s = { enabled: true, configured: true, bind: '127.0.0.1', port: 0, url: 'test', sessionHours: 4, pinHash: '' }
  const phone = startPhone(deps, { reader: Object.assign(() => s, { invalidate() {} }) })
  await new Promise(r => setTimeout(r, 50))
  assert.equal(listening(), before + 1)
  phone.stop()
  await new Promise(r => setTimeout(r, 50))
  assert.equal(listening(), before)
})
