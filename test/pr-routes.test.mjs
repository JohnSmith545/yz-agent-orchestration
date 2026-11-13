// Tests for the Send routes (pr-routes.mjs, through factoryRoute): GET the facts and
// the digest of what is reviewed, POST to push exactly the reviewed commit and open
// the pull request (only with the send PIN, the page's own Origin, and a confirm that
// still matches), POST refresh. A real http server on port 0 calls factoryRoute with
// STUB git, push and gh runners, so nothing is ever pushed and no pull request is ever
// opened. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the imports.

import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http, { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-routes-test-'))
const F = await import('../flows.mjs')
const { factoryRoute } = await import('../factory-routes.mjs')
const { resetPrState, digestOf } = await import('../pr-routes.mjs')
const { hashPin } = await import('../send-pin.mjs')

const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'no-visual.json'), 'utf8'))
const MERGE = { head: 'feature/dark-mode', base: 'dev', title: 'Add a dark mode to Settings', body: '## What\n\nA moon switch next to Theme.', at: '2026-11-12T10:00:00Z' }
const URL12 = 'https://github.com/acme/app/pull/12'
const HEAD_SHA = 'a'.repeat(40)
const PIN = '246810'
const PIN_HASH = hashPin(PIN, { N: 1024 })
const SETTINGS = { enabled: true, off: null, remote: 'origin', bases: ['dev'], gh: 'gh', protect: ['main', 'master', 'stage', 'prod', 'production', 'release/*', 'release-*'], pinHash: PIN_HASH }

/** The stub git (and push): the sandbox shape (3 ahead, clean, a GitHub remote); every call recorded. */
const gitCalls = []
let gitOver = {}
async function git(args) {
  gitCalls.push(args)
  const k = args[0] === 'rev-parse' ? args.at(-1).replace('^{commit}', '') : args[0] === 'rev-list' ? `rev-list ${args[1]}` : args[0]
  const answers = {
    [`refs/heads/${MERGE.head}`]: { ok: true, out: HEAD_SHA },
    'refs/heads/main': { ok: true, out: HEAD_SHA },
    'refs/remotes/origin/dev': { ok: true, out: 'b'.repeat(40) },
    'rev-list --left-right': { ok: true, out: '0\t3' },
    log: { ok: true, out: `${'1'.repeat(40)}\x1ffeat: a dark theme\x1ffeat: a dark theme\n\x1e` },
    diff: { ok: true, out: 'theme.css' },
    'merge-tree': { ok: true, out: 'c'.repeat(40) },
    config: { ok: true, out: 'git@github.com:acme/app.git' },
    fetch: { ok: true, out: '' },
    push: { ok: true, out: '' },
    ...gitOver,
  }
  const a = typeof answers[k] === 'function' ? await answers[k](args) : answers[k]
  return { err: '', code: 0, ...(a || { ok: false, out: '', code: 1 }) }
}
/** The stub gh: signed in, no PR yet; create prints the link; view answers number, state and checks. */
const ghCalls = []
let ghOver = {}
let bodySeen = null
const flagValue = (args, name) => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
async function gh(args) {
  ghCalls.push(args)
  const k = `${args[0]} ${args[1] || ''}`.trim()
  const answers = {
    'auth status': { ok: true, out: '' },
    'pr list': { ok: true, out: '[]' },
    'pr create': () => {
      const file = flagValue(args, '--body-file')
      bodySeen = { file, text: fs.readFileSync(file, 'utf8') }
      return { ok: true, out: `Creating pull request\n${URL12}\n` }
    },
    'pr view': { ok: true, out: JSON.stringify({ number: 12, state: 'OPEN', url: URL12, mergedAt: null, statusCheckRollup: [] }) },
    ...ghOver,
  }
  const a = typeof answers[k] === 'function' ? await answers[k](args) : answers[k]
  return { err: '', code: 0, ...(a || { ok: false, out: '', code: 1 }) }
}
let settings = { ...SETTINGS }

