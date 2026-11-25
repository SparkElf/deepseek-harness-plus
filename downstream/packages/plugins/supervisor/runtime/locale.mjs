import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Read the explicit interface locale from the Harness settings document.
 * @param {string} dshHome - Harness home containing settings.yaml.
 * @returns {Promise<'zh' | 'en' | undefined>} selected locale.
 */
export async function readLocalePreference(dshHome) {
  // settings.yaml is the LEGACY document: the running distribution imports it into the active
  // profile and renames it to settings.yaml.imported, so its absence is the normal steady state
  // rather than an error. Reading it unguarded threw ENOENT on every progress-page publish; on a
  // home with saved settings that ran continuously (measured 358 times in 20 minutes) and the
  // snapshot lost its locale. Only a genuinely unreadable or malformed file deserves a warning.
  let text
  try {
    text = await readFile(join(dshHome, 'settings.yaml'), 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[plus-supervisor] locale settings unreadable:', error?.message ?? error)
    return undefined
  }
  let settings
  try { settings = parseYaml(text) } catch (error) {
    console.warn('[plus-supervisor] locale settings unparsable:', error?.message ?? error)
    return undefined
  }
  const preference = settings?.locale?.preference
  return preference === 'zh' || preference === 'en' ? preference : undefined
}
