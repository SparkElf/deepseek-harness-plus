import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

const FONT_ROUTES = [
  { file: 'FZXiaoBiaoSong.ttf', path: '/office-viewer-fonts/FZXiaoBiaoSong.ttf' },
  { file: 'FangSongGB2312.ttf', path: '/office-viewer-fonts/FangSongGB2312.ttf' },
  { file: 'KaiTiGB2312.ttf', path: '/office-viewer-fonts/KaiTiGB2312.ttf' },
  { file: 'SimHei.ttf', path: '/office-viewer-fonts/SimHei.ttf' },
  { file: 'Calibri.ttf', path: '/office-viewer-fonts/Calibri.ttf' },
  { file: 'Calibri-Bold.ttf', path: '/office-viewer-fonts/Calibri-Bold.ttf' },
  { file: 'Calibri-Italic.ttf', path: '/office-viewer-fonts/Calibri-Italic.ttf' },
  { file: 'Calibri-BoldItalic.ttf', path: '/office-viewer-fonts/Calibri-BoldItalic.ttf' },
  { file: 'Calibri-Light.ttf', path: '/office-viewer-fonts/Calibri-Light.ttf' },
  { file: 'Calibri-LightItalic.ttf', path: '/office-viewer-fonts/Calibri-LightItalic.ttf' },
  // 政务文档常见的其余字体：补齐到 17 个，使镜像只从本包安装一次字体，
  // base 层不再重复安装一份相同的字体。
  { file: 'FZXiaoBiaoSong-JT.ttf', path: '/office-viewer-fonts/FZXiaoBiaoSong-JT.ttf' },
  { file: 'FangSong.ttf', path: '/office-viewer-fonts/FangSong.ttf' },
  { file: 'KaiTi.ttf', path: '/office-viewer-fonts/KaiTi.ttf' },
  { file: 'Arial.ttf', path: '/office-viewer-fonts/Arial.ttf' },
  { file: 'Arial-Bold.ttf', path: '/office-viewer-fonts/Arial-Bold.ttf' },
  { file: 'Arial-Italic.ttf', path: '/office-viewer-fonts/Arial-Italic.ttf' },
  { file: 'Arial-BoldItalic.ttf', path: '/office-viewer-fonts/Arial-BoldItalic.ttf' },
] as const

export const name = 'office-viewer-fonts'
export const inject = ['webServer']

/** 注册 Office Viewer 字体资源。写作技能由 `@sparkelf/dsh-officecli` 的 `word` 提供。 */
export function apply(ctx: Context): void {
  for (const font of FONT_ROUTES) {
    const file = fileURLToPath(new URL('../assets/fonts/' + font.file, import.meta.url))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: font.path,
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET', 'content-length': '0' })
          response.end()
          return
        }
        const bytes = await readFile(file)
        response.writeHead(200, {
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=31536000, immutable',
          'content-length': String(bytes.byteLength),
          'content-type': 'font/ttf',
        })
        response.end(bytes)
      },
    }), 'office-viewer-fonts: ' + font.file)
  }
}
