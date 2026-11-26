// Tests for the brainstorming skill in POST /api/script/generate (script-routes.mjs): the injected finder
// (script-skill.mjs findSkill in server.mjs) is asked once per run; what it found is handed to generate();
// when it found nothing (or threw), the run still goes, on the built-in rules, and ONE context line says so
// in a plain sentence, which the run log keeps too. Without a finder (the tests' default) nothing changes.
// The stub generate means no Claude turn ever runs.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const { makeScriptRoute } = await import('../script-routes.mjs')
const { SKILL_MISSING, SKILL_TOO_LONG } = await import('../script-skill.mjs')

let runs = []
function stubGenerate(text, opts) {
  const run = { text, opts }
  run.done = new Promise(r => (run.end = r))
  runs.push(run)
  return { done: run.done, cancel: () => run.end({ error: 'Stopped.', cancelled: true }) }
}

const servers = []
async function serve(deps) {
  let route
  const s = createServer(async (req, res) => {
    if (!(await route(req, res, new URL(req.url, 'http://localhost')))) res.writeHead(404).end()
  })
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  route = makeScriptRoute({ generate: stubGenerate, port: s.address().port, ...deps })
  servers.push(s)
  return `http://127.0.0.1:${s.address().port}/api/script/generate`
}
after(() => servers.forEach(s => s.close()))

const lines = text => text.split('\n').filter(Boolean).map(l => JSON.parse(l))
const until = async cond => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5))
  assert.ok(cond(), 'timed out waiting')
}
async function send(url, text = 'idea') {
  runs = []
  const pending = fetch(url, { method: 'POST', body: JSON.stringify({ text }) })
  await until(() => runs.length === 1)
  runs[0].opts.onDelta('words')
  runs[0].end({ ok: true, stopReason: 'end_turn', cost: 0.1 })
  return { run: runs[0], out: lines(await (await pending).text()) }
}
const plain = v => JSON.parse(JSON.stringify(v))

// QA, 2026-11-25: the line under the output never said the skill was used, only when it was missing.
test('regression: found: generate gets the skill, and the context line names it FIRST in what was sent', async () => {
  const skill = { text: '# Brainstorming', file: 'C:/acct/SKILL.md' }
  let asked = 0
  const url = await serve({ skill: () => (asked++, skill) })
  const { run, out } = await send(url)
  assert.deepEqual(run.opts.skill, skill)
  assert.equal(asked, 1, 'asked once per run')
  assert.deepEqual(out[0], { type: 'context', used: [{ title: 'Brainstorming skill', chars: skill.text.length }], skipped: [] })
  assert.deepEqual(out.slice(1).map(l => l.type), ['delta', 'done'])
})

test('regression: the skill is named before the attached context, and the run log keeps it for History', async () => {
  const logged = []
  const gather = async () => ({ parts: [{ title: 'Your orchestration', text: 'brief' }], skipped: [] })
  const url = await serve({ skill: () => ({ text: '# B', file: 'x' }), gather, log: e => logged.push(e) })
  const { out } = await send(url)
  assert.deepEqual(out[0].used.map(u => u.title), ['Brainstorming skill', 'Your orchestration'])
  await until(() => logged.length === 1)
  assert.deepEqual(plain(logged[0].context.used).map(u => u.title), ['Brainstorming skill', 'Your orchestration'])
})

test('not found, or the finder throws: the run goes on the built-in rules, and ONE context line says so first', async () => {
  for (const finder of [() => null, async () => null, () => ({ text: '' }), () => { throw new Error('EACCES') }]) {
    const url = await serve({ skill: finder })
    const { run, out } = await send(url)
    assert.equal(run.opts.skill, null)
    assert.equal(run.text, 'idea', 'the text is sent as it was')
    assert.deepEqual(out[0], { type: 'context', used: [], skipped: [plain(SKILL_MISSING)] })
    assert.deepEqual(out.slice(1).map(l => l.type), ['delta', 'done'])
  }
})

test('too long to send: the run goes on the built-in rules, and the line gives that reason', async () => {
  const url = await serve({ skill: () => ({ error: SKILL_TOO_LONG }) })
  const { run, out } = await send(url)
  assert.equal(run.opts.skill, null)
  assert.deepEqual(out[0].skipped, [{ title: 'Brainstorming skill', why: SKILL_TOO_LONG }])
})

test('the missing skill joins what the context left out, after it, and the run log keeps it', async () => {
  const logged = []
  const gather = async () => ({ parts: [{ title: 'Notes', text: 'a note' }], skipped: [{ title: 'Live session', why: 'It ended.' }] })
  const url = await serve({ skill: () => null, gather, log: e => logged.push(e) })
  const { out } = await send(url)
  assert.deepEqual(out[0].used, [{ title: 'Notes', chars: 6 }])
  assert.deepEqual(out[0].skipped, [{ title: 'Live session', why: 'It ended.' }, plain(SKILL_MISSING)])
  await until(() => logged.length === 1)
  assert.deepEqual(plain(logged[0].context.skipped).at(-1), plain(SKILL_MISSING))
})

test('no finder (the default): nothing is checked, no line, and generate gets no skill', async () => {
  const url = await serve({})
  const { run, out } = await send(url)
  assert.equal(run.opts.skill ?? null, null)
  assert.deepEqual(out.map(l => l.type), ['delta', 'done'])
})

test('the server asks the real finder, and npm run check covers the new file', async () => {
  const fs = await import('node:fs')
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(server, /import \{ findSkill \} from '\.\/script-skill\.mjs'/)
  assert.match(server, /makeScriptRoute\(\{ port: PORT,[^\n]*skill: findSkill \}\)/)
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.checkList.includes('node --check script-skill.mjs'))
})
