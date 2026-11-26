// Predict and warn's settings: config.json's `alerts` and `estimates` blocks, checked like the other blocks
// (completed.mjs outputSettings, pipeline.mjs pipelineSettings). PURE: the caller passes the raw block and a `warn`.
//
//   alertSettings(raw, warn)      { enabled, stuckFactor, stuckMinMinutes, stuckHours, spikeFactor, spikeMinTokens,
//                                 contextTokens, dailyUsd, dailyTokens } (predict-alerts.mjs says what each one does)
//   estimateSettings(raw, warn)   { enabled, nearest }: estimates from similar finished flows (predict-estimate.mjs)
//
// Rules: left out is the default. Each bad value keeps its default with ONE warning that names the key and what is
// used instead, never a failed startup: a typo must not stop the dashboard, and the defaults are the quiet side. A
// block that is not an object is one warning and every default. The two daily limits are OFF (null) by default; a
// positive number turns one on.
// ⚠️ The floor of 3 similar flows for an estimate is not a setting: fewer than 3 is never a number (the honesty rule).

export const ALERT_DEFAULTS = Object.freeze({
  enabled: true,
  stuckFactor: 3,
  stuckMinMinutes: 60,
  stuckHours: 24,
  spikeFactor: 4,
  spikeMinTokens: 20_000_000,
  contextTokens: 400_000,
  dailyUsd: null,
  dailyTokens: null,
})
export const ESTIMATE_DEFAULTS = Object.freeze({ enabled: true, nearest: 8 })

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = v => typeof v === 'number' && Number.isFinite(v)

/** Each numeric key: [low, high, whole numbers only, the words a warning uses]. */
const ALERT_RULES = Object.freeze({
  stuckFactor: [1, 100, false, 'a number from 1 to 100'],
  stuckMinMinutes: [0, 10_080, true, 'a whole number of minutes from 0 to 10080'],
  stuckHours: [1, 720, false, 'a number of hours from 1 to 720'],
  spikeFactor: [1, 1000, false, 'a number from 1 to 1000'],
  spikeMinTokens: [0, 10_000_000_000, true, 'a whole number of tokens from 0 to 10000000000'],
  contextTokens: [1000, 10_000_000, true, 'a whole number of tokens from 1000 to 10000000'],
})
const DAILY_RULES = Object.freeze({
  dailyUsd: [false, 'null (off) or a number of dollars above 0'],
  dailyTokens: [true, 'null (off) or a whole number of tokens above 0'],
})

const inRange = (v, [lo, hi, whole]) => isNum(v) && v >= lo && v <= hi && (!whole || Number.isInteger(v))

/** config.json `alerts`, checked. */
export function alertSettings(raw, warn = console.warn) {
  const out = { ...ALERT_DEFAULTS }
  if (raw === undefined) return out
  if (!isObject(raw)) {
    warn('config.json: alerts should be an object such as { "stuckFactor": 3 }; the defaults are used.')
    return out
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
    else warn('config.json: alerts.enabled needs true or false; true is used.')
  }
  for (const [key, rule] of Object.entries(ALERT_RULES)) {
    if (raw[key] === undefined) continue
    if (inRange(raw[key], rule)) out[key] = raw[key]
    else warn(`config.json: alerts.${key} needs ${rule[3]}; ${out[key]} is used.`)
  }
  for (const [key, [whole, words]] of Object.entries(DAILY_RULES)) {
    const v = raw[key]
    if (v === undefined || v === null) continue
    if (isNum(v) && v > 0 && (!whole || Number.isInteger(v))) out[key] = v
    else warn(`config.json: alerts.${key} needs ${words}; it is off.`)
  }
  return out
}

/** config.json `estimates`, checked. */
export function estimateSettings(raw, warn = console.warn) {
  const out = { ...ESTIMATE_DEFAULTS }
  if (raw === undefined) return out
  if (!isObject(raw)) {
    warn('config.json: estimates should be an object such as { "enabled": true, "nearest": 8 }; the defaults are used.')
    return out
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
    else warn('config.json: estimates.enabled needs true or false; true is used.')
  }
  if (raw.nearest !== undefined) {
    if (Number.isInteger(raw.nearest) && raw.nearest >= 3 && raw.nearest <= 20) out.nearest = raw.nearest
    else warn(`config.json: estimates.nearest needs a whole number from 3 to 20; ${out.nearest} is used.`)
  }
  return out
}