let server
let base
let port
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!(await factoryRoute(req, res, url, { git, push: git, gh, pr: settings, port, relay: {} }))) res.writeHead(404).end('not found')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  base = `http://127.0.0.1:${port}`
})
after(() => {
  server.close()
  fs.rmSync(F.DATA_DIR, { recursive: true, force: true })
})
const writeFlow = (output = { merge: { ...MERGE } }) => {
  const f = structuredClone(FIXTURE)
  f.output = output
  fs.writeFileSync(path.join(F.FLOWS_DIR, `${f.id}.json`), JSON.stringify(f))
}
beforeEach(() => {
  gitCalls.length = ghCalls.length = 0
  gitOver = {}
  ghOver = {}
  bodySeen = null
  settings = { ...SETTINGS }
  resetPrState()
  fs.mkdirSync(F.FLOWS_DIR, { recursive: true })
  writeFlow()
})

const ID = FIXTURE.id
const get = p => fetch(base + p)
const post = (body, origin = base) => fetch(`${base}/api/flows/${ID}/pr`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
})
/** What the page sends after its review: the PIN and what it reviewed (the GET's sha and digest). */
async function reviewed() {
  const j = await (await get(`/api/flows/${ID}/pr`)).json()
  return { head: MERGE.head, sha: j.facts.sha, digest: j.digest }
}
const send = async (extra = {}) => post({ pin: PIN, confirm: await reviewed(), ...extra })
const stored = () => F.readFlow(ID).output.pr
const pushes = () => gitCalls.filter(a => a[0] === 'push')
const creates = () => ghCalls.filter(a => a[1] === 'create')

// ═══ GET ═══

test('GET: the merge, no pr yet, the facts with the head sha, and the digest of what is reviewed; fetched once a minute, cached 20 s', async () => {
  const r = await get(`/api/flows/${ID}/pr`)
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.deepEqual(j.merge, MERGE)
  assert.deepEqual([j.pr, j.ready, j.facts.ahead, j.facts.sha, j.facts.repo], [null, true, 3, HEAD_SHA, 'acme/app'])
  assert.deepEqual(j.facts.blockers, [])
  const want = createHash('sha256').update(JSON.stringify({ head: MERGE.head, base: MERGE.base, title: MERGE.title, body: MERGE.body })).digest('hex')
  assert.equal(j.digest, want)
  assert.equal(digestOf(MERGE), want)
  assert.deepEqual(gitCalls.filter(a => a[0] === 'fetch'), [['fetch', 'origin', '--prune', '--quiet']])
  const n = gitCalls.length
  await get(`/api/flows/${ID}/pr`)
  assert.equal(gitCalls.length, n, 'the second read is the cached facts')
  assert.equal(pushes().length, 0)
})

test('GET with nothing recorded is no facts; a missing flow is 404', async () => {
  writeFlow({})
  const j = await (await get(`/api/flows/${ID}/pr`)).json()
  assert.deepEqual([j.merge, j.pr, j.facts], [null, null, null])
  assert.equal((await get('/api/flows/nope/pr')).status, 404)
})

test('GET adopts an open pull request for exactly that head and base when none is stored', async () => {
  ghOver = { 'pr list': { ok: true, out: '[{"number":7,"url":"https://github.com/acme/app/pull/7","state":"OPEN"}]' } }
  const j = await (await get(`/api/flows/${ID}/pr`)).json()
  assert.equal(j.pr.number, 7)
  assert.equal(j.ready, false)
  assert.deepEqual([stored().url, stored().state], ['https://github.com/acme/app/pull/7', 'open'])
  assert.equal(F.derive(F.readFlow(ID)).output.merge.ready, false)
})

test('GET after a fetch that failed warns that the facts may be out of date', async () => {
  gitOver = { fetch: { ok: false, out: '', err: 'Could not resolve host' } }
  const j = await (await get(`/api/flows/${ID}/pr`)).json()
  assert.ok(j.facts.warnings.includes('Could not reach origin: these facts may be out of date.'))
})

