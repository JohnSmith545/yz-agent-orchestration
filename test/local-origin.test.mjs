// Tests for local-origin.mjs: the dashboard answers only requests addressed to
// itself by name (Host 127.0.0.1:<port> or localhost:<port>), so a website that
// rebinds its own name to 127.0.0.1 is refused; and an Origin is compared with
// that fixed set, never with the request's own Host header.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const L = await import('../local-origin.mjs')

test('a Host is allowed only as 127.0.0.1:<port> or localhost:<port>', () => {
  for (const h of ['127.0.0.1:4318', 'localhost:4318', 'LOCALHOST:4318']) assert.equal(L.hostAllowed(h, 4318), true, h)
  for (const h of ['evil.example:4318', 'evil.example', '127.0.0.1:4317', '127.0.0.1', '', undefined, 'localhost:4318.evil.example', '[::1]:4318']) assert.equal(L.hostAllowed(h, 4318), false, String(h))
})

test('an Origin is allowed only as http:// one of those hosts, whatever Host the request claims', () => {
  assert.equal(L.originAllowed('http://127.0.0.1:4318', 4318), true)
  assert.equal(L.originAllowed('http://localhost:4318', 4318), true)
  for (const o of ['http://evil.example:4318', 'https://127.0.0.1:4318', 'http://127.0.0.1:4317', 'null', '', undefined]) assert.equal(L.originAllowed(o, 4318), false, String(o))
})

test('server.mjs refuses a foreign Host before any route, and factory-routes compares Origin with the fixed set', () => {
  const server = fs.readFileSync(path.join(HERE, '..', 'server.mjs'), 'utf8')
  assert.match(server, /if \(!hostAllowed\(req\.headers\.host, PORT\)\) return res\.writeHead\(403/)
  const routes = fs.readFileSync(path.join(HERE, '..', 'factory-routes.mjs'), 'utf8')
  assert.doesNotMatch(routes, /req\.headers\.host/)
  assert.doesNotMatch(fs.readFileSync(path.join(HERE, '..', 'pr-routes.mjs'), 'utf8'), /headers\.host/)
})
