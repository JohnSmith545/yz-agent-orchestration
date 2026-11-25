// `node tools/factory.mjs phone-pin` and `node tools/factory.mjs phone-setup`: the person sets up phone access, in
// their own terminal.
//
// phone-pin   reads the phone PIN twice from the keyboard with nothing echoed (tools/pr-pin.mjs readHidden) and
//             REFUSES when stdin is not a terminal: a PIN piped in is what an agent could do, and the PIN exists to
//             stop exactly that. 8 to 12 digits (phone-auth.mjs), and not the send PIN: a PIN typed on a phone must
//             never be the one that pushes code. It writes only the salted scrypt hash (remote.pinHash) and when it
//             was set (remote.pinSetAt) into config.json, every other line as it was (config-write.mjs), and signs
//             every phone out (a new PIN ends the old sessions). The running dashboard picks the hash up without a
//             restart (phone-bind.mjs makeRemoteReader). The PIN itself is never stored, logged or printed.
// phone-setup lists this PC's private and Tailscale addresses (phone-bind.mjs eligibleAddresses), Tailscale marked;
//             the person picks one; it says plainly what that opens (plain HTTP on that network, the PIN the only
//             lock, never forward the port) and writes remote.enabled and remote.bind ONLY after a typed yes. It
//             also refuses without a terminal: turning on a network door is the person's call, never an agent's.
//             The listener starts at the next start of the dashboard.
//
// Both take an injected `io` ({ isTTY, hidden(prompt), line(prompt) }, each answer a string or null for cancel) and
// config file, so the tests script the keyboard and never touch the real config.json.

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

import { writeAtomic } from '../atomic-write.mjs'
import { makeAuthStore, phonePinProblem } from '../phone-auth.mjs'
import { eligibleAddresses, REMOTE_DEFAULTS } from '../phone-bind.mjs'
import { withRemote } from '../phone-config.mjs'
import { hashPin, verifyPin } from '../send-pin.mjs'
import { readHidden } from './pr-pin.mjs'

const CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json')
const NOT_A_TERMINAL = cmd => `${cmd} reads from your keyboard: type it yourself in a terminal (anything piped in is refused).`

/** The real keyboard: hidden for the PIN, a plain line for a choice. */
export function terminal() {
  const { stdin, stdout } = process
  return {
    isTTY: !!stdin.isTTY && typeof stdin.setRawMode === 'function',
    hidden: readHidden,
    line: prompt => new Promise(resolve => {
      const rl = readline.createInterface({ input: stdin, output: stdout })
      let answered = false
      rl.question(prompt, a => { answered = true; rl.close(); resolve(a) })
      rl.on('close', () => { if (!answered) resolve(null) })
    }),
  }
}

export async function runPhonePin({ io = terminal(), configFile = CONFIG, auth = makeAuthStore(), now = () => new Date() } = {}) {
  if (!io.isTTY) return { out: NOT_A_TERMINAL('phone-pin'), code: 1 }
  let text
  try {
    text = readFileSync(configFile, 'utf8')
  } catch {
    return { out: 'config.json is missing: copy config.example.json to config.json first.', code: 1 }
  }
  const pin = await io.hidden('New phone PIN (8 to 12 digits, not shown): ')
  if (pin == null) return { out: 'Cancelled: the phone PIN is unchanged.', code: 1 }
  const problem = phonePinProblem(pin)
  if (problem) return { out: problem, code: 1 }
  const sendHash = JSON.parse(text)?.pr?.pinHash
  if (sendHash && verifyPin(pin, sendHash)) return { out: 'Pick a phone PIN that differs from your send PIN: the phone PIN is typed on a phone, the send PIN pushes code.', code: 1 }
  const again = await io.hidden('The same PIN again: ')
  if (again !== pin) return { out: 'The two PINs differ: the phone PIN is unchanged.', code: 1 }
  const pinHash = hashPin(pin)
  auth.markPin(pinHash) // first: the watcher then knows this new hash came from the setup command (phone-auth.mjs noteRemote)
  writeAtomic(configFile, withRemote(text, { pinHash, pinSetAt: now().toISOString(), pinDigits: pin.length }))
  const ended = auth.signOutEverywhere()
  return {
    out: `Phone PIN set in config.json (only its hash is kept).${ended ? ` ${ended} signed-in phone${ended === 1 ? ' was' : 's were'} signed out.` : ''} The dashboard uses it from now on.`,
    code: 0,
  }
}

export async function runPhoneSetup({ io = terminal(), configFile = CONFIG, interfaces = os.networkInterfaces() } = {}) {
  if (!io.isTTY) return { out: NOT_A_TERMINAL('phone-setup'), code: 1 }
  let text
  try {
    text = readFileSync(configFile, 'utf8')
  } catch {
    return { out: 'config.json is missing: copy config.example.json to config.json first.', code: 1 }
  }
  const list = eligibleAddresses(interfaces)
  if (!list.length) {
    return {
      out: 'This PC has no private or Tailscale address right now. Install Tailscale on the PC and the phone and sign in to the same account, or join your home Wi-Fi, then run phone-setup again.',
      code: 1,
    }
  }
  const cfg = JSON.parse(text)
  const port = Number.isInteger(cfg.remote?.port) ? cfg.remote.port : REMOTE_DEFAULTS.port
  const lines = list.map((a, i) => `  ${i + 1}. ${a.address} (${a.name})${a.tailscale ? ' - recommended: it encrypts the link and follows you between networks' : ''}`)
  const pick = await io.line(`Phone access listens on ONE address of this PC. Which one?\n${lines.join('\n')}\nType its number (Enter to cancel): `)
  if (pick == null || !pick.trim()) return { out: 'Cancelled: nothing changed.', code: 1 }
  const i = /^\d+$/.test(pick.trim()) ? Number(pick.trim()) - 1 : -1
  const chosen = list[i]
  if (!chosen) return { out: `${pick.trim()} is not on the list: nothing changed.`, code: 1 }
  const url = `http://${chosen.address}:${port}/phone`
  const yes = await io.line([
    '',
    `This turns phone access ON at ${url}.`,
    `- It is plain HTTP on that network. Over home Wi-Fi the PIN and the session can be read by someone who can see the traffic; Tailscale removes that, because it encrypts the link${chosen.tailscale ? ' (this is the Tailscale address)' : ''}.`,
    '- The PIN guards the ability to instruct a coding agent: treat it like a password. Five wrong tries lock sign-in for 15 minutes; three lockouts in a day turn phone access off.',
    `- It opens only while this PC is on this network (${chosen.name}, ${chosen.cidr || 'its subnet'}).`,
    '- Never forward this port on your router: it is not made to face the internet.',
    'Type yes to write this to config.json: ',
  ].join('\n'))
  if (String(yes ?? '').trim().toLowerCase() !== 'yes') return { out: 'Not changed: phone access stays as it was.', code: 1 }
  // the network too (phone-bind.mjs networkProblem): the listener opens only while this PC is on it
  writeAtomic(configFile, withRemote(text, { enabled: true, bind: chosen.address, port, iface: chosen.name, mac: chosen.mac, cidr: chosen.cidr }))
  const hasPin = typeof cfg.remote?.pinHash === 'string' && cfg.remote.pinHash
  return {
    out: [
      `Phone access is on at ${chosen.address}, port ${port}.`,
      hasPin ? '' : 'Next: set a phone PIN with node tools/factory.mjs phone-pin (it stays off until you do).',
      'Then restart the dashboard so it starts listening.',
      `On the phone, open ${url} and add it to the home screen.`,
    ].filter(Boolean).join('\n'),
    code: 0,
  }
}
