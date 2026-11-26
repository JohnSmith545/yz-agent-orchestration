// The pipeline routes (factory-routes.mjs mounts them):
//
//   GET  /api/pipeline           { graph, tickets, builtAt }: the orchestration graph (pipeline.mjs pipelineGraph) and
//                                every flow on it: [{ id, title, agent, tickets, status, stage: { node, status, path,
//                                reworks }, route, progress, qa (flow-qa.mjs qaView: earlier attempts as an outline),
//                                codeProducing, hasOutput, archived, completed, waiting, updatedAt }], newest first. `route` and `progress`
//                                are flow-route.mjs withRoute: the planned way (stored, or inferred: true) and each
//                                step's state; every page reads those, none works its own out. Open and blocked flows always; done
//                                and dropped ones changed in the last 14 days; archived ones too, flagged; the Trash
//                                never (a trashed flow has no file in data/flows). `completed` is the user's sign-off
//                                (completed.mjs): the page never draws one. `waiting` is a finished flow that waits
//                                for it, listed however old, so the Output box holds every one the reminders count.
//   GET  /api/qa[?status=passed] { qa, flows, remotes, builtAt }: what QA recorded, for a QA page. `qa` is the QA
//                                label; each flow is { id, title, agent, tickets, status, archived, updatedAt, stage,
//                                route, progress, qa (qaView, each step with the `url` of its shot), report: { ref, url, text,
//                                truncated } | null, shots: [{ ref, url }], links: { repo, commit, branch } }, newest
//                                first, at most 100; `remotes` is { repo, dashboard }: the GitHub page of the watched
//                                repo's remote and of the dashboard's own, or null.
//   POST /api/flows/<id>/rework  send a QA failure back again after it was not delivered (qa-rework.mjs reworkRetry)
//
// The links name the repo that HOLDS the tested commit, never just the watched one: QA tests the dashboard's own
// changes too, and a dashboard commit linked under the watched repo's remote is a dead link. `qa.repo` (set by
// `flow qa-push --repo`) when there is one; else the watched repo (config.repo) when `git -C <repo> cat-file -e
// <sha>^{commit}` finds the commit there; else the dashboard's own folder; else no commit and no branch link.
// The answer is cached per sha (a commit never moves; a miss is asked again after a minute, it may be fetched).
// The address comes from `git remote get-url <remote>` (a read), turned into a GitHub web address (webUrlOf), never
// the raw address: a remote URL may carry a token, and nothing returned here may (pr-check.mjs repoOf drops any
// user:token@). Read at most once a minute per repo and remote. A report is read as text, at most 64 KB.
//
// Each handler returns { status, body }. `deps` is { git, config }: server.mjs's git runner (tests pass a stub)
// and the config (config.mjs CONFIG by default).

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { waitsForSignOff } from './completed.mjs'
import { CONFIG } from './config.mjs'
import { qaView } from './flow-qa.mjs'
import { withRoute } from './flow-route.mjs'
import { EVIDENCE_DIR, listFlows } from './flows.mjs'
import { isCodeProducing, pipelineGraph, stageOf } from './pipeline.mjs'
import { repoOf } from './pr-check.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
const RECENT_MS = 14 * 86_400_000
const REMOTE_MS = 60_000
const REPORT_MAX = 64 * 1024
const QA_LISTED = 100
const remotes = new Map() // `${repo}\0${remote}` -> { at, web }

const holders = new Map() // [sha, repos] as JSON -> { at, repo }: which repo holds a commit (null: none of them)

/** Tests start clean: no remote address and no commit's repo remembered. */
export function resetPipelineState() {
  remotes.clear()
  holders.clear()
}

/** A remote address as its GitHub web page (`https://github.com/owner/name`), or null for anything else. */
export function webUrlOf(address) {
  const repo = repoOf(address)
  return repo && repo.split('/').length === 2 ? `https://github.com/${repo}` : null
}

/** The web page of `remote` in `repo`, from `git -C <repo> remote get-url`, cached a minute; null when it is not GitHub. */
async function webOf(git, repo, remote) {
  const key = `${repo}\0${remote}`
  const hit = remotes.get(key)
  if (hit && Date.now() - hit.at < REMOTE_MS) return hit.web
  let web = null
  try {
    const r = await git(['-C', repo, 'remote', 'get-url', remote])
    web = r.ok ? webUrlOf(r.out.trim()) : null
  } catch {
    web = null
  }
  remotes.set(key, { at: Date.now(), web })
  return web
}

/**
 * The first of `repos` that has commit `sha` (`git -C <repo> cat-file -e <sha>^{commit}`, a read), or null. A hit is
 * kept for good, since a commit never moves; a miss for a minute only, since the commit may be fetched later.
 */
