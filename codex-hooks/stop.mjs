#!/usr/bin/env node

// Advisor/worker Stop hook: bounded delivery-recovery gate.
//
// Self-gated on a fresh armed flag for this session (written by the
// advisor-worker-orchestration MCP server on arm). When the agent tries to go
// idle while the watched mailbox has changed since its last MCP wait, the
// stop is blocked with a continuation prompt so the agent picks the order up
// instead of stalling. stop_hook_active (second consecutive stop attempt)
// always wins, so this can never trap the session in a loop.

import { readSync, statSync } from 'node:fs'
import { readFileSync } from 'node:fs'
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
  if (payload.stop_hook_active === true) return

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
    return // mailbox gone — nothing to wake for
  }
  const lastSeen = Number(flag.lastSeenMtimeMs) || 0
  if (currentMtime <= lastSeen + MTIME_EPSILON_MS) return // caught up
  if (!needsRecovery(sessionId, watchPath, 'stop')) return

  const mailbox = basename(watchPath) === 'ARCHITECT-QUESTIONS.md' ? 'questions' : 'steer'
  const role = String(flag.role || '').toLowerCase() || 'implementer'
  const reason = [
    `${mailbox} mailbox at ${watchPath} differs from the last MCP wait watermark; automatic delivery is not confirmed. This does not prove it is unread. You are armed as ${flag.role || 'Implementer'}.`,
    role === 'architect'
      ? 'Reread QUESTIONS newest-first, verify reported evidence, and write any answer or next order only in STEER.'
      : 'Reread STEER newest-first, reconcile the newest order with in-flight work, and acknowledge it in QUESTIONS.',
    'If already reviewed, do not duplicate replies. Otherwise reconcile it once. Then finish your turn; leave the watcher armed. Waiting with wait_advisor_worker_mailbox is optional.',
  ].join(' ')
  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
}

main()
