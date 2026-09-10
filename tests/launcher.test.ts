import { describe, expect, test } from 'bun:test'

import { buildAdvisorWorkerLaunch } from '../src/launcher.ts'

const generatedId = '550e8400-e29b-41d4-a716-44665544000c'

describe('buildAdvisorWorkerLaunch', () => {
  test('names a new Claude session from the exact UUID it launches', () => {
    const launch = buildAdvisorWorkerLaunch(['--model', 'opus'], { uuidFactory: () => generatedId })

    expect(launch.sessionId).toBe(generatedId)
    expect(launch.identity?.title).toBe('Session · 000C')
    expect(launch.args).toContainAllValues([
      '--session-id',
      generatedId,
      '--name',
      launch.identity.title,
      '--dangerously-load-development-channels',
      'plugin:advisor-worker-orchestration@codex-cc-advisor-worker-orchestration',
      '--model',
      'opus',
    ])
  })

  test('uses the architect role in the display name when requested', () => {
    const launch = buildAdvisorWorkerLaunch([], {
      accountLabel: 'EXAMPLE',
      role: 'Architect',
      uuidFactory: () => generatedId,
    })

    expect(launch.identity?.title).toBe('EXAMPLE · Advisor · 000C')
    expect(launch.args).toContain('--name')
    expect(launch.args).toContain(launch.identity!.title)
  })

  test('resumes an existing named session without replacing its identity', () => {
    const launch = buildAdvisorWorkerLaunch(['--resume', 'EXAMPLE · Advisor · EC0C'], {
      uuidFactory: () => generatedId,
    })

    expect(launch.sessionId).toBeNull()
    expect(launch.identity).toBeNull()
    expect(launch.args).not.toContain('--session-id')
    expect(launch.args).not.toContain('--name')
    expect(launch.args).toContainAllValues([
      '--dangerously-load-development-channels',
      'plugin:advisor-worker-orchestration@codex-cc-advisor-worker-orchestration',
      '--resume',
      'EXAMPLE · Advisor · EC0C',
    ])
  })

  test('uses an explicit session UUID when the caller supplies one', () => {
    const explicitId = '550e8400-e29b-41d4-a716-44665544000d'
    const launch = buildAdvisorWorkerLaunch(['--session-id', explicitId], {
      uuidFactory: () => generatedId,
    })

    expect(launch.sessionId).toBe(explicitId)
    expect(launch.identity?.sessionId).toBe(explicitId)
    expect(launch.args.filter((arg) => arg === '--session-id')).toHaveLength(1)
    expect(launch.args).toContain('--name')
    expect(launch.args).toContain(launch.identity!.title)
  })

  test('does not add session flags to administrative or print-mode commands', () => {
    const administrative = buildAdvisorWorkerLaunch(['plugin', 'list'], {
      uuidFactory: () => generatedId,
    })
    const printMode = buildAdvisorWorkerLaunch(['-p', 'summarize this'], {
      uuidFactory: () => generatedId,
    })

    expect(administrative).toEqual({ args: ['plugin', 'list'], identity: null, sessionId: null })
    expect(printMode).toEqual({ args: ['-p', 'summarize this'], identity: null, sessionId: null })
  })
})
