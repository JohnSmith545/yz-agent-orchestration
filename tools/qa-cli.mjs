// The QA commands, behind `node tools/factory.mjs flow …` (tools/flow-cli.mjs registers them):
//
//   qa-start <flow> --by QA [--commit <sha>] [--status testing|pending]
//       QA picks the flow up: attempt n+1 (the last result moves into qa.attempts), or the same attempt
//       again while no result is in yet. A done or blocked flow opens again; a dropped one is refused.
//   qa <flow> --status passed|failed --report <file.md|file.txt> --commit <sha> [--summary "..."] --by QA
//          [--shot <file>]... [--step "<do>" --expect "<see>" [--step-shot <file>]]...
//       The result. The report and every screenshot are copied into the flow's evidence folder, like
//       `flow result --shot` (the report as <flow>/qa-<n>-report.md). PASSED marks the flow done. FAILED sends
//       it back to the flow's agent (qa.rework.to, the server delivers it: qa-rework.mjs), unless that agent
//       is not a producer or it already went back pipeline.maxReworks times: then qa-failed, the flow
//       blocked, and nothing is sent (stop).
//   qa-push <flow> [--branch <b>] [--remote origin] [--repo <path>] --by QA
//       Only after a pass: checks the tested commit is in the repo, then `git -C <repo> push <remote>
//       <sha>:refs/heads/<branch>` with that FULL sha. Never forced (no --force, no +), no tags, never a
//       protected branch (pipeline.protectedBranches, pr.protect, pr.bases, HEAD; any case), and never
//       retried: a refusal is recorded as qa.pushError. The branch defaults to the flow's recorded pull
//       request head (`flow pr`), and must be that head when there is one.
//       With Security on the pipeline (config pipeline.security) it also waits for Security: it refuses, with one
//       plain sentence, until Security passed the SAME commit QA passed (flow-security.mjs securityBlockers).
//       Then a QA pass does not mark the flow done either: Security's pass does (tools/security-cli.mjs), and
//       QA and Security failures share the one pipeline.maxReworks limit.
//
// ⚠️ ONLY QA: every command refuses unless --by (or FACTORY_BY) is exactly config pipeline.qa. That stops a
// producer marking its own work passed by mistake; a process with a shell could still edit the file, as it
// could run git push itself (README, Security). These are the only writers of `flow.qa` (flow-qa.mjs).
//
// Like the other flow commands they return { out, code } and never print; qa-push returns a Promise of it.
// The context may carry `git` (a runner `(args, { env, timeout }) => Promise<{ ok, out, err }>`, so tests stub
// it and never touch a repository or a remote) and `config` (default config.mjs CONFIG).

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

import { CONFIG } from '../config.mjs'
import { isBranch } from '../flow-merge.mjs'
import { QA_FINISHED, QA_MAX, REPORT_EXT } from '../flow-qa.mjs'
import { reworksSoFar, securityBlockers } from '../flow-security.mjs'
import { EVIDENCE_DIR, readFlow, validateFlow, writeFlow } from '../flows.mjs'
import { gateLabels, producersOf } from '../pipeline.mjs'
import { scrub } from '../pr-check.mjs'
import { pushEnv } from '../pr-routes.mjs'

const fail = out => ({ out, code: 1 })
const ok = out => ({ out, code: 0 })
const now = () => new Date().toISOString()
const isText = v => typeof v === 'string' && v.trim() !== ''
const SHA = /^[0-9a-f]{7,40}$/i
const REMOTE = /^[A-Za-z0-9._-]{1,100}$/
const PUSH_TIMEOUT_MS = 180_000

/** git with no prompt and no optional locks, as an argv array (never a shell): { ok, out, err }. */
export function realGit(args, { env = {}, timeout = 60_000 } = {}) {
  return new Promise(resolve => {
    execFile('git', args, { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...env }, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout ?? '').trim(), err: String(stderr || err?.message || '').trim() }))
  })
}

function load(id) {
  const flow = readFlow(id)
  if (!flow) throw new Error(`No flow ${id}`)
  return flow
}

/** `*` matches anything; everything else literal; compared lower-case. */
const glob = pattern => new RegExp(`^${String(pattern).toLowerCase().split('*').map(x => x.replace(/[.+?^${}()|[\]\\/-]/g, '\\$&')).join('.*')}$`)

