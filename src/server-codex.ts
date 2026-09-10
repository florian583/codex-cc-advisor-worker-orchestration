#!/usr/bin/env bun

// Codex CLI edition of the advisor-worker-orchestration MCP server.
//
// Deltas from the Claude Code server (src/server.ts), driven by platform
// constraints:
// - Codex has no MCP Channel push API. This server therefore uses two delivery
//   paths: a long-poll `wait_advisor_worker_mailbox` tool while the agent is idle, and
//   App Server turn/steer while it is busy. A companion Stop hook
//   (codex-hooks/stop.mjs) blocks an idle stop while the mailbox has unread
//   changes, so a waiting implementer actually wakes up.
// - Codex does not expose the session id to MCP server processes, so the
//   session id comes from (in priority order): the `sessionId` tool argument
//   (the SessionStart hook announces it in context), the ORCHESTRATION_SESSION_ID env
//   var. Missing identity fails closed; no newest-session guessing.
//
// Armed flags are written to the same shared directory as the Claude plugin
// (~/.local/state/advisor-worker-orchestration/armed.d/) so the role-reminder hook works
// uniformly across Claude Code and Codex sessions. Codex flags carry
// client: "codex", watchPath and lastSeenMtimeMs (used by the Stop hook's
// unread detection and the prompt-notice hook).

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, normalize } from 'node:path'

import { sessionIdentity } from './identity.ts'
import { MailboxWatcher } from './mailbox-watcher.ts'
import { wakeCodexAdvisor, wakeCodexWorker } from './codex-queue.ts'
import { deliverMailbox } from './codex-steer.ts'
import { missionContextFor } from './mission-link.ts'

const RULES_ARM_DIR =
  process.env.ADVISOR_WORKER_ARM_DIR ??
  join(homedir(), '.local', 'state', 'advisor-worker-orchestration', 'armed.d')
const STATE_DIR =
  process.env.CODEX_ORCHESTRATION_STATE_DIR ??
  join(homedir(), '.codex', 'advisor-worker-orchestration')

const DEFAULT_WAIT_TIMEOUT_SEC = 120
const MAX_WAIT_TIMEOUT_SEC = 540 // stay below the configured tool_timeout_sec
const APP_SERVER_SOCKET = process.env.ORCHESTRATION_CODEX_APP_SERVER_SOCKET
const STEER_ENABLED =
  process.env.ORCHESTRATION_CODEX_STEER_ENABLED !== '0' &&
  process.env.ORCHESTRATION_CODEX_QUEUE_ENABLED !== '0'

type ArmedIdentity = {
  accountLabel: string | null
  callSign: string
  displayRole: 'Advisor' | 'Worker' | 'Session'
  role: string
  sessionId: string
  title?: string
}

async function writeArmedFlag(
  sessionId: string,
  identity: ArmedIdentity,
  watchPath: string,
  lastSeenMtimeMs: number,
): Promise<void> {
  try {
    const mission = missionContextFor(watchPath)
    await mkdir(RULES_ARM_DIR, { recursive: true })
    await writeFile(
      join(RULES_ARM_DIR, `${sessionId}.json`),
      JSON.stringify({
        role: identity.role,
        callSign: identity.callSign,
        accountLabel: identity.accountLabel,
        title: identity.title ?? null,
        sessionId,
        client: 'codex',
        appServerSocket: APP_SERVER_SOCKET ?? null,
        watchPath,
        handoffDir: mission.handoffDir,
        specsPath: mission.specsPath,
        lastSeenMtimeMs,
        armedAt: new Date().toISOString(),
      }) + '\n',
    )
  } catch {
    // Never fail an arm/disarm call over the reminder flag.
  }
}

async function patchFlagLastSeen(sessionId: string, lastSeenMtimeMs: number): Promise<void> {
  try {
    const file = join(RULES_ARM_DIR, `${sessionId}.json`)
    const flag = JSON.parse(await readFile(file, 'utf8'))
    flag.lastSeenMtimeMs = lastSeenMtimeMs
    await writeFile(file, JSON.stringify(flag) + '\n')
  } catch {
    // Best effort: the Stop hook's unread detection degrades silently.
  }
}

async function removeArmedFlag(sessionId: string): Promise<void> {
  try {
    await rm(join(RULES_ARM_DIR, `${sessionId}.json`), { force: true })
  } catch {
    // Never fail a disarm over the flag.
  }
}

