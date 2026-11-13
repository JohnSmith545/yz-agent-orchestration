// Tests for send-pin.mjs, the secret only the person knows that every Send needs:
// the scrypt hash and its check, the lock after five wrong tries, the edit that
// puts the hash into config.json, and `factory.mjs pr-pin`, which only takes a
// PIN typed at a terminal: a PIN piped in (what an agent could do) is refused.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const P = await import('../send-pin.mjs')

test('a PIN hash is scrypt$N$r$p$salt$hash; the right PIN checks, a wrong one does not, two hashes of one PIN differ', () => {
  const h = P.hashPin('correct horse', { N: 1024 })
  assert.match(h, /^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]{20,}\$[A-Za-z0-9+/=]{40,}$/)
  assert.equal(P.verifyPin('correct horse', h), true)
  assert.equal(P.verifyPin('correct hors', h), false)
  assert.equal(P.verifyPin('', h), false)
  assert.equal(P.verifyPin(123456, h), false)
  assert.notEqual(P.hashPin('correct horse', { N: 1024 }), h, 'a fresh salt each time')
  assert.equal(P.validPinHash(h), true)
  for (const bad of ['', 'scrypt$1024$8$1$abc', 'bcrypt$1$2$3$4$5', 'scrypt$3$8$1$c2FsdHNhbHRzYWx0$aGFzaA==', null]) assert.equal(P.validPinHash(bad), false, String(bad))
  assert.equal(P.verifyPin('correct horse', 'nonsense'), false)
})

test('a PIN is at least 6 characters on one line', () => {
  assert.equal(P.pinProblem('12345'), 'A send PIN needs at least 6 characters.')
  assert.equal(P.pinProblem('123456'), null)
  assert.equal(P.pinProblem('12345\n6'), 'A send PIN is one line.')
})

test('the lock: five wrong tries lock sending for 10 minutes, per server; a right PIN clears the count', () => {
  let t = 0
  const lock = P.makeLock({ max: 5, ms: 600_000, now: () => t })
  for (let i = 0; i < 4; i++) { assert.equal(lock.locked(), 0); lock.fail() }
  lock.ok()
  for (let i = 0; i < 4; i++) lock.fail()
  assert.equal(lock.locked(), 0, 'a right PIN started the count again')
  lock.fail()
  assert.equal(lock.locked(), 600_000)
  t = 300_000
  assert.equal(lock.locked(), 300_000)
  t = 600_001
  assert.equal(lock.locked(), 0)
  lock.fail()
  assert.equal(lock.locked(), 0, 'after the lock, a fresh count')
})

test('withPinHash puts the hash into config.json and leaves every other line as it was', () => {
  const H = 'scrypt$1024$8$1$c2FsdA==$aGFzaA=='
  const base = '{\n  "repo": "C:/path/to/your-repo",\n  "port": 4317,\n  "ticketPrefixes": ["ABC"]\n}\n'
  const added = P.withPinHash(base, H)
  assert.deepEqual(JSON.parse(added), { ...JSON.parse(base), pr: { pinHash: H } })
  assert.ok(added.startsWith('{\n  "repo": "C:/path/to/your-repo",\n  "port": 4317,\n  "ticketPrefixes": ["ABC"]'), 'the rest untouched')
  const withPr = '{\n  "repo": "x",\n  "pr": {\n    "enabled": true,\n    "bases": ["dev"]\n  }\n}\n'
  const inPr = P.withPinHash(withPr, H)
  assert.deepEqual(JSON.parse(inPr).pr, { enabled: true, bases: ['dev'], pinHash: H })
  assert.ok(inPr.includes('    "bases": ["dev"]'), 'the list keeps its one-line form')
  const replaced = P.withPinHash(inPr, 'scrypt$2048$8$1$bmV3$bmV3')
  assert.equal(JSON.parse(replaced).pr.pinHash, 'scrypt$2048$8$1$bmV3$bmV3')
  assert.equal(replaced.split('pinHash').length, 2, 'replaced, not added twice')
})

test('factory.mjs pr-pin refuses a PIN piped in, so an agent cannot set one, and leaves config.json alone', () => {
  const config = path.join(ROOT, 'config.json')
  const before = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : null
  const r = spawnSync(process.execPath, ['tools/factory.mjs', 'pr-pin'], { cwd: ROOT, input: '123456\n123456\n', encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /type it yourself in a terminal/)
  assert.doesNotMatch(r.stdout + r.stderr, /123456/, 'the PIN is never echoed')
  assert.equal(fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : null, before)
})

test('the README and the guide say what protects what, and no longer claim that only a click can send', () => {
  for (const f of ['README.md', 'docs/USER_GUIDE.md']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
    assert.doesNotMatch(text, /only your click on the page can push/, f)
    assert.match(text, /node tools\/factory\.mjs pr-pin/, f)
    assert.match(text, /refuses a PIN piped\s+in only so/, f)
    assert.doesNotMatch(text, /so an agent cannot set one/, f)
    assert.match(text, /could always run `git push` and `gh` itself/, f)
    assert.match(text, /Host and Origin checks/, f)
    assert.match(text, /Type it only in your own browser, never in a window an agent is driving\./, f)
    assert.match(text, /### Settings/, f)
    assert.match(text, /outside the browser/, f)
  }
})

test('A3: a hash asking for too much memory or too many passes is not a valid PIN hash, and a check that throws is a wrong PIN', () => {
  const ok = P.hashPin('correct horse', { N: 1024 })
  const [, , , , salt, key] = ok.split('$')
  for (const [N, r, p] of [[2 ** 20, 32, 16], [2 ** 17, 8, 1], [16384, 8, 5], [65536, 16, 1]]) {
    assert.equal(P.validPinHash(`scrypt$${N}$${r}$${p}$${salt}$${key}`), false, `${N} ${r} ${p}: 128*N*r over 64 MiB or p over 4`)
  }
  assert.equal(P.validPinHash(`scrypt$65536$8$4$${salt}$${key}`), true, '64 MiB and p 4 are the limit')
  assert.equal(P.verifyPin('x'.repeat(10), `scrypt$65536$8$4$${salt}$${key}`), false)
})
