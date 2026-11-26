// Tests for routing-intake.mjs: sorting tickets into code, no-code and needs-a-person by rules (with the reason), the
// model's answer and the user's correction over them, the model prompt and the parse of its reply, and likely
// duplicates among open tickets (a true pair, a near miss, the same ticket named, and a remembered not-a-duplicate).

import { test } from 'node:test'
import assert from 'node:assert/strict'

const I = await import('../routing-intake.mjs')

const t = (id, title, over = {}) => ({ id, title, state: 'Unstarted', labels: [], type: 'chore', ...over })

test('the three kinds', () => {
  assert.deepEqual([...I.KINDS], ['code', 'no-code', 'needs-a-person'])
})

test('rules: code work from code words and the story type', () => {
  for (const ticket of [t('A-1', 'Bug: saving a profile crashes'), t('A-2', 'Feat: add reply to reply comments'), t('A-3', 'Performance: Fix N+1 query problems'), t('A-4', 'The list is distorted', { type: 'bug' })]) {
    const r = I.intakeRules(ticket)
    assert.equal(r.kind, 'code', `${ticket.title}: ${r.reason}`)
    assert.notEqual(r.confidence, 'unsure')
  }
})

test('rules: no-code work in a console, DNS or a cloud setting', () => {
  for (const title of ['Technical SEO: Verify GSC & Bing Webmaster DNS records', 'Cloud Hosting: Service quotas reviewed/increased', 'Google Analytics: Consent Mode configured in the console']) {
    const r = I.intakeRules(t('B-1', title))
    assert.equal(r.kind, 'no-code', `${title}: ${r.reason}`)
    assert.match(r.reason, /\w/)
  }
})

test('rules: needs a person for legal, billing, sign off, marketing and access', () => {
  for (const title of ['Legal: Privacy Policy link accessible', 'Cloud Hosting: Billing account linked', 'Testing: QA Sign-off received', 'Marketing: launch email to the list', 'Maintenance: Perform quarterly access review']) {
    const r = I.intakeRules(t('C-1', title))
    assert.equal(r.kind, 'needs-a-person', `${title}: ${r.reason}`)
  }
})

test('rules: nothing to go on is unsure', () => {
  const r = I.intakeRules(t('D-1', 'Things'))
  assert.equal(r.confidence, 'unsure')
  assert.match(r.reason, /Too little to go on/)
})

test('sortTickets: the user over the model over the rules, each saying who sorted it', () => {
  const tickets = [t('A-1', 'Bug: crash on save'), t('A-2', 'Things'), t('A-3', 'Things too')]
  const stored = {
    'A-1': { kind: 'needs-a-person', reason: 'Ask legal first.', by: 'you', at: '2026-11-25T10:00:00Z' },
    'A-2': { kind: 'no-code', reason: 'A console change.', by: 'model', at: '2026-11-25T10:00:00Z' },
    'A-9': { kind: 'nonsense', by: 'you' },
  }
  const s = I.sortTickets(tickets, stored)
  assert.deepEqual(s['A-1'], { kind: 'needs-a-person', reason: 'Ask legal first.', by: 'you', confidence: 'certain' })
  assert.deepEqual(s['A-2'], { kind: 'no-code', reason: 'A console change.', by: 'model', confidence: 'likely' })
  assert.equal(s['A-3'].by, 'rules')
  assert.equal(s['A-3'].confidence, 'unsure')
  assert.equal(s['A-9'], undefined)
})

test('unsureIds: the open tickets the rules could not sort and nobody else has, at most 30', () => {
  const many = Array.from({ length: 40 }, (_, i) => t(`U-${i + 1}`, 'Things'))
  const done = t('U-99', 'Things', { state: 'Accepted' })
  const s = I.sortTickets([...many, done], { 'U-1': { kind: 'code', by: 'you', reason: 'x' } })
  const ids = I.unsureIds([...many, done], s)
  assert.equal(ids.length, 30)
  assert.ok(!ids.includes('U-1'), 'sorted by the user')
  assert.ok(!ids.includes('U-99'), 'finished')
})

