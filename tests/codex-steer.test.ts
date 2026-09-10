import { afterEach, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deliverMailbox } from '../src/codex-steer.ts'
import { mockCodex } from './helpers/mock-codex.ts'
const mocks: Awaited<ReturnType<typeof mockCodex>>[] = []
afterEach(async () => {
  for (const mock of mocks.splice(0)) await mock.close()
})
async function fixture(mode = 'active') {
  const mock = await mockCodex(mode)
  mocks.push(mock)
  const mailboxPath = join(mock.directory, 'ARCHITECT-QUESTIONS.md')
  await writeFile(mailboxPath, 'worker done')
  return {
    mock,
    args: {
      socket: mock.socket,
      sessionId: 'exact-session',
      mailboxPath,
      stateDir: mock.directory,
      message: `Read ${mailboxPath}`,
    },
  }
}
test('steers the exact active turn without queue, start, resume, or permission overrides', async () => {
  const { mock, args } = await fixture()
  expect(await deliverMailbox(args)).toEqual({
    status: 'steered',
    sessionId: args.sessionId,
    turnId: 'turn-0',
  })
  const messages = await mock.messages()
  expect(messages.map((m) => m.method)).toEqual([
    'initialize',
    'thread/read',
    'thread/turns/list',
    'turn/steer',
  ])
  expect(messages[3].params).toEqual({
    threadId: args.sessionId,
    expectedTurnId: 'turn-0',
    input: [{ type: 'text', text: args.message, text_elements: [] }],
    clientUserMessageId: expect.any(String),
  })
  expect((await deliverMailbox(args)).status).toBe('already-delivered')
  expect((await mock.messages()).length).toBe(4)
  await writeFile(args.mailboxPath, 'worker revision two')
  expect((await deliverMailbox(args)).status).toBe('steered')
})
test('explicit turn-id rejection re-reads once and steers the new active turn', async () => {
  const { mock, args } = await fixture('race')
  expect(await deliverMailbox(args)).toMatchObject({ status: 'steered', turnId: 'turn-1' })
  expect((await mock.messages()).filter((m) => m.method === 'turn/steer').length).toBe(2)
})
test('idle thread starts exactly one new turn with inherited policy and deduplicates', async () => {
  const { mock, args } = await fixture('idle')
  expect(await deliverMailbox(args)).toMatchObject({ status: 'started', turnId: 'started-1' })
  expect((await deliverMailbox(args)).status).toBe('already-delivered')
  const messages = await mock.messages()
  expect(messages.map((m) => m.method)).toEqual(['initialize', 'thread/read', 'turn/start'])
  expect(Object.keys(messages[2].params).sort()).toEqual([
    'clientUserMessageId',
    'input',
    'threadId',
  ])
  expect(messages[2].params.threadId).toBe(args.sessionId)
})
for (const mode of ['not-loaded', 'wrong-thread', 'reject'])
  test(`${mode} fails closed with no invented turn`, async () => {
    const { mock, args } = await fixture(mode)
    expect((await deliverMailbox(args)).status).toBe(
      ['not-loaded', 'wrong-thread'].includes(mode) ? 'not-loaded' : 'not-steerable',
    )
    expect(
      (await mock.messages()).some((m) => ['turn/start', 'thread/resume'].includes(m.method)),
    ).toBe(false)
  })
test('lost acknowledgment is durable unknown, never blindly replayed', async () => {
  const { mock, args } = await fixture('disconnect')
  expect((await deliverMailbox(args)).status).toBe('delivery-unknown')
  expect((await deliverMailbox(args)).status).toBe('delivery-unknown')
  expect((await mock.messages()).filter((m) => m.method === 'turn/steer').length).toBe(1)
})
test('idle wake acknowledgment loss never starts a duplicate turn', async () => {
  const { mock, args } = await fixture('idle-disconnect')
  expect((await deliverMailbox(args)).status).toBe('delivery-unknown')
  expect((await deliverMailbox(args)).status).toBe('delivery-unknown')
  expect((await mock.messages()).filter((m) => m.method === 'turn/start')).toHaveLength(1)
})
test('idle-to-active explicit rejection falls back to steering the active turn', async () => {
  const { mock, args } = await fixture('idle-race')
  expect((await deliverMailbox(args)).status).toBe('steered')
  expect((await mock.messages()).map((m) => m.method)).toEqual([
    'initialize',
    'thread/read',
    'turn/start',
    'thread/read',
    'thread/turns/list',
    'turn/steer',
  ])
})
test('missing endpoint reports unavailable, leaves content eligible for later delivery', async () => {
  const { args } = await fixture()
  expect((await deliverMailbox({ ...args, socket: undefined })).status).toBe('unavailable')
  expect((await deliverMailbox(args)).status).toBe('steered')
})
test('overlapping notify and watcher sends do not duplicate delivery', async () => {
  const { mock, args } = await fixture()
  const results = await Promise.all([deliverMailbox(args), deliverMailbox(args)])
  expect(results.map((r) => r.status).sort()).toEqual(['busy', 'steered'])
  expect((await mock.messages()).filter((m) => m.method === 'turn/steer').length).toBe(1)
})
