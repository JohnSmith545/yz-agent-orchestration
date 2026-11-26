// Tests for learn-settings.mjs: the `learn` block of config.json, checked. Every key is optional; a bad value keeps
// its default with ONE warning, never a failed startup. Learn only READS config.json: nothing here writes it.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LEARN_DEFAULTS, learnSettings } from '../learn-settings.mjs'

const quiet = () => {}

test('left out, the defaults: retros on and automatic, no weekly run, verdicts after 14 days', () => {
  assert.deepEqual(learnSettings(undefined, quiet), LEARN_DEFAULTS)
  assert.equal(LEARN_DEFAULTS.enabled, true)
  assert.equal(LEARN_DEFAULTS.autoRetro, true)
  assert.equal(LEARN_DEFAULTS.weekly, false)
  assert.equal(LEARN_DEFAULTS.verdictAfterDays, 14)
  assert.equal(LEARN_DEFAULTS.model, 'claude-opus-5-5')
  assert.equal(LEARN_DEFAULTS.retroModel, 'claude-sonnet-5-5')
})

test('each good value is taken', () => {
  const s = learnSettings({ enabled: false, autoRetro: false, weekly: true, verdictAfterDays: 21, model: 'claude-opus-5-5', retroModel: 'claude-haiku-5-5' }, quiet)
  assert.deepEqual(s, { enabled: false, autoRetro: false, weekly: true, verdictAfterDays: 21, model: 'claude-opus-5-5', retroModel: 'claude-haiku-5-5' })
})

test('a bad value keeps its default with one warning each; a block that is no object warns once', () => {
  const said = []
  const s = learnSettings({ enabled: 'yes', autoRetro: 1, weekly: null, verdictAfterDays: 0, model: 'gpt-4', retroModel: '--tools' }, m => said.push(m))
  assert.deepEqual(s, LEARN_DEFAULTS)
  assert.equal(said.length, 6)
  assert.ok(said.every(m => m.startsWith('config.json: learn.')))
  const once = []
  assert.deepEqual(learnSettings([1], m => once.push(m)), LEARN_DEFAULTS)
  assert.equal(once.length, 1)
})

test('verdictAfterDays is a whole number from 1 to 365, the edges included', () => {
  assert.equal(learnSettings({ verdictAfterDays: 1 }, quiet).verdictAfterDays, 1)
  assert.equal(learnSettings({ verdictAfterDays: 365 }, quiet).verdictAfterDays, 365)
  assert.equal(learnSettings({ verdictAfterDays: 366 }, quiet).verdictAfterDays, 14)
  assert.equal(learnSettings({ verdictAfterDays: 7.5 }, quiet).verdictAfterDays, 14)
})

test('the settings object handed out cannot change the defaults', () => {
  const s = learnSettings({}, quiet)
  s.weekly = true
  assert.equal(LEARN_DEFAULTS.weekly, false)
})
