// Dependency-free identity core shared by the Bun/TypeScript plugin and the
// Node Codex hooks.

export function stableHash(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function sessionIdentity(sessionId, role, accountLabel) {
  const alphanumeric = sessionId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  const suffix = alphanumeric.slice(-4).padStart(4, '0')
  const normalizedAccountLabel = accountLabel?.trim() || null
  const normalizedRole = role?.trim() || null
  const displayRole =
    normalizedRole === 'Architect'
      ? 'Advisor'
      : normalizedRole === 'Implementer'
        ? 'Worker'
        : 'Session'
  const callSign = `${displayRole} · ${suffix}`
  const title = [normalizedAccountLabel, callSign].filter(Boolean).join(' · ')

  return {
    accountLabel: normalizedAccountLabel,
    callSign,
    displayRole,
    role: normalizedRole,
    sessionId,
    suffix,
    title,
  }
}
