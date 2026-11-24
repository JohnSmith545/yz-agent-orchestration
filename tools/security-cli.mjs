// The Security commands, behind `node tools/factory.mjs flow …` (tools/flow-cli.mjs registers them). Security
// (config pipeline.security, pipeline.mjs) reviews every code change after QA passed it and before QA pushes it.
// Its record is `flow.qa.security`, inside the QA attempt it reviewed (flow-security.mjs). They mirror the QA
// commands (tools/qa-cli.mjs):
//
//   security-start <flow> [--commit <sha>] --by Security
//       Security picks up the commit QA passed: qa.security.status reviewing. Refused unless QA passed the current
//       attempt, and once Security already gave its verdict on that attempt (a new review needs QA to test again).
//       A --commit must be the one QA passed.
//   security <flow> --status passed|failed --report <file.md|file.txt> --commit <sha> [--summary "..."] --by Security
//       The verdict, on the commit QA passed and no other. The report is copied into the flow's evidence folder as
//       <flow>/security-<n>-report.md (n the QA attempt). PASSED marks the flow done: QA may push it now
//       (`flow qa-push` refuses until then). FAILED sends it back to the flow's producer exactly as a QA failure
//       does (qa.security.rework, delivered by the server, qa-rework.mjs), unless that agent is not a producer or
//       the flow already went back pipeline.maxReworks times, QA and Security failures together: then
//       security-failed, the flow blocked, nothing sent.
//
// ⚠️ ONLY SECURITY: both refuse unless the pipeline has a Security agent and --by (or FACTORY_BY) is exactly its
// label. Security never pushes and never changes application code: it reports, and the producer fixes.
//
// Like the other flow commands they return { out, code } and never print. `config` comes from runFlow's context.

import { CONFIG } from '../config.mjs'
import { reworksSoFar, SECURITY_FINISHED, SECURITY_MAX, SECURITY_REPORT_EXT } from '../flow-security.mjs'
import { readFlow, validateFlow, writeFlow } from '../flows.mjs'
import { gateLabels, producersOf } from '../pipeline.mjs'
import { docTarget } from './plan-cli.mjs'

const fail = out => ({ out, code: 1 })
const ok = out => ({ out, code: 0 })
const now = () => new Date().toISOString()
const SHA = /^[0-9a-f]{7,40}$/i
const short = sha => String(sha || '').slice(0, 7)
const sameCommit = (a, b) => {
  const x = String(a || '').toLowerCase()
  const y = String(b || '').toLowerCase()
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x))
}

function load(id) {
  const flow = readFlow(id)
  if (!flow) throw new Error(`No flow ${id}`)
  return flow
}

const QA_NOT_PASSED = {
  pending: 'it waits for QA', testing: 'QA is testing it', failed: 'it failed QA and went back for a fix', 'qa-failed': 'it failed QA and is stopped',
}

