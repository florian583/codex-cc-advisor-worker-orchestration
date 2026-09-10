#!/usr/bin/env bun

import { randomUUID } from 'node:crypto'

import { buildAdvisorWorkerLaunch, extractRoleFlag } from './launcher.ts'

const binary = process.env.ORCHESTRATION_CLAUDE_BINARY || 'claude'
// --worker / --advisor / --role <name> pin the role tag into the launch
// --name (frozen for the session's lifetime); flag wins over the env var.
const { role: flagRole, args } = extractRoleFlag(process.argv.slice(2))
const launch = buildAdvisorWorkerLaunch(args, {
  accountLabel: process.env.CLAUDE_ACCOUNT_LABEL,
  role: flagRole ?? process.env.ORCHESTRATION_ROLE,
  uuidFactory: randomUUID,
})

if (process.env.ORCHESTRATION_CLAUDE_DRY_RUN === '1') {
  console.log(JSON.stringify({ binary, ...launch }))
  process.exit(0)
}

const child = Bun.spawn([binary, ...launch.args], {
  env: process.env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => child.kill(signal))
}

process.exit(await child.exited)
