// Bun substitutes bare `ws` with a shim lacking ws+unix support.
import WebSocket from '../node_modules/ws/index.js'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export type WakeResult =
  | { status: 'steered' | 'started' | 'already-delivered'; sessionId: string; turnId?: string }
  | {
      status:
        | 'unavailable'
        | 'not-loaded'
        | 'not-steerable'
        | 'delivery-unknown'
        | 'busy'
        | 'failed'
      sessionId: string
      reason?: string
    }
  | { status: 'no-recipient' | 'ambiguous-recipient' }

export class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

// Private Unix socket only. No ports, remote authentication, or approval grants.
export class CodexRpc {
  private ws: WebSocket
  private id = 0
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private opened: Promise<void>
  private timeoutMs: number
  constructor(socket: string, timeoutMs = 5000) {
    this.timeoutMs = timeoutMs
    if (!isAbsolute(socket) || /[:?\r\n]/.test(socket))
      throw new Error('Invalid private socket path')
    this.ws = new WebSocket(`ws+unix:${socket}:/`, {
      maxPayload: 4 << 20,
      perMessageDeflate: false,
      handshakeTimeout: timeoutMs,
    })
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.ws.on('error', () => this.rejectPending())
    this.ws.on('close', () => this.rejectPending())
    this.ws.on('message', (data) => {
      let message: any
      try {
        message = JSON.parse(data.toString())
      } catch {
        this.close()
        return
      }
      // Never approve commands or mutate policy on behalf of the user.
      if (message.method && message.id != null) return // Interactive turn owner answers; never race it with a rejection.
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new RpcError(message.error.code, message.error.message))
      else pending.resolve(message.result)
    })
  }
  async ready() {
    await this.opened
    await this.request('initialize', {
      clientInfo: { name: 'advisor_worker_steering', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    })
    this.ws.send(JSON.stringify({ method: 'initialized', params: {} }))
  }
  request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('App Server disconnected'))
        return
      }
      const id = ++this.id
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('App Server acknowledgment timed out'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }
  private rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('App Server disconnected'))
    }
    this.pending.clear()
  }
  close() {
    this.rejectPending()
    this.ws.terminate()
  }
}

export async function sendSteering(
  socket: string,
  sessionId: string,
  message: string,
  eventId: string,
): Promise<WakeResult> {
  let rpc: CodexRpc | undefined
  let sent = false
  try {
    rpc = new CodexRpc(socket)
    await rpc.ready()
    // Do not resume/create a saved thread on a different server. The exact
    // recipient must already be loaded on the endpoint recorded when armed.
    for (let retry = 0; retry < 2; retry++) {
      const { thread } = await rpc.request('thread/read', {
        threadId: sessionId,
        includeTurns: false,
      })
      if (thread.id !== sessionId || thread.status?.type === 'notLoaded')
        return { status: 'not-loaded', sessionId }
      const input = [{ type: 'text', text: message, text_elements: [] }]
      let method: string, params: any
      if (thread.status?.type === 'active') {
        const page = await rpc.request('thread/turns/list', {
          threadId: sessionId,
          limit: 1,
          sortDirection: 'desc',
          itemsView: 'summary',
        })
        const turn = page.data?.[0]
        if (!turn || turn.status !== 'inProgress') continue
        method = 'turn/steer'
        params = {
          threadId: sessionId,
          expectedTurnId: turn.id,
          input,
          clientUserMessageId: eventId,
        }
      } else if (thread.status?.type === 'idle') {
        method = 'turn/start'
        // Reuse this loaded thread's policy/model. Never create a new thread,
        // override approvals, or answer server approval requests from the bridge.
        params = { threadId: sessionId, input, clientUserMessageId: eventId }
      } else return { status: 'not-steerable', sessionId }
      try {
        sent = true
        const response = await rpc.request(method, params)
        const turnId = response.turnId ?? response.turn?.id
        if (!turnId)
          return { status: 'delivery-unknown', sessionId, reason: 'missing-turn-acknowledgment' }
        return { status: method === 'turn/steer' ? 'steered' : 'started', sessionId, turnId }
      } catch (error) {
        // An explicit rejection did not deliver input. Re-read once for a
        // turn-ended/turn-id race. Timeouts/disconnects are ambiguous: no replay.
        if (error instanceof RpcError && error.code === -32600) {
          sent = false
          continue
        }
        return { status: error instanceof RpcError ? 'failed' : 'delivery-unknown', sessionId }
      }
    }
    return { status: 'not-steerable', sessionId }
  } catch {
    return { status: sent ? 'delivery-unknown' : 'unavailable', sessionId }
  } finally {
    rpc?.close()
  }
}

