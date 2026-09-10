import { closeSync, fchmodSync, ftruncateSync, openSync, writeSync } from 'node:fs'

// One private, bounded log per wrapper session. Retains latest block on rollover.
export function boundedServerLog(path: string, maxBytes = 1024 * 1024) {
  const fd = openSync(path, 'w', 0o600)
  fchmodSync(fd, 0o600)
  let bytes = 0,
    closed = false
  return {
    write(chunk: Uint8Array) {
      if (closed) return
      if (chunk.byteLength > maxBytes) chunk = chunk.subarray(chunk.byteLength - maxBytes)
      if (bytes + chunk.byteLength > maxBytes) {
        ftruncateSync(fd, 0)
        bytes = 0
      }
      let offset = 0
      while (offset < chunk.byteLength)
        offset += writeSync(fd, chunk, offset, chunk.byteLength - offset, bytes + offset)
      bytes += chunk.byteLength
    },
    close() {
      if (!closed) {
        closed = true
        closeSync(fd)
      }
    },
  }
}