async function writeFleetAdvisorFlag(
  sessionId: string,
  identity: ArmedIdentity,
  fleetRoot: string,
): Promise<void> {
  try {
    await mkdir(RULES_ARM_DIR, { recursive: true })
    await writeFile(
      join(RULES_ARM_DIR, `${sessionId}.json`),
      JSON.stringify({
        role: 'Architect',
        callSign: identity.callSign,
        accountLabel: identity.accountLabel,
        title: identity.title ?? null,
        sessionId,
        client: 'codex',
        appServerSocket: APP_SERVER_SOCKET ?? null,
        fleetRoot,
        armedAt: new Date().toISOString(),
      }) + '\n',
    )
  } catch {
    // Never fail registration over the routing flag.
  }
}

// Resolve the session id for identity + flag keying. The agent knows its id
// from the SessionStart hook announcement and passes it explicitly; the
// no cwd-based fallback: concurrent sessions can share a directory.
async function resolveSessionId(explicit?: unknown): Promise<string> {
  const id =
    typeof explicit === 'string' && explicit.trim() !== ''
      ? explicit.trim()
      : process.env.ORCHESTRATION_SESSION_ID
  if (id) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid sessionId')
    return id
  }

  throw new Error(
    'Cannot resolve the Codex session id: pass the sessionId argument announced at session start ' +
      '(or set ORCHESTRATION_SESSION_ID).',
  )
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function roleForMailbox(path: string): 'Architect' | 'Implementer' {
  return basename(path) === 'ARCHITECT-QUESTIONS.md' ? 'Architect' : 'Implementer'
}

function wakeAction(role: string): string {
  return role === 'Architect'
    ? 'Use the architect-mailbox-claude-implementer skill, reread QUESTIONS newest-first, verify reported evidence, and write any answer or next order only in STEER.'
    : 'Load the architect mailbox implementer skill, reread STEER newest-first, reconcile the newest order with in-flight work, acknowledge it in QUESTIONS, and continue.'
}

function fleetRootFor(input: unknown): string {
  if (typeof input !== 'string' || !isAbsolute(input)) {
    throw new Error('fleetRoot must be an absolute directory path')
  }
  const fleetRoot = normalize(input)
  try {
    if (!statSync(fleetRoot).isDirectory()) throw new Error('not directory')
  } catch {
    throw new Error(`fleetRoot must be an existing directory: ${fleetRoot}`)
  }
  return fleetRoot
}

const server = new Server(
  { name: 'advisor-worker-orchestration', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Mailbox transport for the two-session Advisor/Worker workflow. Arm once with the absolute mailbox path ' +
      '(ARCHITECT-STEER.md = implementer, ARCHITECT-QUESTIONS.md = architect), passing the session id announced at ' +
      'session start. File changes steer active turns or start a new turn when idle. Optionally call wait_advisor_worker_mailbox: it returns ' +
      "when the mailbox changes. Never edit the other role's file; acknowledge orders in your own file newest-first.",
  },
)

const watcher = new MailboxWatcher({
  onChange: async () => {
    // An idle agent already owns a blocked MCP tool call. Resolve it directly
    // instead of sending a redundant steering message.
    if (wakePending) {
      if (armed)
        armed.lastDeliveredMtimeMs = Math.max(armed.lastDeliveredMtimeMs, mtimeMs(armed.path))
      wakePending()
      return
    }
    await steerMailboxWake()
  },
  onError: (error) => console.error(error instanceof Error ? error.stack : String(error)),
})

let armed: {
  identity: ArmedIdentity & { title: string }
  path: string
  lastSeenMtimeMs: number
  lastDeliveredMtimeMs: number
} | null = null
let wakePending: (() => void) | null = null
let fleetAdvisor: { identity: ArmedIdentity & { title: string }; fleetRoot: string } | null = null

