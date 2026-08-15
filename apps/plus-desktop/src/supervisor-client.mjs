import { connect } from 'node:net'

function argumentsFrom(argv) {
  const values = {}
  const commands = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--socket') {
      values.socket = argv[index + 1]
      index += 1
    } else if (!value.startsWith('--')) commands.push(value)
  }
  return { ...values, command: commands[0] }
}

const args = argumentsFrom(process.argv.slice(2))
if (!args.socket || !args.command) throw new Error('usage: node supervisor-client.mjs --socket <path> <command>')

const socket = connect(args.socket)
let input = ''
socket.setEncoding('utf8')
socket.on('data', chunk => {
  input += chunk
  const lines = input.split(String.fromCharCode(10))
  input = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.event === 'progress') {
      const phase = message.message
      process.stdout.write('[supervisor] ' + phase.key + ' ' + JSON.stringify(phase.values) + String.fromCharCode(10))
      continue
    }
    if (message.ok) {
      process.stdout.write(JSON.stringify(message.value) + String.fromCharCode(10))
      socket.end()
      continue
    }
    console.error('[supervisor] failed: ' + message.error)
    process.exitCode = 1
    socket.end()
  }
})
socket.once('error', error => {
  console.error('[supervisor] connection failed:', error)
  process.exitCode = 1
})
socket.write(JSON.stringify({ command: args.command }) + String.fromCharCode(10))
