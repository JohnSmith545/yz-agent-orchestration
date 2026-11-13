// Tests for the story lines on a flow (output.story, validated in flows.mjs)
// and storyOf (flow-story.mjs): the plain "who did what, and why" the page
// shows, made from the flow itself when the agent wrote none. Also the marked
// words on the payload (derived.terms). FACTORY_DATA_DIR points at a fresh temp
// folder BEFORE the imports, so no test ever touches the real data/ folder.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-story-test-'))
const F = await import('../flows.mjs')
const G = await import('../glossary.mjs')
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))

const fixture = name => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name + '.json'), 'utf8'))
const line = (id, did, more = {}) => ({ id, who: 'Agent 1', did, at: '2026-11-12T08:00:00Z', ...more })
const withStory = story => ({ ...fixture('dark-mode'), output: { story } })

// ═══ validation ═══

test('the dark-mode fixture story is valid; a story is optional', () => {
  assert.deepEqual(F.validateFlow(fixture('dark-mode')), [])
  assert.equal(fixture('dark-mode').output.story.length, 3)
  assert.equal(fixture('no-visual').output, undefined)
})

test('a story line longer than 140 characters is refused saying how much shorter', () => {
  const problems = F.validateFlow(withStory([line('s1', 'd'.repeat(212))]))
  assert.deepEqual(problems, ['output.story s1: did: say it shorter: at most 140 characters (this has 212)'])
  assert.deepEqual(F.validateFlow(withStory([line('s1', 'd'.repeat(140))])), [])
})

test('a why longer than 160 characters is refused the same way; a why is optional', () => {
  assert.deepEqual(F.validateFlow(withStory([line('s1', 'Did it', { why: 'w'.repeat(161) })])),
    ['output.story s1: why: say it shorter: at most 160 characters (this has 161)'])
  assert.deepEqual(F.validateFlow(withStory([line('s1', 'Did it', { why: 'w'.repeat(160) }), line('s2', 'More')])), [])
})

test('a story holds at most 8 lines', () => {
  const nine = Array.from({ length: 9 }, (_, i) => line(`s${i + 1}`, `Line ${i + 1}`))
  assert.deepEqual(F.validateFlow(withStory(nine)), ['output.story has 9 lines, at most 8: keep the story short'])
  assert.deepEqual(F.validateFlow(withStory(nine.slice(0, 8))), [])
})

test('each bad story line is one plain problem: id, duplicate id, who, empty did, a line break, the time', () => {
  const problems = F.validateFlow(withStory([
    line('x1', 'Bad id'),
    line('s2', 'Fine'),
    line('s2', 'Twice'),
    { ...line('s3', 'Bad who'), who: 'Agent "1"' },
    line('s4', '  '),
    line('s5', 'Two\nlines'),
    { ...line('s6', 'No time'), at: 5 },
    'not an object',
  ]))
  assert.deepEqual(problems, [
    'output.story #1 id must be s1, s2, s3 and so on',
    'duplicate story line id s2',
    'output.story s3: who must be a label of 1 to 40 letters, digits, spaces, dots, dashes or underscores',
    'output.story s4: did must say what was done',
    'output.story s5: did must be one line',
    'output.story s6: at must be a time',
    'output.story #8 must be a JSON object',
  ])
  assert.deepEqual(F.validateFlow(withStory('nope')), ['output.story must be a list'])
})

test('flow write keeps the stored story when the file leaves output out (agent-owned like the rest of output)', () => {
  const existing = withStory([line('s1', 'Kept')])
  const incoming = { ...fixture('dark-mode') }
  delete incoming.output
  const merged = F.mergeKeepingAnswers(incoming, existing)
  assert.deepEqual(merged.output.story, [line('s1', 'Kept')])
})

// ═══ storyOf ═══

test('storyOf gives the agent story when there is one, each line marked not derived', () => {
  const story = F.storyOf(fixture('dark-mode'))
  assert.equal(story.length, 3)
  for (const l of story) {
    assert.equal(l.derived, false)
    assert.deepEqual(Object.keys(l).sort(), ['at', 'derived', 'did', 'id', 'who', 'why'])
  }
  assert.equal(story[2].why, '', 'a line with no why gets an empty one')
})

test('storyOf on the no-visual fixture derives at most 3 plain lines, the open decision credited to You, without any model', () => {
  const story = F.storyOf(fixture('no-visual'))
  assert.deepEqual(story, [
    { who: 'Agent 3', did: 'Finished 7 steps', why: '', derived: true },
    { who: 'Agent 3', did: 'Is working on: Compare the reports from both runs', why: '', derived: true },
    { who: 'You', did: 'To decide: Turn off the old scheduler now?', why: '', derived: true },
  ])
  assert.ok(story.every(l => !/left|blocked/.test(l.did)), 'no counts line: the Picture shows them')
})

