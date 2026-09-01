/** Local socket client for one Plus Supervisor process. */

import { createConnection } from 'node:net'

function pipePath(socketPath) {
  return process.platform === 'win32'
    ? String.fromCharCode(92, 92, 46, 92, 112, 105, 112, 101, 92) + socketPath
    : socketPath
}

/**
 * Send one command and retain progress delivery until its final result.
 * @param {string} socketPath - local Supervisor socket or named-pipe identity.
 * @param {string} command - lifecycle command.
 * @param {(phase: object) => void} [onProgress] - ordered progress observer.
 * @returns {Promise<object>} final Supervisor status.
 */
export function sendSupervisorCommand(socketPath, command, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipePath(socketPath))
    let input = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      input += chunk
      const lines = input.split(String.fromCharCode(10))
      input = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        const message = JSON.parse(line)
        if (message.event === 'progress') {
          onProgress(message.message)
          continue
        }
        socket.end()
        if (message.ok) resolve(message.value)
        else reject(new Error(message.error))
      }
    })
    socket.once('error', reject)
    socket.write(JSON.stringify({ command }) + String.fromCharCode(10))
  })
}

/**
 * Observe whether one Supervisor command socket currently accepts a connection.
 * @param {string} socketPath - local Supervisor socket or named-pipe identity.
 * @returns {Promise<boolean>} current availability.
 */
export function supervisorAvailable(socketPath) {
  return new Promise(resolve => {
    const socket = createConnection(pipePath(socketPath))
    const settle = open => { socket.destroy(); resolve(open) }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

/**
 * Wait until the newly launched Supervisor accepts local commands.
 * @param {string} socketPath - local Supervisor socket or named-pipe identity.
 * @returns {Promise<object>} first available status.
 */
export async function waitForSupervisor(socketPath) {
  while (!(await supervisorAvailable(socketPath))) await new Promise(resolve => setTimeout(resolve, 200))
  return await sendSupervisorCommand(socketPath, 'status')
}
