// The task type of a piece of work, for the routing rules (routing-rules.mjs) and the outcomes they learn from
// (routing-outcomes.mjs): what KIND of work a flow or a ticket is, read from its words, its labels and its tracker
// story type, never from a model.
//
//   taskTypeOf({ title, text, labels, storyType })  { type, confidence, reason }
//   withCorrection(auto, corrected)                  the user's correction wins: { type, confidence, reason, by }
//   sizeOf({ files, text, type })                    small | medium | large
//   planFileCount(planText)                          the distinct file paths a plan names (the size's best source)
//   typeName(type)                                   'small fix' for small-fix: the words the pages show
//
// ═══ HOW A TYPE IS FOUND ═══ Each type has a list of words, each with a weight: a word that says one thing
// (typo, refactor, README, CI/CD, console) weighs 3, a word that could mean several things (fix, add, new) weighs 1.
// A word in the title counts its weight; a word only in the text counts half, and only the first TEXT_MAX
// characters of the text are read (a pasted log must not outvote the title). A word in a `Prefix:` at the start of
// the title (`Docs:`, `CI/CD:`, `Legal:`) counts PREFIX_BONUS more: the tracker's own heading. A label that names a
// type counts LABEL_WEIGHT, and the story type (bug, feature) STORY_WEIGHT.
// The highest score wins:
//   certain   at least CERTAIN_MIN and at least twice the next type's score
//   likely    at least LIKELY_MIN and more than the next
//   unsure    anything else: a tie (the reason names both), or too little to go on (no type at all, type null)
// ⚠️ An unsure answer is never dressed up as a guess: the pages say Unsure, the routing rules match it only with a
// rule that names no type, and the user can correct it. The correction is stored by the caller (the flow's
// `routing.typeBy`, factory-state.mjs for a ticket) and always wins (withCorrection).
//
// Pure: no file, no config, no clock.

export const TASK_TYPES = Object.freeze(['wording', 'style', 'small-fix', 'feature', 'refactor', 'tests', 'docs', 'data', 'infra', 'investigation', 'review', 'by-hand'])
export const SIZES = Object.freeze(['small', 'medium', 'large'])
export const CONFIDENCE = Object.freeze(['certain', 'likely', 'unsure'])

const TEXT_MAX = 4000
const PREFIX_BONUS = 2
const LABEL_WEIGHT = 4
const STORY_WEIGHT = 1
const CERTAIN_MIN = 5
const LIKELY_MIN = 2
const SHOWN_WORDS = 3

/** What the pages call each type. */
const NAMES = Object.freeze({ 'small-fix': 'small fix', 'by-hand': 'by hand' })
export const typeName = t => (t ? NAMES[t] || t : 'not known')

