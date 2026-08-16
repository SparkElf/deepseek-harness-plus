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
    const cardIsDark = url.searchParams.get('theme') === 'dark'
    const outsideBackground = cardIsDark ? '#f5f6f7' : '#232324'
    const frameUrl = '/renderer/index.html' + url.search
    const preview = '<!doctype html>' +
      '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>Installer preview</title>' +
      '<style>' +
      ':root{color-scheme:' + (cardIsDark ? 'light' : 'dark') + '}' +
      '*{box-sizing:border-box}' +
      'html,body{width:100%;min-height:100%;margin:0}' +
      'body{background:' + outsideBackground + '}' +
      'main{min-height:100vh;display:grid;place-items:center;padding:32px}' +
      'iframe{display:block;width:min(980px,calc((100vh - 64px) * 1.25641),calc(100vw - 64px));aspect-ratio:980 / 780;border:1px solid rgba(0,0,0,.18);border-radius:8px;box-shadow:0 18px 44px rgba(0,0,0,.2);background:' + (cardIsDark ? '#232324' : '#ffffff') + '}' +
      '</style></head><body><main><iframe title="DeepSeek Harness Plus installer" src="' + frameUrl + '"></iframe></main></body></html>'
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(preview)
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
