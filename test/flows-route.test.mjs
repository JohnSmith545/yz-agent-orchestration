// The Flows page gets its own route (spec 5): every link that used to go to the
// Factory page for a flow now goes to #/flows, the rest to #/tickets, and only
// shell.js still knows the old #/factory hash (its redirect table). Plus
// Shell.whenReady, the one wait-for-the-page helper notify.js, orchestration.js
// and flows.js share, run in a vm with a bare window and a fake document.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUB = path.join(HERE, '..', 'public')
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8')

// ═══ grep: no page links to the Factory route any more ═══

test('no #/factory literal is left in public/*.js except shell.js', () => {
  const hits = fs
    .readdirSync(PUB)
    .filter(f => f.endsWith('.js') && f !== 'shell.js')
    .filter(f => read(f).includes('#/factory'))
  assert.deepEqual(hits, [])
})

test('no script still waits for the Factory page or names it in a toast', () => {
  assert.doesNotMatch(read('notify.js'), /toFactory|onFactory|Factory page|Factory chat/)
})

test('the Flows page is wired: its own script, after flows.js, opened by the shell, checked by npm run check', () => {
  const html = read('index.html')
  const at = s => html.indexOf(`<script src="${s}"></script>`)
  assert.ok(at('flows-page.js') > at('flows.js') && at('flows.js') > 0, 'flows-page.js loads after flows.js')
  assert.match(read('shell.js'), /flows: 'FlowsPage'/)
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  assert.match(pkg.scripts.check, /node --check public\/flows-page\.js/)
})

test('the Output charts are wired: diagram.js and flow-picture.js load after flow-chart.js and before flow-output.js, and are checked', () => {
  const html = read('index.html')
  const at = s => html.indexOf(`<script src="${s}"></script>`)
  assert.ok(at('flow-chart.js') > 0 && at('flow-chart.js') < at('diagram.js'), 'diagram.js measures text with FlowChart')
  assert.ok(at('diagram.js') < at('flow-output.js') && at('flow-picture.js') < at('flow-output.js'))
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  for (const f of ['public/diagram.js', 'public/flow-picture.js', 'diagram-text.mjs']) assert.ok(pkg.scripts.check.includes(`node --check ${f}`), f)
})

test('a box of the Output chart opens that step on Status, by click or by Enter, revealing its row once, without making Status the remembered tab', () => {
  const src = read('flows.js')
  const line = (/e\.target\.closest\('\.fl-out \[data-goto\]'\)[^\n]*\n\s*(if \(pic\) [^\n]*)/.exec(src)?.[1] || '').trim()
  assert.equal(line, "if (pic) { opened.node = opened.reveal = pic.dataset.goto; view = 'status'; showView(); return renderOpened() }")
  assert.doesNotMatch(line, /setView/, 'setView would store flows.view: Output stays the tab a flow opens on')
  assert.match(src, /if \(e\.target\.closest\('\.fl-out \[data-goto\]'\)\) return onBoardClick\(e\)/)
})

