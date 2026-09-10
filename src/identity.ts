// Typed wrapper over the dependency-free identity core used by Codex hooks.
import { sessionIdentity as coreSessionIdentity } from './identity-core.mjs'

export type SessionIdentity = {
  accountLabel: string | null
  callSign: string
  displayRole: 'Advisor' | 'Worker' | 'Session'
  role: string | null
  sessionId: string
  suffix: string
  title: string
}

export function sessionIdentity(
  sessionId: string,
  role?: string | null,
  accountLabel?: string,
): SessionIdentity {
  return coreSessionIdentity(sessionId, role ?? null, accountLabel) as SessionIdentity
}
