import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Read the explicit interface locale from the Harness settings document.
 * @param {string} dshHome - Harness home containing settings.yaml.
 * @returns {Promise<'zh' | 'en' | undefined>} selected locale.
 */
export async function readLocalePreference(dshHome) {
  const settings = parseYaml(await readFile(join(dshHome, 'settings.yaml'), 'utf8'))
  const preference = settings?.locale?.preference
  return preference === 'zh' || preference === 'en' ? preference : undefined
}
