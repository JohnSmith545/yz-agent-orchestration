// The SCRIPT page's completion pop: one short, soft sine made with the Web Audio API
// (no audio file), played once when the last section finishes, never on a failure or
// on the questions path. test/script-sound.test.mjs runs this file in a vm with stubs.
//
//   ScriptSound.popTone()        the tone's numbers, pure: a 115 ms sine that falls from
//                                620 Hz to 300 Hz, up to a 0.07 gain in 5 ms and down
//                                exponentially to near silence. No noise tick: it is
//                                softer without one.
//   ScriptSound.play(ctx)        schedule it on `ctx`; true when scheduled. Never throws.
//   ScriptSound.ensureContext()  make (once) or resume the AudioContext. ⚠️ Call it from
//                                the Generate click: browsers only let a page start audio
//                                after a user gesture, and the pop comes much later.
//   ScriptSound.isMuted(store), setMuted(store, on)   the mute switch, kept per browser in
//                                localStorage (`script.muted` = '1'); every access is
//                                guarded, so a storage that throws reads as not muted.
;(() => {
  const MUTE_KEY = 'script.muted'
  const TONE = Object.freeze({
    type: 'sine',
    startHz: 620,
    endHz: 300,
    glideS: 0.09,
    attackS: 0.005,
    peakGain: 0.07,
    durationS: 0.115,
    floorGain: 0.0001,
  })

  const popTone = () => ({ ...TONE })

  function play(ctx, tone = popTone()) {
    if (!ctx) return false
    try {
      const t = ctx.currentTime
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = tone.type
      osc.frequency.setValueAtTime(tone.startHz, t)
      osc.frequency.exponentialRampToValueAtTime(tone.endHz, t + tone.glideS)
      gain.gain.setValueAtTime(tone.floorGain, t)
      gain.gain.linearRampToValueAtTime(tone.peakGain, t + tone.attackS)
      gain.gain.exponentialRampToValueAtTime(tone.floorGain, t + tone.durationS)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.onended = () => {
        try {
          osc.disconnect()
          gain.disconnect()
        } catch {
          /* already gone */
        }
      }
      osc.start(t)
      osc.stop(t + tone.durationS + 0.02)
      return true
    } catch {
      return false
    }
  }

  let ctx = null
  function ensureContext() {
    try {
      if (!ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext
        if (!Ctx) return null
        ctx = new Ctx()
      }
      if (ctx.state === 'suspended') ctx.resume?.()?.catch?.(() => {})
      return ctx
    } catch {
      ctx = null
      return null
    }
  }

  function isMuted(store) {
    try {
      return store?.getItem(MUTE_KEY) === '1'
    } catch {
      return false
    }
  }

  function setMuted(store, on) {
    try {
      if (on) store?.setItem(MUTE_KEY, '1')
      else store?.removeItem(MUTE_KEY)
    } catch {
      /* not remembered: this page still honours it until reload */
    }
  }

  window.ScriptSound = { popTone, play, ensureContext, isMuted, setMuted }
})()