// ═══ POST: who may send ═══

test('POST refuses a missing Origin (a script, an agent) and another origin, and pushes nothing', async () => {
  const confirm = await reviewed()
  const none = await post({ pin: PIN, confirm }, null)
  assert.equal(none.status, 403)
  assert.match((await none.json()).error, /from the dashboard page/)
  assert.equal((await post({ pin: PIN, confirm }, 'http://evil.example')).status, 403)
  assert.deepEqual([pushes(), creates()], [[], []])
})

test('a rebinding site that sends its own Host and a matching Origin is still refused: Origin is checked against 127.0.0.1 and localhost only', async () => {
  const evil = `evil.example:${port}`
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/flows/${ID}/pr`, method: 'POST', headers: { host: evil, origin: `http://${evil}`, 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end(JSON.stringify({ pin: PIN, confirm: { head: MERGE.head } }))
  })
  assert.equal(status, 403)
  assert.equal((await post({ pin: PIN, confirm: await reviewed() }, `http://localhost:${port}`)).status, 200, 'localhost is the same dashboard')
})

test('POST needs the send PIN: none or a wrong one is 403 Wrong PIN; five wrong lock sending for 10 minutes; the PIN is never stored or echoed', async () => {
  const confirm = await reviewed()
  const none = await post({ confirm })
  assert.equal(none.status, 403)
  assert.deepEqual(await none.json(), { error: 'Wrong PIN.' })
  for (let i = 0; i < 4; i++) assert.equal((await post({ pin: '000000', confirm })).status, 403)
  const locked = await post({ pin: PIN, confirm })
  assert.equal(locked.status, 429)
  assert.match((await locked.json()).error, /Too many wrong PINs: sending is locked for 10 minutes/)
  assert.deepEqual([pushes(), creates()], [[], []])
  assert.doesNotMatch(JSON.stringify(F.readFlow(ID)), new RegExp(PIN))
})

test('POST refuses a confirm for another branch, and a review that went stale (the text or the commit changed)', async () => {
  const confirm = await reviewed()
  const r = await post({ pin: PIN, confirm: { ...confirm, head: 'feature/other' } })
  assert.equal(r.status, 400)
  const f = F.readFlow(ID)
  f.output.merge.title = 'A different title'
  F.writeFlow(f)
  const text = await post({ pin: PIN, confirm })
  assert.equal(text.status, 409)
  assert.deepEqual(await text.json(), { error: 'Changed since you reviewed it. Review again.', changed: true })
  writeFlow()
  resetPrState()
  const again = await reviewed()
  gitOver = { [`refs/heads/${MERGE.head}`]: { ok: true, out: 'd'.repeat(40) } }
  const commit = await post({ pin: PIN, confirm: again })
  assert.equal(commit.status, 409, 'a new commit since the review')
  assert.equal((await commit.json()).changed, true)
  assert.deepEqual(pushes(), [])
})

test('POST refuses each blocker with the plain reasons, and pushes nothing', async () => {
  const cases = [
    [() => { settings = { ...settings, bases: ['main'] } }, /not a branch this dashboard sends to/],
    [() => { gitOver = { 'merge-tree': { ok: false, out: `${'c'.repeat(40)}\ntheme.css` } } }, /does not merge cleanly/],
    [() => { gitOver = { log: { ok: true, out: `${'1'.repeat(40)}\x1ffeat: x\x1ffeat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\x1e` } } }, /credits an AI tool/],
    [() => { ghOver = { 'auth status': { ok: false, out: '' } } }, /not signed in/],
    [() => { gitOver = { config: { ok: true, out: '../origin.git' } } }, /GitHub repository/],
  ]
  for (const [setup, why] of cases) {
    gitOver = {}
    ghOver = {}
    settings = { ...SETTINGS }
    resetPrState()
    writeFlow()
    const confirm = await reviewed()
    resetPrState()
    setup()
    const r = await post({ pin: PIN, confirm })
    const j = await r.json()
    assert.equal(r.status, 409, String(why))
    assert.match(j.error, why)
  }
  assert.deepEqual([pushes(), creates()], [[], []])
})

