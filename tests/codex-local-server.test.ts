import { expect, test } from 'bun:test'
import { serverConfigArgs, needsLocalServer } from '../src/codex-local-server.ts'
test('interactive advisors and explicit resumes own a server; headless/admin do not', () => {
  expect(needsLocalServer([], true)).toBe(true)
  expect(needsLocalServer(['resume', 'thread-id'], true)).toBe(true)
  expect(needsLocalServer(['exec', 'task'], true)).toBe(false)
  expect(needsLocalServer(['mcp', 'list'], false)).toBe(false)
})
test('only App Server compatible config options are forwarded', () => {
  expect(
    serverConfigArgs([
      '-c',
      'model="test"',
      '--enable',
      'hooks',
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'on-request',
      '--model',
      'test',
      '--strict-config',
    ]),
  ).toEqual(['-c', 'model="test"', '--enable', 'hooks', '--strict-config'])
})
test('profile and remote overrides fail explicitly rather than silently changing config', () => {
  for (const args of [['-p', 'work'], ['--profile=work'], ['--remote', 'unix:///other.sock']])
    expect(() => serverConfigArgs(args)).toThrow('cannot safely mirror')
  expect(() => serverConfigArgs(['-c'])).toThrow('Missing value')
})
