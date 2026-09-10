// Launch construction for the Codex advisor/worker wrapper.
//
// Codex has no --session-id/--name flags and no development-channel flag, so
// the wrapper's job is much smaller than the Claude one: enable the orchestration
// MCP server for this launch only (it ships disabled in config.toml), and pin
// the role/account label into the environment for the SessionStart hook and
// the MCP server. Identity display (context injection + terminal tab title)
// happens in codex-hooks/session-start.mjs once Codex has assigned the real
// session id.

export const ADVISOR_WORKER_MCP_SERVER = 'advisor-worker-orchestration'

const NON_SESSION_COMMANDS = new Set([
  'app-server',
  'cloud',
  'completion',
  'debug',
  'delete',
  'doctor',
  'exec-server',
  'features',
  'help',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'plugin',
  'remote-control',
  'sandbox',
  'unarchive',
  'update',
])

// codex subcommands that ARE sessions even though they don't open the TUI:
// exec, review, resume, fork, archive, apply keep the orchestration server on them.

type CodexLaunchOptions = {
  accountLabel?: string
  role?: string
}

export type CodexAdvisorWorkerLaunch = {
  args: string[]
  env: Record<string, string>
  session: boolean
}

export function buildCodexAdvisorWorkerLaunch(
  args: string[],
  options: CodexLaunchOptions,
): CodexAdvisorWorkerLaunch {
  const env: Record<string, string> = {
    ORCHESTRATION_CODEX: '1',
    ORCHESTRATION_ACCOUNT_LABEL: options.accountLabel ?? 'CODEX',
  }
  const role = options.role?.trim()
  if (role) env.ORCHESTRATION_ROLE = role

  if (isNonSessionInvocation(args)) return { args: [...args], env, session: false }

  return {
    args: ['-c', `mcp_servers.${ADVISOR_WORKER_MCP_SERVER}.enabled=true`, ...args],
    env,
    session: true,
  }
}

function isNonSessionInvocation(args: string[]): boolean {
  if (hasOption(args, '--help', '-h', '--version', '-V')) return true
  return args.some((argument) => NON_SESSION_COMMANDS.has(argument))
}

function hasOption(args: string[], ...options: string[]): boolean {
  return args.some((argument) => options.includes(argument))
}