test('POST refuses to send from a protected branch, whatever the rest says', async () => {
  writeFlow({ merge: { ...MERGE, head: 'main' } })
  const j = await (await get(`/api/flows/${ID}/pr`)).json()
  const r = await post({ pin: PIN, confirm: { head: 'main', sha: j.facts.sha, digest: j.digest } })
  assert.equal(r.status, 409)
  assert.match((await r.json()).error, /main is a protected branch/)
  assert.deepEqual(pushes(), [])
})

// ═══ POST: the send ═══

test('POST pushes EXACTLY the reviewed commit to refs/heads/<head>, then gh pr create --flag=value with --repo, stores the pr, deletes the body file', async () => {
  const r = await send()
  assert.equal(r.status, 200)
  assert.equal((await r.json()).pr.url, URL12)
  assert.deepEqual(pushes(), [['push', 'origin', `${HEAD_SHA}:refs/heads/feature/dark-mode`]])
  assert.ok(![...gitCalls, ...ghCalls].flat().some(a => a === '--force' || a === '-f' || a.startsWith('--force') || a.startsWith('+')), 'never forced')
  const create = creates()[0]
  const file = flagValue(create, '--body-file')
  assert.deepEqual(create, ['pr', 'create', '--repo=acme/app', '--base=dev', '--head=feature/dark-mode', `--title=${MERGE.title}`, `--body-file=${file}`])
  assert.ok(path.resolve(file).startsWith(path.resolve(os.tmpdir())))
  assert.equal(bodySeen.text, MERGE.body)
  assert.equal(fs.existsSync(file), false, 'deleted after')
  const pr = stored()
  assert.deepEqual({ ...pr, openedAt: typeof pr.openedAt }, { url: URL12, number: 12, state: 'open', openedAt: 'string', checks: 'pending', checkedAt: null, error: null })
  assert.equal(F.derive(F.readFlow(ID)).output.merge.ready, false)
})

test('a title that starts with dashes is one argv value, never a flag', async () => {
  writeFlow({ merge: { ...MERGE, title: '--draft and more' } })
  assert.equal((await send()).status, 200)
  assert.ok(creates()[0].includes('--title=--draft and more'))
  assert.ok(!creates()[0].includes('--draft'))
})

test('a rejected push returns the reason, keeps an earlier pull request under previous, never retries with force, opens nothing', async () => {
  const old = { url: 'https://github.com/acme/app/pull/3', number: 3, state: 'merged', openedAt: '2026-11-01T10:00:00Z', checks: 'passing', checkedAt: '2026-11-02T10:00:00Z', error: null }
  writeFlow({ merge: { ...MERGE }, pr: old })
  gitOver = { push: { ok: false, out: '', err: "To https://user:secret@github.com/acme/app.git\n ! [rejected]        feature/dark-mode -> feature/dark-mode (non-fast-forward)\nerror: failed to push some refs\nhint: pull first", code: 1 } }
  const r = await send()
  assert.equal(r.status, 502)
  const j = await r.json()
  assert.match(j.error, /push was refused/)
  assert.match(j.error, /non-fast-forward/)
  assert.doesNotMatch(j.error, /secret/)
  assert.equal(pushes().length, 1)
  assert.deepEqual(creates(), [])
  assert.deepEqual(stored(), { error: stored().error, previous: old })
  assert.doesNotMatch(stored().error, /secret/)
  assert.equal(F.derive(F.readFlow(ID)).output.merge.ready, true, 'nothing was opened: it can be tried again')
})

