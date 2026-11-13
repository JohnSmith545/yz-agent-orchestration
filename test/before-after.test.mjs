// Tests for before and after (flow-change.mjs, tools/change-cli.mjs and the hooks in flows.mjs,
// terms.mjs, relay.mjs and tools/flow-cli.mjs): a result shot can be a `before`, a flow can say in
// one line each how it was and how it is now (`output.change`), and an agent can draw how it worked
// before (`output.diagramBefore`). FACTORY_DATA_DIR points at a fresh temp folder BEFORE the
// imports, so no test touches data/.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'before-after-test-'))
const F = await import('../flows.mjs')
const T = await import('../terms.mjs')
const { requestText } = await import('../relay.mjs')
const { runFlow } = await import('../tools/flow-cli.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const fixture = name => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name + '.json'), 'utf8'))
const withOutput = output => ({ ...fixture('dark-mode'), output: { ...fixture('dark-mode').output, ...output } })
const PNG = path.join(process.env.FACTORY_DATA_DIR, 'shot.png')
before(() => fs.writeFileSync(PNG, Buffer.from('89504e470d0a1a0a', 'hex')))

// ═══ validation ═══

test('the dark-mode fixture has a before shot, an after shot and a change line, and is valid', () => {
  const f = fixture('dark-mode')
  assert.deepEqual(F.validateFlow(f), [])
  assert.ok(f.output.result.some(r => r.when === 'before'))
  assert.ok(f.output.result.some(r => r.when !== 'before'))
  assert.ok(f.output.change.before && f.output.change.after)
})

test('a result shot may say when: before or after, nothing else', () => {
  const bad = withOutput({ result: [{ ref: 'dark-mode/a.png', when: 'during' }] })
  assert.deepEqual(F.validateFlow(bad), ['output.result #1 when must be before or after'])
  assert.deepEqual(F.validateFlow(withOutput({ result: [{ ref: 'dark-mode/a.png', when: 'before' }, { ref: 'dark-mode/b.png', when: 'after' }] })), [])
})

test('a change says how it was and how it is now, one line of at most 140 characters each, with plain refusals', () => {
  const at = '2026-11-13T10:00:00Z'
  assert.deepEqual(F.validateFlow(withOutput({ change: { before: 'Always light', after: 'Dark on one switch', at } })), [])
  assert.deepEqual(F.validateFlow(withOutput({ change: { before: 'b'.repeat(141), after: 'ok', at } })),
    ['output.change: before: say it shorter: at most 140 characters (this has 141)'])
  assert.deepEqual(F.validateFlow(withOutput({ change: { before: '', after: 'ok' } })), ['output.change before must say how it was'])
  assert.deepEqual(F.validateFlow(withOutput({ change: { before: 'ok' } })), ['output.change after must say how it is now'])
  assert.deepEqual(F.validateFlow(withOutput({ change: { before: 'two\nlines', after: 'ok' } })), ['output.change before must be one line'])
  assert.deepEqual(F.validateFlow(withOutput({ change: 'nope' })), ['output.change must be a JSON object'])
})

test('diagramBefore has the same shape and limits as the diagram, and says so by its own name', () => {
  const nodes = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, label: `Box ${i}` }))
  const now = { nodes: [{ id: 'a', label: 'A' }], edges: [] }
  assert.deepEqual(F.validateFlow(withOutput({ diagram: now, diagramBefore: { nodes, edges: [] } })), ['output.diagramBefore has 9 boxes, at most 8: keep it high level'])
  assert.deepEqual(F.validateFlow(withOutput({ diagram: now, diagramBefore: { nodes: nodes.slice(0, 3), edges: [{ from: 'n0', to: 'n1' }] } })), [])
})

test('a diagram of how it worked before needs the diagram of how it works now, so it can never hide on its own', () => {
  assert.deepEqual(F.validateFlow(withOutput({ diagram: undefined, diagramBefore: { nodes: [{ id: 'a', label: 'A' }], edges: [] } })),
    ['output.diagramBefore needs output.diagram: draw how it works now first (flow diagram), then how it worked before'])
})

test('diagram --clear removes the diagram before with it, and says so', () => {
  fresh('ba-clear')
  run(['diagram', 'ba-clear', 'Cron -> Report'])
  run(['diagram', 'ba-clear', 'Cron -> Old server', '--before'])
  const r = run(['diagram', 'ba-clear', '--clear'])
  assert.equal(r.code, 0)
  assert.match(r.out, /diagram cleared, and the diagram before with it/)
  const out = F.readFlow('ba-clear').output
  assert.deepEqual([out.diagram, out.diagramBefore], [undefined, undefined])
})

test('derived.output.hasBefore: a before shot, a change or a diagram before; otherwise false', () => {
  const base = { ...fixture('dark-mode'), output: { result: [{ ref: 'dark-mode/a.png' }] } }
  assert.equal(F.derive(base).output.hasBefore, false)
  assert.equal(F.derive({ ...base, output: { result: [{ ref: 'dark-mode/a.png', when: 'before' }] } }).output.hasBefore, true)
  assert.equal(F.derive({ ...base, output: { change: { before: 'x', after: 'y' } } }).output.hasBefore, true)
  assert.equal(F.derive({ ...base, output: { diagramBefore: { nodes: [{ id: 'a', label: 'A' }] } } }).output.hasBefore, true)
})

