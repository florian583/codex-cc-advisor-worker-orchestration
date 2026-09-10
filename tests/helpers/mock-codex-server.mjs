import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import WebSocket from '../../node_modules/ws/index.js'
const server = createServer()
const ws = new WebSocket.WebSocketServer({ server })
let attempts = 0
ws.on('connection', (socket) =>
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (!message.method || message.id == null) return
    appendFileSync(process.env.MOCK_LOG, JSON.stringify(message) + '\n')
    const mode = process.env.MOCK_MODE ?? 'active'
    const params = message.params
    let result = {}
    if (message.method === 'thread/read')
      result = {
        thread: {
          id: mode === 'wrong-thread' ? 'other' : params.threadId,
          status: {
            type:
              mode.startsWith('idle') && !(mode === 'idle-race' && attempts > 0)
                ? 'idle'
                : mode === 'not-loaded'
                  ? 'notLoaded'
                  : 'active',
          },
        },
      }
    if (message.method === 'thread/turns/list')
      result = { data: [{ id: `turn-${attempts}`, status: 'inProgress' }] }
    if (message.method === 'turn/start') {
      attempts++
      if (mode === 'idle-disconnect') {
        socket.terminate()
        return
      }
      if (mode === 'idle-race') {
        socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: -32600, message: 'turn became active' },
          }),
        )
        return
      }
      result = { turn: { id: `started-${attempts}` } }
    }
    if (message.method === 'turn/steer') {
      attempts++
      if (mode === 'disconnect') {
        socket.terminate()
        return
      }
      if (mode === 'reject' || (mode === 'race' && attempts === 1)) {
        socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: -32600, message: 'turn mismatch or not steerable' },
          }),
        )
        return
      }
      if (mode === 'approval')
        socket.send(
          JSON.stringify({
            id: 'approval-1',
            method: 'item/commandExecution/requestApproval',
            params: {},
          }),
        )
      result = { turnId: params.expectedTurnId }
    }
    socket.send(JSON.stringify({ id: message.id, result }))
  }),
)
server.listen(process.env.MOCK_SOCKET, () => process.stdout.write('ready\n'))
