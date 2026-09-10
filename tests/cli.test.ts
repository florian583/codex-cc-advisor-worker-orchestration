import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')

describe('advisor/worker Claude CLI wrapper', () => {
  test('builds a named account session with the channel enabled', async () => {
    const child = Bun.spawn(['bun', cli, '--model', 'opus'], {
      env: {
        ...process.env,
        CLAUDE_ACCOUNT_LABEL: 'EXAMPLE',
        ORCHESTRATION_CLAUDE_DRY_RUN: '1',
        ORCHESTRATION_ROLE: 'Architect',
      },
      stdout: 'pipe',
    })

    expect(await child.exited).toBe(0)
    const result = JSON.parse(await new Response(child.stdout).text())
    expect(result.binary).toBe('claude')
    expect(result.identity.title).toMatch(/^EXAMPLE · Advisor · [0-9A-F]{4}$/)
    for (const argument of [
      '--dangerously-load-development-channels',
      'plugin:advisor-worker-orchestration@codex-cc-advisor-worker-orchestration',
      '--model',
      'opus',
    ]) {
      expect(result.args).toContain(argument)
    }
  })

  test('leaves administrative commands untouched', async () => {
    const child = Bun.spawn(['bun', cli, 'plugin', 'list'], {
      env: { ...process.env, ORCHESTRATION_CLAUDE_DRY_RUN: '1' },
      stdout: 'pipe',
    })

    expect(await child.exited).toBe(0)
    const result = JSON.parse(await new Response(child.stdout).text())
    expect(result).toMatchObject({ args: ['plugin', 'list'], identity: null })
  })

  test('--worker pins the Worker identity and is stripped from claude args', async () => {
    const child = Bun.spawn(['bun', cli, '--worker', '--model', 'opus'], {
      env: { ...process.env, CLAUDE_ACCOUNT_LABEL: 'HYBRID', ORCHESTRATION_CLAUDE_DRY_RUN: '1' },
      stdout: 'pipe',
    })

    expect(await child.exited).toBe(0)
    const result = JSON.parse(await new Response(child.stdout).text())
    expect(result.identity.title).toMatch(/^HYBRID · Worker · [0-9A-F]{4}$/)
    expect(result.args).not.toContain('--worker')
    expect(result.args).toContain('--model')
    expect(result.args).toContain('opus')
  })

  test('--advisor pins the Advisor identity', async () => {
    const child = Bun.spawn(['bun', cli, '--advisor'], {
      env: { ...process.env, CLAUDE_ACCOUNT_LABEL: 'HYBRID', ORCHESTRATION_CLAUDE_DRY_RUN: '1' },
      stdout: 'pipe',
    })

    expect(await child.exited).toBe(0)
    const result = JSON.parse(await new Response(child.stdout).text())
    expect(result.identity.title).toMatch(/^HYBRID · Advisor · [0-9A-F]{4}$/)
    expect(result.args).not.toContain('--advisor')
  })

  test('a role flag beats ORCHESTRATION_ROLE', async () => {
    const child = Bun.spawn(['bun', cli, '--worker'], {
      env: {
        ...process.env,
        CLAUDE_ACCOUNT_LABEL: 'HYBRID',
        ORCHESTRATION_CLAUDE_DRY_RUN: '1',
        ORCHESTRATION_ROLE: 'Architect',
      },
      stdout: 'pipe',
    })

    expect(await child.exited).toBe(0)
    const result = JSON.parse(await new Response(child.stdout).text())
    expect(result.identity.title).toContain('Worker')
  })

  test('--role <name> pins a raw role and consumes its value', async () => {
    const child = Bun.spawn(['bun', cli, '--role', 'Implementer'], {
      env: { ...process.env, CLAUDE_ACCOUNT_LABEL: 'HYBRID', ORCHESTRATION_CLAUDE_DRY_RUN: '1' },
      stdout: 'pipe',
    })

    expect(await child.exited).toBe(0)
    const result = JSON.parse(await new Response(child.stdout).text())
    expect(result.identity.title).toContain('Worker')
    expect(result.args).not.toContain('--role')
    expect(result.args).not.toContain('Implementer')
  })
})
