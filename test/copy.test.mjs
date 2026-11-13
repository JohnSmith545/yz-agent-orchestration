// The copy rules (spec 6) on every page: a card head is a name and a number,
// relative time is short (3m, 2h, 5d) and comes from ONE helper, Shell.ago in
// shell.js, and the state words are the spec set. Greps over public/*.js plus
// the pure helpers run in a vm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')
const scripts = fs.readdirSync(PUBLIC).filter(f => f.endsWith('.js'))

/** Every line of public/*.js matching `re`, as file:line: text. */
function hits(re, files = scripts) {
  const out = []
  for (const f of files) {
    read(f)
      .split(/\r?\n/)
      .forEach((line, i) => re.test(line) && out.push(`${f}:${i + 1}: ${line.trim()}`))
  }
  return out
}

const window = {}
vm.runInNewContext(read('shell.js'), { window })
const { ago } = window.Shell
const NOW = Date.parse('2026-11-12T12:00:00Z')
const before = ms => new Date(NOW - ms).toISOString()

test('Shell.ago: under a minute is now, then minutes, hours and days, short', () => {
  assert.equal(ago(before(0), NOW), 'now')
  assert.equal(ago(before(59_000), NOW), 'now')
  assert.equal(ago(before(3 * 60_000), NOW), '3m')
  assert.equal(ago(before(3 * 60_000 + 59_000), NOW), '3m', 'whole minutes, never rounded up')
  assert.equal(ago(before(59 * 60_000), NOW), '59m')
  assert.equal(ago(before(2 * 3600_000), NOW), '2h')
  assert.equal(ago(before(23 * 3600_000), NOW), '23h')
  assert.equal(ago(before(5 * 86400_000), NOW), '5d')
})

test('Shell.ago: a clock a little ahead is now, and anything that is not a time is empty', () => {
  assert.equal(ago(new Date(NOW + 5000).toISOString(), NOW), 'now')
  for (const bad of [null, undefined, '', 'not a date']) assert.equal(ago(bad, NOW), '', String(bad))
})

test('Shell.ago defaults to the current time', () => {
  assert.equal(ago(new Date(Date.now() - 2 * 3600_000).toISOString()), '2h')
})

test('no relative time is spelled out with ago, min or just now in public/*.js', () => {
  assert.deepEqual(hits(/\b\d*\s*(min|h|d)\s+ago\b|\}\s*ago\b|['`"]just now['`"]/), [])
})

test('only shell.js defines a relative-time helper', () => {
  const def = /\b(?:const|let|function)\s+(?:ago|age)\b|\b(?:ago|age)\s*(?::|=)\s*(?:\(|iso\b|at\b)|\bage\s*\(\s*iso\s*\)\s*\{/
  assert.deepEqual(hits(def, scripts.filter(f => f !== 'shell.js')), [])
  assert.deepEqual(hits(/\bUI\.(?:age|ago)\b|NotifyRules\.age\b/), [])
})

test('every card head is a name and a number: at most 40 characters after the ·, never a sentence', () => {
  const heads = []
  for (const f of [...scripts, 'index.html']) {
    for (const m of read(f).matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/g)) {
      const text = m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
      heads.push([f, text])
    }
  }
  assert.ok(heads.length > 5, 'the pages have card heads')
  const long = heads.filter(([, t]) => t.includes('·') && t.slice(t.indexOf('·') + 1).trim().length > 40)
  assert.deepEqual(long, [])
  const sentences = heads.filter(([, t]) => /\.\s*$/.test(t))
  assert.deepEqual(sentences, [])
})

test('the head counts are a bare number: no word after it', () => {
  assert.deepEqual(hits(/·\s*\$\{[^}]*\}\s+[a-z]+\b/i, ['flows-page.js', 'orchestration.js', 'flows.js', 'app.js']), [])
})

test('state words are the spec set: no Active, Testing or Running tests on a chip or a grid head', () => {
  assert.deepEqual(hits(/>(?:Active|Testing|Running tests|Waiting for input)</), [])
  assert.deepEqual(hits(/\b(?:testing|active):\s*'(?:Testing|Active)'/), [])
})

test('the stand-in ? tooltips are gone: every ? is a Help popover', () => {
  assert.deepEqual(hits(/class="help"[^>]*title=/), [])
  assert.deepEqual(hits(/fl-none"\s+title=/), [])
})

test('the page title is written only through Shell.setTitle', () => {
  assert.deepEqual(hits(/getElementById\(['"]pageTitle['"]\)/, scripts.filter(f => f !== 'shell.js')), [])
})

// ═══ fix round 1: every page puts its meta in the chip and its legend behind a ? ═══

test('the Timeline and the agent page write their meta to the header chip, not the page body', () => {
  assert.deepEqual(hits(/flowMeta|agentMeta/, ['flow.js', 'agent.js']), [])
  for (const f of ['flow.js', 'agent.js']) assert.match(read(f), /Shell\.setStatus\(/, `${f} fills the chip`)
})

test('the node and proof legends sit behind a ? popover, never on the page', () => {
  for (const f of ['flow.js', 'flows.js']) {
    assert.match(read(f), /Help\.attach\([^\n]*LEGEND\)/, `${f} hands its legend to Help`)
    assert.deepEqual(hits(/\$\{LEGEND\}/, [f]), [], `${f} never draws the legend into the page`)
  }
  const build = read('flow.js').match(/function build\(\) \{[\s\S]*?addEventListener/)[0]
  assert.doesNotMatch(build, /flow-legend/, 'the Timeline toolbar has no legend row')
  const opened = read('flows.js').match(/function buildOpened\(\) \{[\s\S]*?FlowZoom\.attach/)[0]
  assert.doesNotMatch(opened, /fl-legend/, 'the opened flow has no legend row')
})

test('the Timeline empty state is one line with its action', () => {
  assert.deepEqual(hits(/Try a longer window/, ['flow.js']), [])
})

test('the Tickets stat tiles count up from what they showed', () => {
  const stats = read('factory.js').match(/function renderStats\(\) \{[\s\S]*?\n {2}\}/)[0]
  assert.match(stats, /Motion\.countUp\(/)
})
