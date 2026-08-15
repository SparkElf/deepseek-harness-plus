import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * 读取 Harness settings document 中显式选择的界面语言。
 * @param {string} dshHome Harness settings document 所在目录。
 * @returns {Promise<'zh' | 'en' | undefined>} 显式语言；未设置时返回 undefined。
 */
export async function readLocalePreference(dshHome) {
  try {
    const settings = parseYaml(await readFile(join(dshHome, 'settings.yaml'), 'utf8'))
    const preference = settings?.locale?.preference
    return preference === 'zh' || preference === 'en' ? preference : undefined
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}
