// The Brainstorming page's model turn (#/brainstorming, public/script-page.js): ONE headless
// Claude Code turn that turns the user's rough idea into a prompt with six labelled
// sections (Situation, Character, Request, Intent, Presentation, Tone), streamed.
// (The page was called SCRIPT; its files, routes and names here keep that word, see shell.js.)
//
// The brainstorming skill (/superpowers:brainstorming), when script-skill.mjs finds it installed.
// Measured on 2.1.330 against the same local stub (2026-11-25):
// - It is invoked the SUPPORTED way: the plugin is loaded for this run with `--plugin-dir`
//   (`--setting-sources ""` loads no installed plugin), and stdin starts with its slash command.
//   In -p mode the CLI expands that into the skill's text in the user turn, in the SAME request:
//   no Skill tool, no tool round trip, so `--tools ""` stays and the run still cannot write a
//   file or run a command. The skill's text is read by the CLI from the plugin, never copied here.
// - `--settings {"disableAllHooks":true}`: without it the plugin's SessionStart hook added a
//   second whole skill (using-superpowers, about 4,500 characters) to every run.
// - ⚠️ The CLI sends the text after the slash command TWICE (as the command's arguments and again
//   after the skill), so attached context costs about double its input tokens. Measured costs are
//   in the README. Sending the command and the text as two content blocks, or as two messages,
//   was tried: the first is not expanded, the second is two paid turns.
// - The system prompt then carries SKILL_MAPPING (script-prompt.mjs): how the skill's steps map
//   onto one turn whose deliverable is the six-part prompt. Without the skill the run is the
//   built-in rules alone, and the route says so in one Left out line (SKILL_MISSING).
//
// Rules this file keeps:
// - It goes through the Claude Code CLI (claudeBin), like the chat, never the raw API:
//   there is no API key on this machine. Opus 5.5 at high effort, the user's own
//   system prompt (script-prompt.mjs) with --system-prompt, so Claude Code's default
//   one is replaced, not added to.
// - ⚠️ A CLEAN run. Measured on 2.1.330 by pointing the CLI at a local stub that
//   recorded each request body (2026-11-24):
//   - `--tools ""` removes every built-in and `--strict-mcp-config` (no --mcp-config)
//     loads no MCP server, as explain.mjs does.
//   - `--setting-sources ""` loads no user, project or local settings. Without it the
//     turn carried the user's ~/.claude/CLAUDE.md and a plugin's SessionStart hook text
//     (a whole skill). With it, both were gone. `--safe-mode` added nothing on top,
//     and `--exclude-dynamic-system-prompt-sections` is ignored with --system-prompt.
//   - `--name SCRIPT` names the session, which stops the CLI's own session-title call
//     (a SECOND Opus request on every run, paid for).
//   - It runs in a fresh empty folder under os.tmpdir(), removed afterwards, so no
//     project CLAUDE.md is found and there is no project memory. `--no-session-persistence`
//     saves nothing.
//   What still rides along, and cannot be turned off by a flag: the CLI's environment
//   note (the temp folder, the OS, today's date) and the signed-in account's email.
// - The user's text goes on stdin (as chat.mjs does), never in argv: long text, quotes
//   and newlines are safe there on Windows.
// - `generate` never rejects. Its `done` resolves { ok, stopReason, cost } or
//   { error, cost?, stopReason?, cancelled? } with a calm plain message (MESSAGES).
// - No output for `idleMs` (2 minutes) kills the child: thinking counts as output,
//   since every stdout chunk resets the timer.
// - The turn's total_cost_usd is recorded ONCE as `script` spend (spend.mjs), failed
//   turns included: a turn that errored after it ran was still paid for.
// - spawn, bin, record and the temp folder are injected, so tests never spawn Claude.

import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { claudeBin } from './claude-cli.mjs'
import { systemPrompt } from './script-prompt.mjs'
import { SKILL } from './script-skill.mjs'
import { recordCost } from './spend.mjs'

/** The plugin's SessionStart hook would add a second whole skill (using-superpowers) to every run. */
const SKILL_SETTINGS = '{"disableAllHooks":true}'

export const SCRIPT_MODEL = 'claude-opus-5-5'
export const SCRIPT_EFFORT = 'high'
export const SCRIPT_MAX = 8000
export const SCRIPT_IDLE_MS = 120_000
const DETAIL_CAP = 160

/** What the page shows when a run fails. Plain, calm, no blame. */
export const MESSAGES = Object.freeze({
  missing: 'Claude Code was not found on this machine, so nothing was sent.',
  failed: 'The model run stopped before it finished. Try again in a moment.',
  refusal: 'The model chose not to write this one. Try describing the task differently.',
  timeout: 'No reply for 2 minutes, so the run was stopped. Try again.',
  cancelled: 'Stopped.',
})

const usable = skill => typeof skill?.pluginDir === 'string' && skill.pluginDir !== ''

/**
 * The argv of one run: headless, streamed, no tools, no MCP, no settings, no session. The text goes on stdin.
 * With `skill` ({ pluginDir }, script-skill.mjs) the plugin is loaded for this run only, with its hooks off,
 * and the system prompt carries the skill's mapping onto the page.
 */
export function scriptArgs(skill = null) {
  const withSkill = usable(skill)
  return [
    '-p', '--model', SCRIPT_MODEL, '--effort', SCRIPT_EFFORT, '--system-prompt', systemPrompt(withSkill),
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--name', 'SCRIPT',
    ...(withSkill ? ['--plugin-dir', skill.pluginDir, '--settings', SKILL_SETTINGS] : []),
  ]
}

