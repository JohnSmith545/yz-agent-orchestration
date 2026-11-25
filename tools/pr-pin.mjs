// `node tools/factory.mjs pr-pin`: the person sets the send PIN, in their own terminal.
//
// It reads the PIN twice from the keyboard with nothing echoed, and REFUSES when
// stdin is not a terminal: a PIN piped in is what an agent could do, and the PIN
// exists to stop exactly that. It writes only the scrypt hash into config.json
// (pr.pinHash, atomic, every other line as it was: send-pin.mjs withPinHash) and
// prints one line; the running dashboard picks it up without a restart (config.mjs prNow). The PIN itself
// is never stored, logged or printed. The Settings page does the same in the browser (settings-routes.mjs).

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeAtomic } from '../atomic-write.mjs'
import { hashPin, pinProblem, withPinHash } from '../send-pin.mjs'

const CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json')
export const NOT_A_TERMINAL = 'pr-pin reads the PIN from your keyboard: type it yourself in a terminal (a PIN piped in is refused).'

/** One line from the keyboard with nothing shown; Ctrl+C or Ctrl+D gives null. The phone PIN reads it too (tools/phone-cli.mjs). */
export function readHidden(prompt) {
  return new Promise(resolve => {
    const { stdin, stdout } = process
    stdout.write(prompt)
    let pin = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const done = value => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write('\n')
      resolve(value)
    }
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(pin)
        if (ch === '\u0003' || ch === '\u0004') return done(null)
        if (ch === '\u007f' || ch === '\b') pin = pin.slice(0, -1)
        else if (ch >= ' ') pin += ch
      }
    }
    stdin.on('data', onData)
  })
}

/** { out, code }: never the PIN. */
export async function runPinCli() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return { out: NOT_A_TERMINAL, code: 1 }
  if (!existsSync(CONFIG)) return { out: 'config.json is missing: copy config.example.json to config.json first.', code: 1 }
  const pin = await readHidden('New send PIN (at least 6 characters, not shown): ')
  if (pin == null) return { out: 'Cancelled: the send PIN is unchanged.', code: 1 }
  const problem = pinProblem(pin)
  if (problem) return { out: problem, code: 1 }
  const again = await readHidden('The same PIN again: ')
  if (again !== pin) return { out: 'The two PINs differ: the send PIN is unchanged.', code: 1 }
  writeAtomic(CONFIG, withPinHash(readFileSync(CONFIG, 'utf8'), hashPin(pin)))
  return { out: 'Send PIN set in config.json (only its hash is kept). The dashboard uses it from now on.', code: 0 }
}
