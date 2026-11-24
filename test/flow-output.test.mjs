// Tests for public/flow-output.js, the Output view of an opened flow, read in
// ten seconds: Story, Picture, How to test, then Details folded away (the
// blocks are flow-story.js, flow-visual.js and flow-steps.js), and
// public/flow-tabs.js, the three tabs and the remembered view. Browser scripts,
// so they run here in a vm context with a stub window and localStorage (model
// and html never touch the DOM). FACTORY_DATA_DIR points at a fresh temp folder
// BEFORE flows.mjs is imported (for derive), so no test touches data/.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'public')
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-output-test-'))
const { derive, DATA_DIR } = await import('../flows.mjs')
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

/** A Map-backed localStorage, or one whose every call throws (a private window, blocked site data). */
const memoryStorage = () => {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }
}
const throwingStorage = () => ({ getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } })

const SCRIPTS = ['shell.js', 'terms.js', 'flow-chart.js', 'diagram-fit.js', 'diagram-route.js', 'diagram.js', 'flow-picture.js', 'flow-drawer.js', 'lightbox.js', 'flow-tabs.js', 'flow-story.js', 'flow-compare.js', 'flow-visual.js', 'flow-steps.js', 'flow-send.js', 'flow-output.js']
/** The page scripts flow-output.js leans on, then its blocks and flow-output.js, in one vm context. */
function load(localStorage = memoryStorage(), window = {}) {
  const ctx = { window, localStorage }
  for (const f of SCRIPTS) vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), ctx)
  return { window, localStorage }
}
const { window } = load()
const FO = window.FlowOutput

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dark-mode.json'), 'utf8'))
/** A fresh copy of the fixture, changed by `edit`, with its derived state attached. */
const fx = (edit = () => {}) => {
  const flow = structuredClone(FIXTURE)
  edit(flow)
  flow.derived = derive(flow)
  return flow
}
const NOVIS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const nv = (edit = () => {}) => {
  const flow = structuredClone(NOVIS)
  edit(flow)
  flow.derived = derive(flow)
  return flow
}
const noShots = f => { delete f.output.result; f.nodes.find(n => n.id === 'n2').evidence = [] }
/** The fixture with no before and after (flow-compare.test.mjs tests that): the plain Picture. */
const noBefore = f => { f.output.result = f.output.result.filter(r => r.when !== 'before'); delete f.output.change }
/** Objects made inside the vm have its prototypes, so strict deepEqual needs plain copies. */
const plain = v => JSON.parse(JSON.stringify(v))
const node = (flow, id) => flow.nodes.find(n => n.id === id)
/** The text of every block head, in order, tags stripped. */
const heads = h => [...h.matchAll(/<h3 class="ob-h">([\s\S]*?)<\/h3>/g)].map(m => m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
/** One block's markup: from its aria-label to the next block. */
const block = (h, name) => {
  const at = h.indexOf(`aria-label="${name}"`)
  const next = h.slice(at + 1).search(/<(section|details) class="ob /)
  return next < 0 ? h.slice(at) : h.slice(at, at + 1 + next)
}

// ═══ model ═══

test('model: a full output is what the agent wrote, and complete', () => {
  const m = plain(FO.model(fx()))
  assert.deepEqual(m.result, [{ ref: 'dark-mode/out-after.png', caption: 'Settings in dark mode, the moon switch on', at: '2026-11-12T08:35:00Z' }])
  assert.equal(m.summary, FIXTURE.output.summary)
  assert.deepEqual(m.changes, [{ kind: 'commit', ref: 'ab12cd3', label: 'web: theme tokens', at: null }])
  assert.deepEqual(m.testing.map(t => [t.id, t.do, t.expect, t.shot]), [
    ['t1', 'Open Settings and click the moon next to Theme.', 'The page turns dark at once.', 'dark-mode/out-t1-moon.png'],
    ['t2', 'Reload the page.', 'It is still dark, even with [prefers-color-scheme] set to light.', 'dark-mode/out-t2-reload.png'],
  ])
  assert.deepEqual(m.source, { result: 'agent' })
  assert.equal(m.requestedAt, null)
  assert.equal(m.complete, true)
  assert.deepEqual(m.story.lines.map(l => l.who), ['Agent 3', 'Agent 3', 'Agent 3'])
  assert.equal(m.story.derived, false)
  assert.equal(m.picture, null, 'no chart drawn from the flow when there is a visual')
})

test('model: with no output the result and changes come from the flow: its latest shots and the commits in its evidence', () => {
  const m = plain(FO.model(fx(f => { delete f.output })))
  assert.deepEqual(m.result, [{ ref: 'dark-mode/toggle.png', caption: 'toggle ok', at: '2026-11-12T08:25:00Z', nodeId: 'n2' }])
  assert.equal(m.summary, '')
  assert.deepEqual(m.changes, [{ kind: 'commit', ref: 'ab12cd3', label: 'web: theme tokens', at: '2026-11-12T08:10:00Z' }])
  assert.deepEqual(m.testing, [])
  assert.deepEqual(m.source, { result: 'derived' })
  assert.equal(m.complete, false)
  assert.equal(m.story.derived, true, 'no story written: the derived one')
  assert.ok(m.story.lines.length >= 1)
})

test('model: the derived Result leads with the LATEST screenshot in the flow', () => {
  const m = plain(FO.model(fx(f => {
    delete f.output
    node(f, 'n2').evidence.push({ kind: 'shot', ref: 'dark-mode/later.png', label: 'later', at: '2026-11-12T09:30:00Z' })
  })))
  assert.deepEqual(m.result.map(s => s.ref), ['dark-mode/later.png', 'dark-mode/toggle.png'])
})

test('model: the visual is shots over the agent diagram over the auto chart, as flows.mjs visualOf says', () => {
  const cases = [
    [fx(), 'shots'],
    [fx(f => { delete f.output.diagram }), 'shots'],
    [fx(noShots), 'diagram'],
    [fx(f => { noShots(f); delete f.output.diagram }), 'auto'],
    [nv(), 'auto'],
  ]
  for (const [flow, want] of cases) {
    assert.equal(FO.model(flow).visual, want)
    assert.equal(FO.model(flow).visual, flow.derived.output.visual, 'the page and the server agree')
  }
})

// ═══ html: three blocks, then Details ═══

test('html: the Story leads with no head, then Before → Now, Picture and How to test, then Details folded away; no Built stage and no arrows', () => {
  const h = FO.html(fx())
  assert.deepEqual(heads(h), ['How to test · 2'], 'the Story is the lead and the Picture just a picture: no heads')
  const at = name => h.indexOf(`aria-label="${name}"`)
  assert.ok(at('Story') >= 0 && at('Story') < at('What changed') && at('What changed') < at('Picture') && at('Picture') < at('How to test') && at('How to test') < at('Details'))
  assert.match(h, /<section class="ob ob-change" aria-label="What changed"[^>]*><div class="cmp-strip">/, 'Before → Now is its own slim block')
  assert.doesNotMatch(block(h, 'Picture'), /cmp-strip/, 'and no longer inside the Picture')
  assert.doesNotMatch(h.match(/<details class="ob ob-details"[^>]*>/)[0], /\bopen\b/, 'Details is closed by default')
  assert.doesNotMatch(h, /sb-arrow|aria-label="Built"|>Built</)
  const src = ['flow-output.js', 'flow-story.js', 'flow-visual.js', 'flow-steps.js', 'flows.css', 'flow-output.css', 'diagram.css']
    .map(f => fs.readFileSync(path.join(PUBLIC, f), 'utf8')).join('\n')
  assert.doesNotMatch(src, /sb-arrow|builtStage|sb-impl|sb-built|sb-stage/, 'the Built stage and the arrows are gone from the code and the CSS')
})

test('Story: one line per story line, the name chip once per run of lines by the same person, the sentence, and Why? under it', () => {
  const s = block(FO.html(fx()), 'Story')
  assert.equal((s.match(/<li class="st-line(?! st-ask)/g) || []).length, 3, 'the open ask is its own answerable line (flows-ui.test.mjs)')
  assert.equal((s.match(/<span class="st-who st-c\d">Agent 3<\/span>/g) || []).length, 1, 'three lines by Agent 3: one chip')
  assert.equal((s.match(/<span class="st-who-gap" aria-hidden="true"><\/span>/g) || []).length, 2, 'the later lines sit under it')
  const mixed = block(FO.html(fx(f => { f.output.story[1].who = 'Agent 1' })), 'Story')
  assert.equal((mixed.match(/<span class="st-who st-c\d">/g) || []).length, 3, 'a change of person shows the chip again')
  assert.match(s, /<p class="st-did">Turned every colour on the page into a <dfn class="t-chip" data-term="theme token" data-raw="theme token" tabindex="0">theme token<\/dfn>\.<\/p>/)
  assert.match(s, /<p class="st-why"><span class="st-why-k">Why\?<\/span> So one switch changes the whole page at once<\/p>/)
  assert.match(s, /Checked the toggle in the browser with screenshots\.<\/p><\/div><\/li>/, 'no Why? line when there is no why')
  assert.doesNotMatch(s, /class="sb-tag"/, 'written by the agent: no auto tag')
  assert.doesNotMatch(s, /\[theme token\]/, 'no brackets shown')
})

test('Story: the same name always gets the same colour, and different names spread over the tints', () => {
  const S = window.FlowStory
  assert.equal(S.tint('Agent 3'), S.tint('Agent 3'))
  assert.ok(new Set(['Agent 1', 'Agent 2', 'Agent 3', 'Coordinator', 'Independent'].map(S.tint)).size >= 3)
  assert.equal(S.tint('You'), 'st-you')
})

test('Story: a derived story looks the same, and the auto tag sits in its corner', () => {
  const s = block(FO.html(nv()), 'Story')
  assert.match(s, /<span class="ob-corner"><span class="sb-tag">auto<\/span><\/span>/)
  assert.doesNotMatch(s, /<h3/)
  assert.match(s, /<span class="st-who st-c\d">Agent 3<\/span><div class="st-text"><p class="st-did">Finished 7 steps\.<\/p>/)
  assert.equal((s.match(/<li class="st-line/g) || []).length, 3, 'a derived story is at most 3 lines')
  assert.match(s, /<span class="st-who st-you">You<\/span><div class="st-text"><p class="st-did">To decide: Turn off the old scheduler now\?<\/p>/)
})

test('Picture: screenshots alone are one big image; a diagram alone, or neither, is one chart', () => {
  const shots = block(FO.html(fx(f => { noBefore(f); delete f.output.diagram })), 'Picture')
  assert.match(shots, /<figure class="pv-hero">[\s\S]*src="\/evidence\/dark-mode\/out-after\.png"/)
  assert.doesNotMatch(shots, /dg-host|data-pic=/)
  const diagram = block(FO.html(fx(noShots)), 'Picture')
  assert.match(diagram, /<div class="dg-host" data-dg="how"/)
  assert.doesNotMatch(diagram, /pv-hero|data-pic=/)
  assert.doesNotMatch(shots + diagram, /<h3/, 'one view: no head, no lonely switch')
  const auto = block(FO.html(nv()), 'Picture')
  assert.match(auto, /<span class="ob-corner"><button type="button" class="link sb-request"/, 'Request visuals in the corner, no auto chip')
  assert.doesNotMatch(auto, /<h3/)
  assert.match(auto, /<div class="dg-host" data-dg="picture"/)
  assert.match(auto, /<p class="pv-line small">7 done · 5 left · 2 decisions<\/p>/)
})

test('Picture: screenshots and a diagram show ONE at a time, with a Screens | How it works switch remembered in this browser', () => {
  const { window: w, localStorage } = load()
  const both = block(w.FlowOutput.html(fx(noBefore)), 'Picture')
  assert.match(both, /<div class="ob-seg" role="group" aria-label="Show"><button type="button" data-pic="screens" aria-pressed="true">Screens<\/button><button type="button" data-pic="how" aria-pressed="false">How it works<\/button><\/div>/)
  assert.match(both, /pv-hero/)
  assert.doesNotMatch(both, /dg-host/, 'not both at once')
  w.FlowVisual.pref.set('how')
  assert.equal(localStorage._m.get('flows.picture'), '"how"')
  const how = block(w.FlowOutput.html(fx(noBefore)), 'Picture')
  assert.match(how, /data-pic="how" aria-pressed="true"/)
  assert.match(how, /<div class="dg-host" data-dg="how"/)
  assert.doesNotMatch(how, /pv-hero/)
  assert.equal(load(throwingStorage()).window.FlowVisual.pref.get(), 'screens', 'storage that throws: Screens')
})

test('Picture: the auto chart opens a step on Status, an agent diagram is not clickable', () => {
  assert.match(block(FO.html(nv()), 'Picture'), /data-goto="n1"/)
  assert.doesNotMatch(block(FO.html(fx(noShots)), 'Picture'), /data-goto=/)
})

test('How to test: cards in a row, a fixed picture box (the screenshot, or a drawn tile), the step, Expect, and I saw this at the bottom', () => {
  const t = block(FO.html(fx(f => { delete f.output.testing[1].shot })), 'How to test')
  assert.match(t, /<li class="ts-card"[^>]*><div class="ts-pic"><b class="ts-num">1<\/b><a [^>]*><img class="fl-shot" src="\/evidence\/dark-mode\/out-t1-moon\.png"/)
  assert.match(t, /<div class="ts-pic"><b class="ts-num">2<\/b><div class="ts-tile" aria-hidden="true"><\/div><\/div>/, 'a quiet numbered placeholder: the step is said once, below it')
  assert.match(t, /<p class="ts-do">Open Settings and click the moon next to Theme\.<\/p><p class="ts-expect"><span>Expect<\/span> The page turns dark at once\.<\/p><label class="check ts-saw">/)
  assert.match(t, /<span>Expect<\/span> It is still dark, even with <dfn class="t-chip" data-term="prefers color scheme" data-raw="prefers-color-scheme"/)
  assert.equal((t.match(/ts-tile/g) || []).length, 1)
})

test('Details: the summary through md with chips, and Changes · N, collapsed; nothing at all when there is neither', () => {
  const d = block(FO.html(fx(f => { f.output.summary = 'Uses a [theme token] now.' })), 'Details')
  assert.match(d, /<summary class="ob-sum"><span class="ob-h">Details<\/span>/)
  assert.match(d, /Uses a <dfn class="t-chip" data-term="theme token"/)
  assert.match(d, /<details class="ob-changes" data-sb="changes"><summary class="sb-sub">Changes <span class="faint">· 1<\/span><\/summary>/)
  assert.match(d, /<details>[\s\S]*?ab12cd3/, 'a change is collapsed too')
  assert.doesNotMatch(FO.html({ id: 'bare', title: 'Bare', nodes: [] }), /aria-label="Details"/)
})

test('Details stays open across a redraw once you open it (kept per flow in this browser)', () => {
  const { window: w } = load()
  w.FlowOutput.details.set('dark-mode', true)
  assert.match(w.FlowOutput.html(fx()), /<details class="ob ob-details"[^>]* open>/)
  w.FlowOutput.details.set('dark-mode', false)
  assert.doesNotMatch(w.FlowOutput.html(fx()), /<details class="ob ob-details"[^>]* open>/)
})

test('an empty flow: one line per empty block, and the Picture still draws a box', () => {
  const empty = FO.html({ id: 'bare', title: 'Bare', nodes: [] })
  assert.deepEqual(heads(empty), ['How to test'])
  for (const line of ['Nothing yet.', 'No test steps yet.']) assert.equal(empty.split(line).length - 1, 1, line)
  assert.match(empty, /<svg class="dg[^"]*"[\s\S]*No steps yet/)
})

test('no block carries a ? of its own: the opened flow has ONE, whose popover has a short paragraph per block', () => {
  for (const flow of [fx(), nv()]) assert.doesNotMatch(FO.html(flow), /class="help"|data-ob-help/)
  assert.equal(FO.html(fx()).includes('No result screenshot yet'), false)
})

test('Request visuals sits in the Picture head when there is no visual of the agent; How to test then has no button of its own', () => {
  const h = FO.html(nv())
  assert.match(block(h, 'Picture'), /data-sb-request[^>]*>Request visuals<\/button>/)
  assert.match(block(h, 'Picture'), /<form class="sb-req-form" data-sb-form/, 'the note form opens under the button')
  assert.doesNotMatch(block(h, 'How to test'), /data-sb-request|data-sb-form/)
  const shots = FO.html(fx())
  assert.doesNotMatch(block(shots, 'Picture'), /data-sb-request/)
  assert.match(block(shots, 'How to test'), /data-sb-request[^>]*>Ask again<\/button>/)
})

test('the auto chart: at most 7 shapes, solid done, dashed left, diamonds, the answer on the arrow', () => {
  const h = FO.html(nv())
  const svg = h.slice(h.indexOf('<svg class="dg'), h.indexOf('</svg>'))
  assert.ok((svg.match(/<g class="dg-node/g) || []).length <= 7)
  assert.match(svg, /<g class="dg-node dg-box dg-done" data-goto="n1"/)
  assert.match(svg, /<g class="dg-node dg-box dg-left dg-blocked" data-goto="n9"[^>]*>[\s\S]*?class="dg-sub"[^>]*>1 blocked</)
  assert.match(svg, /<g class="dg-node dg-decision dg-ask dg-open" data-goto="n12"/)
  assert.match(svg, /<text [^>]*>Yes<\/text>/, 'the answer on the arrow out of the ask')
  assert.doesNotMatch(svg, />\?<\/text>|class="dg-mark"/, 'no ? on an open question, no proof dots')
})

// ═══ the request button and the checklist (unchanged behaviour) ═══

test('the request button reads Request visuals with no screenshot and no diagram, and asks for both', () => {
  const none = FO.html(nv())
  assert.match(none, /data-sb-request[^>]*title="Ask Agent 3 for a result screenshot or a diagram of how it works, and the test steps \(about \$0\.30\)"[^>]*>Request visuals<\/button>/)
  assert.match(FO.html(fx(noShots)), /data-sb-request[^>]*>Ask again<\/button>/, 'a diagram is a visual')
  assert.match(FO.html(fx(f => { noShots(f); f.output.testing = [] })), /data-sb-request[^>]*>Request test steps<\/button>/)
})

test('html escapes every agent string: a caption, a step, a story line; the summary goes through md only', () => {
  const h = FO.html(fx(f => {
    f.output.result[0].caption = '<img src=x onerror=alert(1)>'
    f.output.result[0].ref = 'dark-mode/a b?.png'
    f.output.testing[0].do = '<script>alert(2)</script>'
    f.output.testing[0].expect = '"><svg onload=alert(3)>'
    f.output.summary = '<b>bold</b>'
    f.output.story[0].did = '<img src=y onerror=alert(4)> [<b>x</b>]'
  }))
  assert.doesNotMatch(h, /<img src=[xy]/)
  assert.doesNotMatch(h, /<script>/)
  assert.doesNotMatch(h, /<svg onload/)
  assert.doesNotMatch(h, /<b>bold<\/b>|<b>x<\/b>/)
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(h, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/)
  assert.match(h, /\/evidence\/dark-mode\/a%20b%3F\.png/, 'refs are encoded per segment')
  const md = load(memoryStorage(), { FactoryChat: { md: s => `<p class="md">${String(s).replace(/</g, '&lt;')}</p>` } }).window.FlowOutput
  assert.match(md.html(fx()), /<p class="md">Every colour on the page is now a \*\*theme token\*\*/)
})

test('the request button says Request test steps with no steps, Ask again with some, and carries the cost', () => {
  const none = FO.html(fx(f => { f.output.testing = [] }))
  assert.match(none, /<button type="button" class="link sb-request" data-sb-request[^>]*title="[^"]*about \$0\.30[^"]*"[^>]*>Request test steps<\/button>/)
  assert.match(FO.html(fx()), /data-sb-request[^>]*>Ask again<\/button>/)
  assert.match(none, /<form class="sb-req-form" data-sb-form[^>]*hidden>[\s\S]*?maxlength="500"[\s\S]*?>Send<\/button>/)
})

test('a request younger than 30 minutes with no step since shows in the head; a newer step or age ends it', () => {
  const at = Date.parse('2026-11-13T10:00:00Z')
  const asked = fx(f => { f.output.requestedAt = '2026-11-13T10:00:00Z' })
  // The time is Shell.ago's, like every relative time on the pages (test/copy.test.mjs): under a minute is now.
  assert.match(FO.html(asked, at + 20_000), /<span class="sb-requested[^"]*">requested now<\/span>/)
  assert.match(FO.html(asked, at + 3 * 60_000), />requested 3m</)
  assert.doesNotMatch(FO.html(asked, at + 31 * 60_000), /sb-requested/, 'older than 30 minutes')
  const answered = fx(f => {
    f.output.requestedAt = '2026-11-13T10:00:00Z'
    f.output.testing[1].at = '2026-11-13T10:02:00Z'
  })
  assert.doesNotMatch(FO.html(answered, at + 3 * 60_000), /sb-requested/, 'a step arrived after the request')
})

test('a request the relay could not deliver says not sent, with the reason in its title, and the button says Ask again', () => {
  const at = Date.parse('2026-11-13T10:00:00Z')
  const failed = fx(f => Object.assign(f.output, { testing: [], requestedAt: '2026-11-13T10:00:00Z', requestError: 'FAILED: no session named "Agent 3"' }))
  const h = FO.html(failed, at + 3 * 60_000)
  assert.match(h, /<span class="sb-requested sb-unsent[^"]*" title="FAILED: no session named &quot;Agent 3&quot;">not sent<\/span>/)
  assert.doesNotMatch(h, />requested /)
  assert.match(h, /data-sb-request[^>]*>Ask again<\/button>/, 'even with no steps yet')
  assert.match(FO.html(failed, at + 5 * 3600_000), /not sent/, 'a failure stays until asked again, however old')
  const sent = fx(f => Object.assign(f.output, { requestedAt: '2026-11-13T10:00:00Z', requestSentAt: '2026-11-13T10:00:30Z' }))
  assert.match(FO.html(sent, at + 3 * 60_000), />requested 3m</, 'sent: requested shows')
})

test('the Changes list is a keyed piece of its own, so a new summary does not close it', () => {
  assert.match(FO.html(fx()), /<details class="ob-changes" data-sb="changes">/)
})

test('the I saw this checklist is local: it survives a re-render, ignores steps that are gone, and a throwing localStorage', () => {
  const { window: w, localStorage } = load()
  const flow = fx()
  const [t1, t2] = flow.output.testing.map(t => w.FlowOutput.checklist.of(t))
  assert.equal(t1, 't1@2026-11-12T08:36:00Z', 'a tick is the step id and when it was recorded')
  assert.doesNotMatch(w.FlowOutput.html(flow), /checked</, 'no count before the first tick')
  w.FlowOutput.checklist.set('dark-mode', t1, true)
  w.FlowOutput.checklist.set('dark-mode', 'gone@x', true)
  assert.deepEqual(JSON.parse(localStorage._m.get('flows.tested.dark-mode')), [t1, 'gone@x'])
  for (let fill = 0; fill < 2; fill++) {
    const h = w.FlowOutput.html(flow)
    assert.match(h, /1\/2 checked/, 'the step that is gone does not count')
    assert.match(h, new RegExp(`data-sb-saw="${t1}" checked`))
    assert.match(h, new RegExp(`data-sb-saw="${t2}">`))
  }
  w.FlowOutput.checklist.set('dark-mode', t1, false)
  assert.doesNotMatch(w.FlowOutput.html(flow), /\d\/2 checked/)
  assert.equal(JSON.stringify(flow).includes('tested'), false, 'never written to the flow')

  const bad = load(throwingStorage()).window.FlowOutput
  assert.doesNotThrow(() => bad.checklist.set('dark-mode', t1, true))
  assert.deepEqual(plain(bad.checklist.get('dark-mode')), [])
  assert.doesNotMatch(bad.html(flow), /\d\/2 checked/)
})

test('ticks never carry over to steps recorded again: test-clear then t1, t2 anew, or a --replace, read 0/N', () => {
  const { window: w } = load()
  const flow = fx()
  for (const t of flow.output.testing) w.FlowOutput.checklist.set('dark-mode', w.FlowOutput.checklist.of(t), true)
  assert.match(w.FlowOutput.html(flow), /2\/2 checked/)
  // the agent cleared the steps and recorded them again: same ids, new times (what flow-cli.mjs writes)
  const again = fx(f => { f.output.testing.forEach((t, i) => { t.at = `2026-11-13T09:0${i}:00Z` }) })
  const h = w.FlowOutput.html(again)
  assert.doesNotMatch(h, /\d\/2 checked/)
  assert.doesNotMatch(h, /data-sb-saw="[^"]*" checked/)
})

test('the Output CSS: one column of quiet blocks, test cards that wrap instead of scrolling, a fixed 16:10 picture box, tokens only', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'flow-output.css'), 'utf8')
  assert.match(css, /\.ob \{[^}]*border: 1px solid var\(--line\)[^}]*border-radius: var\(--radius\)/)
  assert.doesNotMatch(css.match(/\.ob \{[^}]*\}/)[0], /box-shadow/)
  assert.match(css, /\.ts-row \{[^}]*flex-wrap: wrap[^}]*overflow: hidden/, 'a wrapped line start hides its arrow outside the box')
  assert.match(css, /\.ts-pic \{[^}]*aspect-ratio: 16 \/ 10/)
  assert.match(css, /\.ts-pic \.fl-shot \{[^}]*object-fit: cover/)
  assert.match(css, /\.sb-unsent \{[^}]*color: var\(--warn\)/)
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b|rgb\(/i, 'colours are tokens')
  assert.match(css, /\.pv-hero \.fl-shot \{[^}]*max-height: min\(280px, 36vh\)/)
  assert.match(css, /@container \(min-width: 1100px\) \{[^@]*\.ob-split \{[^}]*grid-template-columns/, 'a wide stage puts the screenshot and How to test side by side')
})

test('screenshots on show: the column is marked to put the picture and How to test side by side on a wide stage; a chart is not', () => {
  assert.match(FO.html(fx(f => { noBefore(f); delete f.output.diagram })), /<div class="ob-col ob-split">/)
  assert.match(FO.html(nv()), /<div class="ob-col">/)
  assert.match(FO.html(fx(noShots)), /<div class="ob-col">/, 'a diagram needs the whole width')
})

// ═══ the three tabs: flow-tabs.js ═══

test('flows.view accepts output, status and process, defaults to output, and survives a throwing localStorage', () => {
  const ok = load()
  const T = ok.window.FlowTabs
  assert.equal(T.view.get(), 'output')
  for (const v of ['status', 'process', 'output']) {
    T.view.set(v)
    assert.equal(ok.localStorage._m.get('flows.view'), JSON.stringify(v))
    assert.equal(T.view.get(), v)
  }
  ok.localStorage.setItem('flows.view', '"sideways"')
  assert.equal(T.view.get(), 'output', 'an unknown value reads as output')
  ok.localStorage.setItem('flows.view', 'not json')
  assert.equal(T.view.get(), 'output')
  const bad = load(throwingStorage()).window.FlowTabs
  assert.equal(bad.view.get(), 'output')
  assert.doesNotThrow(() => bad.view.set('status'))
})

test('the tabs are real tabs, Output Explain Status Process, one in the tab order; the arrow keys wrap', () => {
  const T = window.FlowTabs
  const t = T.tabs('status')
  assert.match(t, /role="tablist"/)
  assert.deepEqual([...t.matchAll(/data-view="([a-z]+)">([A-Za-z]+)</g)].map(m => [m[1], m[2]]), [['output', 'Output'], ['explain', 'Explain'], ['status', 'Status'], ['process', 'Process']])
  assert.match(t, /aria-controls="flPanelStatus" aria-selected="true" tabindex="0"/)
  assert.equal((t.match(/tabindex="0"/g) || []).length, 1)
  assert.equal(T.step('output', 1), 'explain')
  assert.equal(T.step('explain', 1), 'status')
  assert.equal(T.step('process', 1), 'output')
  assert.equal(T.step('output', -1), 'process')
})