test('storyOf says what you answered when there is room, the latest answer, whole when under 90 characters', () => {
  const flow = fixture('no-visual')
  flow.nodes = flow.nodes.filter(n => n.id !== 'n12' && n.id !== 'n9')
  const story = F.storyOf(flow)
  assert.deepEqual(story.map(l => [l.who, l.did]), [
    ['Agent 3', 'Finished 7 steps'],
    ['You', 'Answered Yes to: Run both schedulers side by side for a week before switching?'],
  ])
})

test('a long title is cut near 90 characters after a whole word, never ending on a small word', () => {
  const title = 'Move the nightly report job to the new scheduler and keep the old one running for a week in case of trouble'
  const flow = { id: 'f', agent: 'Agent 1', status: 'open', nodes: [{ id: 'n1', type: 'ask', kind: 'yesno', title, answer: null }] }
  const [l] = F.storyOf(flow)
  assert.equal(l.who, 'You')
  const cut = l.did.replace(/^To decide: /, '')
  assert.ok(cut.length <= 90, `${cut.length}`)
  assert.ok(cut.endsWith('…'))
  assert.ok(title.startsWith(cut.slice(0, -1)), 'whole words of the title')
  assert.doesNotMatch(cut, /\b(in|of|a|the|for|to|and)…$/)
  assert.equal(F.clip(title, 90), cut)
})

test('a dropped flow says so in one line after what was finished; a done flow leaves out what is in progress', () => {
  const dropped = { ...fixture('no-visual'), status: 'dropped' }
  assert.deepEqual(F.storyOf(dropped).map(l => [l.who, l.did]), [['Agent 3', 'Finished 7 steps'], ['Agent 3', 'Dropped this work']])
  const done = { ...fixture('no-visual'), status: 'done' }
  done.nodes = done.nodes.filter(n => n.id !== 'n12')
  assert.deepEqual(F.storyOf(done).map(l => [l.who, l.did]), [
    ['Agent 3', 'Finished 7 steps'],
    ['You', 'Answered Yes to: Run both schedulers side by side for a week before switching?'],
  ])
})

test('an agent may not write a story line as You: that name is kept for what you did', () => {
  for (const who of ['You', 'you', ' YOU ']) {
    assert.deepEqual(F.validateFlow(withStory([{ ...line('s1', 'Approved it'), who }])), ['output.story s1: who must not be You: that name is kept for what the user did'], who)
  }
})

test('storyOf on a fresh flow with no steps says nothing; one finished step is singular; an empty story list is derived', () => {
  assert.deepEqual(F.storyOf({ id: 'f', agent: 'Agent 1', nodes: [] }), [])
  const one = { id: 'f', agent: 'Agent 1', output: { story: [] }, nodes: [{ id: 'n1', type: 'step', title: 'T', status: 'done' }] }
  assert.deepEqual(F.storyOf(one), [{ who: 'Agent 1', did: 'Finished 1 step', why: '', derived: true }])
})

test('storyOf for a text ask the user answered says they replied', () => {
  const flow = { id: 'f', agent: 'Agent 1', nodes: [{ id: 'n1', type: 'ask', kind: 'text', title: 'Which colour?', answer: 'Blue', answeredAt: '2026-11-12T08:00:00Z' }] }
  assert.deepEqual(F.storyOf(flow), [{ who: 'You', did: 'Replied to: Which colour?', why: '', derived: true }])
})

// ═══ the payload: derived.story and derived.terms ═══

test('derive adds the story and the marked words, each with whether the glossary knows it', () => {
  G.saveTerm({ term: 'theme token', short: 'A named colour.', source: 'agent' })
  const d = F.derive(fixture('dark-mode'))
  assert.equal(d.story.length, 3)
  const byKey = Object.fromEntries(d.terms.map(t => [t.key, t]))
  assert.deepEqual(byKey['theme token'], { term: 'theme token', key: 'theme token', known: true })
  assert.equal(byKey['local storage'].known, false)
  for (const t of d.terms) assert.deepEqual(Object.keys(t).sort(), ['key', 'known', 'term'])
})

test('derive on the no-visual fixture gives the derived story and its one marked word', () => {
  const d = F.derive(fixture('no-visual'))
  assert.ok(d.story.every(l => l.derived))
  assert.deepEqual(d.terms, [{ term: 'service account', key: 'service account', known: false }])
})
