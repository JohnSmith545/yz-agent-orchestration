// Tests for the briefs of the two optional agents (docs/planner-agent-brief.md, docs/security-agent-brief.md) and
// their sections in docs/agent-brief.md: each says what the agent does, its commands, the skill it uses, that it
// always runs on Opus at high effort, that it never pushes and never changes application code; and the example
// config names both keys (null: off).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
const flat = s => s.replace(/\s*\n>?\s*/g, ' ')

test('the planner brief: its commands, its skill, Opus at high effort, no code, no push', () => {
  const b = flat(read('docs/planner-agent-brief.md'))
  for (const s of ['flow plan-start', 'flow plan ', '--file plan.md --to', '/superpowers:writing-plans', 'Always run on Opus at high effort', 'never change application code', 'Never push', 'pipeline.planner']) assert.ok(b.includes(s), s)
})

test('the Security brief: its commands, its skill, Opus at high effort, reports and never fixes, never pushes', () => {
  const b = flat(read('docs/security-agent-brief.md'))
  for (const s of ['flow security-start', 'flow security ', '--status passed|failed', '/superpowers:requesting-code-review', 'Always run on Opus at high effort', 'you report, the producer fixes', 'Never push', 'pipeline.security', 'the very commit QA passed']) assert.ok(b.includes(s), s)
})

test('the agent brief has a planner section and a Security section, and the example config both keys', () => {
  const b = flat(read('docs/agent-brief.md'))
  assert.match(b, /docs\/planner-agent-brief\.md/)
  assert.match(b, /docs\/security-agent-brief\.md/)
  assert.match(b, /A Security failure comes back to you exactly as a QA failure does/)
  const example = JSON.parse(read('config.example.json'))
  assert.equal(example.pipeline.planner, null)
  assert.equal(example.pipeline.security, null)
})

test('no brief credits an AI tool', () => {
  for (const f of ['docs/planner-agent-brief.md', 'docs/security-agent-brief.md']) assert.doesNotMatch(read(f), /Co-Authored-By|Generated with/i, f)
})
