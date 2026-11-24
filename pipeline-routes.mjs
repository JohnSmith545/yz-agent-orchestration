// The pipeline routes (factory-routes.mjs mounts them):
//
//   GET  /api/pipeline           { graph, tickets, builtAt }: the orchestration graph (pipeline.mjs pipelineGraph) and
//                                every flow on it: [{ id, title, agent, tickets, status, stage: { node, status, path,
//                                reworks }, qa (flow-qa.mjs qaView: earlier attempts as an outline), codeProducing,
//                                hasOutput, archived, updatedAt }], newest first. Open and blocked flows always; done
//                                and dropped ones changed in the last 14 days; archived ones too, flagged; the Trash
//                                never (a trashed flow has no file in data/flows).
//   GET  /api/qa[?status=passed] { qa, flows, remotes, builtAt }: what QA recorded, for a QA page. `qa` is the QA
//                                label; each flow is { id, title, agent, tickets, status, archived, updatedAt, stage,
//                                qa (qaView, each step with the `url` of its shot), report: { ref, url, text,
//                                truncated } | null, shots: [{ ref, url }], links: { repo, commit, branch } }, newest
//                                first, at most 100; `remotes` is { repo, dashboard }: the GitHub page of the watched
//                                repo's remote and of the dashboard's own, or null.
//   POST /api/flows/<id>/rework  send a QA failure back again after it was not delivered (qa-rework.mjs reworkRetry)
//
// The links come from `git remote get-url <remote>` (a read), turned into a GitHub web address (webUrlOf), never
// the raw address: a remote URL may carry a token, and nothing returned here may (pr-check.mjs repoOf drops any
// user:token@). Read at most once a minute per repo and remote. A report is read as text, at most 64 KB.
//
// Each handler returns { status, body }. `deps` is { git, config }: server.mjs's git runner (tests pass a stub)
// and the config (config.mjs CONFIG by default).

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG } from './config.mjs'
import { qaView } from './flow-qa.mjs'
import { EVIDENCE_DIR, listFlows } from './flows.mjs'
import { isCodeProducing, pipelineGraph, stageOf } from './pipeline.mjs'
import { repoOf } from './pr-check.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
const RECENT_MS = 14 * 86_400_000
const REMOTE_MS = 60_000
const REPORT_MAX = 64 * 1024
const QA_LISTED = 100
const remotes = new Map() // `${repo}\0${remote}` -> { at, web }

/** Tests start clean: no remote address remembered. */
export function resetPipelineState() {
  remotes.clear()
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
    .filter(f => f.status === 'open' || f.status === 'blocked' || (isTime(f.updatedAt) && now - Date.parse(f.updatedAt) <= RECENT_MS))
    .map(f => ({
      id: f.id, title: f.title, agent: f.agent, tickets: f.tickets || [], status: f.status, stage: stageOf(f, graph),
      qa: qaView(f.qa), codeProducing: isCodeProducing(f), hasOutput: hasOutput(f), archived: !!f.archivedAt, updatedAt: f.updatedAt ?? null,
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
    const web = await webOf(git, view.repo || config.repo, view.remote || remote)
    flows.push({
      id: f.id, title: f.title, agent: f.agent, tickets: f.tickets || [], status: f.status, archived: !!f.archivedAt,
      updatedAt: f.updatedAt ?? null, stage: stageOf(f, graph), qa: view,
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
