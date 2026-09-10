#!/usr/bin/env node
// Content-hash watcher for one advisor/worker mailbox file. Emits ONE JSON line
// per real content change (sha256 differs); touches and duplicate fs events stay silent.
import { createHash } from 'node:crypto'
import { readFileSync, watch, statSync } from 'node:fs'
import { dirname, basename, resolve, isAbsolute } from 'node:path'

const input = process.argv[2]
if (
  !input ||
  !isAbsolute(input) ||
  !['ARCHITECT-QUESTIONS.md', 'ARCHITECT-STEER.md'].includes(basename(input))
) {
  console.error('Expected absolute ARCHITECT-QUESTIONS.md or ARCHITECT-STEER.md path')
  process.exit(2)
}
const target = resolve(input)
const dir = dirname(target)
const name = basename(target)
const hashOf = () => {
  try {
    if (statSync(target).size > 8 << 20) throw new Error('Mailbox exceeds 8 MiB')
    return createHash('sha256').update(readFileSync(target)).digest('hex')
  } catch (error) {
    if (error.code === 'ENOENT') return 'MISSING'
    throw error
  }
}
let last = hashOf()
const emit = (event, sha) =>
  process.stdout.write(
    JSON.stringify({
      event,
      path: target,
      exists: sha !== 'MISSING',
      sha256: sha,
      at: new Date().toISOString(),
    }) + '\n',
  )
let timer = null
const check = () => {
  const now = hashOf()
  if (now !== last) {
    last = now
    emit('inbound-content-changed', now)
  }
}
const watcher = watch(dir, { persistent: true }, (_ev, fname) => {
  if (fname && fname !== name && fname !== `${name}.new`) return
  clearTimeout(timer)
  timer = setTimeout(check, 50)
})
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    clearTimeout(timer)
    watcher.close()
  })
