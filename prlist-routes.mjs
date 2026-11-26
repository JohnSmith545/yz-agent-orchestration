// The Pull requests list's one route (server.mjs mounts it with makePrListRoute):
//
//   GET /api/prs    { items, checkedAt, problem } (prlist-store.mjs snapshot): every flow's pull request that is
//                   open on GitHub, newest first, each { key, url, repo, number, label, title, flow: { id, title },
//                   agent, openedAt, draft, checks, needs, stale }. Answered at once from memory, cache-control
//                   no-store; the states behind it are read in the background at most once a minute.
//   anything else on that path   405, { error } in one plain sentence
//
// Read only: no write, so no Origin check is needed (like GET /api/alerts). The text is GitHub's and the agents',
// as given: the page escapes everything it draws (public/prlist-view.js).
//
//   makePrListRoute({ gh, git, remote, flows?, list? })   route(req, res, url) -> true when answered,
//                                                         route.start(), route.list (the store, for the tests)
//   `git` and `gh` are server.mjs's runners; `remote()` the Send remote (config pr.remote), whose address names the
//   repository gh is given with --repo (pr-check.mjs repoOf: one `git config --get`, read only).

import { listFlows } from './flows.mjs'
import { repoOf } from './pr-check.mjs'
import { makePrList } from './prlist-store.mjs'

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function makePrListRoute({ gh, git, remote = () => 'origin', flows = () => listFlows({ archived: 'any' }).flows, list = null }) {
  const store = list || makePrList({
    gh,
    flows,
    repo: async () => {
      const r = await git(['config', '--get', `remote.${remote() || 'origin'}.url`])
      return r?.ok ? repoOf(r.out) : null
    },
  })
  async function route(req, res, url) {
    if (url.pathname !== '/api/prs') return false
    if (req.method !== 'GET') {
      json(res, 405, { error: 'The pull request list is only read here.' })
      return true
    }
    json(res, 200, store.snapshot())
    return true
  }
  route.start = () => store.start()
  route.list = store
  return route
}
