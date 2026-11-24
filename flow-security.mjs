// Security, the data half. Security (config pipeline.security, pipeline.mjs) sits after QA and before Push: it
// reviews the very commit QA passed, and QA pushes only once Security passed it too. Its record lives INSIDE the QA
// attempt it reviewed, `flow.qa.security`, so:
//   - a verdict always belongs to one QA attempt and one commit (the one QA passed);
//   - a new QA attempt (flow qa-start, after a fix) starts with no Security verdict: the old one moves into
//     qa.attempts with its attempt, and the new attempt needs a new review;
//   - `qa` stays the one block a producer can never rewrite (flow-qa.mjs keepQa keeps all of it).
//
//   flow.qa.security = {
//     status     reviewing | passed | failed | security-failed (failed too often: stopped, the flow blocked)
//     by, startedAt, at   Security's label, when it started reviewing, when its status last changed
//     commit     the sha Security reviewed: always QA's commit for that attempt (7 to 40 hex)
//     report     '<flow>/security-<n>-report.md' (or .txt), n the QA attempt: its short report
//     summary    one short paragraph, at most 1000 characters
//     rework     { to, queuedAt, sentAt, error } on a failure that goes back to a producer, delivered by the SAME
//                relay path as a QA failure (qa-rework.mjs); queuedAt, sentAt and error are the SERVER's
//   }
//
// QA failures and Security failures share ONE limit, pipeline.maxReworks (reworksSoFar). Only the Security commands
// (tools/security-cli.mjs) write this block. Pure: no file access, no git.

import { gateLabels } from './pipeline.mjs'

export const SECURITY_STATUS = Object.freeze(['reviewing', 'passed', 'failed', 'security-failed'])
/** A verdict is in: no second one on the same QA attempt. */
export const SECURITY_FINISHED = Object.freeze(['passed', 'failed', 'security-failed'])
export const SECURITY_MAX = Object.freeze({ summary: 1000, error: 300 })
/** What a Security report may be: Markdown or plain text (MUST CHANGE IN LOCKSTEP with flow-qa.mjs REPORT_EXT). */
export const SECURITY_REPORT_EXT = Object.freeze(['md', 'txt'])

/** MUST CHANGE IN LOCKSTEP with flows.mjs AGENT_LABEL. */
const LABEL = /^[A-Za-z0-9 ._-]{1,40}$/
const SLUG = /^[a-z0-9-]+$/
const SHA = /^[0-9a-f]{7,40}$/i
/** MUST CHANGE IN LOCKSTEP with flows.mjs ISO_TIME. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
const isTime = v => typeof v === 'string' && ISO_TIME.test(v) && !Number.isNaN(Date.parse(v))
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''

function reportRef(ref, flowId) {
  const m = /^([a-z0-9-]+)\/([^/\\]{1,200})$/.exec(typeof ref === 'string' ? ref : '')
  if (!m || !(m[1] === flowId || !SLUG.test(String(flowId))) || m[2] === '.' || m[2] === '..') return false
  return SECURITY_REPORT_EXT.includes(m[2].split('.').pop().toLowerCase())
}

/** The problems of one `security` block, each line starting with `at` (flow-qa.mjs calls it for every attempt). */
export function validateSecurity(s, flowId, at = 'qa security') {
  if (!isObject(s)) return [`${at} must be a JSON object`]
  const problems = []
  if (!SECURITY_STATUS.includes(s.status)) problems.push(`${at} status must be one of ${SECURITY_STATUS.join(', ')}`)
  if (s.by !== undefined && !(typeof s.by === 'string' && LABEL.test(s.by))) problems.push(`${at} by must be a label of 1 to 40 letters, digits, spaces, dots, dashes or underscores`)
  for (const key of ['at', 'startedAt']) if (s[key] != null && !isTime(s[key])) problems.push(`${at} ${key} must be a time`)
  if (s.commit != null && !SHA.test(String(s.commit))) problems.push(`${at} commit must be a commit sha (7 to 40 hex characters)`)
  if (s.report != null && !reportRef(s.report, flowId)) problems.push(`${at} report must be ${flowId}/<file>.md or .txt (a report is never HTML)`)
  if (s.summary != null && !(typeof s.summary === 'string' && s.summary.length <= SECURITY_MAX.summary)) problems.push(`${at} summary must be text of at most ${SECURITY_MAX.summary} characters`)
  if (s.rework != null) {
    const r = s.rework
    if (!isObject(r)) problems.push(`${at} rework must be null or a JSON object`)
    else {
      if (!(typeof r.to === 'string' && LABEL.test(r.to))) problems.push(`${at} rework to must be a label of the producer it goes back to`)
      for (const key of ['queuedAt', 'sentAt']) if (r[key] != null && !isTime(r[key])) problems.push(`${at} rework ${key} must be null or a time`)
      if (r.error != null && !(isText(r.error) && r.error.length <= SECURITY_MAX.error)) problems.push(`${at} rework error must be null or text of at most ${SECURITY_MAX.error} characters`)
    }
  }
  return problems
}

