// Regression tests for the QA round two nits around Senior:
//   B-N1  after Finish without Senior the flow page drops the old refusal and says, in one line, that the flow was
//         finished without a Senior review
//   B-N2  a refusal because Senior holds the flow says on the PAGE what the user can do (the store's sentence is the
//         agent's: send Senior a message); the store marks it with code senior-hold and the routes pass the code on
//   B-N3  once every step Senior sent back is ticked again, the Senior sent this back banner goes (the record keeps it)
//   and   `flow show` names Human task and Senior on the route line, as the page does
// Browser files in a vm; the CLI with its own config. FACTORY_DATA_DIR points at a fresh temp folder first.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'senior-nits-test-'))
const F = await import('../flows.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
after(() => fs.rmSync(F.DATA_DIR, { recursive: true, force: true }))

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const window = { Shell: { ago: () => '3m' } }
vm.runInNewContext(read('public/flow-hand.js'), { window, CSS: { escape: s => s } })
const H = window.FlowHand
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const CONFIG = {
  repo: 'C:/watched/repo', coordinator: 'Master', coordinatorLabel: 'Master',
  codingAgents: { Master: 'Master', 'Agent 1': 'Agent 1', sen: 'Senior' },
  pipeline: { qa: 'QA', producers: null, protectedBranches: ['dev'], maxReworks: 2, senior: 'Senior' },
}
const step = (id, done) => ({ id, do: `Do ${id}`, expect: 'ok', done: done ? { by: 'you', at: 'x' } : null })
const base = { id: 'keys', title: 'Rotate the keys', agent: 'Agent 1', status: 'open', tickets: [], nodes: [] }

test('B-N1: a flow finished without Senior says so in one line on its checklist, steps or not', () => {
  const released = { ...base, status: 'done', senior: { status: 'released', by: 'you', at: '2026-11-25T12:00:00Z' } }
  for (const hand of [{ steps: [step('h1', false)] }, { steps: [] }]) {
    const h = H.html({ ...released, hand })
    assert.match(h, /<p class="fh-released" role="note">You finished this without a Senior review\.<\/p>/, JSON.stringify(hand))
    assert.doesNotMatch(h, /data-hand-release/)
  }
  const flows = read('public/flows.js')
  assert.match(flows, /opened\.refusedStatus = f\.status/)
  assert.match(flows, /opened\.refused && f\.status !== opened\.refusedStatus/, 'the refusal goes once the status moved on')
})

test('B-N2: the store marks a Senior hold refusal with code senior-hold; the route passes the code; the page says what the user can do', () => {
  assert.equal(runFlow(['new', 'held', 'Keys', '--type', 'ask'], { by: 'Agent 1', config: CONFIG }).code, 0)
  assert.equal(runFlow(['hand-step', 'held', 'Rotate', '--expect', 'New'], { by: 'Agent 1', config: CONFIG }).code, 0)
  let caught
  try {
    F.withPipeline(CONFIG, () => F.writeFlow({ ...F.readFlow('held'), status: 'done' }))
  } catch (e) {
    caught = e
  }
  assert.equal(caught?.code, 'senior-hold')
  assert.match(read('factory-routes.mjs'), /error: e\.message, \.\.\.\(e\.code \? \{ code: e\.code \} : \{\}\)/)
  const progress = [{ node: 'senior', label: 'Senior', role: 'senior', state: 'upcoming' }]
  assert.equal(H.holdText({ ...base, progress }), 'Senior reviews this flow before it is done: wait for its review, or use Finish without Senior below.')
  assert.match(read('public/flows.js'), /res\.code === 'senior-hold' \? window\.FlowHand\.holdText\(f\) : res\.error/)
  assert.match(read('public/flow-hand.js'), /r\.j\?\.code === 'senior-hold' \? holdText\(f\)/)
})

test('B-N3: the Senior sent this back banner shows while a step waits to be redone, and goes once every step is ticked again', () => {
  const back = { status: 'failed', by: 'Senior', at: 'x', summary: 'Wrong project.', redo: ['h1'] }
  assert.match(H.html({ ...base, hand: { steps: [step('h1', false), step('h2', true)] }, senior: back }), /fh-redo/)
  assert.doesNotMatch(H.html({ ...base, hand: { steps: [step('h1', true), step('h2', true)] }, senior: back }), /fh-redo/)
})

test('flow show: a build flow with by-hand steps names Human task and Senior on its route line, as the page does', () => {
  assert.equal(runFlow(['new', 'ci', 'Set up CI', '--type', 'build'], { by: 'Agent 1', config: CONFIG }).code, 0)
  assert.equal(runFlow(['hand-step', 'ci', 'Add the secret', '--expect', 'Listed'], { by: 'Agent 1', config: CONFIG }).code, 0)
  const shown = runFlow(['show', 'ci'], { by: 'Agent 1', config: CONFIG })
  assert.match(shown.err, /route: build, Request -> Master -> Agent 1 -> QA -> Push -> Human task -> Senior -> Output; now at Human task \(waiting\)/)
})
