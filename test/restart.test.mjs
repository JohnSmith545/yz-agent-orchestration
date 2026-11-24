// Tests for restart.mjs: how the server restarts itself after a project switch. Every process call is a stub
// (spawn, exit, kill, the parent's command line), so nothing here starts or stops a real dashboard; the port
// tests use real sockets on free ports of 127.0.0.1.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import path from 'node:path'

const R = await import('../restart.mjs')

const fakeServer = () => {
  const s = { closed: false, dropped: false, close() { s.closed = true }, closeAllConnections() { s.dropped = true } }
  return s
}

test('the restart code the keep-alive loop knows', () => {
  assert.equal(R.RESTART_CODE, 75)
})

test('under the keep-alive loop: said by YZ_KEEP_ALIVE, else read from the parent process on Windows', async () => {
  const never = async () => { throw new Error('not asked') }
  assert.equal(await R.underKeepAlive({ env: { YZ_KEEP_ALIVE: '1' }, platform: 'linux', parentCommand: never }), true)
  assert.equal(await R.underKeepAlive({ env: { YZ_KEEP_ALIVE: '0' }, platform: 'win32', parentCommand: never }), false)
  const cmd = c => async () => c
  assert.equal(await R.underKeepAlive({ env: {}, platform: 'win32', ppid: 9, parentCommand: cmd('C:\\Windows\\system32\\cmd.exe /c ""C:\\x\\tools\\keep-alive.cmd" "') }), true)
  assert.equal(await R.underKeepAlive({ env: {}, platform: 'win32', ppid: 9, parentCommand: cmd('cmd.exe /d /s /c "node server.mjs"') }), false)
  assert.equal(await R.underKeepAlive({ env: {}, platform: 'win32', ppid: 9, parentCommand: async () => { throw new Error('no powershell') } }), false)
  assert.equal(await R.underKeepAlive({ env: {}, platform: 'linux', ppid: 9, parentCommand: never }), false)
})

test('under the loop the server closes and exits with the restart code: the loop starts it again at once', async () => {
  const server = fakeServer()
  const exits = []
  const restart = R.makeRestarter({ server, loop: async () => true, exit: c => exits.push(c), spawn: () => assert.fail('no spawn under the loop'), log: () => {} })
  const r = await restart()
  assert.deepEqual(r, { ok: true, how: 'loop' })
  assert.deepEqual(exits, [75])
  assert.ok(server.closed && server.dropped)
})

test('started by hand it starts its replacement, detached, hidden, same command and folder, then exits', async () => {
  const server = fakeServer()
  const exits = []
  const calls = []
  let unref = false
  const restart = R.makeRestarter({
    server, loop: async () => false, exit: c => exits.push(c), pid: 4242,
    spawn: (bin, args, opts) => (calls.push({ bin, args, opts }), { pid: 5151, unref: () => (unref = true) }),
    execPath: 'C:/node/node.exe', execArgv: ['--no-warnings'], argv: ['C:/node/node.exe', 'C:/app/server.mjs'], cwd: 'C:/app',
    env: { PORT: '4414', FACTORY_DATA_DIR: 'C:/scratch' }, openLog: () => 'ignore', log: () => {},
  })
  const r = await restart()
  assert.deepEqual(r, { ok: true, how: 'spawn', pid: 5151 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].bin, 'C:/node/node.exe')
  assert.deepEqual(calls[0].args, ['--no-warnings', 'C:/app/server.mjs'])
  assert.equal(calls[0].opts.cwd, 'C:/app')
  assert.equal(calls[0].opts.detached, true)
  assert.equal(calls[0].opts.windowsHide, true)
  assert.equal(calls[0].opts.env.YZ_REPLACES, '4242') // the new one waits for this one to be gone
  assert.equal(calls[0].opts.env.PORT, '4414') // the same port and data root
  assert.equal(calls[0].opts.env.FACTORY_DATA_DIR, 'C:/scratch')
  assert.ok(unref)
  assert.deepEqual(exits, [0])
  assert.ok(server.closed)
})

test('a replacement that does not start leaves this server running: never none', async () => {
  for (const spawn of [() => ({ pid: undefined, unref() {} }), () => { throw new Error('ENOENT') }]) {
    const server = fakeServer()
    const exits = []
    const restart = R.makeRestarter({ server, loop: async () => false, exit: c => exits.push(c), spawn, openLog: () => 'ignore', log: () => {} })
    const r = await restart()
    assert.equal(r.ok, false)
    assert.match(r.error, /could not start/i)
    assert.deepEqual(exits, [])
    assert.equal(server.closed, false)
  }
})

test('one restart at a time', async () => {
  let release
  const gate = new Promise(r => (release = r))
  const restart = R.makeRestarter({ server: fakeServer(), loop: () => gate.then(() => true), exit: () => {}, log: () => {} })
  const first = restart()
  const second = await restart()
  assert.equal(second.ok, false)
  release()
  assert.equal((await first).ok, true)
})

test('the replacement waits for the server it replaces to be gone, and not forever', async () => {
  let alive = 3
  const kill = () => { if (alive-- > 0) return true; const e = new Error('gone'); e.code = 'ESRCH'; throw e }
  assert.equal(await R.waitForPredecessor({ env: { YZ_REPLACES: '77' }, kill, sleep: async () => {}, maxMs: 1000, stepMs: 1 }), true)
  assert.equal(await R.waitForPredecessor({ env: {}, kill: () => assert.fail('no pid, no wait') }), true)
  assert.equal(await R.waitForPredecessor({ env: { YZ_REPLACES: 'abc' }, kill: () => assert.fail('not a pid') }), true)
  let t = 0
  const forever = await R.waitForPredecessor({ env: { YZ_REPLACES: '77' }, kill: () => true, sleep: async ms => { t += ms }, maxMs: 500, stepMs: 100 })
  assert.equal(forever, false)
  assert.ok(t >= 500)
})

const freePort = () => new Promise(done => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => done(port))
  })
})

test('listenWhenFree takes the port once the old server lets it go', async () => {
  const port = await freePort()
  const blocker = createServer().listen(port, '127.0.0.1')
  await new Promise(r => blocker.once('listening', r))
  setTimeout(() => blocker.close(), 150)
  const server = createServer((req, res) => res.end('ok'))
  const ok = await R.listenWhenFree(server, port, '127.0.0.1', { maxMs: 4000, retryMs: 40, log: () => {} })
  assert.equal(ok, true)
  assert.equal(server.address().port, port)
  await new Promise(r => server.close(r))
})

test('listenWhenFree gives up with false when the port never frees', async () => {
  const port = await freePort()
  const blocker = createServer().listen(port, '127.0.0.1')
  await new Promise(r => blocker.once('listening', r))
  const said = []
  const ok = await R.listenWhenFree(createServer(), port, '127.0.0.1', { maxMs: 200, retryMs: 40, log: m => said.push(m) })
  assert.equal(ok, false)
  assert.match(said.at(-1), new RegExp(`port ${port}`))
  await new Promise(r => blocker.close(r))
})

test('the replacement writes its output to a log in FACTORY_DATA_DIR for a preview, else beside the keep-alive log', () => {
  assert.equal(R.restartLogFile({ FACTORY_DATA_DIR: 'C:/scratch' }), path.join('C:/scratch', 'server.log'))
  assert.equal(R.restartLogFile({ LOCALAPPDATA: 'C:/Users/me/AppData/Local' }), path.join('C:/Users/me/AppData/Local', 'yz-agent-orchestration', 'server.log'))
})
