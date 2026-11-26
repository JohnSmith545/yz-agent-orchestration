// Tests for phone-config.mjs: the two writes to config.json's remote block. withRemote sets keys in place or adds a
// whole block (off); turnPhoneOff writes remote.enabled false and nothing else, and never turns anything on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-config-test-'))
const { turnPhoneOff, withRemote } = await import('../phone-config.mjs')
const dir = process.env.FACTORY_DATA_DIR
const put = text => { const f = path.join(dir, `c-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, text); return f }

test('withRemote adds a whole block, off, when there is none; changes only the given keys when there is one', () => {
  const added = JSON.parse(withRemote('{ "repo": "x" }\n', { pinHash: 'h' }))
  assert.equal(added.remote.enabled, false)
  assert.equal(added.remote.pinHash, 'h')
  const text = '{\n  "repo": "x",\n  "remote": { "enabled": true, "bind": "10.0.0.2", "port": 4320 }\n}\n'
  const changed = withRemote(text, { bind: '10.0.0.3' })
  assert.equal(changed, text.replace('10.0.0.2', '10.0.0.3'))
})

test('turnPhoneOff writes enabled false only, and leaves a missing or already-off block alone', () => {
  const on = put('{\n  "repo": "x",\n  "remote": { "enabled": true, "bind": "10.0.0.2", "port": 4320 }\n}\n')
  assert.deepEqual(turnPhoneOff(on), { ok: true, changed: true })
  assert.equal(fs.readFileSync(on, 'utf8'), '{\n  "repo": "x",\n  "remote": { "enabled": false, "bind": "10.0.0.2", "port": 4320 }\n}\n')
  assert.deepEqual(turnPhoneOff(on), { ok: true, changed: false })
  const none = put('{ "repo": "x" }\n')
  assert.deepEqual(turnPhoneOff(none), { ok: true, changed: false })
  assert.equal(fs.readFileSync(none, 'utf8'), '{ "repo": "x" }\n')
  assert.equal(turnPhoneOff(put('{ broken')).ok, false)
})
