/** Virtual view aliases for the three canonical knowledge scopes. */
export type ScopeLocale = 'zh' | 'en'

export const CANONICAL_SCOPES = ['global', 'department', 'personal'] as const
export type CanonicalScope = typeof CANONICAL_SCOPES[number]

const ALIASES: Record<ScopeLocale, Record<CanonicalScope, string>> = {
  zh: { global: '全局', department: '部门', personal: '个人' },
  en: { global: 'Global', department: 'Department', personal: 'Personal' },
}

/** Display label for one canonical scope. */
export function scopeAliasFor(scope: CanonicalScope, locale: ScopeLocale = 'zh'): string {
  return ALIASES[locale][scope]
}

/** All accepted spellings of one canonical scope. */
export function scopeSpellings(scope: CanonicalScope): string[] {
  return [scope, ALIASES.zh[scope], ALIASES.en[scope]]
}

/**
 * Map a view path whose first segment is a localized scope alias back to canonical.
 *
 * The NFS tree and the index stay `global/department/personal`; aliases are only a
 * virtual view coordinate accepted at every entry. Unknown first segments are left
 * untouched (legacy/top-level paths).
 */
export function resolveScopeAlias(relPath: string): string {
  if (relPath === '') return relPath
  const slash = relPath.indexOf('/')
  const head = slash < 0 ? relPath : relPath.slice(0, slash)
  const tail = slash < 0 ? '' : relPath.slice(slash)
  for (const scope of CANONICAL_SCOPES) {
    if (scopeSpellings(scope).includes(head)) return scope + tail
  }
  return relPath
}

/** Turn a canonical path into its localized view spelling for display. */
export function localizedScopeForPath(relPath: string, locale: ScopeLocale = 'zh'): string {
  if (relPath === '') return relPath
  const slash = relPath.indexOf('/')
  const head = slash < 0 ? relPath : relPath.slice(0, slash)
  const tail = slash < 0 ? '' : relPath.slice(slash)
  for (const scope of CANONICAL_SCOPES) {
    if (head === scope) return scopeAliasFor(scope, locale) + tail
  }
  return relPath
}

/** Canonical scope from a path or alias, or undefined for a non-bucket path. */
export function scopeFromAlias(segment: string): CanonicalScope | undefined {
  for (const scope of CANONICAL_SCOPES) {
    if (scopeSpellings(scope).includes(segment)) return scope
  }
  return undefined
}
