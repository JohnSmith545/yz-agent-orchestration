// Tests for the chat turn's argv and brief in chat.mjs, and its two start
// modes (a light fresh session by default, or a fork of forkFrom). Nothing here
// spawns Claude: chatArgs and chatBrief are pure, and turnPlan only reads the
// state. FACTORY_DATA_DIR points at a fresh temp folder BEFORE the import, so
// chatNew writes its state and transcript there, never into data/.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'))
const { chatArgs, chatBrief, chatNew, chatStatus, turnPlan, ALLOWED } = await import('../chat.mjs')
const { writeState, STATE_FILE } = await import('../factory-state.mjs')
const { CONFIG } = await import('../config.mjs')
/** The mode a chat with no session starts in, from the checkout's config (fork only with a forkFrom): the tests never assume it. */
const CONFIGURED = CONFIG.factory.chat.mode === 'fork' && CONFIG.factory.chat.forkFrom ? 'fork' : 'brief'
after(() => fs.rmSync(process.env.FACTORY_DATA_DIR, { recursive: true, force: true }))
/** The factory CLI the brief and the Bash rule name: absolute, forward slashes. */
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'factory.mjs').replace(/\\/g, '/')

test('chatArgs names the built-ins in --tools and pre-approves the allow list last', () => {
  const args = chatArgs('m1', ['--resume', 's1'], 'the brief')
  assert.deepEqual(args.slice(0, args.indexOf('--tools')), [
    '-p', '--model', 'm1', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--resume', 's1', '--append-system-prompt', 'the brief',
  ])
  const at = args.indexOf('--tools')
  assert.deepEqual(args.slice(at, at + 2), ['--tools', 'Read,Grep,Glob,Bash,ListAgents,SendMessage'])
  // --allowedTools is variadic, so it comes last; the message goes on stdin.
  assert.deepEqual(args.slice(args.indexOf('--allowedTools')), ['--allowedTools', ...ALLOWED])
})

test('chatArgs denies the Playwright tool that runs code in the browser server, before the allow list', () => {
  const args = chatArgs('m1', [], 'the brief')
  const deny = args.indexOf('--disallowedTools')
  assert.ok(deny >= 0)
  assert.deepEqual(args.slice(deny, deny + 2), ['--disallowedTools', 'mcp__playwright__browser_run_code_unsafe'])
  assert.ok(deny < args.indexOf('--allowedTools'))
})

test('git branch is allowed only in its read-only forms', () => {
  assert.ok(!ALLOWED.some(r => r.startsWith('Bash(git branch:')))
  for (const r of ['Bash(git branch --list:*)', 'Bash(git branch -a)', 'Bash(git branch -a --list:*)', 'Bash(git branch --show-current)']) assert.ok(ALLOWED.includes(r), r)
  // A prefix rule on `-a` would also pass `git branch -a -d <name>` or other flags after it.
  assert.ok(!ALLOWED.includes('Bash(git branch -a:*)'))
  assert.deepEqual(ALLOWED.filter(r => r.startsWith('Bash(git branch')).sort(),
    ['Bash(git branch --list:*)', 'Bash(git branch --show-current)', 'Bash(git branch -a --list:*)', 'Bash(git branch -a)'])
})

test('no git fetch or git grep: their flags can run a program (--upload-pack, -O); Grep and Read cover search', () => {
  assert.ok(!ALLOWED.some(r => r.startsWith('Bash(git fetch')), 'git fetch')
  assert.ok(!ALLOWED.some(r => r.startsWith('Bash(git grep')), 'git grep')
  assert.ok(ALLOWED.includes('Grep') && ALLOWED.includes('Read'))
})

test('the allow list adds Playwright and keeps Bash to read-only git and the factory CLI', () => {
  assert.ok(ALLOWED.includes('mcp__playwright__*'))
  assert.ok(ALLOWED.includes(`Bash(node ${cli}:*)`))
  for (const rule of ALLOWED.filter(r => r.startsWith('Bash'))) assert.match(rule, /^Bash\((git [a-z -]+(:\*)?|node \S+factory\.mjs:\*)\)$/)
  // No write rule: allow rules never grant a write in a headless turn, and acceptEdits would open the repo.
  assert.ok(!ALLOWED.some(r => /^(Write|Edit)\b/.test(r)))
  assert.ok(!chatArgs('m', [], 'b').includes('--permission-mode'))
})

