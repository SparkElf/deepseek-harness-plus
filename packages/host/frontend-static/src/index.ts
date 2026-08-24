/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat. The webserver presents logical root-relative request paths,
 * while this package injects the external mount path as the document base so
 * browser-relative assets stay beneath a reverse proxy prefix.
 */

import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'frontend-static'
export const inject = ['webServer']

export interface Config {
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

/** Inject one canonical document base before runtime boot scripts execute. */
export function injectDocumentBase(html: string, basePath: string): string {
  const href = `${basePath}/`
  const tag = `<base href="${href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`
  const head = html.indexOf('<head>')
  return head === -1 ? `${tag}${html}` : `${html.slice(0, head + 6)}${tag}${html.slice(head + 6)}`
}

/** Parser-blocking plugin preloads are injected as root URLs by the Host graph and become document-relative here. */
export function relativizePluginPreloads(html: string): string {
  return html.replaceAll('src="/plugins/', 'src="plugins/')
}

export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  renderIndex: () => Promise<string>,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  const serveIndex = async (): Promise<void> => {
    const body = await renderIndex()
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(body)
  }
  if (target === distRoot || target === distIndex) {
    await serveIndex()
    return
  }
  try {
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    await serveIndex()
  }
}

export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  const renderIndex = async (): Promise<string> => {
    const source = await readFile(distIndex, 'utf8')
    const tapped = ctx.webServer.applyIndexTaps(source)
    // Injecting after taps places <base> before any parser-blocking scripts that
    // those taps inserted at the beginning of <head>.
    return relativizePluginPreloads(injectDocumentBase(tapped, ctx.webServer.basePath))
  }
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, renderIndex)
  }), 'frontend-static: fallback seat')
}