test('pushed but gh pr create failed: stored as pushed with the reason, the body file deleted', async () => {
  ghOver = { 'pr create': args => { bodySeen = { file: flagValue(args, '--body-file') }; return { ok: false, out: '', err: 'GraphQL: something went wrong', code: 1 } } }
  const r = await send()
  assert.equal(r.status, 502)
  const j = await r.json()
  assert.match(j.error, /did not open the pull request: GraphQL/)
  assert.equal(j.pushed, true, 'the page can say so at once')
  assert.equal(fs.existsSync(bodySeen.file), false)
  assert.deepEqual(Object.keys(stored()).sort(), ['error', 'pushed'])
  assert.equal(stored().pushed, true)
})

test('a second POST while one is sending is busy', async () => {
  const confirm = await reviewed()
  let release
  gitOver = { push: () => new Promise(r => { release = () => r({ ok: true, out: '' }) }) }
  const first = post({ pin: PIN, confirm })
  while (!release) await new Promise(r => setTimeout(r, 5))
  const second = await post({ pin: PIN, confirm })
  assert.equal(second.status, 409)
  assert.deepEqual(await second.json(), { busy: true })
  release()
  assert.equal((await first).status, 200)
  assert.equal(pushes().length, 1)
})

test('POST after it was sent refuses: the pull request is already open', async () => {
  const confirm = await reviewed()
  assert.equal((await post({ pin: PIN, confirm })).status, 200)
  const again = await post({ pin: PIN, confirm })
  assert.equal(again.status, 409)
  assert.match((await again.json()).error, /already sent/i)
  assert.equal(pushes().length, 1)
})

// ═══ refresh ═══

test('POST refresh reads the state and maps statusCheckRollup to pending, passing, failing or none', async () => {
  await send()
  const rollups = [
    [[], 'none', 'OPEN', 'open'],
    [[{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }], 'pending', 'OPEN', 'open'],
    [[{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }], 'passing', 'MERGED', 'merged'],
    [[{ __typename: 'StatusContext', state: 'FAILURE' }], 'failing', 'CLOSED', 'closed'],
  ]
  for (const [rollup, checks, ghState, state] of rollups) {
    ghOver = { 'pr view': { ok: true, out: JSON.stringify({ state: ghState, mergedAt: null, statusCheckRollup: rollup }) } }
    const r = await fetch(`${base}/api/flows/${ID}/pr/refresh`, { method: 'POST', headers: { origin: base } })
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.deepEqual([j.pr.checks, j.pr.state], [checks, state])
    assert.deepEqual([stored().checks, stored().state], [checks, state])
    assert.ok(stored().checkedAt)
  }
  assert.deepEqual(ghCalls.filter(a => a[1] === 'view').at(-1), ['pr', 'view', URL12, '--json=state,mergedAt,statusCheckRollup'])
})

test('POST refresh with no pull request is 400; from another origin 403', async () => {
  assert.equal((await fetch(`${base}/api/flows/${ID}/pr/refresh`, { method: 'POST' })).status, 400)
  assert.equal((await fetch(`${base}/api/flows/${ID}/pr/refresh`, { method: 'POST', headers: { origin: 'http://evil.example' } })).status, 403)
})

test('A8: with no send PIN set, a send is refused in plain words and counts no wrong try', async () => {
  settings = { ...SETTINGS, pinHash: '', enabled: false, off: 'Sending is off: set a send PIN in Settings.' }
  const confirm = await reviewed()
  for (let i = 0; i < 6; i++) {
    const r = await post({ pin: 'anything', confirm })
    assert.equal(r.status, 409)
    assert.deepEqual(await r.json(), { error: 'Sending is off: set a send PIN in Settings.' })
  }
  settings = { ...SETTINGS }
  assert.equal((await post({ pin: PIN, confirm: await reviewed() })).status, 200, 'not locked: those were not wrong PINs')
})

test('A6: the push sets batch-mode ssh only when the repo and the environment name no ssh command of their own', async () => {
  const { pushEnv } = await import('../pr-routes.mjs')
  assert.deepEqual(pushEnv('', {}), { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' })
  assert.deepEqual(pushEnv('ssh -i ~/.ssh/work', {}), {})
  assert.deepEqual(pushEnv('', { GIT_SSH_COMMAND: 'plink' }), {})
})