test('the brief carries the flow paragraph verbatim with the absolute CLI path, and no decide', () => {
  const b = chatBrief()
  assert.ok(b.includes(
    `Narrate your work on the dashboard as a flow: \`node ${cli} flow …\`. Start with \`flow new\` or \`flow write\` ` +
    'before you change anything, keep statuses current with `flow status`, attach proof with `flow evidence` (the commit sha, ' +
    'a test line, a screenshot), and put any choice that is the user\'s as `flow ask` instead of asking in prose, then stop ' +
    'at that step: the answer arrives as a message. Never act on another system (a tracker, a live site, a deploy) before ' +
    'the ask is answered Yes.'
  ), b)
  assert.ok(b.includes('Record review marks with mark; when you check something for the user, put it in a flow as a check node with evidence.'))
  assert.ok(b.includes('Screenshots: take them with the Playwright screenshot tool, then flow evidence --shot <the file it saved>.'))
  assert.doesNotMatch(b, /\bdecide\b/)
  assert.match(b, /mark ABC-123 reviewed --verdict check/)
  assert.match(b, /SendMessage/)
})

test('the brief names the Ask drawer and the Tickets and Flows pages, not the old Factory page', () => {
  const b = chatBrief()
  assert.match(b, /the Ask drawer/)
  assert.match(b, /#\/tickets/)
  assert.match(b, /#\/flows/)
  assert.doesNotMatch(b, /#\/factory|Factory page/)
})

// ═══ the two start modes: light (brief) by default, fork as a choice ═══

/** Index of `seq` as a contiguous run inside `args`, or -1. */
const runAt = (args, seq) => args.findIndex((_, i) => seq.every((x, j) => args[i + j] === x))

test('brief mode with no session never forks', () => {
  for (const args of [chatArgs('m', [], 'the brief', { mode: 'brief', forkFrom: 'F1' }), chatArgs('m', [], 'the brief')]) {
    assert.ok(!args.includes('--fork-session'))
    assert.ok(!args.includes('--resume'))
    assert.ok(!args.includes('F1'))
    // the brief is the system prompt, so a fresh session still knows the drawer, the CLI and the tools
    assert.ok(runAt(args, ['--append-system-prompt', 'the brief']) >= 0)
  }
})

test('fork mode with no session forks forkFrom', () => {
  const args = chatArgs('m', [], 'the brief', { mode: 'fork', forkFrom: 'F1' })
  const at = runAt(args, ['--resume', 'F1', '--fork-session'])
  assert.ok(at >= 0, args.join(' '))
  assert.ok(at < args.indexOf('--append-system-prompt'))
  assert.ok(runAt(args, ['--append-system-prompt', 'the brief']) >= 0)
})

test('fork mode with no forkFrom starts a fresh session instead', () => {
  const args = chatArgs('m', [], 'the brief', { mode: 'fork', forkFrom: '' })
  assert.ok(!args.includes('--fork-session'))
  assert.ok(!args.includes('--resume'))
})

test('a session id resumes itself in both modes', () => {
  for (const mode of ['brief', 'fork']) {
    const args = chatArgs('m', ['--resume', 's1'], 'the brief', { mode, forkFrom: 'F1' })
    assert.ok(runAt(args, ['--resume', 's1']) >= 0, mode)
    assert.ok(!args.includes('--fork-session'), mode)
    assert.ok(!args.includes('F1'), mode)
  }
})

test('chatNew({ fork: true }) makes exactly the next send fork', () => {
  chatNew({ fork: true })
  assert.equal(chatStatus().nextFork, true)
  const plan = turnPlan()
  assert.equal(plan.mode, 'fork')
  assert.deepEqual(plan.resume, [])
  assert.equal(chatStatus().nextFork, false)
  // the send after it is back to the configured mode
  assert.equal(turnPlan().mode, chatStatus().mode)
})

test('a plain chatNew drops a fork that was chosen but not used', () => {
  chatNew({ fork: true })
  chatNew()
  assert.equal(chatStatus().nextFork, false)
  assert.equal(turnPlan().mode, chatStatus().mode)
})

test('with no session the mode is the configured one (light unless the config says fork), and chatStatus carries it', () => {
  chatNew()
  const s = chatStatus()
  assert.equal(s.mode, CONFIGURED)
  assert.equal(s.nextFork, false)
  assert.equal(s.sessionId, '')
})

test('a running session keeps the mode it started in, and resumes its own id', () => {
  writeState({ marks: {}, chat: { sessionId: 's1', mode: 'fork' } })
  assert.equal(chatStatus().mode, 'fork')
  assert.deepEqual(turnPlan().resume, ['--resume', 's1'])
  // New chat ends it: the label goes back to the configured mode
  chatNew()
  assert.equal(chatStatus().mode, CONFIGURED)
  assert.equal(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).chat.sessionId, '')
})

test('a session from before the modes counts as forked when forkFrom is set (every chat forked then)', () => {
  writeState({ marks: {}, chat: { sessionId: 's0' } })
  assert.equal(chatStatus().mode, chatStatus().forkFrom ? 'fork' : 'brief')
  chatNew()
})

test('state and transcript live under FACTORY_DATA_DIR, never in the repo data folder', () => {
  assert.ok(STATE_FILE.startsWith(process.env.FACTORY_DATA_DIR), STATE_FILE)
  chatNew()
  assert.ok(fs.existsSync(path.join(process.env.FACTORY_DATA_DIR, 'chat-log.json')))
})

// ═══ the turn cost (spec F4, spend.mjs) ═══

test('the result event records the turn cost as chat spend, once per turn, and only when it is a number', async () => {
  const { onEvent } = await import('../chat.mjs')
  const { readSpend } = await import('../spend.mjs')
  const before = readSpend().byKind.chat
  onEvent({ type: 'result', total_cost_usd: 0.4412 })
  assert.ok(Math.abs(readSpend().byKind.chat - before - 0.4412) < 1e-9)
  onEvent({ type: 'result', total_cost_usd: 0.4412 }) // a second result in the same turn
  assert.ok(Math.abs(readSpend().byKind.chat - before - 0.4412) < 1e-9)
})

test('a resumed session reports its running total, so each turn records only its own delta, and New chat resets the base', async () => {
  const { onEvent, beginTurn } = await import('../chat.mjs')
  const { readSpend } = await import('../spend.mjs')
  const { readState } = await import('../factory-state.mjs')
  const spent = () => readSpend().byKind.chat
  chatNew()
  onEvent({ type: 'system', subtype: 'init', session_id: 'run-1' })
  let before = spent()
  beginTurn()
  onEvent({ type: 'result', total_cost_usd: 0.44 })
  assert.ok(Math.abs(spent() - before - 0.44) < 1e-9, 'the first turn is its whole total')
  before = spent()
  beginTurn()
  onEvent({ type: 'system', subtype: 'init', session_id: 'run-1' }) // the same session resumed: the base stays
  onEvent({ type: 'result', total_cost_usd: 0.6 })
  assert.ok(Math.abs(spent() - before - 0.16) < 1e-9, `the second turn is 0.60 - 0.44, got ${spent() - before}`)
  assert.equal(readState().chat.costTotal, 0.6)

  chatNew()
  assert.equal(readState().chat.costTotal, 0)
  before = spent()
  beginTurn()
  onEvent({ type: 'system', subtype: 'init', session_id: 'run-2' })
  onEvent({ type: 'result', total_cost_usd: 0.3 })
  assert.ok(Math.abs(spent() - before - 0.3) < 1e-9, 'a new chat starts from 0')
})

test('a new session id from init resets the base, and a total below the base counts whole', async () => {
  const { onEvent, beginTurn } = await import('../chat.mjs')
  const { readSpend } = await import('../spend.mjs')
  const { writeState, readState } = await import('../factory-state.mjs')
  const spent = () => readSpend().byKind.chat
  writeState({ marks: {}, chat: { sessionId: 'old', mode: 'brief', costTotal: 5 } })
  let before = spent()
  beginTurn()
  onEvent({ type: 'system', subtype: 'init', session_id: 'fresh' })
  assert.equal(readState().chat.costTotal, 0)
  onEvent({ type: 'result', total_cost_usd: 0.5 })
  assert.ok(Math.abs(spent() - before - 0.5) < 1e-9)
  // a session whose total came back lower than the base (its saved cost was not restored)
  writeState({ marks: {}, chat: { sessionId: 'fresh', mode: 'brief', costTotal: 2 } })
  before = spent()
  beginTurn()
  onEvent({ type: 'result', total_cost_usd: 0.25 })
  assert.ok(Math.abs(spent() - before - 0.25) < 1e-9)
  assert.equal(readState().chat.costTotal, 0.25)
  chatNew()
})

// ═══ a stale session heals itself (the stored id no longer exists in Claude's files) ═══

import { EventEmitter } from 'node:events'

/** A spawn stub: each call plays the next script against a fake child, and records argv and stdin. */
function fakeSpawner(scripts) {
  const calls = []
  const spawn = (bin, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => child.emit('close', null, 'SIGTERM')
    const call = { args, stdin: null }
    calls.push(call)
    const script = scripts[calls.length - 1] || scripts.at(-1)
    child.stdin = { end: text => { call.stdin = text; setImmediate(() => script(child)) } }
    return child
  }
  return { spawn, calls }
}
const line = o => JSON.stringify(o) + '\n'
const stale = child => {
  child.stderr.emit('data', 'Error: No conversation found with session ID: gone-1\n')
  child.emit('close', 1, null)
}
const fresh = sid => child => {
  child.stdout.emit('data', line({ type: 'system', subtype: 'init', session_id: sid }))
  child.stdout.emit('data', line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }))
  child.stdout.emit('data', line({ type: 'result', total_cost_usd: 0.05 }))
  child.emit('close', 0, null)
}
/** Resolves once the transcript has `n` more done lines than it had at the start. */
async function doneAfter(chatLog, n) {
  const start = chatLog().log.filter(e => e.role === 'done').length
  return async () => {
    for (let i = 0; i < 200; i++) {
      if (chatLog().log.filter(e => e.role === 'done').length >= start + n) return
      await new Promise(r => setTimeout(r, 5))
    }
    throw new Error('no done line')
  }
}