async function repoHolding(git, sha, repos) {
  const key = JSON.stringify([String(sha).toLowerCase(), repos])
  const hit = holders.get(key)
  if (hit && (hit.repo || Date.now() - hit.at < REMOTE_MS)) return hit.repo
  let repo = null
  for (const r of repos) {
    try {
      if ((await git(['-C', r, 'cat-file', '-e', `${sha}^{commit}`])).ok) {
        repo = r
        break
      }
    } catch {
      // a repo git cannot read does not hold it
    }
  }
  holders.set(key, { at: Date.now(), repo })
  return repo
}

/**
 * Where QA's commit lives, as { repo, remote }, or null when no repo has it: qa.repo when QA pushed with --repo;
 * else the watched repo, else the dashboard's own folder, whichever holds the commit; with no commit recorded, the
 * watched repo. The dashboard folder's remote is always origin.
 */
async function commitHome(git, view, config, remote) {
  if (view.repo) return { repo: view.repo, remote: view.remote || remote }
  if (!view.commit) return { repo: config.repo, remote: view.remote || remote }
  const repo = await repoHolding(git, view.commit, [config.repo, HERE])
  if (!repo) return null
  return { repo, remote: repo === config.repo ? view.remote || remote : 'origin' }
}

const evidenceUrl = ref => `/evidence/${String(ref).split('/').map(encodeURIComponent).join('/')}`
const isTime = v => !Number.isNaN(Date.parse(v || ''))

function hasOutput(flow) {
  const o = flow.derived?.output || {}
  return !!(o.hasResult || o.hasSummary || o.tests || o.hasDiagram)
}

// ═══ GET /api/pipeline ═══

export function pipelineGet({ config = CONFIG, now = Date.now() } = {}) {
  const graph = pipelineGraph(config)
  const tickets = listFlows({ archived: 'any' }).flows
    .filter(f => f.status === 'open' || f.status === 'blocked' || (isTime(f.updatedAt) && now - Date.parse(f.updatedAt) <= RECENT_MS) || waitsForSignOff(f, graph))
    .map(f => ({
      id: f.id, title: f.title, agent: f.agent, tickets: f.tickets || [], status: f.status, stage: stageOf(f, graph), ...withRoute(f, graph),
      qa: qaView(f.qa), codeProducing: isCodeProducing(f), hasOutput: hasOutput(f), archived: !!f.archivedAt, updatedAt: f.updatedAt ?? null,
      completed: !!f.completedAt, waiting: waitsForSignOff(f, graph),
      risk: f.risk ?? null, // the risk label (quality-risk.mjs), for the chip's tooltip
    }))
  return { status: 200, body: { graph, tickets, builtAt: new Date(now).toISOString() } }
}

// ═══ GET /api/qa ═══

async function reportOf(ref) {
  if (!ref) return null
  let text = null
  let truncated = false
  try {
    const data = await readFile(path.join(EVIDENCE_DIR, ...String(ref).split('/')))
    truncated = data.length > REPORT_MAX
    text = data.subarray(0, REPORT_MAX).toString('utf8')
  } catch {
    text = null // a report not copied yet, or removed: the rest still shows
  }
  return { ref, url: evidenceUrl(ref), text, truncated }
}

export async function qaGet(status, { git, config = CONFIG } = {}) {
  const graph = pipelineGraph(config)
  const remote = config.pr?.remote || 'origin'
  const listed = listFlows({ archived: 'any' }).flows
    .filter(f => f.qa && (!status || f.qa.status === status))
    .slice(0, QA_LISTED)
  const flows = []
  for (const f of listed) {
    const view = qaView(f.qa)
    view.steps = (view.steps || []).map(s => (s.shot ? { ...s, url: evidenceUrl(s.shot) } : s))
    const home = await commitHome(git, view, config, remote)
    const web = home ? await webOf(git, home.repo, home.remote) : null
    flows.push({
      id: f.id, title: f.title, agent: f.agent, tickets: f.tickets || [], status: f.status, archived: !!f.archivedAt,
      updatedAt: f.updatedAt ?? null, stage: stageOf(f, graph), ...withRoute(f, graph), qa: view,
      report: await reportOf(view.report), shots: (view.shots || []).map(ref => ({ ref, url: evidenceUrl(ref) })),
      links: {
        repo: web,
        commit: web && view.commit ? `${web}/commit/${view.commit}` : null,
        branch: web && view.branch ? `${web}/tree/${view.branch.split('/').map(encodeURIComponent).join('/')}` : null,
      },
    })
  }
  const [repo, dashboard] = [await webOf(git, config.repo, remote), await webOf(git, HERE, 'origin')]
  return { status: 200, body: { qa: config.pipeline?.qa, flows, remotes: { repo, dashboard }, builtAt: new Date().toISOString() } }
}
