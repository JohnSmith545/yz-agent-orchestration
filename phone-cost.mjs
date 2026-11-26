// What a message from the phone costs, as ONE quiet line under the phone's message box (public/phone-chat.js).
// Each message is handed over by the answer relay's short paid turn (phone-talk.mjs), recorded as `phone` spend
// (spend.mjs). With at least MIN_TURNS of them, the line says about the MEDIAN of the newest RECENT_TURNS (a median,
// so one long turn does not move it); with fewer it says the fixed sentence. Only arithmetic on the spend file.
//
//   costLine(usdList)   the line for these costs, oldest first
//   phoneCost()         the line for the spend file now

import { recentCosts } from './spend.mjs'

export const COST_FIXED = 'Each message costs a few cents.'
const MIN_TURNS = 3
const RECENT_TURNS = 20

const median = list => {
  const s = [...list].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function costLine(usdList) {
  const list = (Array.isArray(usdList) ? usdList : []).filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0)
  if (list.length < MIN_TURNS) return COST_FIXED
  const usd = median(list)
  if (usd >= 1) return `Each message costs about $${usd.toFixed(2)}.`
  const cents = Math.round(usd * 100)
  if (cents < 1) return 'Each message costs less than a cent.'
  return `Each message costs about ${cents} ${cents === 1 ? 'cent' : 'cents'}.`
}

export const phoneCost = () => costLine(recentCosts('phone', RECENT_TURNS))
