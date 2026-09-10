#!/usr/bin/env node

// Advisor/worker orchestration SessionStart hook.
//
// Self-gated on ORCHESTRATION_CODEX=1: plain
// `codex` launches stay untouched. When active it:
//   1. records the session id + cwd in the orchestration state directory
//      (the MCP server uses this as a session-id fallback);
//   2. injects the role-based identity context (call sign + session id + how to
//      arm/wait) as developer context;
//   3. sets the terminal tab title (OSC 2 via /dev/tty), unless
//      ORCHESTRATION_TAB_TITLE=0.
//
// Codex hook contract: JSON payload on stdin ({session_id, cwd, source,...}),
// JSON on stdout with hookSpecificOutput.additionalContext.

import { appendFileSync, mkdirSync, readSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { sessionIdentity } from '../src/identity-core.mjs'

function readStdin() {
  try {
    let data = ''
    const buffer = new Uint8Array(65536)
    while (true) {
      const bytes = readSync(0, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      data += Buffer.from(buffer.subarray(0, bytes)).toString('utf8')
    }
    return data
  } catch {
    return ''
  }
}

function main() {
  if (process.env.ORCHESTRATION_CODEX !== '1') return

  let payload = {}
  try {
    payload = JSON.parse(readStdin() || '{}')
  } catch {
    return
  }
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  if (!sessionId) return
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
  const source = typeof payload.source === 'string' ? payload.source : 'startup'

  const accountLabel = process.env.ORCHESTRATION_ACCOUNT_LABEL || 'CODEX'
  const role = process.env.ORCHESTRATION_ROLE || ''
  const identity = sessionIdentity(sessionId, role || null, accountLabel)

  const stateDir =
    process.env.CODEX_ORCHESTRATION_STATE_DIR ||
    join(homedir(), '.codex', 'advisor-worker-orchestration')
  try {
    mkdirSync(join(stateDir, 'sessions.d'), { recursive: true })
    writeFileSync(
      join(stateDir, 'sessions.d', `${sessionId}.json`),
      JSON.stringify({
        sessionId,
        cwd,
        accountLabel,
        role: role || null,
        startedAt: new Date().toISOString(),
        source,
        appServerSocket: process.env.ORCHESTRATION_CODEX_APP_SERVER_SOCKET ?? null,
      }) + '\n',
    )
  } catch {
    // Recording is best effort; identity injection below still works.
  }

  if (process.env.ORCHESTRATION_TAB_TITLE !== '0') {
    try {
      // ESC ] 2 ; title BEL — iTerm2 / Warp / Ghostty tab title.
      appendFileSync('/dev/tty', `]2;${identity.title}`)
    } catch {
      // No controlling terminal (e.g. codex exec) — skip.
    }
  }

  const roleLine = role
    ? `Role pinned at launch: ${role} (display identity ${identity.displayRole}). The definitive role is set by the mailbox filename at arm time.`
    : 'No role pinned at launch; the role is derived from the mailbox filename at arm time.'
  const workerGoalLine =
    role.toLowerCase() === 'implementer'
      ? 'Worker contract: execute only approved STEER orders. Acknowledge substantive orders in QUESTIONS. When awaiting work, finish the turn and stay armed; App Server turn/steer or turn/start delivers changes. Explicit wait is optional, never a required polling loop.'
      : ''
  const advisorQaLine =
    role.toLowerCase() === 'architect'
      ? 'Advisor QA mandate: worker DONE/READY is a claim, never acceptance. Read SPECS and evidence, inspect the actual branch or PR head, run relevant checks, and discover review capability from repository instructions. Use approved independent review where useful. Record an evidence-backed GO / GO-WITH-NITS / NO-GO in STEER. Any later change needs renewed review.'
      : ''
  const context = [
    `Advisor/worker orchestration active for this Codex session: ${identity.title}.`,
    `Session id: ${sessionId} — pass it as sessionId when calling arm_advisor_worker_mailbox.`,
    roleLine,
    process.env.ORCHESTRATION_CODEX_APP_SERVER_SOCKET
      ? 'Mailbox live transport: private App Server turn/steer targets this exact active turn, never codex queue. Acceptance is not proof of consumption; acknowledge after reading. When awaiting work, finish the turn and stay armed. Explicit wait_advisor_worker_mailbox is optional. A finished turn wakes via turn/start on the next mailbox change while this session stays open and armed; approvals remain interactive.'
      : 'Mailbox live steering unavailable in this launch. Long-poll works; relaunch through codex-orchestrated for a private App Server endpoint. Do not claim desktop sessions can be attached automatically.',
    "Workflow: arm once with the absolute mailbox path (ARCHITECT-STEER.md as worker / ARCHITECT-QUESTIONS.md as advisor), work, use wait_advisor_worker_mailbox when you want to wait explicitly; otherwise the watcher starts a new turn for changes while idle. Never edit the other role's file. To stop receiving later STEER wakes, call disarm_advisor_worker_mailbox before /exit; normal process exit also removes the arm record.",
    workerGoalLine,
    role.toLowerCase() === 'implementer'
      ? 'Fleet rule: after every substantive QUESTIONS update, call notify_fleet_advisor with the exact fleetRoot and QUESTIONS path. The durable file is written first; the tool only wakes the registered advisor thread.'
      : '',
    advisorQaLine,
  ]
    .filter(Boolean)
    .join('\n')

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }),
  )
}

main()
