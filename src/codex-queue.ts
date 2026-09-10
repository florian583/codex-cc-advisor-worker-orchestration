import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { deliverMailbox, type WakeResult } from './codex-steer.ts'

type ArmRecord = {
  client?: string
  fleetRoot?: string
  role?: string
  sessionId?: string
  watchPath?: string
  appServerSocket?: string
}
export type CodexQueueResult = WakeResult

// Keep the module name for existing Claude/Codex callers. No codex queue calls.
async function recipients(
  armDir: string,
  matches: (r: ArmRecord) => boolean,
): Promise<ArmRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(armDir)
  } catch {
    return []
  }
  const found = new Map<string, ArmRecord>()
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const record: ArmRecord = JSON.parse(await readFile(join(armDir, entry), 'utf8'))
      if (record.client === 'codex' && record.sessionId && matches(record))
        found.set(record.sessionId, record)
    } catch {}
  }
  return [...found.values()]
}

async function deliver(
  found: ArmRecord[],
  mailboxPath: string,
  message: string,
): Promise<WakeResult> {
  if (!found.length) return { status: 'no-recipient' }
  if (found.length !== 1) return { status: 'ambiguous-recipient' }
  const recipient = found[0]
  return deliverMailbox({
    socket: recipient.appServerSocket,
    sessionId: recipient.sessionId!,
    mailboxPath,
    message,
  })
}

export async function wakeCodexWorker(args: {
  armDir: string
  steerPath: string
  binary?: string
}): Promise<WakeResult> {
  const found = await recipients(
    args.armDir,
    (r) => r.role === 'Implementer' && r.watchPath === args.steerPath,
  )
  return deliver(
    found,
    args.steerPath,
    `Worker: STEER mailbox changed. Reread ${args.steerPath} newest-first now; follow the current order and acknowledge in QUESTIONS.`,
  )
}

export async function wakeCodexAdvisor(args: {
  armDir: string
  fleetRoot: string
  questionsPath: string
  binary?: string
}): Promise<WakeResult> {
  const found = await recipients(
    args.armDir,
    (r) => r.role === 'Architect' && r.fleetRoot === args.fleetRoot,
  )
  return deliver(
    found,
    args.questionsPath,
    `Advisor: worker QUESTIONS changed at ${args.questionsPath}. Reread newest-first, verify evidence, then update SPECS or worker STEER as needed.`,
  )
}
