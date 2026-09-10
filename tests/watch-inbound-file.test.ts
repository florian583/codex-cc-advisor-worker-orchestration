import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = join(import.meta.dir, '..', 'scripts', 'watch-inbound-file.mjs')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

describe('watch-inbound-file helper', () => {
  test('emits only when the inbound file content hash changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'advisor-worker-monitor-'))
    temporaryDirectories.push(directory)
    const mailboxPath = join(directory, 'ARCHITECT-STEER.md')
    await writeFile(mailboxPath, '# Steer\n')

    const child = Bun.spawn([process.execPath, script, mailboxPath], {
      stderr: 'pipe',
      stdout: 'pipe',
    })
    let output = ''
    const pump = (async () => {
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        output += decoder.decode(value, { stream: true })
      }
    })()

    try {
      await Bun.sleep(150)
      await writeFile(mailboxPath, '# Steer\n')
      await Bun.sleep(150)
      expect(output).toBe('')

      await writeFile(mailboxPath, '# Steer\n\nFirst order\n')
      await waitFor(() => completeLines(output).length === 1)
      const first = JSON.parse(completeLines(output)[0])
      expect(first).toMatchObject({
        event: 'inbound-content-changed',
        exists: true,
        path: mailboxPath,
      })
      expect(first.sha256).toMatch(/^[a-f0-9]{64}$/)

      await writeFile(mailboxPath, '# Steer\n\nFirst order\n')
      await Bun.sleep(150)
      expect(completeLines(output)).toHaveLength(1)

      await writeFile(mailboxPath, '# Steer\n\nSecond order\n')
      await waitFor(() => completeLines(output).length === 2)
      expect(JSON.parse(completeLines(output)[1]).sha256).not.toBe(first.sha256)
    } finally {
      child.kill()
      await child.exited
      await pump
    }
  })

  test('rejects non-protocol filenames', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'advisor-worker-monitor-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'notes.md')
    await writeFile(path, '# Notes\n')

    const child = Bun.spawn([process.execPath, script, path], { stderr: 'pipe' })
    expect(await child.exited).toBe(2)
    expect(await new Response(child.stderr).text()).toContain('ARCHITECT-QUESTIONS.md')
  })
})

function completeLines(output: string): string[] {
  return output.split('\n').filter(Boolean)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for helper output')
    await Bun.sleep(10)
  }
}