/** Why QA may never push to `branch`, or null: the pipeline's protected branches, Send's never-send-from list and bases, HEAD. */
function protectedWhy(branch, config) {
  const list = [...(config.pipeline?.protectedBranches || []), ...(config.pr?.protect || []), ...(config.pr?.bases || []), 'HEAD']
  const lower = branch.toLowerCase()
  return list.some(p => glob(p).test(lower)) ? `${branch} is a protected or base branch: QA pushes only the flow's own feature branch.` : null
}

/** The QA line of `flow show`'s Output block (stderr), or nothing when QA has not started. */
export function qaBlock(flow) {
  const q = flow.qa
  if (!q || typeof q !== 'object') return []
  const parts = [`${q.status}, attempt ${q.attempt}${q.commit ? ` at ${String(q.commit).slice(0, 7)}` : ''}`]
  const r = q.rework
  if (r?.to) parts.push(`back to ${r.to} (${r.sentAt ? 'sent' : r.error ? `not delivered: ${r.error}` : 'not sent yet'})`)
  if (q.pushedAt) parts.push(`pushed to ${q.remote} ${q.branch}`)
  else if (q.pushError) parts.push(`push failed: ${q.pushError}`)
  return [`  qa: ${parts.join(', ')}`]
}

/**
 * The repeated step groups of `flow qa`, in order: each --step starts one, the --expect and --step-shot after it
 * belong to it. Read from the raw argv (the flag parser keeps only the last of each). Throws a one-line reason.
 */
function stepsOf(argv) {
  const steps = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a !== '--step' && a !== '--expect' && a !== '--step-shot') continue
    const v = argv[++i] ?? ''
    if (a === '--step') steps.push({ do: v })
    else if (!steps.length) throw new Error(`${a} needs a --step before it`)
    else steps.at(-1)[a === '--expect' ? 'expect' : 'shot'] = v
  }
  steps.forEach((s, i) => { if (!isText(s.expect)) throw new Error(`step ${i + 1} needs --expect "<what QA saw>"`) })
  if (steps.length > QA_MAX.steps) throw new Error(`at most ${QA_MAX.steps} steps`)
  return steps
}

/** An earlier attempt as kept in qa.attempts: everything but its own attempts list. */
const asAttempt = ({ attempts, ...rest }) => rest

/**
 * The commands, given the CLI's helpers (tools/flow-cli.mjs passes them, so this file never imports it back):
 * the refusal for a missing name, its evidence copier (the same rules as `flow result --shot`) and the shot types.
 */
