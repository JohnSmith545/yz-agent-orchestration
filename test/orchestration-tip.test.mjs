// Tests for where public/orchestration.js puts the grid's hover card. The card
// holds links (its flows), so it takes the pointer: it must never cover the
// chip it describes, or the chip under the pointer stops being clickable. The
// file is a browser script, so it runs here in a vm context with a stub DOM.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const el = () => ({ addEventListener() {}, appendChild() {}, querySelector: () => el(), style: {} })
const document = { ...el(), body: el(), createElement: el }
const window = {}
vm.runInNewContext(fs.readFileSync(path.join(HERE, '..', 'public', 'orchestration.js'), 'utf8'), { window, document })
// copied out of the vm realm, so deepEqual compares plain objects
const spot = (...a) => ({ ...window.OrchestrationGrid.tipSpot(...a) })

/** A chip's viewport rect. */
const chip = (left, top, width = 37, height = 24) => ({ left, top, width, height, right: left + width, bottom: top + height })
const overlaps = (r, s, w, h) => s.x < r.right && s.x + w > r.left && s.y < r.bottom && s.y + h > r.top

test('below the chip when it fits, centred on it', () => {
  const r = chip(500, 100)
  assert.deepEqual(spot(r, 380, 200, 1280, 720), { x: 500 + 18.5 - 190, y: 132 })
})

test('above the chip when only that fits', () => {
  const r = chip(500, 600)
  assert.deepEqual(spot(r, 380, 200, 1280, 720), { x: 500 + 18.5 - 190, y: 392 })
})

test('kept 8 px inside the left and right edges', () => {
  assert.equal(spot(chip(2, 100), 380, 200, 1280, 720).x, 8)
  assert.equal(spot(chip(1260, 100), 380, 200, 1280, 720).x, 1280 - 380 - 8)
})

test('a card too tall for above or below goes beside the chip, not over it (the 101 chip at 1280x720)', () => {
  const r = chip(768, 397)
  const s = spot(r, 380, 488, 1280, 720)
  assert.ok(!overlaps(r, s, 380, 488), JSON.stringify(s))
  assert.equal(s.x, r.right + 8)
  assert.ok(s.y >= 8 && s.y + 488 <= 720 - 8)
})

test('beside on the left when the right has no room', () => {
  const r = chip(1100, 397)
  const s = spot(r, 380, 488, 1280, 720)
  assert.equal(s.x, 1100 - 380 - 8)
  assert.ok(!overlaps(r, s, 380, 488))
})

test('no room anywhere (a narrow window): below the chip, never over it', () => {
  const r = chip(150, 300)
  const s = spot(r, 340, 600, 356, 640)
  assert.equal(s.y, r.bottom + 8)
  assert.ok(!overlaps(r, s, 340, 600))
})
