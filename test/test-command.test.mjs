// What counts as a test or check run ("Testing" on an agent card): the common
// runners by name, at the start of a step of the command line. A project's own
// script names (pnpm <area>:test) are not guessed at.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { isTestCommand } = await import('../transcripts.mjs')

test('the common runners count, also after cd x &&', () => {
  for (const c of ['npm test', 'npm run test', 'pnpm test', 'pnpm run lint', 'npx vitest run', 'tsc --noEmit', 'cd app && flutter test', 'dart test', 'pnpm --filter api test'])
    assert.equal(isTestCommand(c), true, c)
})

test('a project script name, a grep or a heredoc that mentions a runner does not count', () => {
  for (const c of ['pnpm mobile:test', 'pnpm mobile:analyze', 'grep -rn vitest src', 'cat <<EOF\nnpm test\nEOF', 'git log'])
    assert.equal(isTestCommand(c), false, c)
})
