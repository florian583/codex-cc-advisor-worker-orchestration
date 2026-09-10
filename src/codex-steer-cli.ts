// Node 22.18+ is required (native TypeScript stripping and Unix WebSocket support).
import { sendSteering } from './codex-steer.ts'
let input = ''
for await (const chunk of process.stdin) {
  input += chunk
  if (input.length > 65536) throw new Error('Bridge input too large')
}
const args = JSON.parse(input)
const result = await sendSteering(args.socket, args.sessionId, args.message, args.eventId)
process.stdout.write(JSON.stringify(result))
