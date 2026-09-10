#!/usr/bin/env bun
// Plugin managers clone source, but do not install JavaScript dependencies.
// Bootstrap once, serialize concurrent starts, and keep MCP stdout clean.
import { mkdir, rmdir, access, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const lock = join(root, '.bootstrap-lock')
const stamp = join(root, '.bootstrap-ready')
const fingerprint = createHash('sha256')
  .update(await readFile(join(root, 'bun.lock')))
  .digest('hex')
const ready = async () => {
  try {
    if ((await readFile(stamp, 'utf8')) !== fingerprint) return false
    await access(join(root, 'node_modules/@modelcontextprotocol/sdk/package.json'))
    await access(join(root, 'node_modules/ws/index.js'))
    return true
  } catch {
    return false
  }
}
const deadline = Date.now() + 60_000
while (!(await ready())) {
  let owned = false
  try {
    try {
      await mkdir(lock)
      owned = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (owned) {
      if (!(await ready())) {
        const install = Bun.spawn(
          [process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts'],
          {
            cwd: root,
            stdin: 'ignore',
            stdout: 2,
            stderr: 'inherit',
          },
        )
        if ((await install.exited) !== 0) throw new Error('Dependency installation failed')
        await writeFile(stamp, fingerprint)
      }
    } else {
      if (Date.now() > deadline)
        throw new Error('Dependency bootstrap locked; inspect .bootstrap-lock before retrying')
      await Bun.sleep(100)
    }
  } finally {
    if (owned) await rmdir(lock)
  }
}
await import('../src/server.ts')