test('a turn whose stored session is gone clears it and re-runs the same message once, fresh and light', async () => {
  const { chatSend, chatLog, setRunner } = await import('../chat.mjs')
  const { readState } = await import('../factory-state.mjs')
  const { spawn, calls } = fakeSpawner([stale, fresh('new-1')])
  setRunner({ spawn, bin: async () => 'claude' })
  writeState({ marks: {}, chat: { sessionId: 'gone-1', mode: 'fork', costTotal: 7 } })
  const wait = await doneAfter(chatLog, 1)
  const from = chatLog().log.length
  await chatSend('Reply with ok.')
  await wait()
  assert.equal(calls.length, 2)
  assert.ok(runAt(calls[0].args, ['--resume', 'gone-1']) >= 0)
  assert.ok(!calls[1].args.includes('--resume'), 'the retry starts a fresh session')
  assert.ok(!calls[1].args.includes('--fork-session'), 'never an automatic fork')
  assert.deepEqual(calls.map(c => c.stdin), ['Reply with ok.', 'Reply with ok.'])
  const added = chatLog().log.slice(from)
  assert.equal(added.filter(e => e.role === 'user').length, 1, 'the message shows once')
  assert.ok(added.some(e => e.role === 'meta' && e.text === 'The old conversation was gone, so this is a new one.'))
  assert.ok(!added.some(e => e.role === 'error'), 'the stale failure is not shown as an error')
  assert.equal(added.filter(e => e.role === 'done').length, 1)
  assert.equal(readState().chat.sessionId, 'new-1')
  assert.equal(readState().chat.mode, 'brief')
  assert.equal(readState().chat.costTotal, 0.05, 'the old base was cleared, so the new turn counts whole')
})

