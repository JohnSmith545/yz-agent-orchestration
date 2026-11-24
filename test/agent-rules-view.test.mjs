// Tests for public/agent-rules-view.js: the Specification and Rules sections of an agent's details pane on the
// Agents page, read and edit, and the draft the editor keeps. Pure: HTML and plain objects out, run in a vm.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ctx = vm.createContext({ window: {} })
vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'public', 'agent-rules-view.js'), 'utf8'), ctx)
const V = ctx.window.AgentRulesView
const plain = v => JSON.parse(JSON.stringify(v))

const node = { id: 'agent-1', kind: 'agent', label: 'Agent 1', role: 'producer' }
const ROLE = 'Writes the code.'
const AT = '2026-11-24T10:00:00.000Z'
const entry = { spec: 'Builds the web pages.\nOnly web.', rules: [{ id: 'a', text: 'Never touch the mobile app.', addedAt: AT }, { id: 'b', text: 'Run the tests.', addedAt: AT }], updatedAt: AT }

test('read: the saved specification and a numbered list of rules', () => {
  const html = V.slotHtml(node, ROLE, { entry })
  assert.match(html, /^<!--ar--><section[^>]*data-ar-slot="Agent 1" data-ar-mode="view"/)
  assert.match(html, /<!--\/ar-->$/)
  assert.match(html, />Specification</)
  assert.match(html, /class="ar-spec">Builds the web pages.\nOnly web.</)
  assert.doesNotMatch(html, /Default/)
  assert.match(html, /<ol class="ar-rules"><li>Never touch the mobile app.<\/li><li>Run the tests.<\/li><\/ol>/)
})

test('read: with nothing saved, the role line stands in, marked as the default, and there are no rules yet', () => {
  const html = V.slotHtml(node, ROLE, { entry: null })
  assert.match(html, /Specification <span class="faint">· Default<\/span>/)
  assert.match(html, /class="pl-desc">Writes the code.</)
  assert.match(html, /No rules yet\./)
})

test('the Settings button: an icon and the word, says whether the editor is open, points at the sections', () => {
  const b = V.settingsButton(node, false)
  assert.match(b, /<button type="button" class="link pl-det-set" data-ar-act="settings" data-ar-label="Agent 1" aria-expanded="false" aria-controls="ar-agent-1">/)
  assert.match(b, /<svg[^>]*aria-hidden="true"/)
  assert.match(b, /Settings<\/button>$/)
  assert.match(V.settingsButton(node, true), /aria-expanded="true"/)
})

test('edit: a labelled textarea with the spec and a count, each rule with a remove button, an Add a rule field, Save and Cancel, and how it works', () => {
  const draft = V.draftOf(entry)
  const html = V.slotHtml(node, ROLE, { entry, draft })
  assert.match(html, /data-ar-mode="edit"/)
  assert.match(html, /<label[^>]*for="ar-agent-1-spec"[^>]*>Specification<\/label>/)
  assert.match(html, /<textarea id="ar-agent-1-spec"[^>]*aria-describedby="[^"]*ar-agent-1-count[^"]*"[^>]*>\nBuilds the web pages.\nOnly web.<\/textarea>/, 'a newline after the tag: the parser drops one, so a typed leading line survives')
  assert.match(html, /id="ar-agent-1-count"[^>]*>31 of 2,000 characters</)
  assert.match(html, /data-ar-act="remove" data-ar-i="0" aria-label="Remove rule 1: Never touch the mobile app."/)
  assert.match(html, /data-ar-act="remove" data-ar-i="1"/)
  assert.match(html, /<label[^>]*for="ar-agent-1-add"[^>]*>Add a rule<\/label>/)
  assert.match(html, /<input type="text" id="ar-agent-1-add" data-ar-field="pending" value=""/)
  assert.match(html, /data-ar-act="add"[^>]*>Add</)
  assert.match(html, /class="primary" data-ar-act="save"[^>]*>Save</)
  assert.match(html, /data-ar-act="cancel"[^>]*>Cancel</)
  assert.match(html, /Agents read these when they start a request\./)
  assert.match(html, /role="status"/)
})

test('edit: a saved error shows, and Save says it is saving', () => {
  const draft = { ...V.draftOf(entry), error: 'Could not save.', saving: true }
  const html = V.slotHtml(node, ROLE, { entry, draft })
  assert.match(html, /data-ar-error[^>]*>Could not save\.</)
  assert.match(html, /data-ar-act="save" disabled[^>]*>Saving…</)
})

test('the draft: add trims and refuses empty, too long and too many; remove takes one out', () => {
  let d = V.draftOf(null)
  assert.deepEqual(plain(d), { spec: '', rules: [], pending: '', error: '', saving: false })
  let r = V.addRule(d, '   ')
  assert.match(r.error, /Write the rule first/)
  r = V.addRule(d, '  Be   kind. ')
  assert.equal(r.error, '')
  assert.deepEqual(plain(r.draft.rules), ['Be kind.'])
  assert.deepEqual(plain(d.rules), [], 'the draft passed in is not changed')
  assert.match(V.addRule(d, 'x'.repeat(301)).error, /too long.*300/)
  d = { ...d, rules: Array.from({ length: 30 }, (_, i) => `r${i}`) }
  assert.match(V.addRule(d, 'one more').error, /30/)
  assert.deepEqual(plain(V.removeRule({ ...d, rules: ['a', 'b', 'c'] }, 1).rules), ['a', 'c'])
})

test('toBody: the spec and the rules, with a rule still in the Add field included', () => {
  assert.deepEqual(plain(V.toBody({ spec: 'S', rules: ['a'], pending: '  b ' })), { spec: 'S', rules: ['a', 'b'] })
  assert.deepEqual(plain(V.toBody({ spec: 'S', rules: ['a'], pending: '' })), { spec: 'S', rules: ['a'] })
})

