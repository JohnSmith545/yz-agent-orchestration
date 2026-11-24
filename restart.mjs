// How the server restarts itself after a project switch (projects-routes.mjs), so every module loads fresh with
// the new project (project-store.mjs says why a restart and not a reload in place).
//
// ═══ TWO WAYS IT RUNS, ONE RULE: NEVER TWO SERVERS, NEVER NONE ═══
// - Under tools/keep-alive.cmd: the loop starts `node server.mjs` again whenever it stops. The server closes and
//   exits with RESTART_CODE (75), and the loop starts it again AT ONCE instead of after its 5-second pause (the
//   pause stays for every other exit, so a server that crashes on start never spins). An older copy of the loop
//   that does not know 75 still restarts it, 5 seconds later. Nothing else is started: the loop is the one owner.
// - Started by hand (`node server.mjs`, `npm start`): the server starts its own replacement, detached and hidden,
//   with the same node, flags, script, folder and environment (PORT, FACTORY_DATA_DIR) and YZ_REPLACES=<its pid>,
//   then closes and exits. The replacement first waits for that pid to be gone (waitForPredecessor) and then
//   retries the port until Windows lets it go (listenWhenFree). If the replacement cannot even be started, the
//   old server does NOT exit (the route then puts `active` back): one server stays, the one that was running.
// - Which way: YZ_KEEP_ALIVE=1 or 0 says it outright; else, on Windows, the parent process's command line names
//   keep-alive.cmd (read once with PowerShell, off the request path). A replacement started by hand has a node
//   parent, so it is never mistaken for the loop.
// - The replacement's output goes to server.log in FACTORY_DATA_DIR (a preview never writes the live log), else
//   beside the keep-alive log in %LOCALAPPDATA%\yz-agent-orchestration.
//
// Every process call is injected, so the tests start and stop nothing.

import { execFile, spawn as cpSpawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The exit code that asks the keep-alive loop to start the server again at once. */
export const RESTART_CODE = 75

/** The parent process's command line on Windows ('' when it cannot be read). */
export function parentCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve('')
  return new Promise(done => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { timeout: 15_000, windowsHide: true }, (err, out) => done(err ? '' : String(out || '').trim()))
  })
}

export async function underKeepAlive({ env = process.env, platform = process.platform, ppid = process.ppid, parentCommand = parentCommandLine } = {}) {
  if (env.YZ_KEEP_ALIVE === '1') return true
  if (env.YZ_KEEP_ALIVE === '0' || platform !== 'win32') return false
  try {
    return /keep-alive\.cmd/i.test(await parentCommand(ppid))
  } catch {
    return false
  }
}

export function restartLogFile(env = process.env) {
  if (env.FACTORY_DATA_DIR) return path.join(env.FACTORY_DATA_DIR, 'server.log')
  return path.join(env.LOCALAPPDATA || os.tmpdir(), 'yz-agent-orchestration', 'server.log')
}

function openRestartLog() {
  const file = restartLogFile()
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    return openSync(file, 'a')
  } catch {
    return 'ignore'
  }
}

function closeServer(server) {
  try {
    server.close()
    server.closeAllConnections?.() // open event streams would hold the old server up
  } catch {}
}

/**
 * restart() -> { ok: true, how: 'loop' | 'spawn', pid? } after which the process exits, or { ok: false, error }
 * with this server still running. `loop()` resolves whether the keep-alive loop runs this server.
 */
export function makeRestarter({
  server, loop = () => underKeepAlive(), spawn = cpSpawn, exit = code => process.exit(code), env = process.env,
  execPath = process.execPath, execArgv = process.execArgv, argv = process.argv, cwd = process.cwd(), pid = process.pid,
  openLog = openRestartLog, log = m => console.log(m),
}) {
  let busy = false
  return async function restart() {
    if (busy) return { ok: false, error: 'The dashboard is already restarting.' }
    busy = true
    try {
      if (await loop()) {
        log('restart: closing; the keep-alive loop starts the dashboard again at once')
        closeServer(server)
        exit(RESTART_CODE)
        return { ok: true, how: 'loop' }
      }
      let child
      try {
        const out = openLog()
        child = spawn(execPath, [...execArgv, ...argv.slice(1)], { cwd, env: { ...env, YZ_REPLACES: String(pid) }, detached: true, windowsHide: true, stdio: ['ignore', out, out] })
      } catch (err) {
        child = null
        log(`restart: the new dashboard could not start: ${err?.message || err}`)
      }
      if (!child?.pid) {
        busy = false
        return { ok: false, error: 'The new dashboard could not start, so this one keeps running.' }
      }
      child.unref?.()
      log(`restart: the new dashboard is process ${child.pid}; its output goes to ${restartLogFile(env)}`)
      closeServer(server)
      exit(0)
      return { ok: true, how: 'spawn', pid: child.pid }
    } catch (err) {
      busy = false
      return { ok: false, error: String(err?.message || err) }
    }
  }
}

const pause = ms => new Promise(r => setTimeout(r, ms))

/** A replacement (YZ_REPLACES=<pid>) waits until that process is gone; true when it is (or there is none), false after `maxMs`. */
export async function waitForPredecessor({ env = process.env, kill = (p, s) => process.kill(p, s), sleep = pause, maxMs = 10_000, stepMs = 100 } = {}) {
  const old = Number(env.YZ_REPLACES)
  if (!Number.isInteger(old) || old <= 0) return true
  for (let waited = 0; waited < maxMs; waited += stepMs) {
    try {
      kill(old, 0)
    } catch (err) {
      if (err?.code !== 'EPERM') return true // ESRCH: gone
    }
    await sleep(stepMs)
  }
  return false
}

/**
 * Listens on `port`, retrying while it is in use (EADDRINUSE: the old server or Windows still holds it) for up to
 * `maxMs`. Resolves true when listening; false, with one plain line, when it never freed. Any other error rejects.
 */
export function listenWhenFree(server, port, host = '127.0.0.1', { maxMs = 15_000, retryMs = 250, log = m => console.error(m) } = {}) {
  const until = Date.now() + maxMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const onError = err => {
        server.removeListener('listening', onListening)
        if (err?.code !== 'EADDRINUSE') return reject(err)
        if (Date.now() >= until) {
          log(`The dashboard did not start: port ${port} is still in use by another program. Close that program, then start the dashboard again.`)
          return resolve(false)
        }
        setTimeout(attempt, retryMs)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve(true)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }
    attempt()
  })
}
