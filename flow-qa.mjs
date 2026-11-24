// QA, the data half: what a flow's `qa` block holds (flows.mjs validates it on every write), that it is
// QA's alone, and the two blockers it adds to Send (pr-routes.mjs). Pure: no file access, no git.
//
//   flow.qa = {
//     status     pending | testing | passed | failed | qa-failed (failed too often: stopped, the flow blocked)
//     attempt    1, 2, …: this test run; attempt n+1 starts when QA starts again after a result
//     by, startedAt, at   QA's label, when this attempt started, when its status last changed
//     commit     the sha QA tested (7 to 40 hex): the ONLY commit `flow qa-push` pushes, and the head Send must match
//     report     '<flow>/qa-<n>-report.md' (or .txt): QA's short report, copied into the flow's evidence folder
//     shots      ['<flow>/qa-<n>-<name>'], steps [{ do, expect, shot? }]: the screenshots and the manual steps
//     summary    one short paragraph, at most 1000 characters
//     branch, remote, repo, pushedAt, pushError   what `flow qa-push` did (never retried on its own)
//     rework     { to, queuedAt, sentAt, error } on a failure: `to` is the producer it goes back to (QA's);
//                queuedAt, sentAt and error are the SERVER's (qa-rework.mjs, relay.mjs), like an answer's delivery
//     security   Security's review of a passed attempt, when pipeline.security is set (flow-security.mjs): it
//                belongs to this attempt and its commit, so a new attempt needs a new review
//     attempts   the earlier attempts, oldest first, each the same shape without `attempts`
//   }
//
// ⚠️ QA's alone, like `output.pr` is the server's: only the QA commands (tools/qa-cli.mjs) write it, and an
// agent's `flow write` rewrite takes it from the stored file only (keepQa, called by mergeKeepingAnswers), so no
// producer can drop a failure or forge a pass. The report is Markdown or text, never HTML: the evidence route
// serves it as text/plain (factory-routes.mjs), so nothing in it ever runs.

import { isBranch } from './flow-merge.mjs'
import { validateSecurity } from './flow-security.mjs'
import { isCodeProducing } from './pipeline.mjs'

export const QA_STATUS = Object.freeze(['pending', 'testing', 'passed', 'failed', 'qa-failed'])
/** A result is in: the next `flow qa-start` begins a new attempt. */
export const QA_FINISHED = Object.freeze(['passed', 'failed', 'qa-failed'])
export const QA_MAX = Object.freeze({ summary: 1000, line: 500, steps: 30, shots: 30, attempts: 50, error: 300 })
/** What a QA report may be: Markdown or plain text, served as text, never HTML. */
export const REPORT_EXT = Object.freeze(['md', 'txt'])

/** MUST CHANGE IN LOCKSTEP with flows.mjs AGENT_LABEL. */
const LABEL = /^[A-Za-z0-9 ._-]{1,40}$/
const SLUG = /^[a-z0-9-]+$/
const SHA = /^[0-9a-f]{7,40}$/i
const REMOTE = /^[A-Za-z0-9._-]{1,100}$/
/** MUST CHANGE IN LOCKSTEP with flows.mjs ISO_TIME. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
const isTime = v => typeof v === 'string' && ISO_TIME.test(v) && !Number.isNaN(Date.parse(v))
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== ''
const bounded = (v, max) => isText(v) && v.length <= max

/**
 * ONE file in this flow's evidence folder, `<flow id>/<name>`, like flows.mjs fileRef (MUST CHANGE IN LOCKSTEP),
 * optionally of the given extensions.
 */
function fileRef(ref, flowId, exts = null) {
  const m = /^([a-z0-9-]+)\/([^/\\]{1,200})$/.exec(typeof ref === 'string' ? ref : '')
  if (!m || !(m[1] === flowId || !SLUG.test(String(flowId))) || m[2] === '.' || m[2] === '..') return false
  return !exts || exts.includes(m[2].split('.').pop().toLowerCase())
}