test('a stale session is retried once only: a second failure is shown, never looped', async () => {
  const { chatSend, chatLog, setRunner } = await import('../chat.mjs')
  const { spawn, calls } = fakeSpawner([stale, stale])
  setRunner({ spawn, bin: async () => 'claude' })
  writeState({ marks: {}, chat: { sessionId: 'gone-1', mode: 'brief', costTotal: 0 } })
  const wait = await doneAfter(chatLog, 1)
  const from = chatLog().log.length
  await chatSend('Again.')
  await wait()
  assert.equal(calls.length, 2)
  const added = chatLog().log.slice(from)
  assert.equal(added.filter(e => e.role === 'error').length, 1)
  assert.match(added.find(e => e.role === 'error').text, /No conversation found/)
})

test('the same message in a result error also counts as a gone session; a fresh turn never retries', async () => {
  const { chatSend, chatLog, chatNew, setRunner } = await import('../chat.mjs')
  const viaResult = child => {
    child.stdout.emit('data', line({ type: 'result', is_error: true, result: 'No conversation found with session ID: gone-2' }))
    child.emit('close', 1, null)
  }
  let r = fakeSpawner([viaResult, fresh('new-2')])
  setRunner({ spawn: r.spawn, bin: async () => 'claude' })
  writeState({ marks: {}, chat: { sessionId: 'gone-2', mode: 'brief', costTotal: 0 } })
  let wait = await doneAfter(chatLog, 1)
  await chatSend('One.')
  await wait()
  assert.equal(r.calls.length, 2)

  chatNew()
  r = fakeSpawner([stale])
  setRunner({ spawn: r.spawn, bin: async () => 'claude' })
  wait = await doneAfter(chatLog, 1)
  await chatSend('Two.')
  await wait()
  assert.equal(r.calls.length, 1, 'a turn that resumed nothing has no stale session to drop')
})

