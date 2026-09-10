import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

// Mission-system link: an armed advisor/worker mailbox usually lives inside a
// mission handoff directory (<mission>/ARCHITECT-STEER.md). Arming therefore
// captures the mission context so the role-reminder hook can point sessions
// at their durable sources of truth (SPECS.md contract + mission ledger)
// instead of treating the mailbox as memory.
export type MissionContext = {
  handoffDir: string
  specsPath: string | null
}

export function missionContextFor(watchPath: string): MissionContext {
  const handoffDir = dirname(watchPath)
  const specsPath = `${handoffDir}/SPECS.md`
  return {
    handoffDir,
    specsPath: existsSync(specsPath) ? specsPath : null,
  }
}
