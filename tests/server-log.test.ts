import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { boundedServerLog } from '../src/server-log.ts'
test('server log is private and bounded; rollover retains newest diagnostics', async () => {
  const dir = await mkdtemp('/tmp/codex-log-test-'),
    path = join(dir, 'server.log')
  const log = boundedServerLog(path, 10)
  try {
    log.write(Buffer.from('12345678'))
    log.write(Buffer.from('latest'))
    expect(await readFile(path, 'utf8')).toBe('latest')
    log.write(Buffer.from('abcdefghijklmnop'))
    expect(await readFile(path, 'utf8')).toBe('ghijklmnop')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    log.close()
    log.close()
    log.write(Buffer.from('ignored'))
    expect((await stat(path)).size).toBe(10)
  } finally {
    log.close()
    await rm(dir, { recursive: true, force: true })
  }
})
