// The quality features as the docs and the example config describe them: config.example.json's quality block and
// pipeline.requireSelfCheck read with no warning; every brief an agent reads names what it must do (the builder the
// self-check, QA the self-check it is shown and the deeper pass, the planner the lessons to pass on); the README and the
// user guide give the measured cost of a run, the same as the Lessons page says.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { qualitySettings } from '../quality-config.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')

test('config.example.json: the quality block and pipeline.requireSelfCheck read with no warning', () => {
  const c = JSON.parse(read('config.example.json'))
  const warns = []
  const q = qualitySettings(c.quality, c.pipeline, m => warns.push(m))
  assert.deepEqual(warns, [])
  assert.deepEqual([q.autoLessons, q.critic, q.requireSelfCheck], [true, 'manual', false])
})

test('the briefs: the builder runs flow self-check, QA tests its claims and the deeper pass, the planner passes the lessons on', () => {
  assert.match(read('docs/agent-brief.md'), /flow self-check <flow> --done/)
  assert.match(read('docs/qa-agent-brief.md'), /self-check/)
  assert.match(read('docs/qa-agent-brief.md'), /deeper QA pass/)
  assert.match(read('docs/planner-agent-brief.md'), /pass them\s+on to the producer/)
})

test('the README and the user guide give the cost the Lessons page says', () => {
  const window = {}
  vm.runInNewContext(read('public/quality-lessons-page.js'), { window })
  const cost = window.QualityLessons.RUN_COST.replace('about ', '')
  assert.ok(read('docs/USER_GUIDE.md').includes(`about ${cost}`), cost)
  assert.match(read('README.md'), /\$0\.013 to \$0\.014 a run/)
  assert.match(read('README.md'), /## Quality: lessons, the self-check, the second opinion and risk labels/)
})
