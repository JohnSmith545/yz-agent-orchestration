// Tests for predict-settings.mjs: config.json's `alerts` and `estimates` blocks, checked. Left out is the defaults; a
// bad value keeps its default with ONE warning naming the key and the value used, never a failed startup; a block
// that is not an object is one warning and every default.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ALERT_DEFAULTS, ESTIMATE_DEFAULTS, alertSettings, estimateSettings } from '../predict-settings.mjs'

const collect = () => {
  const lines = []
  return { warn: l => lines.push(l), lines }
}

test('left out, every alert setting is its default: stuck at 3 times the median and 60 minutes, spikes at 4 times and 20 million', () => {
  const { warn, lines } = collect()
  const s = alertSettings(undefined, warn)
  assert.deepEqual(s, { ...ALERT_DEFAULTS })
  assert.equal(s.enabled, true)
  assert.equal(s.stuckFactor, 3)
  assert.equal(s.stuckMinMinutes, 60)
  assert.equal(s.stuckHours, 24)
  assert.equal(s.spikeFactor, 4)
  assert.equal(s.spikeMinTokens, 20_000_000)
  assert.equal(s.contextTokens, 400_000)
  assert.equal(s.dailyUsd, null)
  assert.equal(s.dailyTokens, null)
  assert.deepEqual(lines, [])
})

test('good values are taken; the daily limits turn on with a number and off again with null', () => {
  const { warn, lines } = collect()
  const s = alertSettings({ enabled: false, stuckFactor: 2.5, stuckMinMinutes: 30, stuckHours: 12, spikeFactor: 6, spikeMinTokens: 5_000_000, contextTokens: 250_000, dailyUsd: 80, dailyTokens: 300_000_000 }, warn)
  assert.deepEqual(s, { enabled: false, stuckFactor: 2.5, stuckMinMinutes: 30, stuckHours: 12, spikeFactor: 6, spikeMinTokens: 5_000_000, contextTokens: 250_000, dailyUsd: 80, dailyTokens: 300_000_000 })
  assert.equal(alertSettings({ dailyUsd: null }, warn).dailyUsd, null)
  assert.deepEqual(lines, [])
})

test('each bad value keeps its default with one warning naming the key', () => {
  const { warn, lines } = collect()
  const s = alertSettings({ enabled: 'yes', stuckFactor: 0.5, stuckMinMinutes: -1, stuckHours: 'a day', spikeFactor: Infinity, spikeMinTokens: 1.5, contextTokens: 10, dailyUsd: -3, dailyTokens: 0 }, warn)
  assert.deepEqual(s, { ...ALERT_DEFAULTS })
  assert.equal(lines.length, 9)
  for (const key of ['enabled', 'stuckFactor', 'stuckMinMinutes', 'stuckHours', 'spikeFactor', 'spikeMinTokens', 'contextTokens', 'dailyUsd', 'dailyTokens']) {
    assert.ok(lines.some(l => l.includes(`alerts.${key}`)), key)
  }
  assert.match(lines.find(l => l.includes('alerts.stuckFactor')), /3 is used/)
  assert.match(lines.find(l => l.includes('alerts.dailyUsd')), /off/)
})

test('an alerts block that is not an object is one warning and the defaults', () => {
  for (const raw of [null, 'on', [1], 3]) {
    const { warn, lines } = collect()
    assert.deepEqual(alertSettings(raw, warn), { ...ALERT_DEFAULTS })
    assert.equal(lines.length, 1)
  }
})

test('the bounds hold at their edges', () => {
  const { warn, lines } = collect()
  assert.equal(alertSettings({ stuckFactor: 1 }, warn).stuckFactor, 1)
  assert.equal(alertSettings({ stuckFactor: 100 }, warn).stuckFactor, 100)
  assert.equal(alertSettings({ stuckFactor: 100.5 }, warn).stuckFactor, 3)
  assert.equal(alertSettings({ stuckMinMinutes: 0 }, warn).stuckMinMinutes, 0)
  assert.equal(alertSettings({ contextTokens: 1000 }, warn).contextTokens, 1000)
  assert.equal(alertSettings({ contextTokens: 999 }, warn).contextTokens, 400_000)
  assert.equal(lines.length, 2)
})

test('estimates: on, from the nearest 8, by default; a bad value keeps its default with one warning', () => {
  const quiet = collect()
  assert.deepEqual(estimateSettings(undefined, quiet.warn), { ...ESTIMATE_DEFAULTS })
  assert.deepEqual(ESTIMATE_DEFAULTS, { enabled: true, nearest: 8 })
  assert.deepEqual(estimateSettings({ enabled: false, nearest: 5 }, quiet.warn), { enabled: false, nearest: 5 })
  assert.deepEqual(quiet.lines, [])
  const { warn, lines } = collect()
  assert.deepEqual(estimateSettings({ enabled: 1, nearest: 2 }, warn), { ...ESTIMATE_DEFAULTS })
  assert.equal(lines.length, 2)
  assert.match(lines.find(l => l.includes('estimates.nearest')), /3 to 20/)
  assert.deepEqual(estimateSettings('no', warn), { ...ESTIMATE_DEFAULTS })
  assert.equal(lines.length, 3)
})
