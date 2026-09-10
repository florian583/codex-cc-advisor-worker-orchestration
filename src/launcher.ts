import { sessionIdentity, type SessionIdentity } from './identity.ts'

const CHANNEL_ARGS = [
  '--dangerously-load-development-channels',
  'plugin:advisor-worker-orchestration@codex-cc-advisor-worker-orchestration',
] as const

const NON_SESSION_COMMANDS = new Set([
  'agents',
  'attach',
  'auth',
  'auto-mode',
  'daemon',
  'doctor',
  'gateway',
  'install',
  'logs',
  'mcp',
  'plugin',
  'plugins',
  'project',
  'remote-control',
  'respawn',
  'rm',
  'setup-token',
  'stop',
  'ultrareview',
  'update',
])

// Role-pinning flags for the wrapper itself — stripped before args reach the
// claude binary. --worker/--advisor are shortcuts for the two mailbox roles;
// --role <name> pins any raw protocol role. A flag beats ORCHESTRATION_ROLE.
const ROLE_FLAGS: Record<string, string> = {
  '--worker': 'Implementer',
  '--advisor': 'Architect',
}

export function extractRoleFlag(args: string[]): { role?: string; args: string[] } {
  const rest: string[] = []
  let role: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument in ROLE_FLAGS) {
      role = ROLE_FLAGS[argument]
      continue
    }
    if (argument === '--role') {
      const value = args[index + 1]
      if (value !== undefined) {
        role = value
        index += 1
      }
      continue
    }
    rest.push(argument)
  }
  return { role, args: rest }
}

type LaunchOptions = {
  accountLabel?: string
  role?: string
  uuidFactory: () => string
}

type AdvisorWorkerLaunch = {
  args: string[]
  identity: SessionIdentity | null
  sessionId: string | null
}

export function buildAdvisorWorkerLaunch(
  args: string[],
  options: LaunchOptions,
): AdvisorWorkerLaunch {
  if (isNonSessionInvocation(args)) return { args: [...args], identity: null, sessionId: null }

  const channelArgs = hasChannelFlag(args) ? [] : [...CHANNEL_ARGS]
  if (hasResumeFlag(args)) {
    return { args: [...channelArgs, ...args], identity: null, sessionId: null }
  }

  const explicitSessionId = optionValue(args, '--session-id')
  const sessionId = explicitSessionId ?? options.uuidFactory()
  // Role is only passed when the launcher pinned it;
  // otherwise the launch --name stays untagged because --name is frozen for
  // the session's lifetime and the real role is only known at arm time.
  const identity = sessionIdentity(sessionId, options.role, options.accountLabel)
  const identityArgs: string[] = []

  if (!explicitSessionId) identityArgs.push('--session-id', sessionId)
  if (!hasOption(args, '--name', '-n')) identityArgs.push('--name', identity.title)

  return { args: [...identityArgs, ...channelArgs, ...args], identity, sessionId }
}

function isNonSessionInvocation(args: string[]): boolean {
  if (hasOption(args, '--print', '-p', '--help', '-h', '--version', '-v', '--init-only'))
    return true
  return args.some((argument) => NON_SESSION_COMMANDS.has(argument))
}

function hasResumeFlag(args: string[]): boolean {
  return hasOption(args, '--resume', '-r', '--continue', '-c')
}

function hasChannelFlag(args: string[]): boolean {
  return hasOption(args, '--dangerously-load-development-channels', '--channels')
}

function hasOption(args: string[], ...options: string[]): boolean {
  return args.some((argument) => options.includes(argument))
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option)
  return index >= 0 ? args[index + 1] : undefined
}
