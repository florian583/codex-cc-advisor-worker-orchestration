import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MailboxChannel, type ChannelNotification } from '../src/channel.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

describe('MailboxChannel', () => {
  test('arms the architect side with a named session and injects a routed wake', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'advisor-worker-channel-'))
    temporaryDirectories.push(directory)
    const mailboxPath = join(directory, 'ARCHITECT-QUESTIONS.md')
    await writeFile(mailboxPath, '# Questions\n')

    const notifications: ChannelNotification[] = []
    const channel = new MailboxChannel({
      accountLabel: 'EXAMPLE',
      debounceMs: 20,
      notify: (notification) => notifications.push(notification),
      sessionId: '550e8400-e29b-41d4-a716-44665544000f',
    })

    const armed = channel.arm(mailboxPath)
    expect(armed.identity.title).toBe('EXAMPLE · Advisor · 000F')
    expect(armed.identity.sessionId).toBe('550e8400-e29b-41d4-a716-44665544000f')
    expect(armed.path).toBe(mailboxPath)
    expect(armed.transport).toBe('Claude Code channel')

    await writeFile(mailboxPath, '# Questions\n\n### BLOCKER\n')
    await waitFor(() => notifications.length === 1)

    expect(notifications[0].method).toBe('notifications/claude/channel')
    expect(notifications[0].params.content).toContain(armed.identity.callSign)
    expect(notifications[0].params.content).toContain(mailboxPath)
    expect(notifications[0].params.content).not.toMatch(/[\u{1F3AC}\u{1F4EC}]/u)
    expect(notifications[0].params.meta).toMatchObject({
      mailbox: 'questions',
      role: 'architect',
      session_id: armed.identity.sessionId,
    })

    expect(channel.disarm()).toBe(mailboxPath)
  })

  test('does not synthesize gate progress during mailbox silence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'advisor-worker-silence-'))
    temporaryDirectories.push(directory)
    const questionsPath = join(directory, 'ARCHITECT-QUESTIONS.md')
    await writeFile(questionsPath, '# Questions\n')
    await Bun.sleep(100)

    const notifications: ChannelNotification[] = []
    const channel = new MailboxChannel({
      debounceMs: 20,
      notify: (notification) => notifications.push(notification),
      sessionId: '550e8400-e29b-41d4-a716-446655440012',
    })
    channel.arm(questionsPath)

    await Bun.sleep(100)
    expect(notifications).toEqual([])

    channel.disarm()
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for channel notification')
    await Bun.sleep(10)
  }
}
