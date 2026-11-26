// The `learn` block of config.json (all optional), for the retrospectives and the Learn page (learn-routes.mjs):
//
//   enabled            true      the off switch for every model run here: the retrospectives AND Run Learn. Off, the
//                                page still shows the verdicts on rule changes (they cost nothing: stored numbers only)
//   autoRetro          true      write a flow's retrospective when the user marks it Completed (the button still works)
//   weekly             false     run Learn by itself when the Learn page opens and the last run is 7 days old or more
//   verdictAfterDays   14        how long after a rule change its Verdict due card shows (a whole number, 1 to 365)
//   model              claude-opus-5-5     the Learn run's model (high effort)
//   retroModel         claude-sonnet-5-5   the retrospective's model (low effort): the relay's Sonnet class, the
//                                          cheapest the house run writes careful plain lines with
//
// Rules this file keeps:
// - PURE: no file, no CONFIG import; the wiring passes CONFIG.learn in. Learn only READS config.json: no route here
//   writes it, a Settings proposal is text the user applies by hand.
// - A bad value keeps its default with ONE warning per key, never a failed startup (completed.mjs outputSettings).
// - A model name must look like a Claude model id: it goes into an argv, so it may never start with a dash.

export const LEARN_DEFAULTS = Object.freeze({
  enabled: true,
  autoRetro: true,
  weekly: false,
  verdictAfterDays: 14,
  model: 'claude-opus-5-5',
  retroModel: 'claude-sonnet-5-5',
})

const MODEL = /^claude-[a-z0-9][a-z0-9.-]{0,60}$/
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** config.json `learn`, checked: { enabled, autoRetro, weekly, verdictAfterDays, model, retroModel }. */
export function learnSettings(raw, warn = console.warn) {
  const out = { ...LEARN_DEFAULTS }
  if (raw === undefined || raw === null) return out
  if (!isObject(raw)) {
    warn('config.json: learn should be an object such as { "autoRetro": true }; the defaults are used.')
    return out
  }
  for (const key of ['enabled', 'autoRetro', 'weekly']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] === 'boolean') out[key] = raw[key]
    else warn(`config.json: learn.${key} must be true or false; ${out[key]} is used.`)
  }
  if (raw.verdictAfterDays !== undefined) {
    const n = raw.verdictAfterDays
    if (Number.isInteger(n) && n >= 1 && n <= 365) out.verdictAfterDays = n
    else warn(`config.json: learn.verdictAfterDays needs a whole number from 1 to 365; ${out.verdictAfterDays} is used.`)
  }
  for (const key of ['model', 'retroModel']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] === 'string' && MODEL.test(raw[key])) out[key] = raw[key]
    else warn(`config.json: learn.${key} must be a Claude model id such as ${LEARN_DEFAULTS[key]}; ${out[key]} is used.`)
  }
  return out
}
