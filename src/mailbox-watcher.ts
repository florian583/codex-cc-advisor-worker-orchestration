import { statSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, isAbsolute, normalize } from 'node:path'

const MAILBOX_NAMES = new Set(['ARCHITECT-QUESTIONS.md', 'ARCHITECT-STEER.md'])

type MailboxWatcherOptions = {
  debounceMs?: number
  onChange: (path: string) => Promise<void> | void
  onError?: (error: unknown) => void
}

export class MailboxWatcher {
  readonly #debounceMs: number
  readonly #onChange: MailboxWatcherOptions['onChange']
  readonly #onError: NonNullable<MailboxWatcherOptions['onError']>
  #path: string | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #watcher: FSWatcher | null = null

  constructor(options: MailboxWatcherOptions) {
    this.#debounceMs = options.debounceMs ?? 200
    this.#onChange = options.onChange
    this.#onError = options.onError ?? (() => undefined)
  }

  get path(): string | null {
    return this.#path
  }

  arm(inputPath: string): string {
    const mailboxPath = validateMailboxPath(inputPath)
    const fileStat = statSync(mailboxPath)
    if (!fileStat.isFile()) throw new Error(`Mailbox path is not a regular file: ${mailboxPath}`)
    if (this.#path === mailboxPath && this.#watcher) return mailboxPath

    this.disarm()
    this.#path = mailboxPath
    const targetName = basename(mailboxPath)
    this.#watcher = watch(dirname(mailboxPath), (event, filename) => {
      if (filename !== null && filename.toString() !== targetName) return
      if (event !== 'change' && event !== 'rename') return
      this.#scheduleWake()
    })
    this.#watcher.on('error', this.#onError)
    return mailboxPath
  }

  disarm(): string | null {
    const previousPath = this.#path
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#watcher?.close()
    this.#watcher = null
    this.#path = null
    return previousPath
  }

  #scheduleWake(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      if (!this.#path) return
      // Catch synchronous callbacks as well as rejected asynchronous callbacks.
      const path = this.#path
      void Promise.resolve()
        .then(() => this.#onChange(path))
        .catch(this.#onError)
    }, this.#debounceMs)
  }
}

export function validateMailboxPath(inputPath: string): string {
  if (!isAbsolute(inputPath)) throw new Error('Mailbox path must be absolute')
  const mailboxPath = normalize(inputPath)
  if (!MAILBOX_NAMES.has(basename(mailboxPath))) {
    throw new Error('Mailbox filename must be ARCHITECT-QUESTIONS.md or ARCHITECT-STEER.md')
  }
  return mailboxPath
}
