// Tests for Senior's brief (docs/senior-agent-brief.md) and the docs around it: the brief says what Senior checks in
// plain words, its commands, that it always runs on Opus at high effort and never runs Terraform or changes a live
// project itself; the agent brief tells a producer what happens to by-hand work and how to send work to Senior; the
// README and the user guide name the key and the commands; and the example config has the key off (null).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
const flat = s => s.replace(/\s*\n>?\s*/g, ' ')

test('the Senior brief: its commands, Opus at high effort, what it checks, and that it never does the work itself', () => {
  const b = flat(read('docs/senior-agent-brief.md'))
  for (const s of [
    'flow senior-start', 'flow senior <flow> pass', 'flow senior <flow> fail', '--steps h1,h3', 'flow senior-ask', 'pipeline.senior',
    'Always run on Opus at high effort', 'NEVER run Terraform', 'Never change a live cloud project, a production database',
    'ask for evidence (a screenshot, a command and its output, the state of the console page)', 'least privilege',
    'no secret was pasted into a ticket, a chat', 'the right project or environment (dev, stage or prod) was changed, and only that one',
    'the change can be undone, and how', 'CI is green after it', 'nothing was opened to the public by mistake', 'what it costs',
    'Never push',
  ]) assert.ok(b.includes(s), s)
})

test('the agent brief: by-hand work waits at Human task, Senior reviews it, and senior-ask sends a change made with an agent tools', () => {
  const b = flat(read('docs/agent-brief.md'))
  assert.match(b, /docs\/senior-agent-brief\.md/)
  assert.match(b, /it waits at the Human task box until every step is ticked/)
  assert.match(b, /`flow senior-ask <flow> "<what you changed, where, and how to check it>"`/)
})

test('the README and the user guide name the key, the graph and the commands; the example config has Senior off', () => {
  const readme = flat(read('README.md'))
  for (const s of ['#### Human task and Senior', '`pipeline.senior`', 'flow senior-ask <flow>', 'flow senior-start <flow>', 'flow senior <flow> pass|fail', '`planner`, `security` and `senior`']) assert.ok(readme.includes(s), s)
  const guide = flat(read('docs/USER_GUIDE.md'))
  assert.match(guide, /\*\*Human task\*\* is you\. It sits to the right of Agent 1/)
  assert.match(guide, /\*\*Senior\*\* \(only when config\.json sets `pipeline\.senior`\)/)
  assert.equal(JSON.parse(read('config.example.json')).pipeline.senior, null)
})

test('the Senior brief credits no AI tool', () => {
  assert.doesNotMatch(read('docs/senior-agent-brief.md'), /Co-Authored-By|Generated with/i)
})
