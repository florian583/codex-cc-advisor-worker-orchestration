import { describe, expect, test } from 'bun:test'

import { sessionIdentity } from '../src/identity.ts'

describe('sessionIdentity', () => {
  test('gives an advisor a deterministic role-based routing identity', () => {
    const sessionId = '550e8400-e29b-41d4-a716-44665544000a'

    const first = sessionIdentity(sessionId, 'Architect')
    const second = sessionIdentity(sessionId, 'Architect')

    expect(first).toEqual(second)
    expect(first.sessionId).toBe(sessionId)
    expect(first.suffix).toBe('000A')
    expect(first.callSign).toBe('Advisor · 000A')
    expect(first.displayRole).toBe('Advisor')
    expect(first.title).toBe('Advisor · 000A')
  })

  test('uses Advisor, Worker, and Session display identities', () => {
    const sessionId = '550e8400-e29b-41d4-a716-44665544000b'

    const architect = sessionIdentity(sessionId, 'Architect')
    const implementer = sessionIdentity(sessionId, 'Implementer')
    const session = sessionIdentity(sessionId)

    expect(architect.callSign).toBe('Advisor · 000B')
    expect(implementer.callSign).toBe('Worker · 000B')
    expect(session.callSign).toBe('Session · 000B')
  })

  test('includes the configured Claude account label in the display title', () => {
    const identity = sessionIdentity('550e8400-e29b-41d4-a716-44665544000e', 'Architect', 'EXAMPLE')

    expect(identity.accountLabel).toBe('EXAMPLE')
    expect(identity.title).toBe('EXAMPLE · Advisor · 000E')
  })
})