test('the model prompt lists each ticket once, and the reply parse keeps only good answers for asked ids', () => {
  const tickets = [t('A-1', 'Things', { labels: ['Ops'] }), t('A-2', 'Other things')]
  const { system, text } = I.intakePrompt(tickets)
  assert.match(system, /code/)
  assert.match(system, /needs-a-person/)
  assert.match(text, /A-1 \| Things \| labels: Ops \| type: chore/)
  assert.match(text, /A-2 \| Other things/)
  const reply = 'Here you go:\n```json\n[{"id":"A-1","kind":"no-code","reason":"A setting in a console."},{"id":"A-2","kind":"poetry","reason":"x"},{"id":"Z-9","kind":"code","reason":"x"},{"id":"A-2","kind":"code","reason":"' + 'y'.repeat(400) + '"}]\n```'
  const got = I.parseIntakeReply(reply, ['A-1', 'A-2'])
  assert.deepEqual(got['A-1'], { kind: 'no-code', reason: 'A setting in a console.' })
  assert.equal(got['A-2'].kind, 'code')
  assert.ok(got['A-2'].reason.length <= 140)
  assert.equal(got['Z-9'], undefined)
  assert.deepEqual(I.parseIntakeReply('no json here', ['A-1']), {})
  assert.deepEqual(I.parseIntakeReply(null, ['A-1']), {})
})

test('duplicates: a true pair by shared significant words; the later ticket looks like the earlier', () => {
  const tickets = [t('FLA-761', 'Bug: Comments do not load on the activity feed'), t('FLA-790', 'Comments not loading on activity feed'), t('FLA-800', 'Add dark mode')]
  const d = I.duplicates(tickets)
  assert.equal(d['FLA-790'].of, 'FLA-761')
  assert.match(d['FLA-790'].reason, /comments, loading, activity and feed/)
  assert.equal(d['FLA-761'], undefined)
  assert.equal(d['FLA-800'], undefined)
})

test('duplicates: a near miss sharing only the heading and common words is not one', () => {
  const tickets = [t('FLA-806', 'CI/CD: Test step passes'), t('FLA-776', 'CI/CD: Build step passes'), t('FLA-839', 'Security: Firestore/RTDB rules locked down'), t('FLA-841', 'Security: Cloud Storage rules locked down')]
  assert.deepEqual(I.duplicates(tickets), {})
})

test('duplicates: a ticket that names another in its title is a likely duplicate of it', () => {
  const d = I.duplicates([t('FLA-10', 'Search is slow'), t('FLA-12', 'Same as FLA-10, the search page')])
  assert.equal(d['FLA-12'].of, 'FLA-10')
  assert.match(d['FLA-12'].reason, /names FLA-10/)
})

test('duplicates: finished tickets are left out, and a remembered not-a-duplicate pair is never shown again', () => {
  const tickets = [t('FLA-761', 'Comments do not load on the activity feed'), t('FLA-790', 'Comments not loading on activity feed')]
  assert.deepEqual(I.duplicates(tickets, { [I.pairKey('FLA-790', 'FLA-761')]: '2026-11-25T10:00:00Z' }), {})
  assert.deepEqual(I.duplicates([tickets[0], { ...tickets[1], state: 'Accepted' }]), {})
  assert.equal(I.pairKey('B-2', 'A-1'), I.pairKey('A-1', 'B-2'))
})

test('humanKinds: only sure sorts, by id, for the Human review list', () => {
  const s = { 'A-1': { kind: 'no-code', confidence: 'likely' }, 'A-2': { kind: 'code', confidence: 'certain' }, 'A-3': { kind: 'needs-a-person', confidence: 'unsure' } }
  assert.deepEqual(I.humanKinds(s), { 'A-1': 'no-code', 'A-2': 'code' })
})