test('problem: the same limits the server keeps, said before anything is sent', () => {
  assert.equal(V.problem({ spec: 'ok', rules: ['a'] }), '')
  assert.match(V.problem({ spec: 'x'.repeat(2001), rules: [] }), /too long/)
  assert.match(V.problem({ spec: '', rules: ['x'.repeat(301)] }), /Rule 1 is too long/)
  assert.match(V.problem({ spec: '', rules: Array(31).fill('a') }), /30/)
})

test('countLine says the characters in plain words', () => {
  assert.equal(V.countLine(0, 2000), '0 of 2,000 characters')
  assert.equal(V.countLine(1, 2000), '1 of 2,000 characters')
})

test('outsideOf: the pane with the sections taken out, so a change only inside them is no change around them', () => {
  const a = `<div><h2>x</h2>${V.slotHtml(node, ROLE, { entry, draft: V.draftOf(entry) })}<p>after</p></div>`
  const b = `<div><h2>x</h2>${V.slotHtml(node, ROLE, { entry, draft: { ...V.draftOf(entry), spec: 'typed' } })}<p>after</p></div>`
  assert.equal(V.outsideOf(a), V.outsideOf(b))
  assert.notEqual(V.outsideOf(a), V.outsideOf(b.replace('after', 'later')))
  assert.equal(V.outsideOf('<p>no slot</p>'), '<p>no slot</p>')
})

test('editSlotOf: the label of the open editor in a pane HTML, or null', () => {
  assert.equal(V.editSlotOf(V.slotHtml(node, ROLE, { entry, draft: V.draftOf(entry) })), 'Agent 1')
  assert.equal(V.editSlotOf(V.slotHtml(node, ROLE, { entry })), null)
  const odd = { ...node, label: 'A "q" & <b>' }
  assert.equal(V.editSlotOf(V.slotHtml(odd, ROLE, { entry: null, draft: V.draftOf(null) })), 'A "q" & <b>')
})

test('everything the user typed is escaped', () => {
  const bad = { spec: '<img src=x onerror=1>', rules: [{ id: 'a', text: '<script>x</script>', addedAt: AT }], updatedAt: AT }
  for (const html of [V.slotHtml(node, ROLE, { entry: bad }), V.slotHtml(node, ROLE, { entry: bad, draft: { ...V.draftOf(bad), pending: '"><b>', error: '<i>' } })]) {
    assert.doesNotMatch(html, /<img|<script|"><b>|<i>/)
  }
  assert.doesNotMatch(V.slotHtml({ ...node, label: '<b>x</b>' }, ROLE, { entry: null }), /<b>x<\/b>/)
})

// ═══ Changes: the agent's last saved changes, under Rules ═══

const changes = [
  { at: '2026-11-24T10:05:00.000Z', text: 'Agent 1 got 2 new rules and its specification changed.' },
  { at: '2026-11-23T09:00:00.000Z', text: '1 rule was removed from Agent 1.' },
]

test('read: a quiet Changes disclosure under Rules lists each change with when it was, closed until opened', () => {
  const html = V.slotHtml(node, ROLE, { entry, changes })
  assert.match(html, /<\/ol><details class="ar-log" data-ar-log="Agent 1"><summary data-ar-summary>Changes <span class="faint">· 2<\/span><\/summary>/)
  assert.match(html, /<li><time datetime="2026-11-24T10:05:00.000Z" title="[^"]+">[^<]+<\/time> <span>Agent 1 got 2 new rules and its specification changed\.<\/span><\/li>/)
  assert.match(V.slotHtml(node, ROLE, { entry, changes, logOpen: true }), /data-ar-log="Agent 1" open>/)
})

test('read: no Changes at all when there are none; the editor never shows them', () => {
  assert.doesNotMatch(V.slotHtml(node, ROLE, { entry, changes: [] }), /Changes/)
  assert.doesNotMatch(V.slotHtml(node, ROLE, { entry }), /Changes/)
  assert.doesNotMatch(V.slotHtml(node, ROLE, { entry, changes, draft: V.draftOf(entry) }), /ar-log/)
})

test('whenOf: a short local day and time, the same text on every redraw', () => {
  const at = '2026-11-24T10:05:00.000Z'
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  assert.equal(V.whenOf(at), `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${hm}`)
  assert.equal(V.whenOf('nope'), '')
})

test('Changes escapes the sentence (it carries a label)', () => {
  assert.doesNotMatch(V.slotHtml(node, ROLE, { entry, changes: [{ at: changes[0].at, text: '<b>x</b> got 1 new rule.' }] }), /<b>x/)
})

// QA, 2026-11-24: the Add field had maxlength=300, so the browser cut a pasted 304-character rule to 300 and
// Enter added the cut rule with no word said. The fields take any length; the page's own checks refuse it.
test('a rule or a specification over its limit is refused with a sentence, never silently cut by the field', () => {
  const draft = V.draftOf(entry)
  assert.doesNotMatch(V.slotHtml(node, ROLE, { entry, draft }), /maxlength/, 'no field cuts what is typed or pasted')
  const long = 'x'.repeat(304)
  const added = V.addRule({ ...draft, pending: long }, long)
  assert.equal(added.error, 'That rule is too long. Keep each rule to 300 characters.')
  assert.equal(added.draft.pending, long, 'the text is kept as typed')
  assert.equal(added.draft.rules.length, draft.rules.length, 'and nothing was added')
  assert.equal(V.problem({ spec: 'y'.repeat(2001), rules: [] }), 'The specification is too long. Keep it to 2,000 characters.')
})
