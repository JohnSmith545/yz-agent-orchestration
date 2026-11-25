// Tests for routing-type.mjs: the task type of a piece of work from its words, labels and story type, with a
// confidence and a plain reason; the user's correction winning; and the size (small, medium, large).

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { TASK_TYPES, SIZES, taskTypeOf, withCorrection, sizeOf, planFileCount, typeName } = await import('../routing-type.mjs')

test('the fixed list of task types and sizes', () => {
  assert.deepEqual([...TASK_TYPES], ['wording', 'style', 'small-fix', 'feature', 'refactor', 'tests', 'docs', 'data', 'infra', 'investigation', 'review', 'by-hand'])
  assert.deepEqual([...SIZES], ['small', 'medium', 'large'])
})

test('every task type is found from typical words', () => {
  const cases = {
    wording: 'Fix the typo and the wording on the sign-up button',
    style: 'Dark mode: the card padding and colours are off',
    'small-fix': 'Bug: saving a profile crashes when the name is empty',
    feature: 'Feat: add reply to reply comments',
    refactor: 'Refactor the relay into smaller modules',
    tests: 'Testing: E2E tests pass (login, main workflow)',
    docs: 'Update the README and the user guide',
    data: 'Performance: Create database indexes for queries',
    infra: 'CI/CD: Deploy step passes',
    investigation: 'Investigate why the build is slow and find the root cause',
    review: 'Code review of the pull request for FLA-12',
    'by-hand': 'Cloud Hosting: Billing account linked in the console',
  }
  for (const [want, title] of Object.entries(cases)) {
    const r = taskTypeOf({ title })
    assert.equal(r.type, want, `${title} -> ${r.type} (${r.reason})`)
    assert.ok(['certain', 'likely'].includes(r.confidence), `${title}: ${r.confidence}`)
    assert.ok(r.reason.length > 0)
  }
})

test('the reason names what was seen, in plain words', () => {
  const r = taskTypeOf({ title: 'Fix a typo in the footer' })
  assert.equal(r.type, 'wording')
  assert.match(r.reason, /typo/)
  assert.doesNotMatch(r.reason, /undefined|null/)
})

test('a label or the story type adds to the words, and a label alone is enough', () => {
  const r = taskTypeOf({ title: 'Footer', labels: ['Docs'] })
  assert.equal(r.type, 'docs')
  assert.match(r.reason, /label/i)
  const bug = taskTypeOf({ title: 'Saving the profile goes wrong', storyType: 'bug' })
  assert.equal(bug.type, 'small-fix')
  assert.match(bug.reason, /story type/i)
})

test('strong signals that agree are certain; a single specific word is likely', () => {
  assert.equal(taskTypeOf({ title: 'Docs: update the README', labels: ['documentation'] }).confidence, 'certain')
  assert.equal(taskTypeOf({ title: 'Fix a typo in the footer' }).confidence, 'likely')
})

test('nothing to go on is unsure, with no type', () => {
  for (const input of [{}, { title: '' }, { title: 'FLA-12' }, { title: 'Things' }, null, { title: 42, labels: 'x' }]) {
    const r = taskTypeOf(input)
    assert.equal(r.confidence, 'unsure')
    assert.equal(r.type, null)
    assert.match(r.reason, /Too little to go on/)
  }
})

test('a tie between two types is unsure and names both', () => {
  const r = taskTypeOf({ title: 'Refactor the README' })
  assert.equal(r.confidence, 'unsure')
  assert.ok(['refactor', 'docs'].includes(r.type))
  assert.match(r.reason, /refactor/)
  assert.match(r.reason, /docs|documentation/)
})

test('the text counts for less than the title, and very long text is read only in part', () => {
  const r = taskTypeOf({ title: 'Add a new export button', text: 'mentions a typo once' })
  assert.equal(r.type, 'feature')
  const long = taskTypeOf({ title: 'x', text: 'a'.repeat(50_000) + ' typo' })
  assert.equal(long.confidence, 'unsure')
})

test('a user correction wins over the rules and says so', () => {
  const auto = taskTypeOf({ title: 'Fix a typo' })
  const r = withCorrection(auto, 'style')
  assert.deepEqual(r, { type: 'style', confidence: 'certain', reason: 'Set by you.', by: 'you' })
  assert.deepEqual(withCorrection(auto, null), { ...auto, by: 'rules' })
  assert.deepEqual(withCorrection(auto, 'not-a-type'), { ...auto, by: 'rules' }, 'a bad stored correction is ignored')
})

test('size: from the plan file count when there is one, else the text and the type', () => {
  assert.equal(sizeOf({ files: 1 }), 'small')
  assert.equal(sizeOf({ files: 2 }), 'small')
  assert.equal(sizeOf({ files: 5 }), 'medium')
  assert.equal(sizeOf({ files: 12 }), 'large')
  assert.equal(sizeOf({ type: 'wording', text: 'Fix a typo' }), 'small')
  assert.equal(sizeOf({ type: 'feature', text: 'Add a button' }), 'medium')
  assert.equal(sizeOf({ type: 'wording', text: 'x'.repeat(800) }), 'medium')
  assert.equal(sizeOf({ type: 'small-fix', text: 'x'.repeat(3000) }), 'large')
  assert.equal(sizeOf({}), 'medium', 'nothing known: the middle')
  assert.equal(sizeOf({ files: 0, type: 'wording', text: 'typo' }), 'small', 'a plan naming no file falls back to the text')
  assert.equal(sizeOf({ files: -3, type: 'feature' }), 'medium')
})

test('planFileCount counts the distinct file paths a plan names', () => {
  const plan = '# Plan\n- change `public/factory.js` and public/factory.js again\n- add routing-type.mjs\n- test/routing-type.test.mjs\nSee https://example.com/a.js for nothing'
  assert.equal(planFileCount(plan), 3)
  assert.equal(planFileCount(''), 0)
  assert.equal(planFileCount(null), 0)
})

test('typeName gives the plain name of a type', () => {
  assert.equal(typeName('small-fix'), 'small fix')
  assert.equal(typeName('by-hand'), 'by hand')
  assert.equal(typeName(null), 'not known')
})