test('flows.js mounts the strip alone for Home, and Home mounts it', () => {
  assert.match(read('flows.js'), /mountStrip\(/)
  assert.match(read('flows.js'), /unmountStrip\(/)
  assert.match(read('app.js'), /FlowsView\??\.mountStrip\(/)
})

test('the grid hover card and the toasts open a flow through FlowsView.gotoFlow', () => {
  assert.match(read('orchestration.js'), /FlowsView\??\.gotoFlow\(/)
  assert.match(read('notify.js'), /FlowsView\??\.gotoFlow\(/)
})

test('the timeline page says Timeline, not Flow', () => {
  assert.doesNotMatch(read('flow.js'), /aria-label="Flowchart/)
  assert.match(read('index.html'), /<section id="flowView" aria-label="Timeline"/)
})

// ═══ Shell.whenReady ═══

/** shell.js in a vm with no document at load (the DOM code returns early); a fake one is attached after. */
function loadShell() {
  const window = {}
  vm.runInNewContext(read('shell.js'), { window, setTimeout, clearTimeout })
  let el = null
  window.document = { querySelector: s => (s === '#flowsView #fxFlows' ? el : null) }
  return { Shell: window.Shell, appear: () => (el = { id: 'fxFlows' }) }
}

test('Shell.whenReady calls back with the element once it appears', async () => {
  const { Shell, appear } = loadShell()
  let got = null
  const done = Shell.whenReady('#flowsView #fxFlows', el => (got = el), 2000)
  setTimeout(appear, 120)
  const el = await done
  assert.deepEqual(el, { id: 'fxFlows' })
  assert.equal(got, el)
})

test('Shell.whenReady calls back at once when the element is already there', async () => {
  const { Shell, appear } = loadShell()
  appear()
  let calls = 0
  const el = await Shell.whenReady('#flowsView #fxFlows', () => calls++, 2000)
  assert.ok(el)
  assert.equal(calls, 1)
})

test('Shell.whenReady gives up after its timeout without calling back', async () => {
  const { Shell } = loadShell()
  let calls = 0
  const t0 = Date.now()
  const el = await Shell.whenReady('#nothing', () => calls++, 150)
  assert.equal(el, null)
  assert.equal(calls, 0)
  assert.ok(Date.now() - t0 >= 140, 'it waited for the timeout')
})

// ═══ fix round 1: the header dot brings the strip into view, below the sticky header ═══

test('the header dot goes through FlowsView.gotoFlow, so it scrolls the strip even on #/flows', () => {
  assert.match(read('shell.js'), /pageWaiting'\)\?\.addEventListener\('click', \(\) => \(window\.FlowsView\?\.gotoFlow \? window\.FlowsView\.gotoFlow\(\) : go\('#\/flows'\)\)\)/)
})

test('the Timeline page error says timeline, not flow', () => {
  assert.doesNotMatch(read('flow.js'), /load the flow/)
  assert.match(read('flow.js'), /Could not load the timeline/)
})

/**
 * flows.js in a vm: no DOM at load, so a fake Shell, document and fetch are enough.
 * The page head is 48 px tall; a box records where it was scrolled.
 */
function loadFlows() {
  const calls = { go: [], ready: [] }
  const window = {
    Shell: {
      go: h => calls.go.push(h),
      whenReady: (sel, fn) => calls.ready.push({ sel, fn }),
      setWaiting() {},
    },
  }
  const document = { querySelector: s => (s === '#pageHead' ? { offsetHeight: 48 } : null), activeElement: null }
  const box = () => ({ style: {}, innerHTML: '', hidden: false, addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [], scrollIntoView(o) { this.scrolled = o } })
  const fetch = () => new Promise(() => {}) // never lands: the test drives no render
  vm.runInNewContext(read('flows.js'), { window, document, fetch, localStorage: { getItem: () => null, setItem() {} }, setInterval: () => 1, clearInterval() {} })
  return { FlowsView: window.FlowsView, calls, box }
}

test('gotoFlow() off the Flows page goes there and waits for a strip that is showing', () => {
  const { FlowsView, calls } = loadFlows()
  FlowsView.gotoFlow()
  assert.deepEqual(calls.go, ['#/flows'])
  assert.equal(calls.ready.length, 1)
  assert.equal(calls.ready[0].sel, '#flowsView #fxWaiting:not([hidden])')
})

test('gotoFlow() on the Flows page scrolls the strip into view, clear of the sticky header', () => {
  const { FlowsView, calls, box } = loadFlows()
  const strip = box()
  FlowsView.mount(strip, box())
  strip.hidden = false
  FlowsView.gotoFlow()
  assert.deepEqual(calls.go, [])
  assert.equal(strip.style.scrollMarginTop, '64px')
  assert.equal(strip.scrolled?.block, 'start')
})
