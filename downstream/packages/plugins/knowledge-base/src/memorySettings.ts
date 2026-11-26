/**
 * Per-user memory settings: whether personal memory learning is enabled and how
 * often the guardian consolidates what it learned.
 *
 * The product rule (design §22.2) is deliberately conservative:
 *
 * - a new user is **paused** (`memoryEnabled: false`), so no extraction starts
 *   until the user explicitly confirms the enable dialog;
 * - an administrator or super administrator (a holder of the configured DataOps
 *   permission, by default `kb:config:manage`) starts **enabled** on the first
 *   read when no settings file exists yet. The global default is never flipped:
 *   the administrator decision is injected through {@link MemorySettingsDefaultPolicy},
 *   and an explicit `false` written by that administrator always wins;
 * - the switch is per user, not per session, and survives restarts;
 * - the file is local state under `<usersRoot>/<userId>/settings.json`, never
 *   knowledge content and never Git content;
 * - a missing or unreadable file is a valid "paused" answer, not an error. Only
 *   a filesystem permission failure is surfaced.
 *
 * The persisted shape is version 2 (`memoryEnabled` + `consolidationIntervalMinutes`).
 * Version 1 files (only `memoryEnabled`, or even a hand-written bare boolean) are
 * still read: a missing interval falls back to 60 minutes, and a malformed
 * interval never turns a remembered enable/disable decision into a different one.
 *
 * The route/UI layer reads `read()` or `isEnabled()` and writes through
 * `save()`; every write is atomic (tmp + rename) and persists both fields in one
 * rename so a page save can never leave the switch and the interval disagreeing.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-settings
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPathSegment, writeFileAtomic } from './memoryBindings.ts'

/** File name inside one user's directory. */
export const MEMORY_SETTINGS_FILE = 'settings.json'

/** Current persisted schema version. */
export const MEMORY_SETTINGS_VERSION = 2

/** Shortest allowed consolidation interval, in minutes. */
export const MEMORY_CONSOLIDATION_INTERVAL_MIN = 15

/** Longest allowed consolidation interval, in minutes. */
export const MEMORY_CONSOLIDATION_INTERVAL_MAX = 1440

/** Default consolidation interval, in minutes. */
export const MEMORY_CONSOLIDATION_INTERVAL_DEFAULT = 60

/** Persisted settings shape. */
export interface MemorySettings {
  version: typeof MEMORY_SETTINGS_VERSION
  /** `false` means paused: no new memories are learned. */
  memoryEnabled: boolean
  /** How often the guardian consolidates memory, in minutes (15–1440). */
  consolidationIntervalMinutes: number
}

/** The paused default for a user who has never confirmed the enable dialog. */
export const DEFAULT_MEMORY_SETTINGS: Readonly<MemorySettings> = Object.freeze({
  version: MEMORY_SETTINGS_VERSION,
  memoryEnabled: false,
  consolidationIntervalMinutes: MEMORY_CONSOLIDATION_INTERVAL_DEFAULT,
})

/** A malformed interval or write patch; the route maps this to HTTP 400. */
export class MemorySettingsError extends Error {
  override readonly name = 'MemorySettingsError'

  constructor(
    readonly code: 'invalid-interval' | 'invalid-settings',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Where the first-read default for a principal comes from.
 *
 * The store deliberately does not know what an administrator is. The Host
 * injects this seam with the existing DataOps principal projection, so the KB
 * package keeps no hard-coded role names and a deployment can change the rule
 * without editing this module.
 */
export interface MemorySettingsDefaultPolicy {
  /**
   * Whether a user with no settings file starts enabled.
   *
   * A rejection is treated as "paused": a backend hiccup must not turn memory on
   * silently, and it must not make the settings page unreadable either.
   */
  memoryEnabled(userId: string): boolean | Promise<boolean>
}

/** Optional per-read override, used by the route that already resolved the principal. */
export interface MemorySettingsReadOptions {
  /** Explicit first-read default; when omitted the constructor policy decides. */
  defaultEnabled?: boolean
}

/** A partial write; at least one field must be present. */
export interface MemorySettingsPatch {
  memoryEnabled?: boolean
  consolidationIntervalMinutes?: number
}

/**
 * Validate one consolidation interval.
 *
 * The guard is strict on purpose: a fractional value or a value outside
 * 15–1440 is a client bug, not a number to clamp silently. The route turns this
 * error into a 400 so the page can show the allowed range.
 *
 * @param value - raw value from an API body or a hand-edited file.
 * @returns the accepted integer.
 * @throws {MemorySettingsError} when the value is not an integer in range.
 */
export function normalizeConsolidationInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MemorySettingsError('invalid-interval', 'consolidationIntervalMinutes must be an integer')
  }
  if (value < MEMORY_CONSOLIDATION_INTERVAL_MIN || value > MEMORY_CONSOLIDATION_INTERVAL_MAX) {
    throw new MemorySettingsError(
      'invalid-interval',
      `consolidationIntervalMinutes must be between ${String(MEMORY_CONSOLIDATION_INTERVAL_MIN)} and ${String(MEMORY_CONSOLIDATION_INTERVAL_MAX)}`,
    )
  }
  return value
}

/** Read a stored interval leniently: an invalid legacy value falls back to 60. */
function readStoredInterval(value: unknown): number {
  try {
    return normalizeConsolidationInterval(value)
  } catch {
    return MEMORY_CONSOLIDATION_INTERVAL_DEFAULT
  }
}

