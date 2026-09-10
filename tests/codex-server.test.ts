import { afterEach, describe, expect, test } from 'bun:test'
import { mockCodex } from './helpers/mock-codex.ts'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const temporaryDirectories: string[] = []
const mocks: Awaited<ReturnType<typeof mockCodex>>[] = []

afterEach(async () => {
  for (const mock of mocks.splice(0)) await mock.close()
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'advisor-worker-codex-'))
  temporaryDirectories.push(directory)
  const armDir = join(directory, 'armed.d')
  const stateDir = join(directory, 'state')
  const mailboxPath = join(directory, 'ARCHITECT-STEER.md')
  await writeFile(mailboxPath, '# Steer\n')
  const queueBinary = join(directory, 'fake-codex-queue')
  const queueLog = join(directory, 'queue.log')
  await writeFile(queueBinary, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ORCHESTRATION_QUEUE_LOG"\n')
  await chmod(queueBinary, 0o755)
  const mock = await mockCodex()
  mocks.push(mock)
  return {
    armDir,
    directory,
    mailboxPath,
    queueBinary,
    queueLog: mock.log,
    socket: mock.socket,
    stateDir,
  }
}

async function waitForFile(path: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const log = await readFile(path, 'utf8')
      if (log.includes('"method":"turn/steer"')) return log
      await Bun.sleep(50)
    } catch {
      await Bun.sleep(50)
    }
  }
  return readFile(path, 'utf8')
}