// [pattern, weight, the word the reason shows]: a pattern is matched on lower-case text with word edges
const W = (re, weight, word) => ({ re: new RegExp(`(?:^|[^a-z0-9])(?:${re})(?![a-z0-9])`), weight, word })
const WORDS = {
  wording: [W('typos?', 3, 'typo'), W('wording', 3, 'wording'), W('reword(?:ing)?', 3, 'reword'), W('spelling', 3, 'spelling'), W('grammar', 3, 'grammar'),
    W('phrasing', 3, 'phrasing'), W('microcopy', 3, 'microcopy'), W('punctuation', 3, 'punctuation'), W('(?:ui |button |page )?copy (?:change|text|tweak)s?', 2, 'copy'), W('label text', 2, 'label text')],
  style: [W('css', 3, 'CSS'), W('styl(?:e|es|ing)', 2, 'style'), W('colou?rs?', 2, 'colour'), W('dark mode', 3, 'dark mode'), W('padding', 3, 'padding'), W('margins?', 2, 'margin'),
    W('spacing', 3, 'spacing'), W('align(?:ed|ment)?', 2, 'alignment'), W('fonts?', 2, 'font'), W('layout', 2, 'layout'), W('responsive', 2, 'responsive'), W('ui/ux|ux/ui', 2, 'UI/UX'),
    W('distorted', 2, 'distorted'), W('truncated', 2, 'truncated'), W('icons?', 1, 'icon'), W('theme', 1, 'theme')],
  'small-fix': [W('bug', 1, 'bug'), W('fix(?:es|ed)?', 1, 'fix'), W('broken', 2, 'broken'), W('crash(?:es|ed)?', 2, 'crash'), W('errors?', 1, 'error'), W('fails?', 1, 'fails'),
    W('regression', 2, 'regression'), W('wrong', 1, 'wrong'), W('does not work|doesn.t work|not working', 2, 'not working')],
  feature: [W('feat(?:ure)?', 2, 'feature'), W('add(?:s|ed|ing)?', 1, 'add'), W('new', 1, 'new'), W('implement(?:ed|s)?', 1, 'implement'), W('support', 1, 'support'),
    W('allow(?:s)?', 1, 'allow'), W('enable(?:s)?', 1, 'enable'), W('introduce', 1, 'introduce'), W('create', 1, 'create')],
  refactor: [W('refactor(?:s|ed|ing)?', 3, 'refactor'), W('clean ?up', 3, 'clean up'), W('tidy', 2, 'tidy'), W('restructure', 3, 'restructure'), W('split', 1, 'split'),
    W('extract', 2, 'extract'), W('simplify', 2, 'simplify'), W('dead code', 3, 'dead code'), W('tech(?:nical)? debt', 3, 'tech debt')],
  tests: [W('tests?', 2, 'test'), W('testing', 2, 'testing'), W('unit tests?', 3, 'unit test'), W('e2e', 3, 'E2E'), W('integration tests?', 3, 'integration test'),
    W('coverage', 2, 'coverage'), W('flaky', 3, 'flaky'), W('playwright', 2, 'Playwright')],
  docs: [W('docs?', 3, 'docs'), W('documentation', 3, 'documentation'), W('readme', 3, 'README'), W('user guide|guide', 2, 'guide'), W('runbook', 3, 'runbook'),
    W('documented', 3, 'documented'), W('changelog', 3, 'changelog'), W('template', 1, 'template'), W('write ?up', 2, 'write-up')],
  data: [W('database', 3, 'database'), W('db', 2, 'DB'), W('sql', 3, 'SQL'), W('migrations?', 2, 'migration'), W('schema', 2, 'schema'), W('indexes|indices', 3, 'indexes'),
    W('quer(?:y|ies)', 2, 'query'), W('backups?', 2, 'backup'), W('seed(?:ing)?', 2, 'seed'), W('data retention', 3, 'data retention'), W('bigquery', 3, 'BigQuery'),
    W('firestore', 2, 'Firestore'), W('n\\+1', 3, 'N+1'), W('exports?', 1, 'export')],
  infra: [W('ci/cd', 4, 'CI/CD'), W('ci', 2, 'CI'), W('pipeline', 1, 'pipeline'), W('deploy(?:s|ed|ment)?', 2, 'deploy'), W('rollout', 2, 'rollout'), W('rollback', 2, 'rollback'),
    W('dns', 3, 'DNS'), W('cdn', 3, 'CDN'), W('gcp', 3, 'GCP'), W('cloud', 2, 'cloud'), W('hosting', 2, 'hosting'), W('terraform', 3, 'Terraform'), W('docker', 3, 'Docker'),
    W('iam', 3, 'IAM'), W('quotas?', 2, 'quota'), W('environment variables|env vars?', 3, 'environment variables'), W('monitoring', 2, 'monitoring'),
    W('alert(?:s|ing)?', 2, 'alerting'), W('observability', 3, 'observability'), W('tracing', 2, 'tracing'), W('logs?', 1, 'logs'), W('sentry', 2, 'Sentry'),
    W('waf', 3, 'WAF'), W('https', 2, 'HTTPS'), W('cors', 2, 'CORS'), W('uptime', 2, 'uptime'), W('secrets?', 2, 'secrets')],
  investigation: [W('investigat(?:e|ion)', 3, 'investigate'), W('why', 2, 'why'), W('look into', 3, 'look into'), W('find out', 3, 'find out'), W('root cause', 3, 'root cause'),
    W('explore', 2, 'explore'), W('spike', 2, 'spike'), W('research', 3, 'research'), W('audit', 2, 'audit'), W('analy[sz]e', 2, 'analyse'), W('diagnose', 3, 'diagnose'),
    W('measure', 2, 'measure')],
  review: [W('code review', 4, 'code review'), W('review', 2, 'review'), W('pull request|pr', 2, 'pull request'), W('check the code', 3, 'check the code')],
  'by-hand': [W('console', 4, 'console'), W('manual(?:ly)?', 3, 'manual'), W('by hand', 3, 'by hand'), W('notify', 2, 'notify'), W('communicate', 3, 'communicate'),
    W('sign[- ]?off', 3, 'sign off'), W('legal', 3, 'legal'), W('billing', 4, 'billing'), W('account', 1, 'account'), W('rota', 3, 'rota'), W('on-call', 3, 'on-call'),
    W('meeting', 3, 'meeting'), W('marketing', 3, 'marketing'), W('purchase|buy', 3, 'purchase'), W('contract', 3, 'contract'), W('drill', 2, 'drill'),
    W('hard refresh', 3, 'hard refresh'), W('game day', 3, 'game day')],
}

/** A label (any case) that names a type outright. */
const LABELS = new Map(Object.entries({
  wording: 'wording', copy: 'wording', content: 'wording', style: 'style', css: 'style', design: 'style', ui: 'style', bug: 'small-fix', fix: 'small-fix',
  feature: 'feature', enhancement: 'feature', refactor: 'refactor', 'tech debt': 'refactor', tests: 'tests', testing: 'tests', test: 'tests', qa: 'tests',
  docs: 'docs', documentation: 'docs', data: 'data', database: 'data', infra: 'infra', infrastructure: 'infra', devops: 'infra', ci: 'infra', 'ci/cd': 'infra',
  investigation: 'investigation', research: 'investigation', spike: 'investigation', review: 'review', 'by hand': 'by-hand', manual: 'by-hand', ops: 'by-hand',
}))
/** The tracker's story types that say something (a chore or a release says nothing about the kind of work). */
const STORY = Object.freeze({ bug: 'small-fix', feature: 'feature' })