/**
 * Atomic settings store over `<usersRoot>/<userId>/settings.json`.
 *
 * `read()` tolerates a corrupt file by returning the paused default; the next
 * write rewrites it. This keeps the memory page usable after a partial write or
 * a hand-edited file instead of failing the whole route.
 */
export class MemorySettingsStore {
  private readonly usersRoot: string
  private readonly defaultPolicy?: MemorySettingsDefaultPolicy

  constructor(usersRoot: string, defaultPolicy?: MemorySettingsDefaultPolicy) {
    if (typeof usersRoot !== 'string' || usersRoot.trim() === '') {
      throw new Error('memory-settings: usersRoot must be a non-empty path')
    }
    this.usersRoot = usersRoot
    this.defaultPolicy = defaultPolicy
  }

  /** Absolute settings file for one user. */
  filePath(userId: string): string {
    assertPathSegment(userId, 'userId')
    return join(this.usersRoot, userId, MEMORY_SETTINGS_FILE)
  }

  /** The first-read default for one user, from the injected policy. */
  private async defaultFor(userId: string, options: MemorySettingsReadOptions): Promise<MemorySettings> {
    if (options.defaultEnabled !== undefined) {
      return {
        ...DEFAULT_MEMORY_SETTINGS,
        memoryEnabled: options.defaultEnabled === true,
      }
    }
    if (this.defaultPolicy === undefined) return { ...DEFAULT_MEMORY_SETTINGS }
    try {
      return {
        ...DEFAULT_MEMORY_SETTINGS,
        memoryEnabled: (await this.defaultPolicy.memoryEnabled(userId)) === true,
      }
    } catch {
      // Fail closed: a policy lookup failure is "paused", never "enabled".
      return { ...DEFAULT_MEMORY_SETTINGS }
    }
  }

  /**
   * Read one user's settings.
   *
   * Missing content uses {@link MemorySettingsReadOptions.defaultEnabled} or the
   * injected policy. Malformed content stays paused even for an administrator:
   * a corrupt file is not evidence that the administrator opted in. A file with
   * a boolean `memoryEnabled` is accepted even if `version`/the interval is
   * missing, so old settings files keep their explicit choice.
   */
  async read(userId: string, options: MemorySettingsReadOptions = {}): Promise<MemorySettings> {
    let source: string
    try {
      source = await readFile(this.filePath(userId), 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return this.defaultFor(userId, options)
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      return { ...DEFAULT_MEMORY_SETTINGS }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_MEMORY_SETTINGS }
    }
    const memoryEnabled = (parsed as Record<string, unknown>).memoryEnabled
    if (typeof memoryEnabled !== 'boolean') return { ...DEFAULT_MEMORY_SETTINGS }
    return {
      version: MEMORY_SETTINGS_VERSION,
      memoryEnabled,
      consolidationIntervalMinutes: readStoredInterval(
        (parsed as Record<string, unknown>).consolidationIntervalMinutes,
      ),
    }
  }

  /** Whether learning is enabled for this user (default `false`). */
  async isEnabled(userId: string, options: MemorySettingsReadOptions = {}): Promise<boolean> {
    return (await this.read(userId, options)).memoryEnabled
  }

  /**
   * Persist a partial settings change in one atomic write.
   *
   * The current value is read first so a page that saves only the interval
   * cannot accidentally pause memory (nor enable it). An explicit boolean in
   * the patch always wins; an absent field is preserved.
   *
   * @returns the normalized settings actually written.
   */
  async save(
    userId: string,
    patch: MemorySettingsPatch,
    options: MemorySettingsReadOptions = {},
  ): Promise<MemorySettings> {
    if (patch.memoryEnabled === undefined && patch.consolidationIntervalMinutes === undefined) {
      throw new MemorySettingsError('invalid-settings', 'at least one memory setting must be supplied')
    }
    if (patch.memoryEnabled !== undefined && typeof patch.memoryEnabled !== 'boolean') {
      throw new MemorySettingsError('invalid-settings', 'memoryEnabled must be a boolean')
    }
    const interval = patch.consolidationIntervalMinutes === undefined
      ? undefined
      : normalizeConsolidationInterval(patch.consolidationIntervalMinutes)
    const current = await this.read(userId, options)
    const settings: MemorySettings = {
      version: MEMORY_SETTINGS_VERSION,
      memoryEnabled: patch.memoryEnabled ?? current.memoryEnabled,
      consolidationIntervalMinutes: interval ?? current.consolidationIntervalMinutes,
    }
    await writeFileAtomic(
      this.filePath(userId),
      `${JSON.stringify(settings, null, 2)}\n`,
      { mode: 0o600 },
    )
    return settings
  }

  /**
   * Persist the enable/pause switch atomically, preserving the interval.
   *
   * @returns the normalized settings actually written.
   */
  async setEnabled(
    userId: string,
    enabled: boolean,
    options: MemorySettingsReadOptions = {},
  ): Promise<MemorySettings> {
    if (typeof enabled !== 'boolean') {
      throw new MemorySettingsError('invalid-settings', 'memoryEnabled must be a boolean')
    }
    return this.save(userId, { memoryEnabled: enabled }, options)
  }

  /** Persist one interval while preserving the switch. */
  async setConsolidationInterval(
    userId: string,
    minutes: number,
    options: MemorySettingsReadOptions = {},
  ): Promise<MemorySettings> {
    return this.save(userId, { consolidationIntervalMinutes: minutes }, options)
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}