// Shared receipts suppress a watcher wake plus an explicit peer notification
// for the same content. No queued inference; a busy lock is reported honestly.
export async function deliverMailbox(args: {
  socket?: string
  sessionId: string
  mailboxPath: string
  message: string
  stateDir?: string
}): Promise<WakeResult> {
  const { sessionId, mailboxPath } = args
  if (!args.socket)
    return {
      status: 'unavailable',
      sessionId,
      reason: 'no-app-server-socket; relaunch with codex-orchestrated',
    }
  const stateDir =
    args.stateDir ??
    process.env.CODEX_ORCHESTRATION_STATE_DIR ??
    join(homedir(), '.codex', 'advisor-worker-orchestration')
  const dir = join(stateDir, 'delivery-receipts')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const key = createHash('sha256').update(`${sessionId}\0${mailboxPath}`).digest('hex')
  const lockPath = join(dir, `${key}.lock`),
    receiptPath = join(dir, `${key}.json`)
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch {
    return { status: 'busy', sessionId, reason: 'delivery-lock-held' }
  }
  try {
    if ((await stat(mailboxPath)).size > 8 << 20)
      return { status: 'failed', sessionId, reason: 'mailbox-too-large' }
    const hash = createHash('sha256')
      .update(await readFile(mailboxPath))
      .digest('hex')
    let prior: any
    try {
      prior = JSON.parse(await readFile(receiptPath, 'utf8'))
    } catch {}
    if (prior?.hash === hash)
      return prior.result.status === 'delivery-unknown'
        ? {
            status: 'delivery-unknown',
            sessionId,
            reason: 'prior-acknowledgment-unknown; inspect before retrying',
          }
        : { status: 'already-delivered', sessionId, turnId: prior.result.turnId }
    // Run the Unix WebSocket client in Node: Bun's HTTP upgrade is incompatible.
    // Write intent first: a crash after sending but before acknowledgment must
    // not permit a blind duplicate on restart. Failed known delivery clears it.
    await writeFile(
      receiptPath,
      JSON.stringify({
        hash,
        result: { status: 'delivery-unknown' },
        at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    )
    const result = await sendViaNode(
      args.socket,
      sessionId,
      args.message,
      `mailbox-${key.slice(0, 16)}-${hash.slice(0, 24)}`,
    )
    if (['steered', 'started', 'delivery-unknown'].includes(result.status)) {
      await writeFile(receiptPath, JSON.stringify({ hash, result, at: new Date().toISOString() }), {
        mode: 0o600,
      })
    } else await rm(receiptPath, { force: true })
    return result
  } catch {
    return { status: 'failed', sessionId }
  } finally {
    await lock.close()
    await rm(lockPath, { force: true })
  }
}

function sendViaNode(
  socket: string,
  sessionId: string,
  message: string,
  eventId: string,
): Promise<WakeResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.env.ORCHESTRATION_NODE_BINARY ?? 'node',
      [fileURLToPath(new URL('./codex-steer-cli.ts', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    )
    let output = ''
    let spawned = false
    child.once('spawn', () => {
      spawned = true
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), 35000)
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.length > 65536) child.kill('SIGTERM')
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve({ status: 'unavailable', sessionId, reason: 'node-runtime-unavailable' })
    })
    child.once('close', () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(output))
      } catch {
        resolve({
          status: spawned ? 'delivery-unknown' : 'unavailable',
          sessionId,
          reason: 'bridge-exited-without-acknowledgment',
        })
      }
    })
    child.stdin.end(JSON.stringify({ socket, sessionId, message, eventId }))
  })
}