const text = v => (typeof v === 'string' ? v : '')
const lower = v => text(v).toLowerCase()
const list = (items, and = 'and') => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`)

/** Score every type: { type -> { score, words: Set, label, story } }. */
function scores({ title, body, labels, storyType }) {
  const prefix = /^\s*([^:]{1,40}):/.exec(title)?.[1] || ''
  const out = {}
  const add = (type, n) => {
    out[type] ||= { score: 0, words: [], label: null, story: false }
    out[type].score += n
    return out[type]
  }
  for (const [type, words] of Object.entries(WORDS)) {
    for (const w of words) {
      const inTitle = w.re.test(title)
      const inText = !inTitle && w.re.test(body)
      if (!inTitle && !inText) continue
      const s = add(type, (inTitle ? w.weight : w.weight / 2) + (inTitle && w.re.test(prefix) ? PREFIX_BONUS : 0))
      if (!s.words.includes(w.word)) s.words.push(w.word)
    }
  }
  for (const raw of labels) {
    const type = LABELS.get(lower(raw).trim())
    if (type) add(type, LABEL_WEIGHT).label ||= text(raw).trim()
  }
  const story = STORY[lower(storyType).trim()]
  if (story) add(story, STORY_WEIGHT).story = true
  return out
}

/** Why, in one plain line: the words, the label and the story type that counted. */
function because(type, s, storyType) {
  const parts = []
  if (s.words.length) parts.push(`the words ${list(s.words.slice(0, SHOWN_WORDS))}`)
  if (s.label) parts.push(`the label ${s.label}`)
  if (s.story) parts.push(`the story type ${lower(storyType).trim()}`)
  return `${typeName(type)}: ${list(parts)}`
}

export function taskTypeOf(input) {
  const i = input && typeof input === 'object' ? input : {}
  const title = lower(i.title)
  const body = lower(i.text).slice(0, TEXT_MAX)
  const labels = Array.isArray(i.labels) ? i.labels.filter(l => typeof l === 'string') : []
  const all = scores({ title, body, labels, storyType: i.storyType })
  const ranked = Object.entries(all).sort((a, b) => b[1].score - a[1].score || TASK_TYPES.indexOf(a[0]) - TASK_TYPES.indexOf(b[0]))
  const [top, next] = ranked
  if (!top || top[1].score < LIKELY_MIN / 2) return { type: null, confidence: 'unsure', reason: 'Too little to go on: no words or labels say what kind of work this is.' }
  const second = next?.[1].score || 0
  if (top[1].score === second) {
    return { type: top[0], confidence: 'unsure', reason: `Unsure between ${typeName(top[0])} and ${typeName(next[0])}. ${capital(because(top[0], top[1], i.storyType))}; ${because(next[0], next[1], i.storyType)}.` }
  }
  const confidence = top[1].score >= CERTAIN_MIN && top[1].score >= 2 * second ? 'certain' : top[1].score >= LIKELY_MIN ? 'likely' : 'unsure'
  return { type: top[0], confidence, reason: `${capital(because(top[0], top[1], i.storyType))}.` }
}

const capital = s => s.charAt(0).toUpperCase() + s.slice(1)

/** The user's correction (a type, or null for none) over the automatic answer: it always wins. */
export function withCorrection(auto, corrected) {
  if (TASK_TYPES.includes(corrected)) return { type: corrected, confidence: 'certain', reason: 'Set by you.', by: 'you' }
  return { ...auto, by: 'rules' }
}

/** The types whose work is usually small when the request is short. */
const SMALL_KINDS = new Set(['wording', 'style', 'small-fix', 'docs', 'tests', 'review'])
const SHORT = 400
const LONG = 1500

/**
 * small | medium | large: from the plan's file count when it names files (2 or fewer small, 8 or fewer medium, more
 * large); else from the length of the request and its type (a short wording, style, fix, docs, tests or review
 * request is small; any other short one medium; past LONG characters large). Nothing known: medium.
 */
export function sizeOf({ files, text: t, type } = {}) {
  if (Number.isInteger(files) && files > 0) return files <= 2 ? 'small' : files <= 8 ? 'medium' : 'large'
  const n = typeof t === 'string' ? t.trim().length : 0
  if (!n && !type) return 'medium'
  if (n > LONG) return 'large'
  if (n > SHORT) return 'medium'
  return SMALL_KINDS.has(type) ? 'small' : 'medium'
}

/** A file path in a plan: a name with a code or text extension, not part of a web address. */
const FILE_PATH = /(?<![\w/:.-])((?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|js|jsx|ts|tsx|css|scss|html|md|json|dart|py|sql|yml|yaml|sh|go|rs|java|kt|swift|tf))(?![\w/])/g

/** How many distinct file paths a plan names (a web address does not count). */
export function planFileCount(plan) {
  if (typeof plan !== 'string' || !plan) return 0
  const noLinks = plan.replace(/\bhttps?:\/\/\S+/g, ' ')
  return new Set([...noLinks.matchAll(FILE_PATH)].map(m => m[1])).size
}
