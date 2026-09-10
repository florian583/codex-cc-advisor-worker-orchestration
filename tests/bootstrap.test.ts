import { expect, test } from 'bun:test'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('fresh plugin bootstraps concurrent MCP starts without contaminating stdout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orchestration-bootstrap-'))
  const children: ReturnType<typeof Bun.spawn>[] = []
  try {
    for (const entry of ['src', 'scripts', 'package.json', 'bun.lock']) {
      await cp(join(import.meta.dir, '..', entry), join(root, entry), { recursive: true })
    }
    await Promise.all(
      [1, 2].map(async (index) => {
        const child = Bun.spawn([process.execPath, join(root, 'scripts/start-claude.mjs')], {
          env: {
            ...process.env,
            CLAUDE_CODE_SESSION_ID: `bootstrap-test-${index}`,
            ADVISOR_WORKER_ARM_DIR: join(root, 'arms'),
          },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        })
        children.push(child)
        // Drain diagnostics so dependency installation can never block on its pipe.
        const diagnostics = new Response(child.stderr).text()
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'bootstrap-test', version: '1' },
            },
          }) + '\n',
        )
        child.stdin.flush()
        const reader = child.stdout.getReader()
        let output = ''
        while (!output.includes('\n')) {
          const chunk = await reader.read()
          if (chunk.done) throw new Error(`Bootstrap exited: ${await diagnostics}`)
          output += new TextDecoder().decode(chunk.value)
        }
        const response = JSON.parse(output.split('\n')[0])
        expect(response.result.capabilities.experimental['claude/channel']).toEqual({})
        child.kill()
        await child.exited
        await diagnostics
      }),
    )
    expect(await readFile(join(root, '.bootstrap-ready'), 'utf8')).toMatch(/^[a-f0-9]{64}$/)
  } finally {
    for (const child of children) child.kill()
    await Promise.all(children.map((child) => child.exited))
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
