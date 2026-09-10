// Delivery acceptance is not a read acknowledgement. Recovery is once per
// content revision; it never advances the MCP wait watermark.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function needsRecovery(sessionId, watchPath, kind) {
  try {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return false
    if (statSync(watchPath).size > 8 * 1024 * 1024) return false
    const hash = createHash('sha256').update(readFileSync(watchPath)).digest('hex')
    const key = createHash('sha256').update(`${sessionId}\0${watchPath}`).digest('hex')
    const root =
      process.env.CODEX_ORCHESTRATION_STATE_DIR ||
      join(homedir(), '.codex', 'advisor-worker-orchestration')
    try {
      const receipt = JSON.parse(
        readFileSync(join(root, 'delivery-receipts', `${key}.json`), 'utf8'),
      )
      if (
        receipt.hash === hash &&
        receipt.result?.sessionId === sessionId &&
        ['started', 'steered'].includes(receipt.result?.status)
      )
        return false
    } catch {
      /* Missing or partial receipt requires recovery. */
    }
    const dir = join(root, 'hook-recovery')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const marker = join(dir, `${key}-${kind}.json`)
    try {
      if (JSON.parse(readFileSync(marker, 'utf8')).hash === hash) return false
    } catch {}
    writeFileSync(marker, JSON.stringify({ hash, at: new Date().toISOString() }), { mode: 0o600 })
    return true
  } catch {
    return true
  } // Stop's second-attempt escape still applies.
}
