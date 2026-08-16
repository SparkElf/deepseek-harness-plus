import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.PORT ?? 4177)
const types = new Map([['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml']])

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    response.writeHead(302, { location: '/renderer/index.html' + url.search })
    response.end()
    return
  }
  const relative = normalize(url.pathname).replace(/^[/\\]+/u, '')
  try {
    const body = await readFile(join(directory, relative))
    const extension = relative.slice(relative.lastIndexOf('.'))
    response.writeHead(200, { 'content-type': types.get(extension) ?? 'application/octet-stream' })
    response.end(body)
  } catch (error) {
    console.error('[installer-preview] request failed', error)
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  }
}).listen(port, '127.0.0.1', () => {
  console.log('Installer preview: http://127.0.0.1:' + String(port))
})
