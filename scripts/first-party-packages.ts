/** First-party npm names accepted by repository, release, and documentation gates. */

const DEEPSEEK_PACKAGE_PREFIX = '@deepseek-ai/'
const DEEPSEEK_DSH_PACKAGE_PREFIX = '@deepseek-ai/dsh-'
const SPARKELF_DSH_PACKAGE_PREFIX = '@sparkelf/dsh-'

/** First-party Backup package published under the owner's npm scope. */
export const SETTINGS_BACKUP_PACKAGE = '@sparkelf/dsh-client-ui-settings-backup'

/** Source repository recorded in the published Backup package. */
export const SETTINGS_BACKUP_REPOSITORY_URL = 'git+https://github.com/SparkElf/deepseek-harness-plus.git'

/**
 * Decide whether a manifest name belongs to this repository's release set.
 * @param name - npm package name.
 * @returns Whether repository gates treat the package as first-party.
 */
export function isFirstPartyPackageName(name: string): boolean {
  return name.startsWith(DEEPSEEK_PACKAGE_PREFIX) || name === SETTINGS_BACKUP_PACKAGE
}

/**
 * Decide whether a package participates in the DSH package graph and constraints.
 * @param name - npm package name.
 * @returns Whether the name is a first-party DSH package.
 */
export function isFirstPartyDshPackageName(name: string): boolean {
  return name.startsWith(DEEPSEEK_DSH_PACKAGE_PREFIX) || name === SETTINGS_BACKUP_PACKAGE
}

/**
 * Remove the recognized npm scope and DSH prefix from a first-party package name.
 * @param name - first-party DSH package name.
 * @returns Unscoped package name used in generated catalogs and graphs.
 */
export function shortDshPackageName(name: string): string {
  if (name.startsWith(DEEPSEEK_DSH_PACKAGE_PREFIX)) return name.slice(DEEPSEEK_DSH_PACKAGE_PREFIX.length)
  if (name === SETTINGS_BACKUP_PACKAGE) return name.slice(SPARKELF_DSH_PACKAGE_PREFIX.length)
  throw new Error('not a first-party DSH package: ' + name)
}