test('chatStatus says whether the last reply ended with a question, and when the last message was', async () => {
  const { onEvent, chatStatus: status } = await import('../chat.mjs')
  chatNew()
  assert.equal(status().asked, false)
  onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Shall I deploy it to dev?' }] } })
  assert.equal(status().asked, true)
  assert.ok(Date.parse(status().lastAt) <= Date.now())
  onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done. It is on dev.' }] } })
  assert.equal(status().asked, false)
  onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Which one?  ' }] } })
  assert.equal(status().asked, true)
  chatNew()
  assert.equal(status().asked, false, 'a new chat has asked nothing')
})

// ═══ a turn that writes a flow hands the drawer an Open flow button ═══

test('changedFlows lists the flows that are new or whose updatedAt moved, never the untouched or removed', async () => {
  const { changedFlows } = await import('../chat.mjs')
  const before = [{ id: 'a', title: 'A', updatedAt: 't1' }, { id: 'b', title: 'B', updatedAt: 't1' }, { id: 'gone', title: 'G', updatedAt: 't1' }]
  const after = [{ id: 'new', title: 'New one', updatedAt: 't3' }, { id: 'b', title: 'B renamed', updatedAt: 't2' }, { id: 'a', title: 'A', updatedAt: 't1' }]
  assert.deepEqual(changedFlows(before, after), [{ id: 'new', title: 'New one' }, { id: 'b', title: 'B renamed' }])
  assert.deepEqual(changedFlows(after, after), [])
  assert.deepEqual(changedFlows(undefined, [{ id: 'x', title: '', updatedAt: 't' }]), [{ id: 'x', title: '' }])
})

test('the done line of a turn that wrote a flow carries it; a turn that wrote none carries no flows', async () => {
  const { chatSend, chatLog, chatNew: reset, setRunner } = await import('../chat.mjs')
  const F = await import('../flows.mjs')
  reset()
  const writesFlow = child => {
    const flow = F.createFlow({ id: 'turn-flow', title: 'Check the <b>login</b>', agent: 'Independent' })
    F.writeFlow(flow)
    fresh('flow-1')(child)
  }
  let r = fakeSpawner([writesFlow])
  setRunner({ spawn: r.spawn, bin: async () => 'claude' })
  let wait = await doneAfter(chatLog, 1)
  await chatSend('Check the login and show me.')
  await wait()
  let done = chatLog().log.filter(e => e.role === 'done').at(-1)
  assert.deepEqual(done.flows, [{ id: 'turn-flow', title: 'Check the <b>login</b>' }])

  r = fakeSpawner([fresh('flow-1')])
  setRunner({ spawn: r.spawn, bin: async () => 'claude' })
  wait = await doneAfter(chatLog, 1)
  await chatSend('Thanks.')
  await wait()
  done = chatLog().log.filter(e => e.role === 'done').at(-1)
  assert.equal(done.flows, undefined)
})

