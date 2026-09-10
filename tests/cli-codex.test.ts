import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const cli = join(import.meta.dir, '..', 'src', 'cli-codex.ts')

describe('advisor/worker Codex CLI wrapper', () => {
  test('enables the orchestration MCP server for the launch and marks the environment', async () => {
    const child = Bun.spawn(['bun', cli, '--model', 'gpt-5.6-sol'], {
      env: { ...process.env, ORCHESTRATION_ACCOUNT_LABEL: 'CDX', ORCHESTRATION_CODEX_DRY_RUN: '1' },
      stdout: 'pipe',
    })
    expect(await child.exited).toBe(0)
    const result = JSON.parse(await new Response(child.stdout).text())
    expect(result.binary).toBe('codex')
    expect(result.session).toBe(true)
    expect(result.args.slice(0, 2)).toEqual([
      '-c',
      'mcp_servers.advisor-worker-orchestration.enabled=true',
    ])
    expect(result.args).toContain('--model')
    expect(result.env).toMatchObject({
      ORCHESTRATION_CODEX: '1',
      ORCHESTRATION_ACCOUNT_LABEL: 'CDX',
    })
    expect(result.env.ORCHESTRATION_ROLE).toBeUndefined()
  })

  test('--worker pins the Implementer role and is stripped from codex args', async () => {
    const child = Bun.spawn(['bun', cli, '--worker', '--full-auto'], {
      env: { ...process.env, ORCHESTRATION_CODEX_DRY_RUN: '1' },
      stdout: 'pipe',
    })
    expect(await child.exited).toBe(0)
    const result = JSON.parse(await new Response(child.stdout).text())
    expect(result.env.ORCHESTRATION_ROLE).toBe('Implementer')
    expect(result.env.ORCHESTRATION_ACCOUNT_LABEL).toBe('CODEX')
    expect(result.args).not.toContain('--worker')
    expect(result.args).toContain('--full-auto')
  })

  test('--advisor beats ORCHESTRATION_ROLE', async () => {
    const child = Bun.spawn(['bun', cli, '--advisor'], {
      env: { ...process.env, ORCHESTRATION_CODEX_DRY_RUN: '1', ORCHESTRATION_ROLE: 'Implementer' },
      stdout: 'pipe',
    })
    expect(await child.exited).toBe(0)
    const result = JSON.parse(await new Response(child.stdout).text())
    expect(result.env.ORCHESTRATION_ROLE).toBe('Architect')
    expect(result.args).not.toContain('--advisor')
  })

  test('resume and exec stay sessions; admin commands pass through untouched', async () => {
    const resumed = Bun.spawn(['bun', cli, 'resume', '--last'], {
      env: { ...process.env, ORCHESTRATION_CODEX_DRY_RUN: '1' },
      stdout: 'pipe',
    })
    const resumedResult = JSON.parse(await new Response(resumed.stdout).text())
    expect(resumedResult.session).toBe(true)
    expect(resumedResult.args).toContain('mcp_servers.advisor-worker-orchestration.enabled=true')

    const admin = Bun.spawn(['bun', cli, 'mcp', 'list'], {
      env: { ...process.env, ORCHESTRATION_CODEX_DRY_RUN: '1' },
      stdout: 'pipe',
    })
    const adminResult = JSON.parse(await new Response(admin.stdout).text())
    expect(adminResult).toMatchObject({ args: ['mcp', 'list'], session: false })
  })
})
