import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
export async function mockCodex(mode = 'active') {
  const directory = await mkdtemp('/tmp/codex-mock-')
  const socket = join(directory, 'rpc.sock'),
    log = join(directory, 'rpc.jsonl')
  const child = Bun.spawn(['node', join(import.meta.dir, 'mock-codex-server.mjs')], {
    env: { ...process.env, MOCK_MODE: mode, MOCK_SOCKET: socket, MOCK_LOG: log },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const reader = child.stdout.getReader()
  const first = await reader.read()
  reader.releaseLock()
  if (!new TextDecoder().decode(first.value).includes('ready'))
    throw new Error('Mock startup failed')
  return {
    directory,
    socket,
    log,
    async messages() {
      try {
        return (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      } catch {
        return []
      }
    },
    async close() {
      child.kill()
      await child.exited
      await rm(directory, { recursive: true, force: true })
    },
  }
}