/** How many times a flow already went back, over `attempts` (QA attempts): QA failures and Security failures alike. */
export const reworksSoFar = attempts => (Array.isArray(attempts) ? attempts : []).filter(a => a?.status === 'failed' || a?.security?.status === 'failed').length

/**
 * The failure of the CURRENT attempt that goes (or went) back to a producer, from QA or from Security:
 * { source: 'qa' | 'security', rework, attempt } or null. qa-rework.mjs delivers both the same way.
 */
export function pendingRework(qa) {
  if (!isObject(qa)) return null
  if (qa.status === 'failed' && isObject(qa.rework) && isText(qa.rework.to)) return { source: 'qa', rework: qa.rework, attempt: qa.attempt }
  const s = qa.security
  if (qa.status === 'passed' && isObject(s) && s.status === 'failed' && isObject(s.rework) && isText(s.rework.to)) return { source: 'security', rework: s.rework, attempt: qa.attempt }
  return null
}

const short = sha => String(sha || '').slice(0, 7).toLowerCase()
const sameCommit = (a, b) => {
  const x = String(a || '').toLowerCase()
  const y = String(b || '').toLowerCase()
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x))
}
const NOT_PASSED = {
  none: 'it has not started its review.',
  reviewing: 'it is reviewing it.',
  failed: 'it failed the review and went back for a fix.',
  'security-failed': 'it failed the review too often and is stopped: look at the Security report.',
}

/**
 * Why a flow may not be pushed or sent yet because of Security, one line each; [] when Security is not on the
 * pipeline, there is no commit QA passed (nothing to push, so nothing to review), or Security passed the very commit
 * QA passed. Send (pr-routes.mjs) and `flow qa-push` (tools/qa-cli.mjs) both ask this.
 * ⚠️ NOT isCodeProducing: that reads step evidence, the summary and a recorded pull request, and a flow can carry
 * none of them while QA passed a commit that is about to be pushed (QA, 2026-11-25). The commit QA passed decides.
 */
export function securityBlockers(flow, config) {
  const label = gateLabels(config).security
  const qa = isObject(flow?.qa) ? flow.qa : null
  if (!label || !qa || !isText(qa.commit)) return []
  if (qa.status !== 'passed') return [] // QA's own blocker says why
  const s = isObject(qa.security) ? qa.security : null
  if (s?.status !== 'passed') return [`${label} has not passed the commit QA passed (${short(qa.commit) || 'none'}): ${NOT_PASSED[s?.status] || NOT_PASSED.none}`]
  if (!sameCommit(s.commit, qa.commit)) return [`${label} reviewed a different commit (${short(s.commit) || 'none'}) than QA passed (${short(qa.commit)}): ask ${label} to review again.`]
  return []
}

/** One sentence on the Security verdict for `flow show` (stderr), or nothing when Security has not looked yet. */
export function securityBlock(flow) {
  const s = flow?.qa?.security
  if (!isObject(s)) return []
  const parts = [`${s.status}${s.commit ? ` at ${short(s.commit)}` : ''}`]
  const r = s.rework
  if (r?.to) parts.push(`back to ${r.to} (${r.sentAt ? 'sent' : r.error ? `not delivered: ${r.error}` : 'not sent yet'})`)
  return [`  security: ${parts.join(', ')}`]
}