export function securityCommands({ noName, copyEvidence }) {
  /** One line when `by` may not record a review; null when it may. */
  function notSecurity(by, config) {
    const label = gateLabels(config).security
    if (!label) return 'This pipeline has no Security agent (config pipeline.security), so there is nothing to review.'
    if (!by) return noName
    return by === label ? null : `Only Security records a review: --by must be "${label}" (config pipeline.security), not "${by}".`
  }

  /** The QA attempt Security may review, or a one-line refusal: QA passed it, and Security has no verdict on it yet. */
  function reviewable(flow) {
    if (flow.status === 'dropped') return { error: `${flow.id} is dropped: there is nothing to review.` }
    const qa = flow.qa && typeof flow.qa === 'object' ? flow.qa : null
    if (qa?.status !== 'passed') return { error: `${flow.id}: Security reviews only what QA passed, and ${QA_NOT_PASSED[qa?.status] || 'QA has not tested it yet'}.` }
    if (SECURITY_FINISHED.includes(qa.security?.status)) return { error: `${flow.id}: Security already gave its verdict on QA attempt ${qa.attempt}. A new review needs QA to test the fix first.` }
    return { qa }
  }

  /** A --commit that is not the one QA passed, as the refusal; null when it is (or none was given and none is needed). */
  function wrongCommit(given, qa, needed) {
    if (given === undefined) return needed ? 'security needs --commit <sha>: the commit Security reviewed, which is the one QA passed' : null
    if (!SHA.test(String(given))) return `--commit ${given} is not a commit sha (7 to 40 hex characters)`
    return sameCommit(given, qa.commit) ? null : `Security reviews the commit QA passed (${short(qa.commit)}), not ${short(given)}: review that commit, or ask QA to test the new one first.`
  }

  function securityStart(f, { by, config = CONFIG }) {
    const refused = notSecurity(by, config)
    if (refused) return fail(refused)
    const flow = load(f._[0])
    const { qa, error } = reviewable(flow)
    if (error) return fail(error)
    const bad = wrongCommit(f.commit, qa, false)
    if (bad) return fail(bad)
    const at = now()
    const cur = qa.security?.status === 'reviewing' ? qa.security : null
    flow.qa = { ...qa, security: { status: 'reviewing', by, startedAt: cur?.startedAt || at, at, commit: String(qa.commit) } }
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    writeFlow(flow)
    return ok(`${flow.id}: Security is reviewing QA attempt ${qa.attempt} at ${short(qa.commit)}.`)
  }

  function securityResult(f, { by, cwd, config = CONFIG }) {
    const refused = notSecurity(by, config)
    if (refused) return fail(refused)
    const flow = load(f._[0])
    if (!['passed', 'failed'].includes(f.status)) return fail('security needs --status passed|failed')
    if (f.report === undefined) return fail('security needs --report <file.md>: a short report of what Security checked and found')
    const { qa, error } = reviewable(flow)
    if (error) return fail(error)
    const bad = wrongCommit(f.commit, qa, true)
    if (bad) return fail(bad)
    if (f.summary !== undefined && String(f.summary).length > SECURITY_MAX.summary) return fail(`--summary must be at most ${SECURITY_MAX.summary} characters`)
    const report = docTarget(flow.id, `security-${qa.attempt}-report`, f.report, cwd, SECURITY_REPORT_EXT)
    if (!report) return fail('a Security report must be an existing .md or .txt file (never HTML)')

    const at = now()
    const security = { status: f.status, by, startedAt: qa.security?.startedAt || at, at, commit: String(qa.commit), report: report.ref, summary: String(f.summary ?? ''), rework: null }
    let line
    if (f.status === 'passed') {
      flow.status = 'done'
      line = `${flow.id}: Security passed QA attempt ${qa.attempt} at ${short(qa.commit)}; the flow is done. Send ${config.pipeline?.qa || 'QA'} a message naming flow ${flow.id}: it pushes that commit.`
    } else {
      const max = config.pipeline?.maxReworks ?? 3
      const sent = reworksSoFar(qa.attempts)
      const producer = producersOf(config).includes(flow.agent)
      if (producer && sent < max) {
        security.rework = { to: flow.agent, queuedAt: null, sentAt: null, error: null }
        flow.status = 'open'
        line = `${flow.id}: Security failed QA attempt ${qa.attempt}; it goes back to ${flow.agent} (the dashboard sends the report).`
      } else {
        security.status = 'security-failed'
        flow.status = 'blocked'
        const why = producer ? `stopped after ${max} reworks, QA and Security failures together` : `${flow.agent} is not a producer, so there is no one to send it back to`
        line = `${flow.id}: Security failed QA attempt ${qa.attempt}; ${why}. The flow is blocked and nothing is sent.`
      }
    }
    flow.qa = { ...qa, security }
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    copyEvidence(report)
    writeFlow(flow)
    return ok(line)
  }

  return { 'security-start': securityStart, security: securityResult }
}
