// Tests for config-write.mjs withConfigKeys / writeConfigKeys / setKeys: the writer the Orchestration bank uses to
// put a saved style into a project's config (the pipeline block, the coordinator, the session labels, the chat
// agent's name). Like the "pr" writer, it changes only the values it is given and leaves every other byte as it
// was; when it cannot, it writes the whole file again as JSON with the same values.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'config-keys-test-'))
process.env.FACTORY_DATA_DIR = TMP
const { withConfigKeys, writeConfigKeys, setKeys } = await import('../config-write.mjs')
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const TEXT = `{
  "repo": "C:/work/app",
  "aliases": { "pipeline": "a session called pipeline" },
  "coordinator": "Master",
  "codingAgents": {
    "Master": "Master",
    "Agent 1": "Agent 1"
  },
  "factory": {
    "me": "x",
    "chat": {
      "name": "Independent",
      "model": "claude-opus-5-5"
    }
  },
  "pr": { "enabled": false }
}
`

const parsed = t => JSON.parse(t)

test('a top-level value is replaced in place, at its own indentation, and nothing else moves', () => {
  const out = withConfigKeys(TEXT, { codingAgents: { Lead: 'Lead', Maker: 'Maker' } })
  assert.deepEqual(parsed(out).codingAgents, { Lead: 'Lead', Maker: 'Maker' })
  assert.ok(out.includes('  "codingAgents": {\n    "Lead": "Lead",\n    "Maker": "Maker"\n  },'))
  const head = TEXT.slice(0, TEXT.indexOf('"codingAgents"'))
  const tail = TEXT.slice(TEXT.indexOf('  "factory"'))
  assert.ok(out.startsWith(head))
  assert.ok(out.endsWith(tail))
})

test('a key with the same name inside another object is never taken for the top-level one', () => {
  const out = withConfigKeys(TEXT, { pipeline: { qa: 'Tester', maxReworks: 2 } })
  assert.equal(parsed(out).aliases.pipeline, 'a session called pipeline')
  assert.deepEqual(parsed(out).pipeline, { qa: 'Tester', maxReworks: 2 })
})

test('a missing top-level key is added at the end of the object, the rest kept byte for byte', () => {
  const out = withConfigKeys(TEXT, { coordinatorLabel: 'Boss' })
  assert.equal(parsed(out).coordinatorLabel, 'Boss')
  assert.ok(out.startsWith(TEXT.slice(0, TEXT.lastIndexOf('\n}'))))
  assert.ok(out.includes('"pr": { "enabled": false },\n  "coordinatorLabel": "Boss"\n}'))
})

test('a nested value is changed by its dotted path; a missing nested key goes into its parent', () => {
  const a = withConfigKeys(TEXT, { 'factory.chat.name': 'Helper' })
  assert.equal(parsed(a).factory.chat.name, 'Helper')
  assert.equal(parsed(a).factory.chat.model, 'claude-opus-5-5')
  assert.equal(a, TEXT.replace('"name": "Independent"', '"name": "Helper"'))
  const b = withConfigKeys(TEXT, { 'factory.chat.mode': 'brief' })
  assert.deepEqual(parsed(b).factory.chat, { name: 'Independent', model: 'claude-opus-5-5', mode: 'brief' })
})

test('several changes at once, each in place', () => {
  const out = withConfigKeys(TEXT, { coordinator: 'Lead', coordinatorLabel: 'Lead', pipeline: { qa: 'QA' }, 'factory.chat.name': 'Ask' })
  const o = parsed(out)
  assert.equal(o.coordinator, 'Lead')
  assert.equal(o.coordinatorLabel, 'Lead')
  assert.deepEqual(o.pipeline, { qa: 'QA' })
  assert.equal(o.factory.chat.name, 'Ask')
  assert.equal(o.repo, 'C:/work/app')
})

test('a parent that is not there: the whole file is written again as JSON, with the same values', () => {
  const out = withConfigKeys('{ "repo": "x" }', { 'factory.chat.name': 'Ask' })
  assert.deepEqual(parsed(out), { repo: 'x', factory: { chat: { name: 'Ask' } } })
  assert.equal(out, `${JSON.stringify({ repo: 'x', factory: { chat: { name: 'Ask' } } }, null, 2)}\n`)
})

test('an empty object gets its first key; a file with Windows line ends keeps them', () => {
  assert.deepEqual(parsed(withConfigKeys('{ "aliases": {} }', { 'aliases.x': 'X' })), { aliases: { x: 'X' } })
  const crlf = TEXT.replace(/\n/g, '\r\n')
  const out = withConfigKeys(crlf, { codingAgents: { A: 'A' } })
  assert.ok(!/[^\r]\n/.test(out), 'every line ends in CRLF')
  assert.deepEqual(parsed(out).codingAgents, { A: 'A' })
})

test('strings with braces, quotes and backslashes never end a block early', () => {
  const t = '{\n  "aliases": { "a}": "b\\"{", "c\\\\": "}" },\n  "coordinator": "M"\n}\n'
  const out = withConfigKeys(t, { coordinator: 'N' })
  assert.deepEqual(parsed(out), { aliases: { 'a}': 'b"{', 'c\\': '}' }, coordinator: 'N' })
  assert.equal(out, t.replace('"M"', '"N"'))
})

test('writeConfigKeys reads, changes and writes the file whole', () => {
  const file = path.join(TMP, 'config.json')
  fs.writeFileSync(file, TEXT)
  writeConfigKeys(file, { coordinator: 'Lead' })
  assert.equal(parsed(fs.readFileSync(file, 'utf8')).coordinator, 'Lead')
  assert.deepEqual(fs.readdirSync(TMP).filter(f => f.endsWith('.tmp')), [])
})

test('setKeys changes a plain object by the same dotted paths (a project kept in projects.json)', () => {
  const before = { repo: 'x', factory: { me: 'y' } }
  const after = setKeys(before, { coordinator: 'Lead', 'factory.chat.name': 'Ask', pipeline: { qa: 'QA' } })
  assert.deepEqual(after, { repo: 'x', factory: { me: 'y', chat: { name: 'Ask' } }, coordinator: 'Lead', pipeline: { qa: 'QA' } })
  assert.deepEqual(before, { repo: 'x', factory: { me: 'y' } }) // the object passed in is not changed
})
