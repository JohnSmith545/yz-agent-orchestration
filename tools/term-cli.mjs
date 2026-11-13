// `node tools/factory.mjs term "<word>" "<plain explanation>" [--more "..."] [--flow <id>]`:
// an agent defines a word it marked in square brackets, for free, so the
// dashboard explains it in the agent's own words instead of asking a model.
//
// Saved in data/glossary.json with source `agent` (glossary.mjs). The
// explanation is 1 or 2 plain sentences, at most 300 characters; --more at
// most 600. It never overwrites the user's own wording (source `you`).
// Returns { out, code } and never prints: tools/factory.mjs prints.

import { sayShorter } from '../flow-story.mjs'
import { MORE_MAX, saveTerm, SHORT_MAX } from '../glossary.mjs'
import { flags } from './flow-cli.mjs'

export const TERM_USAGE = 'usage: term "<word>" "<plain explanation, 1 or 2 sentences, at most 300 characters>" [--more "<at most 600 characters>"] [--flow <id>]'

/** Run `term` with its arguments (after the word `term`). */
export function runTerm(argv) {
  const f = flags(argv)
  const [term, short] = f._
  if (typeof term !== 'string' || typeof short !== 'string' || !short.trim()) return { out: TERM_USAGE, code: 1 }
  if (short.trim().length > SHORT_MAX) return { out: sayShorter(SHORT_MAX, short.trim().length), code: 1 }
  if (f.more !== undefined && String(f.more).trim().length > MORE_MAX) return { out: `--more: ${sayShorter(MORE_MAX, String(f.more).trim().length)}`, code: 1 }
  try {
    const r = saveTerm({ term, short, more: f.more, source: 'agent', flowId: f.flow })
    if (!r.saved) return { out: `Not saved: ${r.reason}. It stays: ${r.entry.short}`, code: 1 }
    return { out: `Saved ${r.entry.key}: ${r.entry.short}`, code: 0 }
  } catch (err) {
    return { out: err.message, code: 1 }
  }
}
