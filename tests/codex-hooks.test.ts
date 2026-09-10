import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const node = process.execPath // bun runs the hooks; the hooks are plain ESM
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function fixture(role = 'Implementer') {
  const directory = await mkdtemp(join(tmpdir(), 'advisor-worker-codex-hooks-'))
  temporaryDirectories.push(directory)
  const armDir = join(directory, 'armed.d')
  const stateDir = join(directory, 'state')
  const mailboxPath = join(directory, 'ARCHITECT-STEER.md')
  await writeFile(mailboxPath, '# Steer\n')
  const sessionId = '550e8400-e29b-41d4-a716-446655440030'
  return { armDir, directory, mailboxPath, role, sessionId, stateDir }
}

async function armFlag(f: Awaited<ReturnType<typeof fixture>>, lastSeenMtimeMs: number) {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(f.armDir, { recursive: true })
  await writeFile(
    join(f.armDir, `${f.sessionId}.json`),
    JSON.stringify({
      role: f.role,
      callSign: 'Worker · TEST',
      accountLabel: 'CODEX',
      sessionId: f.sessionId,
      client: 'codex',
      watchPath: f.mailboxPath,
      lastSeenMtimeMs,
      armedAt: new Date().toISOString(),
    }) + '\n',
  )
}

function runHook(script: string, payload: unknown, env: Record<string, string | undefined>) {
  return Bun.spawn([node, join(pluginRoot, 'codex-hooks', script)], {
    env: {
      ...process.env,
      ...(env.ADVISOR_WORKER_ARM_DIR
        ? { CODEX_ORCHESTRATION_STATE_DIR: join(dirname(env.ADVISOR_WORKER_ARM_DIR), 'state') }
        : {}),
      ...env,
    } as Record<string, string>,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function settle(child: ReturnType<typeof Bun.spawn>, input: string) {
  child.stdin.write(input)
  child.stdin.end()
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return { code, stdout }
}

describe('codex session-start hook', () => {
  test('records the session and injects the role identity when ORCHESTRATION_CODEX=1', async () => {
    const f = await fixture()
    const child = runHook(
      'session-start.mjs',
      { session_id: f.sessionId, cwd: f.directory, source: 'startup' },
      {
        ORCHESTRATION_CODEX: '1',
        ORCHESTRATION_ACCOUNT_LABEL: 'CDX',
        ORCHESTRATION_ROLE: 'Implementer',
        ORCHESTRATION_TAB_TITLE: '0',
        CODEX_ORCHESTRATION_STATE_DIR: f.stateDir,
      },
    )
    const { code, stdout } = await settle(
      child,
      JSON.stringify({ session_id: f.sessionId, cwd: f.directory, source: 'startup' }),
    )
    expect(code).toBe(0)
    const output = JSON.parse(stdout)
    const context = output.hookSpecificOutput.additionalContext
    expect(context).toContain('CDX ·')
    expect(context).toContain('CDX · Worker')
    expect(context).toContain(f.sessionId)
    expect(context).toContain('wait_advisor_worker_mailbox')
    expect(context).toContain('Worker contract:')
    expect(context).toContain('App Server turn/steer')

    const record = JSON.parse(
      await readFile(join(f.stateDir, 'sessions.d', `${f.sessionId}.json`), 'utf8'),
    )
    expect(record).toMatchObject({ cwd: f.directory, role: 'Implementer', sessionId: f.sessionId })
  })

  test('stays silent without ORCHESTRATION_CODEX=1', async () => {
    const f = await fixture()
    const child = runHook(
      'session-start.mjs',
      {},
      { CODEX_ORCHESTRATION_STATE_DIR: f.stateDir, ORCHESTRATION_CODEX: undefined },
    )
    const { code, stdout } = await settle(
      child,
      JSON.stringify({ session_id: f.sessionId, cwd: f.directory }),
    )
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('')
    await expect(
      readFile(join(f.stateDir, 'sessions.d', `${f.sessionId}.json`), 'utf8'),
    ).rejects.toThrow()
  })

  test('injects the advisor QA mandate for an Architect session', async () => {
    const f = await fixture()
    const child = runHook(
      'session-start.mjs',
      { session_id: f.sessionId, cwd: f.directory, source: 'startup' },
      {
        ORCHESTRATION_CODEX: '1',
        ORCHESTRATION_ROLE: 'Architect',
        ORCHESTRATION_TAB_TITLE: '0',
        CODEX_ORCHESTRATION_STATE_DIR: f.stateDir,
      },
    )
    const { code, stdout } = await settle(
      child,
      JSON.stringify({ session_id: f.sessionId, cwd: f.directory }),
    )
    expect(code).toBe(0)
    const context = JSON.parse(stdout).hookSpecificOutput.additionalContext
    expect(context).toContain('Advisor QA mandate:')
    expect(context).toContain('discover review capability')
    expect(context).toContain('approved independent review')
    expect(context).not.toContain('Brainstorm')
    expect(context).toContain('GO / GO-WITH-NITS / NO-GO')
  })
})

describe('codex stop hook (unread gate)', () => {
  test('successful delivery suppresses both hooks; unknown and changed revisions recover once', async () => {
    for (const status of ['started', 'steered', 'delivery-unknown', 'failed']) {
      const f = await fixture()
      await armFlag(f, 0)
      const dir = join(f.stateDir, 'delivery-receipts')
      await mkdir(dir, { recursive: true })
      const key = createHash('sha256').update(`${f.sessionId}\0${f.mailboxPath}`).digest('hex')
      const hash = createHash('sha256')
        .update(await readFile(f.mailboxPath))
        .digest('hex')
      await writeFile(
        join(dir, `${key}.json`),
        JSON.stringify({ hash, result: { status, sessionId: f.sessionId } }),
      )
      const env = { ADVISOR_WORKER_ARM_DIR: f.armDir }
      const invoke = async (script: string) =>
        settle(runHook(script, {}, env), JSON.stringify({ session_id: f.sessionId }))
      for (const script of ['stop.mjs', 'prompt-notice.mjs']) {
        const first = await invoke(script)
        expect(first.code).toBe(0)
        expect(Boolean(first.stdout)).toBe(!['started', 'steered'].includes(status))
        expect((await invoke(script)).stdout).toBe('')
      }
      await writeFile(f.mailboxPath, 'new revision')
      const recovery = JSON.parse((await invoke('stop.mjs')).stdout)
      expect(recovery.reason).toContain('does not prove it is unread')
      expect(recovery.reason).toContain('Then finish your turn')
      expect((await invoke('stop.mjs')).stdout).toBe('')
      const flag = JSON.parse(await readFile(join(f.armDir, `${f.sessionId}.json`), 'utf8'))
      expect(flag.lastSeenMtimeMs).toBe(0)
    }
  })

  test('blocks the stop while the mailbox is unread', async () => {
    const f = await fixture()
    await armFlag(f, 0) // armed but never seen the current content
    const child = runHook('stop.mjs', {}, { ADVISOR_WORKER_ARM_DIR: f.armDir })
    const { code, stdout } = await settle(
      child,
      JSON.stringify({ session_id: f.sessionId, stop_hook_active: false }),
    )
    expect(code).toBe(0)
    const output = JSON.parse(stdout)
    expect(output.decision).toBe('block')
    expect(output.reason).toContain('ARCHITECT-STEER.md')
    expect(output.reason.toLowerCase()).toContain('implementer')
  })

  test('allows the stop when caught up, on the second attempt, or unarmed', async () => {
    const f = await fixture()
    const { stat } = await import('node:fs/promises')
    const mtime = (await stat(f.mailboxPath)).mtimeMs
    await armFlag(f, mtime)

    const caughtUp = runHook('stop.mjs', {}, { ADVISOR_WORKER_ARM_DIR: f.armDir })
    expect(
      (await settle(caughtUp, JSON.stringify({ session_id: f.sessionId }))).stdout.trim(),
    ).toBe('')

    await armFlag(f, 0)
    const secondAttempt = runHook('stop.mjs', {}, { ADVISOR_WORKER_ARM_DIR: f.armDir })
    expect(
      (
        await settle(
          secondAttempt,
          JSON.stringify({ session_id: f.sessionId, stop_hook_active: true }),
        )
      ).stdout.trim(),
    ).toBe('')

    const unarmed = runHook('stop.mjs', {}, { ADVISOR_WORKER_ARM_DIR: f.armDir })
    expect(
      (await settle(unarmed, JSON.stringify({ session_id: 'no-such-session' }))).stdout.trim(),
    ).toBe('')
  })
})

describe('codex prompt-notice hook', () => {
  test('notices an unread mailbox once per mtime', async () => {
    const f = await fixture()
    await armFlag(f, 0)
    const env = { ADVISOR_WORKER_ARM_DIR: f.armDir }

    const first = runHook('prompt-notice.mjs', {}, env)
    const firstOut = JSON.parse(
      (await settle(first, JSON.stringify({ session_id: f.sessionId }))).stdout,
    )
    expect(firstOut.hookSpecificOutput.additionalContext).toContain('ARCHITECT-STEER.md')

    const second = runHook('prompt-notice.mjs', {}, env)
    expect((await settle(second, JSON.stringify({ session_id: f.sessionId }))).stdout.trim()).toBe(
      '',
    )

    // A new mailbox revision re-arms the notice.
    await Bun.sleep(1100)
    await writeFile(f.mailboxPath, '# Steer\n\nnewer order\n')
    const third = runHook('prompt-notice.mjs', {}, env)
    const thirdOut = (await settle(third, JSON.stringify({ session_id: f.sessionId }))).stdout
    expect(thirdOut).toContain('additionalContext')
  }, 15000)

  test('stays silent when caught up or unarmed', async () => {
    const f = await fixture()
    const { stat } = await import('node:fs/promises')
    await armFlag(f, (await stat(f.mailboxPath)).mtimeMs)

    const caughtUp = runHook('prompt-notice.mjs', {}, { ADVISOR_WORKER_ARM_DIR: f.armDir })
    expect(
      (await settle(caughtUp, JSON.stringify({ session_id: f.sessionId }))).stdout.trim(),
    ).toBe('')

    const unarmed = runHook('prompt-notice.mjs', {}, { ADVISOR_WORKER_ARM_DIR: f.armDir })
    expect((await settle(unarmed, JSON.stringify({ session_id: 'nope' }))).stdout.trim()).toBe('')
  })
})