// QA 2026-11-26: building a button or an endpoint for billing, the console or an account is code work; the place
// word alone must not sort it as needing a person or as no code.
test('rules: a build verb with a UI or code object is code, whatever place it names', () => {
  for (const title of ['Add a Stripe payment refund button to billing', 'Build the admin console audit page', 'Implement an API endpoint for account deletion']) {
    assert.equal(I.intakeRules({ id: 'X-1', title, labels: [] }).kind, 'code', title)
  }
  assert.equal(I.intakeRules({ id: 'X-2', title: 'Turn on billing alerts in the Cloud Console', labels: [] }).kind === 'code', false)
  assert.equal(I.intakeRules({ id: 'X-3', title: 'Cloud Hosting: Email DNS records set (SPF, DKIM, DMARC)', labels: [] }).kind, 'no-code')
})

// QA 2026-11-26: the old rule (2 shared words making up 0.6 of all) flagged none of the 112 real tickets and missed
// this pair. A shared NAME (written with a capital in both titles, found in no other open title) with one more shared
// word now makes a pair; checklist boilerplate (verify, check, define, configured...) and a second heading are ignored.
const REAL = [
  ['FLA-775', 'Planning: Define SLIs/SLOs (latency, error rate, availability)'], ['FLA-810', 'CI/CD: Define rollback triggers (e.g., >2% error rate)'],
  ['FLA-836', 'Observability: Error reporting (Sentry/Crashlytics)'], ['FLA-853', 'Verify: Check monitoring for error/latency spikes'],
  ['FLA-884', 'Monitoring: Sentry error and performance monitoring for the web app'], ['FLA-780', 'Legal: Privacy Policy link accessible'],
  ['FLA-784', 'Legal: Terms of Service (ToS) link accessible'], ['FLA-811', 'Technical SEO: Verify GSC & Bing Webmaster DNS records'],
  ['FLA-832', 'Cloud Hosting: Email DNS records set (SPF, DKIM, DMARC)'], ['FLA-809', 'CI/CD: Staged rollout (canary) & automated rollback'],
  ['FLA-838', 'Deploy: Pause staged rollout (e.g., at 25%) to review metrics'], ['FLA-839', 'Security: Firestore/RTDB rules locked down'],
  ['FLA-841', 'Security: Cloud Storage rules locked down'], ['FLA-858', 'SEO Monitoring: Set up Semrush position tracking'],
  ['FLA-864', 'SEO Monitoring: Perform quarterly Semrush site health audits'], ['FLA-797', 'Technical SEO: Configure Semrush pre-launch site audit'],
]
test('duplicates on real titles: a shared name plus one more word is a pair; generic words and boilerplate are not', () => {
  const d = I.duplicates(REAL.map(([id, title]) => t(id, title)))
  assert.equal(d['FLA-884']?.of, 'FLA-836')
  assert.match(d['FLA-884'].reason, /Sentry/)
  for (const id of ['FLA-810', 'FLA-853', 'FLA-784', 'FLA-832', 'FLA-838', 'FLA-841', 'FLA-864']) assert.equal(d[id], undefined, `${id}: ${d[id]?.reason}`)
  // Not a duplicate still wins
  assert.equal(I.duplicates(REAL.map(([id, title]) => t(id, title)), { [I.pairKey('FLA-884', 'FLA-836')]: '2026-11-26T10:00:00Z' })['FLA-884'], undefined)
})

// QA 2026-11-26: an Unsure ticket said Code: the words error. as if it were sure; and one word read the words console.
test('rules: an unsure sort says why it is unsure, and one word is the word', () => {
  const r = I.intakeRules({ id: 'X-1', title: 'Leaderboard error', labels: [] })
  assert.equal(r.confidence, 'unsure')
  assert.match(r.reason, /^Unsure: too little to go on\. Only the word error points to code\.$/)
  const one = I.intakeRules({ id: 'X-2', title: 'Set up the admin console', labels: [] })
  assert.doesNotMatch(one.reason, /the words console/)
  assert.match(one.reason, /the word console/)
  const tie = I.intakeRules({ id: 'X-3', title: 'Fix the DNS records', labels: [] })
  if (tie.confidence === 'unsure' && /between/.test(tie.reason)) assert.match(tie.reason, /^Unsure: the signals disagree/)
})