/** What goes on stdin: the text, after the skill's slash command when the run invokes the skill. */
export const stdinFor = (text, skill = null) => (usable(skill) ? `/${SKILL} ${text}` : text)

/** '' when `text` can be sent, else the reason in plain words. */
export function checkText(text) {
  if (typeof text !== 'string' || !text.trim()) return 'Write a few words about the task first.'
  if (text.length > SCRIPT_MAX) return `That is over ${SCRIPT_MAX} characters. Shorten it a little.`
  return ''
}

/**
 * One stream-json event as what the run cares about: { delta } for a text delta, { stop } for a
 * stop reason, { result } for the final result, or null for anything else (thinking, init, tools).
 */
export function readEvent(e) {
  if (!e || typeof e !== 'object') return null
  if (e.type === 'stream_event') {
    const ev = e.event
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') return { delta: ev.delta.text }
    if (ev?.type === 'message_delta' && typeof ev.delta?.stop_reason === 'string') return { stop: ev.delta.stop_reason }
    return null
  }
  if (e.type === 'result') {
    return {
      result: {
        cost: typeof e.total_cost_usd === 'number' && Number.isFinite(e.total_cost_usd) ? e.total_cost_usd : null,
        isError: e.is_error === true,
        stopReason: typeof e.stop_reason === 'string' ? e.stop_reason : null,
        text: typeof e.result === 'string' ? e.result : '',
      },
    }
  }
  return null
}

const firstLine = s => String(s || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || ''
const withDetail = (msg, detail) => {
  const d = firstLine(detail).slice(0, DETAIL_CAP)
  return d ? `${msg} (${d})` : msg
}

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'script-gen-'))
}
function dropDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* a folder Windows still holds is left for the OS to clean */
  }
}

/**
 * Run one generation for `text` (already checked). `onDelta(text)` hears each text delta as it
 * arrives. Returns { done, cancel }: `done` resolves once the child has closed (never rejects),
 * `cancel()` kills it (the browser went away). `skill` ({ pluginDir } from script-skill.mjs, or null)
 * makes the run invoke the brainstorming skill.
 */
export function generate(text, {
  onDelta = () => {}, spawn = nodeSpawn, bin = claudeBin, record = recordCost,
  idleMs = SCRIPT_IDLE_MS, makeDir = tempDir, removeDir = dropDir, skill = null,
} = {}) {
  let child = null
  let cancelled = false
  let timedOut = false
  let finish
  const done = new Promise(resolve => (finish = resolve))
  const kill = () => {
    try {
      child?.kill()
    } catch {
      /* already gone */
    }
  }
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    if (child) kill()
    else finish({ error: MESSAGES.cancelled, cancelled: true })
  }

  void (async () => {
    let binPath
    try {
      binPath = await bin()
    } catch {
      return finish({ error: MESSAGES.missing })
    }
    if (cancelled) return finish({ error: MESSAGES.cancelled, cancelled: true })
    let dir = ''
    try {
      dir = makeDir()
      child = spawn(binPath, scriptArgs(skill), { cwd: dir, windowsHide: true, env: { ...process.env } })
    } catch {
      if (dir) removeDir(dir)
      return finish({ error: MESSAGES.missing })
    }

    let buf = ''
    let errText = ''
    let sawDelta = false
    let stop = null
    let result = null
    let spawnFailed = false
    let timer = null
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        kill()
      }, idleMs)
      timer.unref?.()
    }
    const say = t => {
      try {
        onDelta(t)
      } catch {
        /* the listener went away; the run still finishes and is still recorded */
      }
    }
    const take = e => {
      const r = readEvent(e)
      if (r?.delta !== undefined) {
        sawDelta = true
        return say(r.delta)
      }
      if (r?.stop) stop = r.stop
      if (r?.result && !result) {
        result = r.result
        record('script', result.cost)
        return
      }
      // An older CLI without partial messages: the whole reply arrives once, as the assistant message.
      if (e?.type === 'assistant' && !sawDelta) {
        const whole = (e.message?.content || []).filter(c => c?.type === 'text').map(c => c.text).join('')
        if (whole) say(whole)
      }
    }
    arm()
    child.stdout.on('data', d => {
      arm()
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let e
        try {
          e = JSON.parse(line)
        } catch {
          continue // a warning line, not an event
        }
        take(e)
      }
    })
    child.stderr.on('data', d => {
      arm()
      errText += d
    })
    child.on('error', err => {
      if (err?.code === 'ENOENT') spawnFailed = true
      else errText += `\n${err?.message || err}`
    })
    child.on('close', code => {
      clearTimeout(timer)
      removeDir(dir)
      const cost = result?.cost ?? undefined
      const stopReason = result?.stopReason || stop || null
      const base = cost == null ? {} : { cost }
      if (spawnFailed) return finish({ error: MESSAGES.missing })
      if (cancelled) return finish({ ...base, error: MESSAGES.cancelled, cancelled: true })
      if (timedOut) return finish({ ...base, error: MESSAGES.timeout })
      if (stopReason === 'refusal') return finish({ ...base, error: MESSAGES.refusal, stopReason })
      if (result?.isError) return finish({ ...base, error: withDetail(MESSAGES.failed, result.text) })
      if (code !== 0 || !result) return finish({ ...base, error: withDetail(MESSAGES.failed, errText) })
      finish({ ok: true, stopReason, cost: result.cost })
    })
    child.stdin.end(stdinFor(text, skill))
  })()

  return { done, cancel }
}