test('a before shot alone is not the result: hasResult and complete need how it is now', () => {
  const only = withOutput({ result: [{ ref: 'dark-mode/a.png', when: 'before' }] })
  assert.deepEqual([F.derive(only).output.hasResult, F.derive(only).output.complete], [false, false])
  const both = withOutput({ result: [{ ref: 'dark-mode/a.png', when: 'before' }, { ref: 'dark-mode/b.png', when: 'after' }] })
  assert.deepEqual([F.derive(both).output.hasResult, F.derive(both).output.complete], [true, true])
})

test('words marked in the change line are found and learned like any other', () => {
  const t = T.termsOfFlow({ id: 'f', output: { change: { before: 'Colours were fixed', after: 'Every colour is a [theme token]' } }, nodes: [] })
  assert.deepEqual(t.map(x => [x.key, x.where[0].field]), [['theme token', 'change after']])
})

test('a request for visuals asks for a before and an after when the flow has none', () => {
  const none = { id: 'f', title: 'T', nodes: [] }
  assert.match(requestText(none), /--before/)
  assert.match(requestText(none), /flow change f --before/)
  const has = { id: 'f', title: 'T', nodes: [], output: { change: { before: 'x', after: 'y' } } }
  assert.doesNotMatch(requestText(has), /flow change/)
})

// ═══ the commands ═══

const run = (argv, by = 'Agent 3') => runFlow(argv, { by, cwd: process.env.FACTORY_DATA_DIR })
const fresh = id => {
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
  fs.writeFileSync(path.join(F.FLOWS_DIR, `${id}.json`), JSON.stringify({ ...fixture('no-visual'), id }))
}

test('result --before records a before shot; without it the shot is the result as before', () => {
  fresh('ba-shots')
  assert.equal(run(['result', 'ba-shots', '--shot', PNG, '--before', '--caption', 'Light, before']).code, 0)
  assert.equal(run(['result', 'ba-shots', '--shot', PNG]).code, 0)
  const r = F.readFlow('ba-shots').output.result
  assert.equal(r[0].when, 'before')
  assert.equal(r[0].caption, 'Light, before')
  assert.equal(r[1].when, undefined)
})

test('change needs both lines and a name, says it shorter when long, and --clear removes it', () => {
  fresh('ba-change')
  assert.equal(run(['change', 'ba-change', '--before', 'Always light']).code, 1)
  assert.match(run(['change', 'ba-change', '--before', 'Always light']).out, /--after/)
  assert.equal(run(['change', 'ba-change', '--before', 'Always light', '--after', 'x'.repeat(141)]).code, 1)
  assert.match(run(['change', 'ba-change', '--before', 'Always light', '--after', 'x'.repeat(141)]).out, /say it shorter/)
  assert.equal(run(['change', 'ba-change', '--before', 'a', '--after', 'b'], '').code, 1, 'a name is required')
  const ok = run(['change', 'ba-change', '--before', 'Always light', '--after', 'Dark on one switch'])
  assert.equal(ok.code, 0, ok.out)
  const c = F.readFlow('ba-change').output.change
  assert.equal(c.before, 'Always light')
  assert.equal(c.after, 'Dark on one switch')
  assert.ok(c.at)
  assert.equal(run(['change', 'ba-change', '--clear']).code, 0)
  assert.equal(F.readFlow('ba-change').output.change, undefined)
})

test('diagram --before writes how it worked before, and --before --clear removes only that one', () => {
  fresh('ba-diagram')
  assert.equal(run(['diagram', 'ba-diagram', 'Cron -> Old server -> Report']).code, 0)
  assert.equal(run(['diagram', 'ba-diagram', 'Cron -> Old server', '--before']).code, 0)
  const out = F.readFlow('ba-diagram').output
  assert.equal(out.diagramBefore.nodes.length, 2)
  assert.equal(out.diagram.nodes.length, 3)
  assert.equal(run(['diagram', 'ba-diagram', '--before', '--clear']).code, 0)
  const after = F.readFlow('ba-diagram').output
  assert.equal(after.diagramBefore, undefined)
  assert.equal(after.diagram.nodes.length, 3)
})

test('show tells what before and after the Output holds; the usage lists the commands', () => {
  fresh('ba-show')
  run(['result', 'ba-show', '--shot', PNG, '--before'])
  run(['change', 'ba-show', '--before', 'Always light', '--after', 'Dark on one switch'])
  const shown = run(['show', 'ba-show'])
  assert.match(shown.err, /before: 1 shot/)
  assert.match(shown.err, /\n {2}result: none yet\n/, 'a before shot is not counted as the result')
  assert.match(shown.err, /change: Always light -> Dark on one switch/)
  const usage = run(['nope']).out
  assert.match(usage, /change <flow> --before/)
  assert.match(usage, /--before/)
})
