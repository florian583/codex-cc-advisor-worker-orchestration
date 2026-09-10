#!/usr/bin/env node
// Prints a mergeable fragment; never writes the caller's settings.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const hook = (name) => ({
  type: 'command',
  command: `${quote(process.execPath)} ${quote(join(root, 'codex-hooks', name))}`,
  timeout: 5,
})
console.log(
  JSON.stringify(
    {
      hooks: {
        SessionStart: [{ matcher: 'startup|resume', hooks: [hook('session-start.mjs')] }],
        UserPromptSubmit: [{ hooks: [hook('prompt-notice.mjs')] }],
        Stop: [{ hooks: [hook('stop.mjs')] }],
      },
    },
    null,
    2,
  ),
)
