// The quality features wired for the server (server.mjs mounts and starts them, three lines): the library's file made
// sure of, the two model runners (quality-extract.mjs, quality-critic.mjs: one run at a time each, on the clean
// headless run of script.mjs), the routes (quality-routes.mjs) and the watch (quality-watch.mjs). Kept out of
// server.mjs, which is long and shared.
//
//   const qualityRoute = makeQualityServer({ port: PORT, git })
//   if (await qualityRoute(req, res, url)) return     in the request handler
//   qualityRoute.start()                              once the server listens

import { CONFIG } from './config.mjs'
import { qualityOf } from './quality-config.mjs'
import { makeCritic } from './quality-critic.mjs'
import { makeExtractor } from './quality-extract.mjs'
import { ensureLessons } from './quality-lessons.mjs'
import { makeQualityRoute } from './quality-routes.mjs'
import { makeQualityWatch } from './quality-watch.mjs'

/** The route handler, with start() for the watch. `git(args)` is server.mjs's runner in the watched repo. */
export function makeQualityServer({ port, git }) {
  try {
    ensureLessons()
  } catch (err) {
    console.error(`quality: the lessons library could not be created: ${err?.message || err}`)
  }
  const extractor = makeExtractor({ areas: () => qualityOf(CONFIG).areas })
  const critic = makeCritic()
  const route = makeQualityRoute({ port, extractor, critic })
  const watch = makeQualityWatch({ extractor, critic, git })
  return Object.assign(route, { start: () => watch.start() })
}
