#!/usr/bin/env bun

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { MailboxChannel } from './channel.ts'
import { wakeCodexWorker } from './codex-queue.ts'
import { missionContextFor } from './mission-link.ts'

// Arms/disarms the self-gating role-rules reminder alongside the mailbox
// watcher. One flag file per session, carrying the full role-based
// identity (role + callSign) computed from the ACTUAL runtime session ID, so
// the reminder hook and the status line stay consistent with channel wakes
// even after a session resume forks a new session ID.
const RULES_ARM_DIR =
  process.env.ADVISOR_WORKER_ARM_DIR ??
  join(homedir(), '.local', 'state', 'advisor-worker-orchestration', 'armed.d')

type ArmedIdentity = {
  accountLabel: string | null
  callSign: string
  displayRole: 'Advisor' | 'Worker' | 'Session'
  role: string
  sessionId: string
  title?: string
}

async function setRulesReminderArmed(
  armed: boolean,
  sessionId: string,
  identity?: ArmedIdentity,
  watchPath?: string,
): Promise<void> {
  try {
    const file = join(RULES_ARM_DIR, `${sessionId}.json`)
    if (armed) {
      // Mission link: record the mission handoff dir + SPECS contract (when
      // present) so the reminder hook can anchor the session to its durable
      // sources of truth, not just the ephemeral mailbox.
      const mission = watchPath ? missionContextFor(watchPath) : null
      await mkdir(RULES_ARM_DIR, { recursive: true })
      await writeFile(
        file,
        JSON.stringify({
          role: identity?.role ?? null,
          callSign: identity?.callSign ?? null,
          accountLabel: identity?.accountLabel ?? null,
          title: identity?.title ?? null,
          sessionId,
          handoffDir: mission?.handoffDir ?? null,
          specsPath: mission?.specsPath ?? null,
          armedAt: new Date().toISOString(),
        }) + '\n',
      )
    } else {
      await rm(file, { force: true })
    }
  } catch {
    // Never fail an arm/disarm call over the reminder flag.
  }
}

const server = new Server(
  { name: 'advisor-worker-orchestration', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      'Advisor/worker mailbox events arrive as <channel source="plugin:advisor-worker-orchestration:advisor-worker-orchestration" mailbox="questions|steer" role="architect|implementer" session_id="...">. Treat each event as a wake for this exact session. Reread the named mailbox from disk and follow its ownership, acknowledgement, heartbeat, evidence, and deduplication protocol.',
  },
)

const sessionId = process.env.CLAUDE_CODE_SESSION_ID
if (!sessionId) {
  throw new Error('CLAUDE_CODE_SESSION_ID is required for exact-session Channel routing')
}
const channel = new MailboxChannel({
  accountLabel: process.env.CLAUDE_ACCOUNT_LABEL,
  notify: (notification) => server.notification(notification),
  onError: (error) => console.error(error instanceof Error ? error.stack : String(error)),
  sessionId,
})

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'arm_advisor_worker_mailbox',
      description:
        'Watch one absolute ARCHITECT-QUESTIONS.md or ARCHITECT-STEER.md path and wake this exact Claude session through its channel. Returns the role-based identity, full Claude session ID, and transport.',
      inputSchema: {
        type: 'object',
        properties: {
          watchPath: {
            type: 'string',
            description: 'Absolute path to ARCHITECT-QUESTIONS.md or ARCHITECT-STEER.md',
          },
        },
        required: ['watchPath'],
      },
    },
    {
      name: 'disarm_advisor_worker_mailbox',
      description: "Stop this Claude session's advisor/worker mailbox watcher.",
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wake_codex_worker',
      description:
        'After writing an ARCHITECT-STEER.md order for a Codex implementation session, steer its exact active turn to reread it. Use the exact absolute STEER path. Returns delivery status; never queues input or invents a session id. Not needed for Claude workers using the Channel.',
      inputSchema: {
        type: 'object',
        properties: {
          steerPath: {
            type: 'string',
            description: 'Exact absolute path to the Codex implementer ARCHITECT-STEER.md',
          },
        },
        required: ['steerPath'],
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
    const result = channel.arm(watchPath)
    await setRulesReminderArmed(true, sessionId, result.identity, watchPath)
    const mission = missionContextFor(watchPath)
    return textResult({ ...result, ...mission, rulesReminderArmed: true })
  }

  if (request.params.name === 'disarm_advisor_worker_mailbox') {
    const path = channel.disarm()
    await setRulesReminderArmed(false, sessionId)
    return textResult({ disarmed: path !== null, path, sessionId, rulesReminderArmed: false })
  }

  if (request.params.name === 'wake_codex_worker') {
    const steerPath = request.params.arguments?.steerPath
    if (typeof steerPath !== 'string' || steerPath.trim() === '') {
      throw new Error('steerPath must be a non-empty absolute mailbox path')
    }
    return textResult(await wakeCodexWorker({ armDir: RULES_ARM_DIR, steerPath }))
  }

  throw new Error(`Unknown tool: ${request.params.name}`)
})

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    channel.disarm()
    void setRulesReminderArmed(false, sessionId).finally(() => process.exit(0))
  })
}

await server.connect(new StdioServerTransport())