describe('Codex advisor/worker MCP server', () => {
  test('arms with an explicit session id, writes the shared armed flag, and waits long-poll style', async () => {
    const { armDir, mailboxPath, stateDir } = await fixture()
    const sessionId = '550e8400-e29b-41d4-a716-446655440020'
    const process = Bun.spawn(['bun', 'run', 'src/server-codex.ts'], {
      cwd: pluginRoot,
      env: {
        ...Bun.env,
        ORCHESTRATION_ACCOUNT_LABEL: 'CODEX',
        ADVISOR_WORKER_ARM_DIR: armDir,
        ORCHESTRATION_CODEX_QUEUE_ENABLED: '0',
        CODEX_ORCHESTRATION_STATE_DIR: stateDir,
      },
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    })
    const client = new JsonRpcClient(process)
    try {
      await client.request(1, 'initialize', {
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
        protocolVersion: '2025-06-18',
      })
      client.notify('notifications/initialized')

      const listed = await client.request(2, 'tools/list', {})
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'arm_advisor_worker_mailbox',
        'wait_advisor_worker_mailbox',
        'disarm_advisor_worker_mailbox',
        'register_fleet_advisor',
        'dispatch_worker_order',
        'notify_fleet_advisor',
      ])

      const armedResponse = await client.request(3, 'tools/call', {
        arguments: { watchPath: mailboxPath, sessionId },
        name: 'arm_advisor_worker_mailbox',
      })
      const armedResult = JSON.parse(armedResponse.result.content[0].text)
      expect(armedResult.identity.sessionId).toBe(sessionId)
      expect(armedResult.identity.role).toBe('Implementer')
      expect(armedResult.identity.title).toMatch(/^CODEX · Worker · [0-9A-F]{4}$/)
      expect(armedResult.path).toBe(mailboxPath)

      // Shared armed flag carries the codex client marker + unread tracking.
      const flag = JSON.parse(await readFile(join(armDir, `${sessionId}.json`), 'utf8'))
      expect(flag).toMatchObject({
        client: 'codex',
        role: 'Implementer',
        sessionId,
        watchPath: mailboxPath,
      })
      expect(flag.lastSeenMtimeMs).toBeGreaterThan(0)

      // A wait issued before the write blocks, then resolves on the change.
      const waitPromise = client.request(4, 'tools/call', {
        arguments: { timeoutSec: 5 },
        name: 'wait_advisor_worker_mailbox',
      })
      await Bun.sleep(300) // let the wait park on the watcher
      await Bun.sleep(1100) // push mtime past the armed-flag epsilon
      await writeFile(mailboxPath, '# Steer\n\nnew order\n')
      const waited = await waitPromise
      const waitResult = JSON.parse(waited.result.content[0].text)
      expect(waitResult.changed).toBe(true)
      expect(waitResult.mailbox).toBe('steer')
      expect(waitResult.session_id).toBe(sessionId)
      expect(waitResult.content).toContain(mailboxPath)

      // lastSeen caught up in the flag → a prompt-hook unread check would be silent.
      const updatedFlag = JSON.parse(await readFile(join(armDir, `${sessionId}.json`), 'utf8'))
      expect(updatedFlag.lastSeenMtimeMs).toBeGreaterThanOrEqual(flag.lastSeenMtimeMs)

      const disarmed = await client.request(5, 'tools/call', {
        arguments: {},
        name: 'disarm_advisor_worker_mailbox',
      })
      expect(JSON.parse(disarmed.result.content[0].text).disarmed).toBe(true)
      await expect(readFile(join(armDir, `${sessionId}.json`), 'utf8')).rejects.toThrow()
    } finally {
      process.kill()
      await process.exited
    }
  }, 15000)

  test('wait returns immediately when the mailbox moved since arm (unread fast path)', async () => {
    const { armDir, mailboxPath, stateDir } = await fixture()
    const sessionId = '550e8400-e29b-41d4-a716-446655440021'
    const process = Bun.spawn(['bun', 'run', 'src/server-codex.ts'], {
      cwd: pluginRoot,
      env: {
        ...Bun.env,
        ADVISOR_WORKER_ARM_DIR: armDir,
        ORCHESTRATION_CODEX_QUEUE_ENABLED: '0',
        CODEX_ORCHESTRATION_STATE_DIR: stateDir,
      },
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    })
    const client = new JsonRpcClient(process)
    try {
      await client.request(1, 'initialize', {
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
        protocolVersion: '2025-06-18',
      })
      client.notify('notifications/initialized')
      await client.request(2, 'tools/call', {
        arguments: { watchPath: mailboxPath, sessionId },
        name: 'arm_advisor_worker_mailbox',
      })
      await Bun.sleep(1100)
      await writeFile(mailboxPath, '# Steer\n\nunread order\n')

      const started = Date.now()
      const waited = await client.request(3, 'tools/call', {
        arguments: { timeoutSec: 30 },
        name: 'wait_advisor_worker_mailbox',
      })
      expect(Date.now() - started).toBeLessThan(3000)
      expect(JSON.parse(waited.result.content[0].text).changed).toBe(true)
    } finally {
      process.kill()
      await process.exited
    }
  }, 15000)

  test('wait times out cleanly and errors when nothing is armed', async () => {
    const { armDir, mailboxPath, stateDir } = await fixture()
    const sessionId = '550e8400-e29b-41d4-a716-446655440022'
    const process = Bun.spawn(['bun', 'run', 'src/server-codex.ts'], {
      cwd: pluginRoot,
      env: {
        ...Bun.env,
        ADVISOR_WORKER_ARM_DIR: armDir,
        ORCHESTRATION_CODEX_QUEUE_ENABLED: '0',
        CODEX_ORCHESTRATION_STATE_DIR: stateDir,
      },
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    })
    const client = new JsonRpcClient(process)
    try {
      await client.request(1, 'initialize', {
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
        protocolVersion: '2025-06-18',
      })
      client.notify('notifications/initialized')

      const unarmedWait = await client.request(2, 'tools/call', {
        arguments: {},
        name: 'wait_advisor_worker_mailbox',
      })
      expect(JSON.stringify(unarmedWait)).toContain('arm_advisor_worker_mailbox')

      await client.request(3, 'tools/call', {
        arguments: { watchPath: mailboxPath, sessionId },
        name: 'arm_advisor_worker_mailbox',
      })
      const started = Date.now()
      const waited = await client.request(4, 'tools/call', {
        arguments: { timeoutSec: 1 },
        name: 'wait_advisor_worker_mailbox',
      })
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
      expect(JSON.parse(waited.result.content[0].text).changed).toBe(false)
    } finally {
      process.kill()
      await process.exited
    }
  }, 15000)

  test('steers one direct reread instruction when a busy session mailbox changes', async () => {
    const { armDir, mailboxPath, queueBinary, queueLog, socket, stateDir } = await fixture()
    const sessionId = '550e8400-e29b-41d4-a716-446655440023'
    const process = Bun.spawn(['bun', 'run', 'src/server-codex.ts'], {
      cwd: pluginRoot,
      env: {
        ...Bun.env,
        ADVISOR_WORKER_ARM_DIR: armDir,
        ORCHESTRATION_CODEX_QUEUE_BINARY: queueBinary,
        ORCHESTRATION_QUEUE_LOG: queueLog,
        ORCHESTRATION_CODEX_APP_SERVER_SOCKET: socket,
        CODEX_ORCHESTRATION_STATE_DIR: stateDir,
      },
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    })
    const client = new JsonRpcClient(process)
    try {
      await client.request(1, 'initialize', {
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
        protocolVersion: '2025-06-18',
      })
      client.notify('notifications/initialized')
      await client.request(2, 'tools/call', {
        arguments: { watchPath: mailboxPath, sessionId },
        name: 'arm_advisor_worker_mailbox',
      })

      await Bun.sleep(1100)
      await writeFile(mailboxPath, '# Steer\n\nsteered order\n')
      const queued = await waitForFile(queueLog)
      expect(queued).toContain('"method":"turn/steer"')
      expect(queued).toContain(sessionId)
      expect(queued).toContain('STEER mailbox changed')
      expect(queued).toContain(mailboxPath)
    } finally {
      process.kill()
      await process.exited
    }
  }, 15000)

  test('routes fleet dispatches in both directions through exact armed sessions', async () => {
    const { armDir, directory, queueBinary, queueLog, socket, stateDir } = await fixture()
    const fleetRoot = join(directory, 'fleet')
    const workerDir = join(fleetRoot, 'workers', 'w1')
    const steerPath = join(workerDir, 'ARCHITECT-STEER.md')
    const questionsPath = join(workerDir, 'ARCHITECT-QUESTIONS.md')
    await mkdir(workerDir, { recursive: true })
    await writeFile(steerPath, '# Steer\n')
    await writeFile(questionsPath, '# Questions\n')
    const advisorSessionId = '550e8400-e29b-41d4-a716-446655440024'
    const workerSessionId = '550e8400-e29b-41d4-a716-446655440025'
    const process = Bun.spawn(['bun', 'run', 'src/server-codex.ts'], {
      cwd: pluginRoot,
      env: {
        ...Bun.env,
        ADVISOR_WORKER_ARM_DIR: armDir,
        ORCHESTRATION_CODEX_QUEUE_BINARY: queueBinary,
        ORCHESTRATION_QUEUE_LOG: queueLog,
        ORCHESTRATION_CODEX_APP_SERVER_SOCKET: socket,
        CODEX_ORCHESTRATION_STATE_DIR: stateDir,
      },
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    })
    const client = new JsonRpcClient(process)
    try {
      await client.request(1, 'initialize', {
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
        protocolVersion: '2025-06-18',
      })
      client.notify('notifications/initialized')
      const registered = await client.request(2, 'tools/call', {
        arguments: { fleetRoot, sessionId: advisorSessionId },
        name: 'register_fleet_advisor',
      })
      expect(JSON.parse(registered.result.content[0].text)).toMatchObject({ fleetRoot })
      await writeFile(
        join(armDir, `${workerSessionId}.json`),
        JSON.stringify({
          armedAt: new Date().toISOString(),
          client: 'codex',
          role: 'Implementer',
          sessionId: workerSessionId,
          watchPath: steerPath,
          appServerSocket: socket,
        }),
      )
      const dispatch = await client.request(3, 'tools/call', {
        arguments: { steerPath },
        name: 'dispatch_worker_order',
      })
      expect(JSON.parse(dispatch.result.content[0].text)).toEqual({
        status: 'steered',
        sessionId: workerSessionId,
        turnId: 'turn-0',
      })
      const notify = await client.request(4, 'tools/call', {
        arguments: { fleetRoot, questionsPath },
        name: 'notify_fleet_advisor',
      })
      expect(JSON.parse(notify.result.content[0].text)).toEqual({
        status: 'steered',
        sessionId: advisorSessionId,
        turnId: 'turn-1',
      })
      const queued = await waitForFile(queueLog)
      expect(queued).toContain(workerSessionId)
      expect(queued).toContain(advisorSessionId)
    } finally {
      process.kill()
      await process.exited
    }
  }, 15000)
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
