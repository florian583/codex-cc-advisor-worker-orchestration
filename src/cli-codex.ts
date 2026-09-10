#!/usr/bin/env bun

// Codex CLI wrapper mirroring the Claude advisor/worker wrapper. Extracts role
// flags (--worker / --advisor / --role <name>), then launches `codex`
// with the orchestration MCP server enabled for this invocation and the role pinned
// into the environment (read by codex-hooks/session-start.mjs for the
// identity announcement and the terminal tab title).

import { buildCodexAdvisorWorkerLaunch } from './launcher-codex.ts'
import { extractRoleFlag } from './launcher.ts'
import { needsLocalServer, startLocalServer } from './codex-local-server.ts'

const binary = process.env.ORCHESTRATION_CODEX_BINARY || 'codex'
const { role: flagRole, args } = extractRoleFlag(process.argv.slice(2))
const launch = buildCodexAdvisorWorkerLaunch(args, {
  accountLabel: process.env.ORCHESTRATION_ACCOUNT_LABEL ?? process.env.CLAUDE_ACCOUNT_LABEL,
  role: flagRole ?? process.env.ORCHESTRATION_ROLE,
})

if (process.env.ORCHESTRATION_CODEX_DRY_RUN === '1') {
  console.log(JSON.stringify({ binary, ...launch }))
  process.exit(0)
}

let local: Awaited<ReturnType<typeof startLocalServer>> | undefined
try {
  if (needsLocalServer(args, launch.session))
    local = await startLocalServer(binary, launch.args, { ...process.env, ...launch.env })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
let child: ReturnType<typeof Bun.spawn>
try {
  child = Bun.spawn([binary, ...(local?.args ?? launch.args)], {
    env: local?.env ?? { ...process.env, ...launch.env },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
} catch (error) {
  await local?.stop()
  throw error
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => child.kill(signal))
}

local?.exited.then(() => {
  if (child.exitCode === null) child.kill('SIGTERM')
})
const exitCode = await child.exited
await local?.stop()
if (local) {
  const roleFlag =
    launch.env.ORCHESTRATION_ROLE === 'Architect'
      ? ' --advisor'
      : launch.env.ORCHESTRATION_ROLE === 'Implementer'
        ? ' --worker'
        : ''
  console.error(
    `Orchestration private App Server stopped. Resume saved work with codex-orchestrated${roleFlag} resume <session-id>; the temporary remote socket is no longer available.`,
  )
}
process.exit(exitCode)