test('the brief tells Independent to narrate real work as a flow with evidence and screenshots', () => {
  const b = chatBrief()
  assert.ok(b.includes('For any request that is work, not a one-line answer, narrate it as a flow with evidence'), b)
  assert.match(b, /flow evidence <flow> <node> --shot/)
  assert.match(b, /Open flow button/)
})

test('the brief tells Independent to record the Output of finished work, and what a request for test steps means', () => {
  const b = chatBrief()
  assert.ok(b.includes('When a piece of work is finished, record its output: a result screenshot (`flow result`), a short summary with the commits (`flow summary`), and manual test steps with a screenshot each (`flow test-step`).'), b)
  assert.match(b, /node \S+factory\.mjs flow result <flow> --shot <file>/)
  assert.match(b, /node \S+factory\.mjs flow summary <flow> "<markdown>" --commit <sha>/)
  assert.match(b, /node \S+factory\.mjs flow test-step <flow> "<do this>" --expect "<you should see>" --shot <file>/)
  assert.ok(b.includes('A message asking for manual test steps means: drive the app with Playwright, capture a screenshot at each step, and record each one with `flow test-step`.'), b)
})

test('the brief says every flow needs a visual, a screenshot for UI work and a high-level diagram for the rest, with one worked line', () => {
  const b = chatBrief()
  assert.ok(b.includes('Every flow needs a visual; a flow with neither is unfinished: for UI work a result screenshot (`flow result --shot`), ' +
    'for anything else (an API, a job, a deploy, an investigation) a diagram of how it works (`flow diagram`), the big picture only'), b)
  assert.match(b, /at most 8 boxes/)
  assert.match(b, /node \S+factory\.mjs flow diagram <flow> "\[actor\] User -> Page: clicks; Page -> \[store\] Storage: saves"/)
  assert.match(b, /`flow diagram <flow> "\[actor\] Scheduler -> Report job: every night; Report job -> \[store\] Reports: saves"`/)
  const brief = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'agent-brief.md'), 'utf8')
  assert.match(brief, /Every flow needs a visual/)
  assert.match(brief, /flow diagram acme-report "\[actor\] Scheduler -> Report job: every night/)
})

test('the agent brief users paste says the same two sentences about the Output', () => {
  const brief = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'agent-brief.md'), 'utf8')
  assert.match(brief, /When a piece of work is finished, record its output: a result screenshot \(`flow result`\), a short summary with the commits\s+> \(`flow summary`\), and manual test steps with a screenshot each \(`flow test-step`\)\./)
})

test('the chat brief and the agent brief say test steps go one command at a time, and that flow write keeps the output it leaves out', () => {
  const brief = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'agent-brief.md'), 'utf8').replace(/\s*\n>?\s*/g, ' ')
  for (const text of [chatBrief(), brief]) {
    assert.ok(text.includes('Record test steps one command at a time, never in parallel'), text)
    assert.ok(text.includes('A `flow write` file with no `output` keeps the stored one; `"output": {}` clears it.'), text)
  }
})

test('the chat brief and the agent brief carry the plain writing rule, the say commands with a two-line example, and term', () => {
  const brief = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'agent-brief.md'), 'utf8').replace(/\s*\n>?\s*/g, ' ')
  const rule = 'Write for a reader who was not there. Say who did what in one short plain sentence, then why. Not a commit message: no file names, no flags, no ticket ids in the sentence. ' +
    'Use the right technical word, and put it in square brackets the first time, like [idempotency], so the dashboard can explain it. If the word is unusual, define it yourself with `term`.'
  for (const text of [chatBrief(), brief]) {
    assert.ok(text.includes(rule), text)
    assert.match(text, /flow say \S+ "[^"]+" --why "[^"]+"/)
    assert.match(text, /flow say-clear/)
    assert.match(text, /term "[^"]+" "[^"]+"/)
  }
  assert.match(chatBrief(), /glossary\.json/)
})