/** The problems of one attempt (the current one, or one in `attempts`), each line starting with `at`. */
function attemptProblems(q, flowId, at, nested) {
  const problems = []
  const FILE = `${flowId}/<file name>, at most 200 characters`
  if (!QA_STATUS.includes(q.status)) problems.push(`${at} status must be one of ${QA_STATUS.join(', ')}`)
  if (!(Number.isInteger(q.attempt) && q.attempt >= 1)) problems.push(`${at} attempt must be a whole number from 1`)
  if (q.by !== undefined && !(typeof q.by === 'string' && LABEL.test(q.by))) problems.push(`${at} by must be a label of 1 to 40 letters, digits, spaces, dots, dashes or underscores`)
  for (const key of ['at', 'startedAt']) if (q[key] != null && !isTime(q[key])) problems.push(`${at} ${key} must be a time`)
  if (q.commit != null && !SHA.test(String(q.commit))) problems.push(`${at} commit must be a commit sha (7 to 40 hex characters)`)
  if (q.report != null && !fileRef(q.report, flowId, REPORT_EXT)) problems.push(`${at} report must be ${flowId}/<file>.md or .txt (a report is never HTML)`)
  if (q.shots !== undefined) {
    if (!Array.isArray(q.shots)) problems.push(`${at} shots must be a list`)
    else if (q.shots.length > QA_MAX.shots) problems.push(`${at} shots has ${q.shots.length}, at most ${QA_MAX.shots}`)
    else q.shots.forEach((s, i) => { if (!fileRef(s, flowId)) problems.push(`${at} shots #${i + 1} must be ${FILE}`) })
  }
  if (q.steps !== undefined) {
    if (!Array.isArray(q.steps)) problems.push(`${at} steps must be a list`)
    else if (q.steps.length > QA_MAX.steps) problems.push(`${at} steps has ${q.steps.length}, at most ${QA_MAX.steps}`)
    else {
      q.steps.forEach((s, i) => {
        const where = `${at} steps #${i + 1}`
        if (!isObject(s)) return problems.push(`${where} must be a JSON object`)
        for (const key of ['do', 'expect']) if (!bounded(s[key], QA_MAX.line)) problems.push(`${where} ${key} must be non-empty text of at most ${QA_MAX.line} characters`)
        if (s.shot !== undefined && !fileRef(s.shot, flowId)) problems.push(`${where} shot must be ${FILE}`)
      })
    }
  }
  if (q.summary != null && !(typeof q.summary === 'string' && q.summary.length <= QA_MAX.summary)) problems.push(`${at} summary must be text of at most ${QA_MAX.summary} characters`)
  if (q.branch != null && !isBranch(q.branch)) problems.push(`${at} branch must be a branch name`)
  if (q.remote != null && !(typeof q.remote === 'string' && REMOTE.test(q.remote) && !q.remote.startsWith('-'))) problems.push(`${at} remote must be a remote name such as origin`)
  if (q.repo != null && !bounded(q.repo, 400)) problems.push(`${at} repo must be a folder path`)
  if (q.pushedAt != null && !isTime(q.pushedAt)) problems.push(`${at} pushedAt must be null or a time`)
  if (q.pushError != null && !bounded(q.pushError, QA_MAX.error)) problems.push(`${at} pushError must be null or text of at most ${QA_MAX.error} characters`)
  if (q.rework != null) {
    const r = q.rework
    if (!isObject(r)) problems.push(`${at} rework must be null or a JSON object`)
    else {
      if (!(typeof r.to === 'string' && LABEL.test(r.to))) problems.push(`${at} rework to must be a label of the producer it goes back to`)
      for (const key of ['queuedAt', 'sentAt']) if (r[key] != null && !isTime(r[key])) problems.push(`${at} rework ${key} must be null or a time`)
      if (r.error != null && !bounded(r.error, QA_MAX.error)) problems.push(`${at} rework error must be null or text of at most ${QA_MAX.error} characters`)
    }
  }
  if (q.security !== undefined) problems.push(...validateSecurity(q.security, flowId, `${at} security`))
  if (nested && q.attempts !== undefined) problems.push(`${at} must not hold attempts of its own`)
  return problems
}

/** The problems of a flow's optional `qa` block, one plain line each; [] when it is valid. */
export function validateQa(qa, flowId) {
  if (!isObject(qa)) return ['qa must be a JSON object']
  const problems = attemptProblems(qa, flowId, 'qa', false)
  if (qa.attempts !== undefined) {
    if (!Array.isArray(qa.attempts)) problems.push('qa attempts must be a list')
    else if (qa.attempts.length > QA_MAX.attempts) problems.push(`qa attempts has ${qa.attempts.length}, at most ${QA_MAX.attempts}`)
    else {
      qa.attempts.forEach((a, i) => {
        if (!isObject(a)) problems.push(`qa attempts #${i + 1} must be a JSON object`)
        else problems.push(...attemptProblems(a, flowId, `qa attempts #${i + 1}`, true))
      })
    }
  }
  return problems
}

/**
 * For `flow write` (mergeKeepingAnswers): the `qa` block only ever comes from the stored file. Left out, changed
 * or forged in the agent's file, it is the stored one (or none). Returns `incoming`, changed.
 */
export function keepQa(incoming, existing) {
  if (existing?.qa !== undefined) incoming.qa = existing.qa
  else delete incoming.qa
  return incoming
}

const short = sha => String(sha || '').slice(0, 7).toLowerCase()
const NOT_PASSED = {
  none: 'hand the flow to QA, which tests it and pushes the branch on a pass.',
  pending: 'it waits for QA to test it.',
  testing: 'QA is testing it.',
  failed: 'it failed QA and went back for a fix.',
  'qa-failed': 'it failed QA too often and is stopped: look at the QA report.',
}

/**
 * Send's QA blockers (pr-routes.mjs adds them to pr-check.mjs's facts): a flow that produced code must have
 * passed QA, and QA must have tested the very commit being sent (`headSha`, the full sha of the branch; a short
 * sha QA recorded matches its start). A flow that changed no code needs no QA. With no head (no branch), the
 * branch blocker already says why, so no second line.
 */
export function qaBlockers(flow, headSha) {
  if (!isCodeProducing(flow)) return []
  const qa = isObject(flow?.qa) ? flow.qa : null
  if (qa?.status !== 'passed') return [`QA has not passed: ${NOT_PASSED[qa?.status] || NOT_PASSED.none}`]
  if (!headSha) return []
  const tested = String(qa.commit || '').toLowerCase()
  if (tested && String(headSha).toLowerCase().startsWith(tested)) return []
  return [`QA tested a different commit (${short(tested) || 'none'}) than the head being sent (${short(headSha)}): ask QA to test the branch again.`]
}

/** The qa block for a page (/api/pipeline): everything of the current attempt, the earlier ones as an outline. Null for none. */
export function qaView(qa) {
  if (!isObject(qa)) return null
  const { attempts, ...current } = qa
  return {
    ...current,
    attempts: (Array.isArray(attempts) ? attempts : []).map(a => ({
      attempt: a.attempt, status: a.status, at: a.at ?? null, commit: a.commit ?? null, summary: a.summary ?? '', report: a.report ?? null,
      ...(a.security && typeof a.security === 'object' ? { security: a.security.status } : {}), // Security's verdict on it, when it had one
    })),
  }
}
