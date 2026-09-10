import { basename } from 'node:path'

import { sessionIdentity, type SessionIdentity } from './identity.ts'
import { MailboxWatcher } from './mailbox-watcher.ts'

export type ChannelNotification = {
  method: 'notifications/claude/channel'
  params: {
    content: string
    meta: Record<string, string>
  }
}

type MailboxChannelOptions = {
  accountLabel?: string
  debounceMs?: number
  notify: (notification: ChannelNotification) => Promise<void> | void
  onError?: (error: unknown) => void
  sessionId: string
}

type ArmedMailbox = {
  identity: SessionIdentity
  path: string
  transport: 'Claude Code channel'
}

export class MailboxChannel {
  readonly #accountLabel?: string
  readonly #notify: MailboxChannelOptions['notify']
  readonly #sessionId: string
  readonly #watcher: MailboxWatcher
  #armed: ArmedMailbox | null = null

  constructor(options: MailboxChannelOptions) {
    this.#accountLabel = options.accountLabel
    this.#notify = options.notify
    this.#sessionId = options.sessionId
    this.#watcher = new MailboxWatcher({
      debounceMs: options.debounceMs,
      onChange: (path) => this.#wake(path),
      onError: options.onError,
    })
  }

  arm(path: string): ArmedMailbox {
    const watchedPath = this.#watcher.arm(path)
    const role = roleForMailbox(watchedPath)
    this.#armed = {
      identity: sessionIdentity(this.#sessionId, role, this.#accountLabel),
      path: watchedPath,
      transport: 'Claude Code channel',
    }
    return this.#armed
  }

  disarm(): string | null {
    this.#armed = null
    return this.#watcher.disarm()
  }

  async #wake(path: string): Promise<void> {
    if (!this.#armed || this.#armed.path !== path) return
    const isArchitect = this.#armed.identity.role === 'Architect'
    const mailbox = isArchitect ? 'questions' : 'steer'
    const action = isArchitect
      ? 'Load the architect mailbox orchestrator skill, reread QUESTIONS newest-first, verify reported evidence, and write any answer or next order only in STEER.'
      : 'Load the architect mailbox implementer skill, reread STEER newest-first, reconcile the newest order with in-flight work, acknowledge it in QUESTIONS, and continue.'

    await this.#notify({
      method: 'notifications/claude/channel',
      params: {
        content: `${this.#armed.identity.callSign}: ${mailbox} mailbox changed at ${path}. ${action}`,
        meta: {
          mailbox,
          role: this.#armed.identity.role.toLowerCase(),
          session_id: this.#armed.identity.sessionId,
        },
      },
    })
  }
}

function roleForMailbox(path: string): 'Architect' | 'Implementer' {
  return basename(path) === 'ARCHITECT-QUESTIONS.md' ? 'Architect' : 'Implementer'
}
