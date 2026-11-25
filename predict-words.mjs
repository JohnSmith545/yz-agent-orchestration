// The few words Predict and warn's server side writes (alert lines, estimate misses): a duration, a token count and
// dollars. MUST CHANGE IN LOCKSTEP with public/predict-view.js (the page says the same numbers the same way).
//
//   durationText(ms)   '45 min', '3 h 20 min', '2 h', '2.5 days'; under a minute 'under 1 min'
//   tokensText(n)      '850', '12.4K', '12.4M', '1.2B'
//   usdText(n)         '$4.10', '$0.04', '$120'

export function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'under 1 min'
  if (min < 60) return `${min} min`
  if (min < 48 * 60) {
    const h = Math.floor(min / 60)
    const m = min % 60
    return m ? `${h} h ${m} min` : `${h} h`
  }
  return `${Math.round((min / 1440) * 10) / 10} days`
}

export function tokensText(n) {
  if (!Number.isFinite(n)) return ''
  const cut = (v, s) => `${Math.round(v * 10) / 10}${s}`
  const a = Math.abs(n)
  if (a >= 1e9) return cut(n / 1e9, 'B')
  if (a >= 1e6) return cut(n / 1e6, 'M')
  if (a >= 1e3) return cut(n / 1e3, 'K')
  return String(Math.round(n))
}

export function usdText(n) {
  if (!Number.isFinite(n)) return ''
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`
}
