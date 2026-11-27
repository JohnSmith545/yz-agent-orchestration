#!/usr/bin/env node
// A Claude Code Notification, PermissionRequest and Stop hook (the VS Code extension sends no Notification): records that a session stopped to wait on the user (a permission prompt, or an
// idle prompt after a reply that asked something) in data/waiting/<session>.json, for the dashboard to show (waiting.mjs).
// The hook runs this with its JSON on stdin:
//
//   { "session_id", "transcript_path", "cwd", "hook_event_name", "notification_type", "message", "tool_name", "last_assistant_message" }
//
// It FAILS OPEN: bad input, an unreadable transcript or any error ends with exit code 0 and no output, so a broken
// recorder never gets in a session's way. It prints nothing, ever.

import { lastReplyText, nextWait, pruneWaits, readWaits, resumedIn, tailFrom, waitKind, writeWait } from '../waiting.mjs' // the wait rules and the files

// Reads stdin and records the wait when there is one.
async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = JSON.parse(raw)
  if (!input?.session_id || !input.transcript_path) return
  const tail = tailFrom(input.transcript_path)
  if (!tail) return
  const wait = waitKind(input, lastReplyText(tail.text))
  if (!wait) return
  // the same wait recorded again (Stop, then an idle prompt) keeps its first time, so the page alerts once
  const prev = readWaits()[input.session_id]
  const since = prev?.transcript === input.transcript_path ? tailFrom(prev.transcript, prev.size) : null
  const entry = nextWait(prev, input, wait, { size: tail.size, prevResumed: !since || resumedIn(since.text, prev.kind) })
  if (entry) writeWait(input.session_id, entry)
  pruneWaits()
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
