import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { boundedServerLog } from './server-log.ts'

const NONINTERACTIVE = new Set([
  'exec',
  'e',
  'review',
  'apply',
  'a',
  'archive',
  'queue',
  'agents',
  'app',
  'migrate-rollouts',
])
export function needsLocalServer(args: string[], session: boolean): boolean {
  // Existing wrapper classifies admin commands first. Preserve headless modes.
  return session && !args.some((arg) => NONINTERACTIVE.has(arg))
}

export function serverConfigArgs(args: string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (
      ['-p', '--profile', '--remote', '--remote-auth-token-env'].includes(arg) ||
      /^(--profile=|--remote=|-p.)/.test(arg)
    ) {
      throw new Error(
        'Orchestrated private-server launch cannot safely mirror profile/remote options. Use plain codex for that invocation.',
      )
    }
    if (['-c', '--config', '--enable', '--disable'].includes(arg)) {
      if (args[i + 1] === undefined) throw new Error(`Missing value for ${arg}`)
      result.push(arg, args[++i])
    } else if (/^(--config=|--enable=|--disable=|-c.)/.test(arg) || arg === '--strict-config')
      result.push(arg)
  }
  return result
}

export async function startLocalServer(
  binary: string,
  args: string[],
  env: Record<string, string | undefined>,
) {
  const forwarded = serverConfigArgs(args)
  // Short path avoids macOS sockaddr_un's path limit. Directory is private.
  const directory = await mkdtemp('/tmp/codex-orch-')
  await chmod(directory, 0o700)
  const socket = join(directory, 'rpc.sock')
  const endpoint = `unix://${socket}`
  const socketConfig = `mcp_servers.advisor-worker-orchestration.env.ORCHESTRATION_CODEX_APP_SERVER_SOCKET=${JSON.stringify(socket)}`
  const childEnv = { ...env, ORCHESTRATION_CODEX_APP_SERVER_SOCKET: socket }
  const logDir = join(
    env.CODEX_ORCHESTRATION_STATE_DIR ?? join(homedir(), '.codex', 'advisor-worker-orchestration'),
    'server-logs',
  )
  await mkdir(logDir, { recursive: true, mode: 0o700 })
  const logPath = join(logDir, `${basename(directory)}.log`)
  const log = boundedServerLog(logPath)
  let server: ReturnType<typeof Bun.spawn>
  try {
    server = Bun.spawn(
      [binary, 'app-server', ...forwarded, '-c', socketConfig, '--listen', endpoint],
      {
        env: childEnv,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      },
    )
  } catch (error) {
    log.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  const drain = (async () => {
    let warned = false
    try {
      for await (const chunk of server.stderr as ReadableStream<Uint8Array>) {
        try {
          log.write(chunk)
        } catch {
          if (!warned) {
            warned = true
            console.error('Could not retain App Server diagnostics; continuing to drain stderr.')
          }
        }
      }
    } finally {
      log.close()
    }
  })()
  // Drain errors must never become unhandled rejections or block the server.
  const drained = drain.catch(() => console.error('Could not retain App Server diagnostics.'))
  console.error(`Orchestration App Server diagnostics: ${logPath} (1 MiB limit)`)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    server.kill('SIGTERM')
    const timer = setTimeout(() => server.kill('SIGKILL'), 3000)
    await server.exited
    await drained
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true })
  }
  try {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline && server.exitCode === null) {
      try {
        if ((await lstat(socket)).isSocket())
          return {
            env: childEnv,
            args: [...args, '-c', socketConfig, '--remote', endpoint],
            stop,
            exited: server.exited,
          }
      } catch {}
      await Bun.sleep(50)
    }
    throw new Error(`Private Codex App Server did not become ready; inspect ${logPath}`)
  } catch (error) {
    await stop()
    throw error
  }
}