export function qaCommands({ noName, evidenceTarget, copyEvidence, shotExt, shotError }) {
  /** One line when `by` is not QA; null when it is. */
  const notQa = (by, config) => {
    if (!by) return noName
    const qa = config.pipeline?.qa
    return by === qa ? null : `Only QA records QA: --by must be "${qa}" (config pipeline.qa), not "${by}".`
  }

  /** Where the report goes: <flow>/qa-<n>-report.<md|txt> (numbered when taken), or null when the file is not a report. */
  function reportTarget(flowId, n, given, cwd) {
    const src = path.resolve(cwd, String(given))
    const ext = path.extname(src).slice(1).toLowerCase()
    if (!REPORT_EXT.includes(ext) || !existsSync(src) || !statSync(src).isFile()) return null
    let name = `qa-${n}-report.${ext}`
    for (let k = 2; existsSync(path.resolve(EVIDENCE_DIR, flowId, name)); k++) name = `qa-${n}-report-${k}.${ext}`
    const dest = path.resolve(EVIDENCE_DIR, flowId, name)
    const rel = path.relative(EVIDENCE_DIR, dest)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || path.dirname(rel) !== flowId) return null
    return { src, dest, ref: `${flowId}/${name}` }
  }

  /** The attempt this command works on: the current one while no result is in, else a new one (the old moves into attempts). */
  function attemptFor(flow) {
    const cur = flow.qa && typeof flow.qa === 'object' ? flow.qa : null
    if (cur && !QA_FINISHED.includes(cur.status)) return { n: cur.attempt, startedAt: cur.startedAt ?? null, attempts: cur.attempts || [], base: cur }
    return { n: (cur?.attempt || 0) + 1, startedAt: null, attempts: cur ? [...(cur.attempts || []), asAttempt(cur)] : [], base: null }
  }

  function qaStart(f, { by, config = CONFIG }) {
    const refused = notQa(by, config)
    if (refused) return fail(refused)
    const flow = load(f._[0])
    if (flow.status === 'dropped') return fail(`${flow.id} is dropped: there is nothing to test.`)
    const status = f.status ?? 'testing'
    if (!['testing', 'pending'].includes(status)) return fail('qa-start takes --status testing or pending')
    if (f.commit !== undefined && !SHA.test(String(f.commit))) return fail(`--commit ${f.commit} is not a commit sha (7 to 40 hex characters)`)
    const { n, startedAt, attempts, base } = attemptFor(flow)
    const at = now()
    flow.qa = { ...(base || {}), status, attempt: n, by, startedAt: startedAt || at, at, ...(f.commit !== undefined ? { commit: String(f.commit) } : {}), attempts }
    if (!flow.qa.attempts.length) delete flow.qa.attempts
    if (flow.status === 'done' || flow.status === 'blocked') flow.status = 'open'
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    writeFlow(flow)
    return ok(`${flow.id}: QA attempt ${n} ${status}`)
  }

  function qaResult(f, { by, cwd, argv = [], config = CONFIG }) {
    const refused = notQa(by, config)
    if (refused) return fail(refused)
    const flow = load(f._[0])
    if (!['passed', 'failed'].includes(f.status)) return fail('qa needs --status passed|failed')
    if (f.report === undefined) return fail('qa needs --report <file.md>: a short report of what QA ran and saw')
    if (f.commit === undefined) return fail('qa needs --commit <sha>: the commit QA tested')
    if (!SHA.test(String(f.commit))) return fail(`--commit ${f.commit} is not a commit sha (7 to 40 hex characters)`)
    if (f.summary !== undefined && String(f.summary).length > QA_MAX.summary) return fail(`--summary must be at most ${QA_MAX.summary} characters`)
    let steps
    try {
      steps = stepsOf(argv)
    } catch (err) {
      return fail(err.message)
    }
    const { n, startedAt, attempts } = attemptFor(flow)
    const report = reportTarget(flow.id, n, f.report, cwd)
    if (!report) return fail('a QA report must be an existing .md or .txt file (never HTML)')
    const copies = [report]
    const shot = (given, prefix) => {
      const c = evidenceTarget(flow.id, prefix, given, cwd, shotExt)
      if (!c) throw new Error(shotError)
      if (copies.some(x => x.dest === c.dest)) throw new Error(`two screenshots would both be ${c.ref}: give them different names`)
      copies.push(c)
      return c.ref
    }
    let shots
    try {
      shots = [].concat(f.shot ?? []).map(s => shot(s, `qa-${n}`))
      steps = steps.map((s, i) => ({ do: s.do, expect: s.expect, ...(s.shot !== undefined ? { shot: shot(s.shot, `qa-${n}-step${i + 1}`) } : {}) }))
    } catch (err) {
      return fail(err.message)
    }

    const at = now()
    const qa = { status: f.status, attempt: n, by, startedAt: startedAt || at, at, commit: String(f.commit), report: report.ref, shots, steps, summary: String(f.summary ?? ''), rework: null }
    let line
    const security = gateLabels(config).security
    if (f.status === 'passed' && security) {
      // Security reviews the same commit next; its pass marks the flow done
      line = `${flow.id}: QA passed attempt ${n} at ${qa.commit.slice(0, 7)}. Send ${security} a message naming flow ${flow.id}: it reviews this commit next, and you push it with flow qa-push once Security passed it.`
    } else if (f.status === 'passed') {
      flow.status = 'done'
      line = `${flow.id}: QA passed attempt ${n} at ${qa.commit.slice(0, 7)}; the flow is done. Push it with flow qa-push ${flow.id} --branch <branch>, then the user sends it.`
    } else {
      const max = config.pipeline?.maxReworks ?? 3
      const sentBack = reworksSoFar(attempts) // QA and Security failures share the one limit
      const producer = producersOf(config).includes(flow.agent)
      if (producer && sentBack < max) {
        qa.rework = { to: flow.agent, queuedAt: null, sentAt: null, error: null }
        line = `${flow.id}: QA failed attempt ${n}; it goes back to ${flow.agent} (the dashboard sends the report).`
      } else {
        qa.status = 'qa-failed'
        flow.status = 'blocked'
        const why = producer ? `stopped after ${max} reworks` : `${flow.agent} is not a producer, so there is no one to send it back to`
        line = `${flow.id}: QA failed attempt ${n}; ${why}. The flow is blocked and nothing is sent.`
      }
    }
    if (attempts.length) qa.attempts = attempts
    flow.qa = qa
    const problems = validateFlow(flow)
    if (problems.length) return fail(problems.join('\n'))
    for (const c of copies) copyEvidence(c)
    writeFlow(flow)
    return ok(line)
  }

  /** Record the push outcome on the flow as it is NOW (re-read, so a write in between is kept). */
  function recordPush(id, fields) {
    const flow = readFlow(id)
    if (!flow?.qa) return
    flow.qa = { ...flow.qa, ...fields }
    writeFlow(flow)
  }

  async function qaPush(f, { by, cwd, git = realGit, config = CONFIG }) {
    try {
      const refused = notQa(by, config)
      if (refused) return fail(refused)
      const flow = load(f._[0])
      const qa = flow.qa
      if (qa?.status !== 'passed') return fail(`${flow.id}: QA has not passed this flow, so nothing is pushed.`)
      if (!qa.commit) return fail(`${flow.id}: QA recorded no commit, so nothing is pushed.`)
      if (qa.pushedAt) return fail(`${flow.id}: already pushed to ${qa.remote} ${qa.branch} at ${qa.pushedAt}.`)
      const held = securityBlockers(flow, config)
      if (held.length) return fail(`${flow.id}: nothing is pushed yet. ${held.join(' ')}`)
      const head = flow.output?.merge?.head
      const branch = f.branch ?? head
      if (branch === undefined) return fail('qa-push needs --branch <the flow branch> (or a pull request recorded with flow pr)')
      if (!isBranch(String(branch))) return fail('--branch must be a branch name: letters, digits, dots, dashes, underscores and slashes, no .., not starting with a dash')
      const guarded = protectedWhy(String(branch), config)
      if (guarded) return fail(guarded)
      if (head && branch !== head) return fail(`${flow.id} records its pull request from ${head}: push that branch, or record the pull request again with flow pr.`)
      const remote = String(f.remote ?? config.pr?.remote ?? 'origin')
      if (!REMOTE.test(remote) || remote.startsWith('-') || /^\.+$/.test(remote)) return fail('--remote must be a remote name such as origin')
      const repo = f.repo !== undefined ? path.resolve(cwd, String(f.repo)) : config.repo
      const at = { branch: String(branch), remote, repo }

      // the commit QA tested, in full, from THAT repo: nothing else is ever pushed
      const tested = String(qa.commit)
      const found = await git(['-C', repo, 'rev-parse', '--verify', '--quiet', `${tested}^{commit}`])
      const sha = found.ok ? found.out.trim() : ''
      if (!/^[0-9a-f]{40,64}$/i.test(sha) || !sha.toLowerCase().startsWith(tested.toLowerCase())) {
        const error = `${repo} has no commit ${tested.slice(0, 7)}: QA tested a commit that is not in this repo.`
        recordPush(flow.id, { ...at, pushError: error.slice(0, QA_MAX.error) })
        return fail(error)
      }
      // the full refspec: no +, no --force, no tags; ssh never waits on a prompt; one try, never retried
      const own = await git(['-C', repo, 'config', '--get', 'core.sshCommand'])
      const pushed = await git(['-C', repo, 'push', remote, `${sha}:refs/heads/${branch}`], { env: pushEnv(own.ok ? own.out : ''), timeout: PUSH_TIMEOUT_MS })
      if (!pushed.ok) {
        const error = `The push was refused (it is never forced): ${scrub(pushed.err || pushed.out) || 'no reason given'}`.slice(0, QA_MAX.error)
        recordPush(flow.id, { ...at, pushError: error })
        return fail(`${flow.id}: ${error}`)
      }
      recordPush(flow.id, { ...at, pushedAt: now(), pushError: null })
      return ok(`${flow.id}: pushed ${sha.slice(0, 7)} to ${remote} ${branch}. The user opens the pull request with Send.`)
    } catch (err) {
      return fail(err?.message || String(err))
    }
  }

  return { 'qa-start': qaStart, qa: qaResult, 'qa-push': qaPush }
}
