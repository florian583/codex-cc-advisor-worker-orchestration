import { afterEach, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mockCodex } from './helpers/mock-codex.ts'
import { wakeCodexAdvisor, wakeCodexWorker } from '../src/codex-queue.ts'
const mocks: Awaited<ReturnType<typeof mockCodex>>[] = []
const initialStateDir = process.env.CODEX_ORCHESTRATION_STATE_DIR
afterEach(async () => {
  for (const mock of mocks.splice(0)) await mock.close()
  if (initialStateDir === undefined) delete process.env.CODEX_ORCHESTRATION_STATE_DIR
  else process.env.CODEX_ORCHESTRATION_STATE_DIR = initialStateDir
})
async function fixture() {
  const mock = await mockCodex()
  mocks.push(mock)
  process.env.CODEX_ORCHESTRATION_STATE_DIR = mock.directory
  const armDir = join(mock.directory, 'armed.d')
  const steerPath = join(mock.directory, 'ARCHITECT-STEER.md')
  await mkdir(armDir)
  await writeFile(steerPath, 'order')
  return { mock, armDir, steerPath }
}
test('ambiguous exact-path workers fail closed rather than choosing newest', async () => {
  const { mock, armDir, steerPath } = await fixture()
  for (const sessionId of ['old', 'new'])
    await writeFile(
      join(armDir, sessionId + '.json'),
      JSON.stringify({
        client: 'codex',
        role: 'Implementer',
        sessionId,
        watchPath: steerPath,
        appServerSocket: mock.socket,
      }),
    )
  expect(await wakeCodexWorker({ armDir, steerPath })).toEqual({ status: 'ambiguous-recipient' })
  expect(await mock.messages()).toEqual([])
})
test('missing recipient never creates a session', async () => {
  const { armDir, steerPath } = await fixture()
  expect(await wakeCodexWorker({ armDir, steerPath })).toEqual({ status: 'no-recipient' })
})
test('exact worker receives steer; unrelated path and Claude records ignored', async () => {
  const { mock, armDir, steerPath } = await fixture()
  await writeFile(
    join(armDir, 'worker.json'),
    JSON.stringify({
      client: 'codex',
      role: 'Implementer',
      sessionId: 'worker',
      watchPath: steerPath,
      appServerSocket: mock.socket,
    }),
  )
  await writeFile(
    join(armDir, 'other.json'),
    JSON.stringify({
      client: 'codex',
      role: 'Implementer',
      sessionId: 'other',
      watchPath: '/other/ARCHITECT-STEER.md',
      appServerSocket: mock.socket,
    }),
  )
  expect(await wakeCodexWorker({ armDir, steerPath })).toEqual({
    status: 'steered',
    sessionId: 'worker',
    turnId: 'turn-0',
  })
})
test('exact fleet advisor receives QUESTIONS via steering', async () => {
  const { mock, armDir } = await fixture()
  const questionsPath = join(mock.directory, 'ARCHITECT-QUESTIONS.md')
  await writeFile(questionsPath, 'done')
  await writeFile(
    join(armDir, 'advisor.json'),
    JSON.stringify({
      client: 'codex',
      role: 'Architect',
      sessionId: 'advisor',
      fleetRoot: mock.directory,
      appServerSocket: mock.socket,
    }),
  )
  expect(await wakeCodexAdvisor({ armDir, fleetRoot: mock.directory, questionsPath })).toEqual({
    status: 'steered',
    sessionId: 'advisor',
    turnId: 'turn-0',
  })
})
