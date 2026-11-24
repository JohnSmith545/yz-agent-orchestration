// Tests for public/script-sound.js: the soft completion pop of the SCRIPT page, made
// with the Web Audio API (no audio file), its pure tone parameters, the AudioContext
// made or resumed from the Generate click, and the mute switch kept in localStorage.
// A browser script in a vm: the AudioContext and the storage are stubs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', 'public', 'script-sound.js'), 'utf8')
const load = (window = {}) => (vm.runInNewContext(SRC, { window }), window.ScriptSound)
const S = load()
const plain = v => JSON.parse(JSON.stringify(v))

// ═══ the tone ═══

test('the pop is short, soft and falling: a sine under 150 ms, peak gain 0.06 to 0.1, a pitch drop', () => {
  const t = S.popTone()
  assert.equal(t.type, 'sine')
  assert.ok(t.durationS > 0 && t.durationS * 1000 < 150, `${t.durationS * 1000} ms`)
  assert.ok(t.peakGain >= 0.06 && t.peakGain <= 0.1, `peak ${t.peakGain}`)
  assert.ok(t.endHz < t.startHz, 'the pitch drops')
  assert.ok(t.startHz <= 1000 && t.endHz >= 200, 'mid-range: never shrill, never a thud')
  assert.ok(t.attackS > 0 && t.attackS <= 0.01, 'a fast attack')
  assert.ok(t.glideS > 0 && t.glideS <= t.durationS)
  assert.ok(t.floorGain > 0 && t.floorGain < 0.001, 'exponential ramps need a floor above zero')
})

test('popTone hands out a fresh copy each time: a caller cannot change the next pop', () => {
  const a = S.popTone()
  a.peakGain = 1
  assert.notEqual(S.popTone().peakGain, 1)
})

// ═══ playing it ═══

function fakeCtx({ state = 'running', throws = false } = {}) {
  const calls = []
  const param = name => ({
    setValueAtTime: (v, t) => calls.push([`${name}.set`, v, t]),
    linearRampToValueAtTime: (v, t) => calls.push([`${name}.linear`, v, t]),
    exponentialRampToValueAtTime: (v, t) => calls.push([`${name}.exp`, v, t]),
  })
  const node = kind => ({ kind, connect: to => calls.push(['connect', kind, to.kind || 'destination']), disconnect: () => calls.push(['disconnect', kind]) })
  return {
    calls, state, currentTime: 2,
    destination: { kind: 'destination' },
    resume: () => (calls.push(['resume']), Promise.resolve()),
    createOscillator() {
      if (throws) throw new Error('no audio')
      return { ...node('osc'), type: '', frequency: param('freq'), start: t => calls.push(['start', t]), stop: t => calls.push(['stop', t]), set onended(f) { calls.push(['onended']) } }
    },
    createGain: () => ({ ...node('gain'), gain: param('gain') }),
  }
}

test('play schedules one sine: pitch from start to end, gain up fast to the peak and down to the floor, then stops', () => {
  const ctx = fakeCtx()
  const t = S.popTone()
  assert.equal(S.play(ctx), true)
  const c = plain(ctx.calls)
  const at = 2
  const find = name => c.filter(x => x[0] === name)
  assert.deepEqual(find('freq.set'), [['freq.set', t.startHz, at]])
  assert.deepEqual(find('freq.exp'), [['freq.exp', t.endHz, at + t.glideS]])
  assert.deepEqual(find('gain.set'), [['gain.set', t.floorGain, at]])
  assert.deepEqual(find('gain.linear'), [['gain.linear', t.peakGain, at + t.attackS]])
  assert.deepEqual(find('gain.exp'), [['gain.exp', t.floorGain, at + t.durationS]])
  assert.deepEqual(find('start'), [['start', at]])
  assert.ok(find('stop')[0][1] > at + t.durationS && find('stop')[0][1] < at + 0.2, 'stops just after the tail')
  assert.ok(c.some(x => x[0] === 'connect' && x[1] === 'osc' && x[2] === 'gain'))
  assert.ok(c.some(x => x[0] === 'connect' && x[1] === 'gain' && x[2] === 'destination'))
})

test('play never throws: no context, or one that fails, is simply no sound', () => {
  assert.equal(S.play(null), false)
  assert.equal(S.play(fakeCtx({ throws: true })), false)
})

// ═══ the context, from the Generate click ═══

test('ensureContext makes one AudioContext and reuses it, resuming it when suspended', () => {
  let made = 0
  const ctx = fakeCtx({ state: 'suspended' })
  const S2 = load({ AudioContext: function () { made++; return ctx } })
  assert.equal(S2.ensureContext(), ctx)
  assert.equal(S2.ensureContext(), ctx)
  assert.equal(made, 1)
  assert.ok(ctx.calls.filter(c => c[0] === 'resume').length >= 1)
})

test('ensureContext falls back to webkitAudioContext, and is null with no Web Audio or when it throws', () => {
  const ctx = fakeCtx()
  assert.equal(load({ webkitAudioContext: function () { return ctx } }).ensureContext(), ctx)
  assert.equal(load({}).ensureContext(), null)
  assert.equal(load({ AudioContext: function () { throw new Error('blocked') } }).ensureContext(), null)
})

// ═══ mute ═══

function store(initial = {}) {
  const data = { ...initial }
  return { data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => (data[k] = String(v)), removeItem: k => delete data[k] }
}

test('mute is remembered per browser under script.muted, and on by nothing but the user', () => {
  const s = store()
  assert.equal(S.isMuted(s), false)
  S.setMuted(s, true)
  assert.equal(s.data['script.muted'], '1')
  assert.equal(S.isMuted(s), true)
  S.setMuted(s, false)
  assert.equal('script.muted' in s.data, false)
  assert.equal(S.isMuted(s), false)
})

test('a storage that throws (a private window) reads as not muted and never breaks the page', () => {
  const bad = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
  assert.equal(S.isMuted(bad), false)
  assert.doesNotThrow(() => S.setMuted(bad, true))
  assert.equal(S.isMuted(undefined), false)
  assert.doesNotThrow(() => S.setMuted(undefined, true))
})
