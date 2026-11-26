// The phone page's own files, made cacheable (phone-server.mjs serves them). WHY: the page loads eight scripts, a
// stylesheet, a font, a manifest and icons, about fifteen requests a load, against the listener's per-address limit
// of 120 a minute (phone-limits.mjs). A few reloads used it up, and a 429 on one script left a blank page.
//
// ═══ HOW ═══
//   - Every file's VERSION is the first 16 hex of the sha256 of what is sent. The page (phone.html), the stylesheet
//     and the manifest are TEXT: each "/phone/<file>" they name that is in the fixed map (phone-server.mjs ASSETS) is
//     sent as "/phone/<file>?v=<version>", so the page names the exact bytes it wants and the stylesheet names its
//     font, the manifest its icons. A text file's own version is taken AFTER that rewrite, so a changed script
//     changes the page's version too.
//   - A request whose ?v= is the file's version now: `private, max-age=31536000, immutable` (the browser does not
//     ask again for a year: those bytes can never change under that address).
//   - Anything else (the page itself, a file without ?v=, an old version): `no-cache` with the ETag, so the browser
//     keeps it but asks first, and the answer is a 304 with no body when nothing changed.
//   - phone-server.mjs answers a matching If-None-Match BEFORE the per-address limit, counted only against its own
//     far higher ceiling (PHONE_LIMITS.revalidate): a reload costs the phone's limit nothing. The API is untouched:
//     no-store, no ETag, counted as before.
//
// ⚠️ Nothing here builds a path from the request: `get(pathname)` looks the path up in the fixed map and returns null
// for anything else. The files are read again when their size or time changes (stat per request), so an update of
// the dashboard is picked up without a restart. `*` in If-None-Match is NOT honoured: it would make every request a
// free 304 whatever was cached.
//
//   makePhoneAssets({ assets, publicDir })   { get(pathname) -> Promise<{ body, type, version, etag } | null> }
//   etagMatches(ifNoneMatch, etag)           true when the header lists this ETag (weak or strong)
//   cachePolicy(query, version)              the cache-control value for one answer

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export const IMMUTABLE = 'private, max-age=31536000, immutable'
export const REVALIDATE = 'no-cache'
const TEXT = /^(text\/|application\/manifest\+json)/
/** A quoted (or url()-wrapped) "/phone/<name>.<ext>" with nothing after it: the only references rewritten. */
const REF = /(["'(])(\/phone\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)(?=["')])/g
const DEPTH_MAX = 4

const versionOf = body => createHash('sha256').update(body).digest('hex').slice(0, 16)

export function etagMatches(header, etag) {
  if (typeof header !== 'string' || !etag) return false
  return header.split(',').map(s => s.trim().replace(/^W\//, '')).includes(etag)
}

export function cachePolicy(query, version) {
  return new URLSearchParams(String(query || '')).get('v') === version ? IMMUTABLE : REVALIDATE
}

export function makePhoneAssets({ assets, publicDir }) {
  const cache = new Map() // pathname -> { stamp, raw, key, body, version }

  async function get(pathname, depth = 0) {
    const entry = Object.hasOwn(assets, pathname) ? assets[pathname] : null
    if (!entry || depth > DEPTH_MAX) return null
    const [file, type] = entry
    const full = path.join(publicDir, file)
    const st = await stat(full)
    const stamp = `${st.mtimeMs}:${st.size}`
    let c = cache.get(pathname)
    if (!c || c.stamp !== stamp) {
      c = { stamp, raw: await readFile(full), key: null, body: null, version: null }
      cache.set(pathname, c)
    }
    if (TEXT.test(type)) {
      const text = c.raw.toString('utf8')
      const refs = [...new Set([...text.matchAll(REF)].map(m => m[2]))].filter(p => p !== pathname && Object.hasOwn(assets, p))
      const versions = {}
      for (const p of refs) versions[p] = (await get(p, depth + 1))?.version || null
      const key = refs.map(p => `${p}=${versions[p]}`).join('&')
      if (c.body === null || c.key !== key) {
        c.body = Buffer.from(text.replace(REF, (m, q, p) => (versions[p] ? `${q}${p}?v=${versions[p]}` : m)), 'utf8')
        c.key = key
        c.version = versionOf(c.body)
      }
    } else if (c.body === null) {
      c.body = c.raw
      c.version = versionOf(c.raw)
    }
    return { body: c.body, type, version: c.version, etag: `"${c.version}"` }
  }

  return { get: pathname => get(pathname) }
}
