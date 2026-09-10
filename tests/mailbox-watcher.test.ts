import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MailboxWatcher, validateMailboxPath } from '../src/mailbox-watcher.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

describe('validateMailboxPath', () => {
  test('accepts absolute architect protocol mailbox files', () => {
    expect(validateMailboxPath('/tmp/mission/ARCHITECT-QUESTIONS.md')).toBe(
      '/tmp/mission/ARCHITECT-QUESTIONS.md',
    )
    expect(validateMailboxPath('/tmp/mission/ARCHITECT-STEER.md')).toBe(
      '/tmp/mission/ARCHITECT-STEER.md',
    )
  })

  test('rejects relative and unrelated paths', () => {
    expect(() => validateMailboxPath('ARCHITECT-QUESTIONS.md')).toThrow('absolute')
    expect(() => validateMailboxPath('/tmp/mission/notes.md')).toThrow(
      'ARCHITECT-QUESTIONS.md or ARCHITECT-STEER.md',
    )
  })
})

describe('MailboxWatcher', () => {
  test('reports synchronous callback errors without an uncaught exception', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'advisor-worker-callback-'))
    temporaryDirectories.push(directory)
    const mailboxPath = join(directory, 'ARCHITECT-STEER.md')
    await writeFile(mailboxPath, 'initial')
    const errors: unknown[] = []
    const watcher = new MailboxWatcher({
      debounceMs: 10,
      onChange: () => {
        throw new Error('callback failed')
      },
      onError: (error) => errors.push(error),
    })
    try {
      watcher.arm(mailboxPath)
      await writeFile(mailboxPath, 'changed')
      await waitFor(() => errors.length === 1)
      expect(String(errors[0])).toContain('callback failed')
    } finally {
      watcher.disarm()
    }
  })
  test('emits one wake for a burst of writes and also wakes on a later edit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'advisor-worker-mailbox-'))
    temporaryDirectories.push(directory)
    const mailboxPath = join(directory, 'ARCHITECT-QUESTIONS.md')
    await writeFile(mailboxPath, '# Questions\n')

    const events: string[] = []
    const watcher = new MailboxWatcher({ debounceMs: 30, onChange: (path) => events.push(path) })
    watcher.arm(mailboxPath)

    await writeFile(mailboxPath, '# Questions\n\nfirst\n')
    await writeFile(mailboxPath, '# Questions\n\nsecond\n')
    await waitFor(() => events.length === 1)
    expect(events).toEqual([mailboxPath])

    // Metadata-only touches are not reported consistently by Bun on Linux.
    await writeFile(mailboxPath, '# Questions\n\nthird\n')
    await waitFor(() => events.length === 2)
    expect(events).toEqual([mailboxPath, mailboxPath])

    watcher.disarm()
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for mailbox event')
    await Bun.sleep(10)
  }
}
