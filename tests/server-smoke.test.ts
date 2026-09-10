import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

describe('channel MCP server', () => {
  test('advertises the channel capability and arms the exact Claude session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'advisor-worker-server-'))
    temporaryDirectories.push(directory)
    const mailboxPath = join(directory, 'ARCHITECT-QUESTIONS.md')
    await writeFile(mailboxPath, '# Questions\n')
    const specsPath = join(directory, 'SPECS.md')
    await writeFile(specsPath, '# Specs\n')
    const armDir = join(directory, 'armed.d')
    const queueLog = join(directory, 'queue.log')
    const queueBinary = join(directory, 'fake-codex')
    await writeFile(queueBinary, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ORCHESTRATION_QUEUE_LOG"\n')
    await chmod(queueBinary, 0o755)

    const sessionId = '550e8400-e29b-41d4-a716-446655440010'
    const process = Bun.spawn(['bun', 'run', 'src/server.ts'], {
      cwd: pluginRoot,
      env: {
        ...Bun.env,
        ADVISOR_WORKER_ARM_DIR: armDir,
        ORCHESTRATION_CODEX_QUEUE_BINARY: queueBinary,
        ORCHESTRATION_QUEUE_LOG: queueLog,
        CLAUDE_ACCOUNT_LABEL: 'EXAMPLE',
        CLAUDE_CODE_SESSION_ID: sessionId,
      },
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    })
    const client = new JsonRpcClient(process)

    const initialized = await client.request(1, 'initialize', {
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
      protocolVersion: '2025-06-18',
    })
    expect(initialized.result.capabilities.experimental).toMatchObject({ 'claude/channel': {} })
    client.notify('notifications/initialized')

    const listed = await client.request(2, 'tools/list', {})
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'arm_advisor_worker_mailbox',
      'disarm_advisor_worker_mailbox',
      'wake_codex_worker',
    ])

    const armed = await client.request(3, 'tools/call', {
      arguments: { watchPath: mailboxPath },
      name: 'arm_advisor_worker_mailbox',
    })
    const result = JSON.parse(armed.result.content[0].text)
    expect(result.identity.sessionId).toBe(sessionId)
    expect(result.identity.title).toBe('EXAMPLE · Advisor · 0010')
    expect(result.path).toBe(mailboxPath)
    // Mission link: arm captures the handoff dir + SPECS contract…
    expect(result.handoffDir).toBe(directory)
    expect(result.specsPath).toBe(specsPath)

    // …and persists them into the reminder flag for the hook to anchor on.
    const flag = JSON.parse(await Bun.file(join(armDir, `${sessionId}.json`)).text())
    expect(flag.handoffDir).toBe(directory)
    expect(flag.specsPath).toBe(specsPath)
    expect(flag.role).toBe('Architect')

    const workerSessionId = '550e8400-e29b-41d4-a716-446655440011'
    const steerPath = join(directory, 'ARCHITECT-STEER.md')
    await writeFile(steerPath, '# Steer\n')
    await writeFile(
      join(armDir, `${workerSessionId}.json`),
      JSON.stringify({
        armedAt: new Date().toISOString(),
        client: 'codex',
        role: 'Implementer',
        sessionId: workerSessionId,
        watchPath: steerPath,
      }),
    )
    const wake = await client.request(4, 'tools/call', {
      arguments: { steerPath },
      name: 'wake_codex_worker',
    })
    expect(JSON.parse(wake.result.content[0].text)).toMatchObject({
      status: 'unavailable',
      sessionId: workerSessionId,
    })
    await expect(readFile(queueLog, 'utf8')).rejects.toThrow()

    await writeFile(mailboxPath, '# Questions\n\nnew question\n')
    const notification = await client.notification('notifications/claude/channel')
    expect(notification.params.meta).toMatchObject({
      mailbox: 'questions',
      role: 'architect',
      session_id: sessionId,
    })
    expect(notification.params.content).toContain(mailboxPath)

    process.kill()
    await process.exited
  })

  test('refuses to invent a routing identity outside a Claude session', async () => {
    const { CLAUDE_CODE_SESSION_ID: _, ...env } = Bun.env
    const process = Bun.spawn(['bun', 'run', 'src/server.ts'], {
      cwd: pluginRoot,
      env,
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    })
    const exitCode = await Promise.race([process.exited, Bun.sleep(500).then(() => null)])
    if (exitCode === null) process.kill()

    expect(exitCode).not.toBeNull()
    expect(await new Response(process.stderr).text()).toContain('CLAUDE_CODE_SESSION_ID')
  })
})

class JsonRpcClient {
  readonly #decoder = new TextDecoder()
  readonly #process: ReturnType<typeof Bun.spawn>
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  #buffer = ''

  constructor(process: ReturnType<typeof Bun.spawn>) {
    this.#process = process
    this.#reader = process.stdout.getReader()
  }

  notify(method: string, params = {}): void {
    this.#send({ jsonrpc: '2.0', method, params })
  }

  async request(id: number, method: string, params: unknown): Promise<any> {
    this.#send({ id, jsonrpc: '2.0', method, params })
    while (true) {
      const message = await this.#nextMessage()
      if (message.id === id) return message
    }
  }

  async notification(method: string): Promise<any> {
    while (true) {
      const message = await this.#nextMessage()
      if (message.method === method) return message
    }
  }

  #send(message: unknown): void {
    this.#process.stdin.write(`${JSON.stringify(message)}\n`)
    this.#process.stdin.flush()
  }

  async #nextMessage(): Promise<any> {
    while (!this.#buffer.includes('\n')) {
      const { done, value } = await this.#reader.read()
      if (done) {
        const stderr = await new Response(this.#process.stderr).text()
        throw new Error(`MCP server exited before responding: ${stderr}`)
      }
      this.#buffer += this.#decoder.decode(value, { stream: true })
    }
    const newline = this.#buffer.indexOf('\n')
    const line = this.#buffer.slice(0, newline)
    this.#buffer = this.#buffer.slice(newline + 1)
    return JSON.parse(line)
  }
}