let deliveryRunning = false
let deliveryDirty = false
async function steerMailboxWake(): Promise<void> {
  if (!armed || !STEER_ENABLED) return
  deliveryDirty = true
  if (deliveryRunning) return
  deliveryRunning = true
  try {
    while (deliveryDirty && armed) {
      deliveryDirty = false
      const target = armed
      const changedMtimeMs = mtimeMs(target.path)
      if (changedMtimeMs <= target.lastDeliveredMtimeMs) continue
      const mailbox = target.identity.role === 'Architect' ? 'QUESTIONS' : 'STEER'
      const result = await deliverMailbox({
        socket: APP_SERVER_SOCKET,
        sessionId: target.identity.sessionId,
        mailboxPath: target.path,
        message: `${target.identity.displayRole}: ${mailbox} mailbox changed. Reread ${target.path} newest-first now; follow its current order.`,
      })
      if (['steered', 'started', 'already-delivered'].includes(result.status)) {
        target.lastDeliveredMtimeMs = changedMtimeMs
      }
      // Passive result only. Receipt records acceptance, never claims model read.
      console.error(JSON.stringify({ event: 'mailbox-delivery', ...result }))
    }
  } finally {
    deliveryRunning = false
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'arm_advisor_worker_mailbox',
      description:
        'Watch one absolute ARCHITECT-QUESTIONS.md or ARCHITECT-STEER.md path for this Codex session. ' +
        'Returns the role-based identity and armed state. Pass the sessionId announced at session start.',
      inputSchema: {
        type: 'object',
        properties: {
          watchPath: {
            type: 'string',
            description: 'Absolute path to ARCHITECT-QUESTIONS.md or ARCHITECT-STEER.md',
          },
          sessionId: {
            type: 'string',
            description: 'Codex session id announced by the advisor/worker SessionStart hook',
          },
        },
        required: ['watchPath'],
      },
    },
    {
      name: 'wait_advisor_worker_mailbox',
      description:
        'Block until the armed advisor/worker mailbox changes (long poll) or the timeout elapses. ' +
        'Optional with live transport; idle sessions can also wake through turn/start. ' +
        'Returns immediately if the mailbox already changed since your last wait.',
      inputSchema: {
        type: 'object',
        properties: {
          timeoutSec: {
            type: 'number',
            description: `Max seconds to wait (default ${DEFAULT_WAIT_TIMEOUT_SEC}, max ${MAX_WAIT_TIMEOUT_SEC})`,
          },
        },
      },
    },
    {
      name: 'disarm_advisor_worker_mailbox',
      description:
        "Stop this Codex session's advisor/worker mailbox watcher and remove its registered session id. Call this before /exit when you want no later STEER wake.",
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'register_fleet_advisor',
      description:
        'Register this Codex Architect as the one session-scoped advisor for an existing fleet root. ' +
        'Workers use notify_fleet_advisor after writing their own QUESTIONS file. No timer or persistent daemon is created.',
      inputSchema: {
        type: 'object',
        properties: {
          fleetRoot: {
            type: 'string',
            description: 'Absolute existing fleet directory shared by worker folders',
          },
          sessionId: {
            type: 'string',
            description: 'Codex session id announced by the advisor/worker SessionStart hook',
          },
        },
        required: ['fleetRoot'],
      },
    },
    {
      name: 'dispatch_worker_order',
      description:
        'After writing a worker ARCHITECT-STEER.md, steer its exact armed Codex worker thread to reread it. ' +
        'Returns delivery status; never queues input or invents a worker session.',
      inputSchema: {
        type: 'object',
        properties: {
          steerPath: { type: 'string', description: 'Absolute worker ARCHITECT-STEER.md path' },
        },
        required: ['steerPath'],
      },
    },
    {
      name: 'notify_fleet_advisor',
      description:
        'After writing this worker QUESTIONS file, steer the exact registered Codex advisor for this fleet. ' +
        'The QUESTIONS file remains durable source of truth.',
      inputSchema: {
        type: 'object',
        properties: {
          fleetRoot: { type: 'string', description: 'Absolute existing fleet directory' },
          questionsPath: {
            type: 'string',
            description: 'Absolute worker ARCHITECT-QUESTIONS.md path',
          },
        },
        required: ['fleetRoot', 'questionsPath'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'arm_advisor_worker_mailbox') {
    const watchPath = request.params.arguments?.watchPath
    if (typeof watchPath !== 'string' || watchPath.trim() === '') {
      throw new Error('watchPath must be a non-empty absolute mailbox path')
    }
    const sessionId = await resolveSessionId(request.params.arguments?.sessionId)
    const armedPath = watcher.arm(watchPath)
    const role = roleForMailbox(armedPath)
    const accountLabel = process.env.ORCHESTRATION_ACCOUNT_LABEL ?? process.env.CLAUDE_ACCOUNT_LABEL
    const identity = sessionIdentity(sessionId, role, accountLabel)
    const seen = mtimeMs(armedPath)
    armed = {
      identity: { ...identity, role },
      path: armedPath,
      lastSeenMtimeMs: seen,
      lastDeliveredMtimeMs: seen,
    }
    await writeArmedFlag(sessionId, { ...identity, role }, armedPath, seen)
    return textResult({
      identity,
      path: armedPath,
      transport:
        APP_SERVER_SOCKET && STEER_ENABLED
          ? 'app-server turn/steer while active; turn/start while idle; mcp long-poll when waiting'
          : 'mcp long-poll only; live steering unavailable (relaunch codex-orchestrated)',
      rulesReminderArmed: true,
      instruction:
        'Read your mailbox newest-first now. File changes steer active turns or start a new turn when idle while this session remains open and armed. Waiting with wait_advisor_worker_mailbox is optional when live transport is available. Call disarm_advisor_worker_mailbox before /exit when this worker must stop accepting later STEER wakes.',
    })
  }

  if (request.params.name === 'wait_advisor_worker_mailbox') {
    if (!armed)
      throw new Error('No advisor/worker mailbox armed: call arm_advisor_worker_mailbox first')
    const timeoutSec = Number(request.params.arguments?.timeoutSec) || DEFAULT_WAIT_TIMEOUT_SEC
    const timeoutMs = Math.min(Math.max(timeoutSec, 1), MAX_WAIT_TIMEOUT_SEC) * 1000

    // Unread fast path: the mailbox already moved since the last wait/arm.
    let currentMtime = mtimeMs(armed.path)
    let changed = currentMtime > armed.lastSeenMtimeMs
    if (!changed) {
      changed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          wakePending = null
          resolve(false)
        }, timeoutMs)
        wakePending = () => {
          clearTimeout(timer)
          wakePending = null
          resolve(true)
        }
      })
      currentMtime = mtimeMs(armed.path)
    }

    armed.lastSeenMtimeMs = currentMtime
    if (changed) armed.lastDeliveredMtimeMs = Math.max(armed.lastDeliveredMtimeMs, currentMtime)
    await patchFlagLastSeen(armed.identity.sessionId, currentMtime)

    if (!changed) return textResult({ changed: false, path: armed.path, timeoutSec })
    const mailbox = armed.identity.role === 'Architect' ? 'questions' : 'steer'
    return textResult({
      changed: true,
      path: armed.path,
      mailbox,
      role: armed.identity.role.toLowerCase(),
      session_id: armed.identity.sessionId,
      content: `${armed.identity.callSign}: ${mailbox} mailbox changed at ${armed.path}. ${wakeAction(armed.identity.role)}`,
    })
  }

  if (request.params.name === 'disarm_advisor_worker_mailbox') {
    const path = watcher.disarm()
    const sessionId = armed?.identity.sessionId ?? fleetAdvisor?.identity.sessionId
    armed = null
    fleetAdvisor = null
    if (sessionId) await removeArmedFlag(sessionId)
    return textResult({ disarmed: path !== null, path, sessionId, rulesReminderArmed: false })
  }

  if (request.params.name === 'register_fleet_advisor') {
    const fleetRoot = fleetRootFor(request.params.arguments?.fleetRoot)
    const sessionId = await resolveSessionId(request.params.arguments?.sessionId)
    const accountLabel = process.env.ORCHESTRATION_ACCOUNT_LABEL ?? process.env.CLAUDE_ACCOUNT_LABEL
    const identity = sessionIdentity(sessionId, 'Architect', accountLabel)
    fleetAdvisor = { identity, fleetRoot }
    await writeFleetAdvisorFlag(sessionId, identity, fleetRoot)
    return textResult({
      identity,
      fleetRoot,
      transport: 'workers call notify_fleet_advisor after QUESTIONS writes',
      instruction:
        'Use one worker directory per lane. Read each worker QUESTIONS file newest-first after a wake; write only that worker STEER and update the fleet SPECS board. Treat READY/DONE as a claim: inspect the current branch or PR head, run applicable repository reviewer agents and checks, use approved independent review for non-trivial work, then record GO / GO-WITH-NITS / NO-GO with evidence in STEER.',
    })
  }

  if (request.params.name === 'dispatch_worker_order') {
    const steerPath = request.params.arguments?.steerPath
    if (!isAbsolute(String(steerPath)) || basename(String(steerPath)) !== 'ARCHITECT-STEER.md') {
      throw new Error('steerPath must be an absolute ARCHITECT-STEER.md path')
    }
    return textResult(
      await wakeCodexWorker({ armDir: RULES_ARM_DIR, steerPath: normalize(steerPath) }),
    )
  }

  if (request.params.name === 'notify_fleet_advisor') {
    const fleetRoot = fleetRootFor(request.params.arguments?.fleetRoot)
    const questionsPath = request.params.arguments?.questionsPath
    if (
      !isAbsolute(String(questionsPath)) ||
      basename(String(questionsPath)) !== 'ARCHITECT-QUESTIONS.md'
    ) {
      throw new Error('questionsPath must be an absolute ARCHITECT-QUESTIONS.md path')
    }
    return textResult(
      await wakeCodexAdvisor({
        armDir: RULES_ARM_DIR,
        fleetRoot,
        questionsPath: normalize(questionsPath),
      }),
    )
  }

  throw new Error(`Unknown tool: ${request.params.name}`)
})

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    const sessionId = armed?.identity.sessionId ?? fleetAdvisor?.identity.sessionId
    watcher.disarm()
    armed = null
    fleetAdvisor = null
    void (sessionId ? removeArmedFlag(sessionId) : Promise.resolve()).finally(() => process.exit(0))
  })
}

await server.connect(new StdioServerTransport())
