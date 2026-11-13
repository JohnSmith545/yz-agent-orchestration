// Tests for public/flow-compare.js, the before and after of a flow's Picture
// block: the change strip, before and after pairs with a 1/3 stepper, the
// Compare overlay slider, unpaired shots under their own label, and the diagram
// of how it worked before beside the one of how it works now. Browser scripts,
// so they run in a vm context with a stub window (html never touches the DOM).

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-compare-test-'))
const { derive, DATA_DIR } = await import('../flows.mjs')
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

const memoryStorage = () => {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }
}
const SCRIPTS = ['shell.js', 'terms.js', 'flow-chart.js', 'diagram-fit.js', 'diagram-route.js', 'diagram.js', 'flow-picture.js', 'flow-drawer.js',
  'lightbox.js', 'flow-tabs.js', 'flow-story.js', 'flow-compare.js', 'flow-visual.js', 'flow-steps.js', 'flow-send.js', 'flow-output.js']
function load() {
  const ctx = { window: {}, localStorage: memoryStorage() }
  for (const f of SCRIPTS) vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), ctx)
  return ctx
}
const { window } = load()
const FO = window.FlowOutput
const FC = window.FlowCompare

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
const NOVIS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const fx = (edit = () => {}, base = FIXTURE) => {
  const flow = structuredClone(base)
  edit(flow)
  flow.derived = derive(flow)
  return flow
}
const plain = v => JSON.parse(JSON.stringify(v))
const block = (h, name) => {
  const at = h.indexOf(`aria-label="${name}"`)
  const next = h.slice(at + 1).search(/<(section|details) class="ob /)
  return next < 0 ? h.slice(at) : h.slice(at, at + 1 + next)
}
const shot = (ref, when, caption = '') => ({ ref, caption, ...(when ? { when } : {}), at: '2026-11-12T08:00:00Z' })
const noBefore = f => { f.output.result = f.output.result.filter(r => r.when !== 'before'); delete f.output.change }
const threePairs = f => {
  f.output.result = [
    shot('dark-mode/b1.png', 'before', 'Settings before'), shot('dark-mode/a1.png', '', 'Settings after'),
    shot('dark-mode/b2.png', 'before'), shot('dark-mode/a2.png'),
    shot('dark-mode/b3.png', 'before'), shot('dark-mode/a3.png'),
  ]
}

// ═══ model ═══

test('model: before shots are kept apart from the result, with the change and the diagram of how it worked before', () => {
  const m = plain(FO.model(fx(f => {
    f.output.diagramBefore = { nodes: [{ id: 'a', label: 'Old page' }], edges: [] }
  })))
  assert.deepEqual(m.result.map(s => s.ref), ['dark-mode/out-after.png'], 'the result is how it is now')
  assert.deepEqual(m.before, [{ ref: 'dark-mode/out-before.png', caption: 'Settings before: always light', at: '2026-11-12T08:05:00Z' }])
  assert.deepEqual(m.change, { before: 'The page was always light, even late at night', after: 'One switch turns the whole page dark, and it stays dark after a reload', at: '2026-11-12T08:36:00Z' })
  assert.deepEqual(m.diagramBefore, { nodes: [{ id: 'a', label: 'Old page' }], edges: [] })
  const none = plain(FO.model(fx(noBefore)))
  assert.deepEqual([none.before, none.change, none.diagramBefore], [[], null, null])
})

// ═══ pairs, views ═══

test('pairs: the before shots and the agent result paired in order, the rest left unpaired', () => {
  const one = plain(FC.pairs(FO.model(fx())))
  assert.deepEqual(one.pairs.map(p => [p.before.ref, p.after.ref]), [['dark-mode/out-before.png', 'dark-mode/out-after.png']])
  assert.deepEqual([one.loneBefore, one.loneAfter], [[], []])
  const uneven = plain(FC.pairs(FO.model(fx(f => {
    f.output.result = [shot('x/b1.png', 'before'), shot('x/b2.png', 'before'), shot('x/b3.png', 'before'), shot('x/a1.png'), shot('x/a2.png')]
  }))))
  assert.deepEqual(uneven.pairs.map(p => [p.before.ref, p.after.ref]), [['x/b1.png', 'x/a1.png'], ['x/b2.png', 'x/a2.png']])
  assert.deepEqual(uneven.loneBefore.map(s => s.ref), ['x/b3.png'])
  const moreAfter = plain(FC.pairs(FO.model(fx(f => { f.output.result.push(shot('x/a9.png')) }))))
  assert.deepEqual(moreAfter.loneAfter.map(s => s.ref), ['x/a9.png'])
  // only a before shot, the after from the flow evidence: not a pair, the before shows on its own
  const derived = plain(FC.pairs(FO.model(fx(f => { f.output.result = [shot('x/b1.png', 'before')] }))))
  assert.deepEqual([derived.pairs.length, derived.loneBefore.map(s => s.ref)], [0, ['x/b1.png']])
})

test('views: the switch offers only the views that exist', () => {
  const views = f => plain(FC.views(FO.model(f)))
  assert.deepEqual(views(fx()), ['screens', 'compare', 'how'])
  assert.deepEqual(views(fx(f => { delete f.output.diagram })), ['screens', 'compare'])
  assert.deepEqual(views(fx(noBefore)), ['screens', 'how'])
  assert.deepEqual(views(fx(f => { f.output.result[0].ref = 'dark-mode/before.mp4' })), ['screens', 'how'], 'a video cannot be laid over a picture: no Compare')
  assert.deepEqual(views(fx(() => {}, NOVIS)), [])
})

// ═══ the slider and the stepper: pure ═══

test('the slider position: clamped 0 to 100, arrows move it 5, Home and End, and a pointer maps to a percent', () => {
  assert.deepEqual([FC.clamp(-4), FC.clamp(140), FC.clamp(37.5), FC.clamp(NaN), FC.clamp('x')], [0, 100, 37.5, 50, 50])
  assert.equal(FC.nudge(50, 'ArrowLeft'), 45)
  assert.equal(FC.nudge(50, 'ArrowRight'), 55)
  assert.equal(FC.nudge(2, 'ArrowLeft'), 0)
  assert.equal(FC.nudge(98, 'ArrowRight'), 100)
  assert.equal(FC.nudge(40, 'Home'), 0)
  assert.equal(FC.nudge(40, 'End'), 100)
  assert.equal(FC.nudge(40, 'Enter'), null, 'any other key is not the slider')
  assert.equal(FC.posAt(150, 100, 200), 25)
  assert.equal(FC.posAt(50, 100, 200), 0)
  assert.equal(FC.posAt(900, 100, 200), 100)
  assert.equal(FC.posAt(150, 100, 0), 50, 'a box of no width: the middle')
})

test('the stepper: one place per flow, kept in range, and moved one pair at a time', () => {
  const { window: w } = load()
  const S = w.FlowCompare.step
  assert.equal(S.get('f', 3), 0)
  assert.equal(S.move('f', 1, 3), 1)
  assert.equal(S.move('f', 1, 3), 2)
  assert.equal(S.move('f', 1, 3), 2, 'the last pair stays the last')
  assert.equal(S.get('f', 2), 1, 'fewer pairs than before: the place is kept in range')
  assert.equal(S.move('f', -5, 3), 0)
  assert.equal(S.get('g', 3), 0, 'each flow has its own')
})

// ═══ html ═══

test('the change strip: Before and Now, one line each, with term chips; none without a change', () => {
  const p = block(FO.html(fx(f => { f.output.change.after = 'One switch flips every [theme token]' })), 'What changed')
  assert.match(p, /^aria-label="What changed"[^>]*><div class="cmp-strip"><p class="cmp-was"><span class="cmp-k">Before<\/span> The page was always light, even late at night<\/p>/)
  assert.match(p, /<p class="cmp-now"><span class="cmp-k">Now<\/span> One switch flips every <dfn class="t-chip" data-term="theme token"/)
  assert.doesNotMatch(FO.html(fx(noBefore)), /cmp-strip|What changed/)
  assert.match(block(FO.html(fx(f => { f.output.result = f.output.result.filter(r => r.when !== 'before') })), 'What changed'), /cmp-strip/, 'a change with no before shot still shows')
})

test('Screens: a pair is the before and the after side by side, each labelled; no stepper for one pair', () => {
  const p = block(FO.html(fx()), 'Picture')
  assert.match(p, /<div class="cmp-pair">[\s\S]*<figure class="cmp-side cmp-before"><figcaption class="cmp-label">Before<\/figcaption>[\s\S]*src="\/evidence\/dark-mode\/out-before\.png"/)
  assert.match(p, /<figure class="cmp-side cmp-after"><figcaption class="cmp-label">After<\/figcaption>[\s\S]*src="\/evidence\/dark-mode\/out-after\.png"/)
  assert.match(p, /<p class="cmp-cap">Settings before: always light<\/p>/)
  assert.doesNotMatch(p, /pv-hero|data-cmp-step/, 'the pair takes the hero place; one pair, no stepper')
})

test('Screens: several pairs step 1/3, and shots with no partner sit under their own label', () => {
  const { window: w } = load()
  const flow = fx(f => { threePairs(f); f.output.result.push(shot('dark-mode/b4.png', 'before', 'Old menu')) })
  const p = block(w.FlowOutput.html(flow), 'Picture')
  assert.match(p, /<div class="cmp-step" role="group" aria-label="Pairs" data-cmp-n="3"><button type="button" data-cmp-step="-1" aria-label="Previous pair" disabled>/)
  assert.match(p, /<span class="cmp-count">1\/3<\/span><button type="button" data-cmp-step="1" aria-label="Next pair">/)
  assert.match(p, /src="\/evidence\/dark-mode\/b1\.png"[\s\S]*src="\/evidence\/dark-mode\/a1\.png"/)
  assert.match(p, /<p class="cmp-lone-h">Before, no after yet<\/p><ul class="pv-film">[\s\S]*?src="\/evidence\/dark-mode\/b4\.png"/)
  w.FlowCompare.step.move(flow.id, 1, 3)
  const next = block(w.FlowOutput.html(flow), 'Picture')
  assert.match(next, /<span class="cmp-count">2\/3<\/span>/)
  assert.match(next, /src="\/evidence\/dark-mode\/b2\.png"[\s\S]*src="\/evidence\/dark-mode\/a2\.png"/)
  assert.doesNotMatch(next, /b1\.png/)
  const extraAfter = block(FO.html(fx(f => { f.output.result.push(shot('dark-mode/menu.png')) })), 'Picture')
  assert.match(extraAfter, /<p class="cmp-lone-h">After<\/p><ul class="pv-film">[\s\S]*?menu\.png/)
})

test('Screens: only a before shot, the result from the evidence: the result leads and the before sits under its label', () => {
  const p = block(FO.html(fx(f => { f.output.result = [shot('dark-mode/b1.png', 'before')] })), 'Picture')
  assert.match(p, /<figure class="pv-hero">[\s\S]*src="\/evidence\/dark-mode\/toggle\.png"/)
  assert.match(p, /<p class="cmp-lone-h">Before, no after yet<\/p>[\s\S]*b1\.png/)
})

test('the switch: Screens, Compare and How it works, only those that exist; Compare is the overlay slider', () => {
  const { window: w } = load()
  const both = block(w.FlowOutput.html(fx()), 'Picture')
  assert.match(both, /<div class="ob-seg" role="group" aria-label="Show"><button type="button" data-pic="screens" aria-pressed="true">Screens<\/button><button type="button" data-pic="compare" aria-pressed="false">Compare<\/button><button type="button" data-pic="how" aria-pressed="false">How it works<\/button><\/div>/)
  assert.match(block(w.FlowOutput.html(fx(noBefore)), 'Picture'), /data-pic="screens"[^>]*>Screens<\/button><button type="button" data-pic="how"/)
  w.FlowVisual.pref.set('compare')
  const c = block(w.FlowOutput.html(fx()), 'Picture')
  assert.match(c, /data-pic="compare" aria-pressed="true"/)
  assert.match(c, /<div class="cmp-slider" data-cmp-slider="0" style="--pos: 50%">/)
  assert.match(c, /<img class="cmp-img" src="\/evidence\/dark-mode\/out-after\.png" alt="After: Settings in dark mode, the moon switch on" draggable="false">/)
  assert.match(c, /<div class="cmp-clip"><img class="cmp-img" src="\/evidence\/dark-mode\/out-before\.png" alt="Before: Settings before: always light" draggable="false"><\/div>/)
  assert.match(c, /<div class="cmp-handle" role="slider" tabindex="0" aria-label="Before and after" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" aria-valuetext="50% before"><\/div>/)
  assert.doesNotMatch(c, /cmp-pair|dg-host/, 'one view at a time')
  // Compare remembered, but this flow has no pair: Screens
  assert.match(block(w.FlowOutput.html(fx(noBefore)), 'Picture'), /data-pic="screens" aria-pressed="true"/)
  // the slider keeps where you left it across a redraw
  w.FlowCompare.pos.set('dark-mode', 0, 72)
  assert.match(block(w.FlowOutput.html(fx()), 'Picture'), /style="--pos: 72%"[\s\S]*aria-valuenow="72"/)
})

test('How it works: the diagram of how it worked before sits beside the one of now, each labelled', () => {
  const { window: w } = load()
  w.FlowVisual.pref.set('how')
  const flow = fx(f => { f.output.diagramBefore = { nodes: [{ id: 'old', label: 'Old page' }, { id: 'css', label: 'Fixed colours' }], edges: [{ from: 'old', to: 'css' }] } })
  const p = block(w.FlowOutput.html(flow), 'Picture')
  assert.match(p, /<div class="cmp-how"><figure class="cmp-how-side"><figcaption class="cmp-label">Before<\/figcaption><div class="dg-host" data-dg="howBefore"[\s\S]*Old page[\s\S]*<figure class="cmp-how-side"><figcaption class="cmp-label">Now<\/figcaption><div class="dg-host" data-dg="how"/)
  assert.doesNotMatch(block(w.FlowOutput.html(fx()), 'Picture'), /cmp-how|howBefore/, 'no diagram before: the one diagram alone')
})

test('the layout: a pair takes the whole width, How to test under it; a single result still sits beside it', () => {
  assert.match(FO.html(fx()), /<div class="ob-col">/)
  assert.match(FO.html(fx(noBefore)), /<div class="ob-col ob-split">/)
})

test('the CSS: tokens only, the pair and the two diagrams side by side on a wide stage, nothing animated when motion is reduced', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'flow-compare.css'), 'utf8')
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b|rgb\(/i, 'colours are tokens')
  assert.match(css, /\.cmp-clip \{[^}]*clip-path: inset\(0 calc\(100% - var\(--pos\)\) 0 0\)/)
  assert.match(css, /\.cmp-handle \{[^}]*left: var\(--pos\)/)
  assert.match(css, /@container \(min-width: 1100px\) \{[^@]*\.cmp-how \{[^}]*grid-template-columns/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.cmp-/)
  const index = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  assert.ok(index.indexOf('flow-compare.js') > 0 && index.indexOf('flow-compare.js') < index.indexOf('flow-visual.js'), 'loaded before flow-visual.js')
  assert.match(index, /<link rel="stylesheet" href="flow-compare\.css">/)
  assert.match(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'), /node --check public\/flow-compare\.js/)
})
