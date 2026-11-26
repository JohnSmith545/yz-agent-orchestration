// The `quality` block of config.json, checked (config.mjs calls qualitySettings once at start):
//
//   "quality": {
//     "autoLessons": true,      every QA, Security or Senior failure is turned into candidate lessons by one small cheap
//                               run as soon as the server notices it (quality-extract.mjs); false: only the Lessons
//                               page's Extract lessons button runs one
//     "critic": "manual",       the second opinion on a plan (quality-critic.mjs): off, manual (a Second opinion button
//                               on the flow's plan) or auto (one run per plan, when the planner records it)
//     "areas": ["billing"],     more lesson areas, added to the built-in ones (quality-areas.mjs)
//     "riskRules": [ … ]        the user's own risk rules, replacing the built-in ones (quality-risk.mjs riskRules)
//   }
//   "pipeline": { "requireSelfCheck": false }   true: QA may not start testing a code flow until its producer recorded
//                                               a self-check (quality-selfcheck.mjs selfCheckRefusal)
//
// requireSelfCheck sits in `pipeline` (it is a gate on the way to QA), but pipeline.mjs keeps only its own keys, so it
// is read here from the raw pipeline block and kept as quality.requireSelfCheck. A bad value keeps its default with
// ONE warning, never a failed start, like every other block. qualityOf(config) gives the settings of a config that has
// no quality block (a test config): the defaults, with pipeline.requireSelfCheck honoured.

import { DEFAULT_AREAS } from './quality-areas.mjs'
import { DEFAULT_RISK_RULES, riskRules } from './quality-risk.mjs'

export const CRITIC_MODES = Object.freeze(['off', 'manual', 'auto'])
export const DEFAULT_QUALITY = Object.freeze({ autoLessons: true, critic: 'manual', areas: DEFAULT_AREAS, riskRules: DEFAULT_RISK_RULES, requireSelfCheck: false })
const AREA = /^[a-z][a-z0-9-]{1,23}$/
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** The checked settings from config.json's `quality` block (`raw`) and its `pipeline` block (`rawPipeline`). */
export function qualitySettings(raw, rawPipeline, warn = console.warn) {
  const out = { ...DEFAULT_QUALITY, areas: [...DEFAULT_AREAS] }
  const need = rawPipeline?.requireSelfCheck
  if (need !== undefined) {
    if (typeof need === 'boolean') out.requireSelfCheck = need
    else warn('config.json: pipeline.requireSelfCheck needs true or false; false is used.')
  }
  if (raw === undefined) return out
  if (!isObject(raw)) {
    warn('config.json: quality should be an object such as { "autoLessons": true, "critic": "manual" }; the defaults are used.')
    return out
  }
  if (raw.autoLessons !== undefined) {
    if (typeof raw.autoLessons === 'boolean') out.autoLessons = raw.autoLessons
    else warn('config.json: quality.autoLessons needs true or false; true is used.')
  }
  if (raw.critic !== undefined) {
    if (CRITIC_MODES.includes(raw.critic)) out.critic = raw.critic
    else warn(`config.json: quality.critic needs ${CRITIC_MODES.join(', ')}; manual is used.`)
  }
  if (raw.areas !== undefined) {
    if (!Array.isArray(raw.areas)) warn('config.json: quality.areas should be a list of short names such as ["billing"]; only the built-in areas are used.')
    else {
      const extra = []
      raw.areas.forEach((a, i) => {
        const name = typeof a === 'string' ? a.trim().toLowerCase() : ''
        if (!AREA.test(name)) return warn(`config.json: quality.areas[${i}] needs a short name of lower-case letters, digits or dashes; it is left out.`)
        if (!out.areas.includes(name) && !extra.includes(name)) extra.push(name)
      })
      out.areas = [...DEFAULT_AREAS.filter(a => a !== 'general'), ...extra, 'general']
    }
  }
  out.riskRules = riskRules(raw.riskRules, warn)
  return out
}

/** The quality settings of `config`: its checked block, or the defaults (with pipeline.requireSelfCheck) for one without. */
export function qualityOf(config) {
  if (isObject(config?.quality) && Array.isArray(config.quality.areas)) return config.quality
  return qualitySettings(undefined, config?.pipeline, () => {})
}
