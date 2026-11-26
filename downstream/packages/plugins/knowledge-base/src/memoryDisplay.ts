/**
 * Display projection shared by the memory page and the model-facing context.
 *
 * The memory page caps a row title at 24 characters and hides internal words
 * (tool names, paths, session ids) behind neutral fallbacks. `memory_context`
 * must show the same title for the same entry, otherwise a user comparing the
 * page with the model's answer sees two names for one memory. Keeping the
 * heuristics here is what makes "the list and the context agree" a property of
 * the data rather than of two copies that happen to match today.
 *
 * Nothing in this module reads or writes the filesystem; it is a pure
 * projection over one parsed entry.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-display
 */

import type { AnyMemoryEntry } from './memoryTypes.ts'

/** Title budget for one memory row (design §22.3: short, ≤20 characters). */
export const MEMORY_TITLE_MAX_CHARS = 24

/** Collapse whitespace and cap one display line. */
export function clipMemoryLine(value: string, max = 80): string {
  const clean = value.replace(/\s+/gu, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/** A technical token that should never be the first thing a reader sees in a row. */
export function looksTechnicalMemoryValue(value: string): boolean {
  if (/[\\/]|session-|kb_[a-z]|\.md\b|\bSOP\b|[a-z]+_[a-z]+/iu.test(value)) return true
  // Long all-ASCII kebab/underscore tokens are internal identifiers, not titles.
  return value.trim().length > 12 && /^[a-z0-9._-]+$/u.test(value.trim())
}

/** Short, non-technical fallback for entries written before displayTitle existed. */
export function memoryEntryFallbackTitle(entry: AnyMemoryEntry): string {
  switch (entry.type) {
    case 'preference':
      return clipMemoryLine(looksTechnicalMemoryValue(entry.value) ? entry.topic : entry.value, 20)
    case 'pitfall':
      return looksTechnicalMemoryValue(entry.errorSignature) ? '踩坑记录' : clipMemoryLine(entry.errorSignature, 20)
    case 'episodic': {
      if (entry.tags?.includes('SOP评估')) return '方法评估'
      if (entry.tags?.includes('SOP晋升')) return '方法晋升'
      if (entry.tags?.includes('idle')) return '空闲触发'
      if (entry.tags?.includes('compaction')) return '压缩触发'
      if (entry.tags?.includes('dream')) return '记忆整理'
      return '情景记录'
    }
    case 'fact':
      return looksTechnicalMemoryValue(entry.key) ? '事实记录' : clipMemoryLine(entry.key, 20)
    case 'sop':
      return clipMemoryLine(entry.title, 20)
  }
}

/** The table's 「记忆」 column: a short user-facing title, never an internal id. */
export function memoryEntryTitle(entry: AnyMemoryEntry): string {
  if (typeof entry.displayTitle === 'string' && entry.displayTitle.trim() !== '') {
    return clipMemoryLine(entry.displayTitle, MEMORY_TITLE_MAX_CHARS)
  }
  return memoryEntryFallbackTitle(entry)
}

/** The detail drawer's editable content, in a type-appropriate shape. */
export function memoryEntryContent(entry: AnyMemoryEntry): string {
  switch (entry.type) {
    case 'preference':
      return entry.value
    case 'pitfall':
      return entry.solution
    case 'episodic':
      return entry.summary
    case 'fact':
      return entry.statement
    case 'sop':
      return entry.steps.map((step, index) => `${String(index + 1)}. ${step}`).join('\n')
  }
}

/**
 * Display source label. The snapshot written at record time wins; then the
 * scenario/app the guardian knew; only then the neutral label. A raw session id
 * is never used as the label.
 */
export function memoryEntrySourceLabel(entry: AnyMemoryEntry): string {
  const label = entry.sourceLabel?.trim()
  if (label !== undefined && label !== '') return label
  const scenario = entry.scenario?.trim()
  if (scenario !== undefined && scenario !== '') return scenario
  const app = entry.app?.trim()
  if (app !== undefined && app !== '') return app
  return '历史会话'
}

/** When the remembered thing happened; falls back to `createdAt`. */
export function memoryEntrySourceTime(entry: AnyMemoryEntry): string {
  return entry.sourceTime ?? entry.createdAt
}

/** Last update, used for deterministic ordering. */
export function memoryEntryUpdatedAt(entry: AnyMemoryEntry): string {
  return entry.updatedAt ?? entry.createdAt
}
