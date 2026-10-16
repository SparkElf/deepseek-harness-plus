/**
 * Chinese metadata for the skill center, read from each skill's own directory.
 *
 * The panel renders what the official registry routes on, so the registry's English
 * description is what decides whether the model invokes a skill. Replacing it would
 * change that decision, so a translation is carried alongside and applied only at
 * render time: the card shows Chinese, the model keeps reading English.
 *
 * A skill keeps its translation in its own directory (`<skill>/i18n/zh.json`), which
 * lets a skill and its Chinese travel together and ship from one clone. The skill
 * file itself is located through the registry, so the translation is found even when
 * the skill resolves through a symlink into another repository.
 *
 * @module @sparkelf/dsh-client-ui-skill-center/translations
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One skill's translated metadata. */
export interface SkillTranslation {
  /** Short Chinese title shown in place of the kebab-case identifier. */
  title: string
  /** Chinese rendering of the registry description. */
  description: string
  /** Chinese summary of the skill body. */
  summary: string
}

/** Translation progress, written by the translation script. */
export interface TranslationProgress {
  total: number
  done: number
  current: string | null
  finishedAt: string | null
}

/** The translation record as stored on disk. */
interface TranslationRecord {
  _meta?: { sourceHash?: string }
  title?: unknown
  description?: unknown
  summary?: unknown
}

/**
 * Read one skill's translation from beside its resolved skill file.
 *
 * A skill without a translation, or with an unreadable or malformed one, is returned
 * as undefined: the panel then shows the registry values, so a partial translation
 * set degrades to English rather than to a broken card.
 *
 * @param skillFilePath - absolute path of the skill's SKILL.md, when the registry reports one.
 * @returns the translation, or undefined when none is usable.
 */
export async function readSkillTranslation(skillFilePath: string | undefined): Promise<SkillTranslation | undefined> {
  if (skillFilePath === undefined) return undefined
  let record: TranslationRecord
  try {
    record = JSON.parse(await readFile(join(dirname(skillFilePath), 'i18n', 'zh.json'), 'utf8')) as TranslationRecord
  } catch {
    // No translation yet, or one that is unreadable or not JSON. Both mean the same
    // thing to the caller, and the skill list must not fail because of either.
    return undefined
  }
  const { title, description, summary } = record
  if (typeof title !== 'string' || typeof description !== 'string' || typeof summary !== 'string') return undefined
  return { title, description, summary }
}

/**
 * Read translation progress for the panel's progress bar.
 *
 * @param translationRoot - repository holding the skill set, whose `i18n/.progress.json` the script writes.
 * @returns the progress, or undefined when no translation run has recorded one.
 */
export async function readTranslationProgress(translationRoot: string): Promise<TranslationProgress | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(translationRoot, 'i18n', '.progress.json'), 'utf8')) as Record<string, unknown>
    if (typeof raw.total !== 'number' || typeof raw.done !== 'number') return undefined
    return {
      total: raw.total,
      done: raw.done,
      current: typeof raw.current === 'string' ? raw.current : null,
      finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    }
  } catch {
    return undefined
  }
}
