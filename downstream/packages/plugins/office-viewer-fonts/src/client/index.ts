import type { Context } from '@deepseek-ai/cordis'

interface ViewerFontResource {
  readonly family: string
  readonly source: string
}

declare global {
  interface Window {
    __DSH_OFFICE_VIEWER_FONTS__?: readonly ViewerFontResource[]
  }
}

const FONT_ASSET_VERSION = '0.1.1'

const FONT_FILES = [
  {
    file: 'FZXiaoBiaoSong.ttf',
    families: ['方正小标宋简体', 'FZXiaoBiaoSong-B05S'],
  },
  {
    file: 'FangSongGB2312.ttf',
    families: ['FangSong_GB2312', '仿宋_GB2312', '仿宋'],
  },
  {
    file: 'KaiTiGB2312.ttf',
    families: ['KaiTi_GB2312', '楷体_GB2312', '楷体'],
  },
  {
    file: 'SimHei.ttf',
    families: ['SimHei', '黑体'],
  },
  {
    file: 'Calibri.ttf',
    families: ['Calibri'],
  },
  {
    file: 'Calibri-Bold.ttf',
    families: ['Calibri'],
  },
  {
    file: 'Calibri-Italic.ttf',
    families: ['Calibri'],
  },
  {
    file: 'Calibri-BoldItalic.ttf',
    families: ['Calibri'],
  },
  {
    file: 'Calibri-Light.ttf',
    families: ['Calibri Light'],
  },
  {
    file: 'Calibri-LightItalic.ttf',
    families: ['Calibri Light'],
  },
  // 下面三个文件的内部 family 与上面同源的字面（方正小标宋简体、仿宋、楷体）重复，
  // 而浏览器按注册顺序取同名的最后一份；因此这里只发布它们各自的拼写，让文档写
  // 方正小标宋简体 / 仿宋 / 楷体 时仍命中上面那一份，不因别名顺序而换字体。
  {
    file: 'FZXiaoBiaoSong-JT.ttf',
    families: ['FZXiaoBiaoSong-JT', 'FZXiaoBiaoSong-B05S-JT'],
  },
  {
    file: 'FangSong.ttf',
    families: ['FangSong'],
  },
  {
    file: 'KaiTi.ttf',
    families: ['KaiTi'],
  },
  {
    file: 'Arial.ttf',
    families: ['Arial'],
  },
  {
    file: 'Arial-Bold.ttf',
    families: ['Arial'],
  },
  {
    file: 'Arial-Italic.ttf',
    families: ['Arial'],
  },
  {
    file: 'Arial-BoldItalic.ttf',
    families: ['Arial'],
  },
] as const

export const name = 'office-viewer-fonts'

/** 将字体 URL 及常见中英文族名公开给 Better Sidebar Office Viewer。 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const previous = window.__DSH_OFFICE_VIEWER_FONTS__
    const fonts = FONT_FILES.flatMap(font => {
      const source = new URL('/office-viewer-fonts/' + font.file, window.location.origin)
      source.searchParams.set('v', FONT_ASSET_VERSION)
      return font.families.map(family => ({ family, source: source.href }))
    })
    window.__DSH_OFFICE_VIEWER_FONTS__ = fonts
    return () => {
      if (window.__DSH_OFFICE_VIEWER_FONTS__ !== fonts) return
      if (previous === undefined) delete window.__DSH_OFFICE_VIEWER_FONTS__
      else window.__DSH_OFFICE_VIEWER_FONTS__ = previous
    }
  }, 'office-viewer-fonts: browser assets')
}
