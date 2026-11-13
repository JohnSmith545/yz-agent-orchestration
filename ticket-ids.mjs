// Ticket ids in text (commit subjects, tool calls) and in branch names. Pure: no
// config and no I/O; the caller passes the prefixes it knows (transcripts.mjs
// binds them from config.ticketPrefixes or the ticket sources).
//
// Two modes:
//   known prefixes   only those count, in any case: abc-120 in a path or a
//                    command is ABC-120, and in a branch name anywhere after
//                    / _ or - (feat/step-2-abc-12 -> ABC-12).
//   none known       a generic shape: ABC-123 in text (upper case, letters only,
//                    no leading zero), abc-123 in a branch name only at the start
//                    of a path segment. Standards, runtimes and step words that
//                    look like ids are left out (NOT_TICKETS), and so are dates
//                    and versions. It still guesses, so set ticketPrefixes.
// In both modes a run of numbers in a branch is a run of tickets:
// fix/xyz-10-11-12-login -> XYZ-10, XYZ-11, XYZ-12.

/** Upper-case words with a number that name standards, runtimes or steps, never tickets (generic mode). */
const NOT_TICKETS = new Set([
  'ADR', 'AES', 'CVE', 'ES', 'GPT', 'HTTP', 'HTTPS', 'IPV', 'ISO', 'MD', 'PEP', 'RFC', 'RSA', 'SHA', 'SSL', 'TLS', 'UTF', 'WCAG',
  'JAVA', 'NODE', 'PHP', 'PYTHON', 'RUBY',
  'ITEM', 'PAGE', 'PART', 'PHASE', 'RELEASE', 'ROUND', 'STEP', 'TRY', 'VERSION', 'WIP',
])

const PREFIX = /^[A-Z][A-Z0-9]*$/
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const clean = prefixes => (Array.isArray(prefixes) ? prefixes.map(p => String(p).toUpperCase()).filter(p => PREFIX.test(p)) : [])
const alternation = prefixes => clean(prefixes).map(escapeRe).join('|')

// Compiled once per prefix list: the transcript reader calls these for every line.
const compiled = new Map()
function regexesFor(known) {
  let r = compiled.get(known)
  if (!r) {
    r = {
      text: new RegExp(`\\b(${known})-(\\d+)\\b`, 'gi'),
      branch: new RegExp(`(?:^|[/_-])(${known})-((?:\\d+-)*\\d+)(?=$|[-_/])`, 'gi'),
      hint: new RegExp(`(?:${known})-\\d`, 'i'),
    }
    compiled.set(known, r)
  }
  return r
}

/** Every ticket id named in `text`, each once, in order of first mention. */
export function idsInText(text, prefixes = []) {
  const known = alternation(prefixes)
  const re = known ? regexesFor(known).text : /\b([A-Z]{2,})-([1-9]\d*)\b/g
  const ids = new Set()
  for (const m of String(text ?? '').matchAll(re)) {
    const p = m[1].toUpperCase()
    if (known || !NOT_TICKETS.has(p)) ids.add(`${p}-${m[2]}`)
  }
  return [...ids]
}

/** A year (19xx, 20xx) as the first number reads as a date or a release, not a ticket. */
const looksLikeDate = nums => /^(19|20)\d\d$/.test(nums[0])

/** The ticket ids a branch name carries: abc-120-122-x -> ABC-120, ABC-122. */
export function idsInBranch(branch, prefixes = []) {
  const name = String(branch || '')
  const known = alternation(prefixes)
  const out = []
  if (known) {
    for (const m of name.matchAll(regexesFor(known).branch))
      for (const n of m[2].split('-')) out.push(`${m[1].toUpperCase()}-${n}`)
    return [...new Set(out)]
  }
  for (const m of name.matchAll(/(?:^|\/)([a-z]{2,})-((?:[1-9]\d*-)*[1-9]\d*)(?=$|[-_/])/gi)) {
    const p = m[1].toUpperCase()
    const nums = m[2].split('-')
    if (NOT_TICKETS.has(p) || looksLikeDate(nums)) continue
    for (const n of nums) out.push(`${p}-${n}`)
  }
  return [...new Set(out)]
}

/** A cheap test before parsing a transcript line: could it name a ticket at all? */
export function mayHoldTicketId(line, prefixes = []) {
  const known = alternation(prefixes)
  return (known ? regexesFor(known).hint : /[A-Z]{2,}-[1-9]/).test(line)
}

/**
 * The prefixes to match: `configured` (config.ticketPrefixes) when it is a list,
 * even an empty one (the generic shape); otherwise the collections' filter
 * prefixes, then the prefixes of the ids in the ticket sources, each once.
 */
export function knownPrefixes({ configured, collections = [], sourceIds = [] } = {}) {
  if (Array.isArray(configured)) return [...new Set(clean(configured))]
  const fromFilters = clean(collections.map(c => c?.filter?.prefix).filter(Boolean))
  const fromSources = clean(sourceIds.map(id => (/^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(String(id)) || [])[1]).filter(Boolean)).sort()
  return [...new Set([...fromFilters, ...fromSources])]
}

/** Ticket order: prefixes in the order given (others after, alphabetical), newest number first. */
export function compareTickets(a, b, prefixes = []) {
  const [pa, na] = a.id.split('-')
  const [pb, nb] = b.id.split('-')
  if (pa !== pb) {
    const rank = p => {
      const i = prefixes.indexOf(p)
      return i < 0 ? prefixes.length : i
    }
    return rank(pa) - rank(pb) || pa.localeCompare(pb)
  }
  return Number(nb) - Number(na)
}
