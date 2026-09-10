#!/usr/bin/env node

// Advisor/worker UserPromptSubmit hook: unread mailbox notice.
//
// Companion to the shared role-rules reminder,
// registered separately): that one reminds HOW to work, this one notices WHEN
// the armed mailbox moved since the agent's last wait/read. Self-gated on a
// fresh armed flag; emits at most once per mailbox mtime so it never spams.

import { readSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { needsRecovery } from './mailbox-delivery.mjs'

const ARM_TTL_H = Number(process.env.ORCHESTRATION_ARM_TTL_HOURS || 6)
const MTIME_EPSILON_MS = 500

function readStdinJson() {
  try {
    let data = ''
    const buffer = new Uint8Array(65536)
    while (true) {
      const bytes = readSync(0, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      data += Buffer.from(buffer.subarray(0, bytes)).toString('utf8')
    }
    return JSON.parse(data || '{}')
  } catch {
    return {}
  }
}

function main() {
  const payload = readStdinJson()
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  if (!sessionId) return

  const armDir =
    process.env.ADVISOR_WORKER_ARM_DIR ||
    join(homedir(), '.local', 'state', 'advisor-worker-orchestration', 'armed.d')
  let flag
  try {
    flag = JSON.parse(readFileSync(join(armDir, `${sessionId}.json`), 'utf8'))
  } catch {
    return // not armed
  }
  try {
    const ageHours = (Date.now() - Date.parse(flag.armedAt || '')) / 3600_000
    if (!(ageHours <= ARM_TTL_H)) return
  } catch {
    return
  }
  const watchPath = typeof flag.watchPath === 'string' ? flag.watchPath : ''
  if (!watchPath) return

  let currentMtime = 0
  try {
    currentMtime = statSync(watchPath).mtimeMs
  } catch {
    return
  }
  const lastSeen = Number(flag.lastSeenMtimeMs) || 0
  if (currentMtime <= lastSeen + MTIME_EPSILON_MS) return // caught up
  if (!needsRecovery(sessionId, watchPath, 'prompt')) return

  const mailbox = basename(watchPath) === 'ARCHITECT-QUESTIONS.md' ? 'questions' : 'steer'
  const context = [
    `${mailbox} mailbox at ${watchPath} differs from the last MCP wait watermark; automatic delivery is not confirmed. This is not a read acknowledgement.`,
    'Check it newest-first if not already reviewed. Reconcile once; do not duplicate replies or enter an idle polling loop.',
  ].join(' ')
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
    }),
  )
}

main()
