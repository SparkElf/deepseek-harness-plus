/**
 * User-facing controls for the decorative film.
 *
 * The two composition modes need values on completely different scales — glass
 * reads correctly at a film opacity of ~0.04 while the modulation mist needs
 * ~0.48 to register on a dark page. A single "明显程度" therefore cannot serve
 * both: switching modes would carry a value that is wrong for the new mode.
 *
 * So the value is stored PER MODE and PER SCHEME. Switching modes lands on the
 * value last used for that mode (its default the first time), and switching the
 * host colour scheme never destroys the value tuned for the other one. The dark
 * scheme keeps its approved 0.48 mist; the light scheme uses a light touch (0.1)
 * and leans on a stronger grid instead.
 */

const STORAGE_KEY = 'dsh.right-bg-anim.settings.v3'

/** Composition modes. */
export const MODES = Object.freeze(['glass', 'modulation'])

/** Slider ranges, shared by the store and the row so they cannot drift apart. */
export const RANGES = Object.freeze({
  alpha: Object.freeze({ min: 0, max: 1, step: 0.01 }),
  gridOpacity: Object.freeze({ min: 0, max: 3, step: 0.05 }),
  speed: Object.freeze({ min: 0.2, max: 3, step: 0.1 }),
})

/**
 * Per-mode, per-scheme defaults for "明显程度".
 *
 * glass: the film opacity that reads as a thin sheet on either page.
 * modulation: the mist strength — dark takes 0.48, light only a trace, because
 * multiply on a white page bites much harder than soft-light on a dark one.
 */
export const DEFAULT_ALPHA = Object.freeze({
  glass: Object.freeze({ dark: 0.04, light: 0.04 }),
  modulation: Object.freeze({ dark: 0.48, light: 0.1 }),
})

/** Per-scheme grid strength: hairlines need more presence on white than on black. */
export const DEFAULT_GRID = Object.freeze({ dark: 1, light: 1.8 })

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  mode: 'modulation',
  speed: 1,
  alpha: DEFAULT_ALPHA,
  gridOpacity: DEFAULT_GRID,
})

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function inRange(value, fallback, range) {
  const number = Number(value)
  return Number.isFinite(number) ? clamp(number, range.min, range.max) : fallback
}

/** Read one alpha quad, falling back per cell so a partial record still loads. */
function alphaQuad(value) {
  const read = (mode, scheme) => inRange(
    value?.[mode]?.[scheme],
    DEFAULT_ALPHA[mode][scheme],
    RANGES.alpha,
  )
  return Object.freeze({
    glass: Object.freeze({ dark: read('glass', 'dark'), light: read('glass', 'light') }),
    modulation: Object.freeze({ dark: read('modulation', 'dark'), light: read('modulation', 'light') }),
  })
}

function gridPair(value) {
  return Object.freeze({
    dark: inRange(value?.dark, DEFAULT_GRID.dark, RANGES.gridOpacity),
    light: inRange(value?.light, DEFAULT_GRID.light, RANGES.gridOpacity),
  })
}

/** Narrow any stored/partial value into a complete, in-range settings object. */
export function normalizeSettings(value) {
  return Object.freeze({
    enabled: value?.enabled !== false,
    mode: MODES.includes(value?.mode) ? value.mode : DEFAULT_SETTINGS.mode,
    speed: inRange(value?.speed, DEFAULT_SETTINGS.speed, RANGES.speed),
    alpha: alphaQuad(value?.alpha),
    gridOpacity: gridPair(value?.gridOpacity),
  })
}

/** Last persisted settings, or the defaults. */
export function readSettings() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw !== null) return normalizeSettings(JSON.parse(raw))
  } catch {}
  return DEFAULT_SETTINGS
}

/** True while the host renders the dark palette. */
function isDark() {
  return document.body.hasAttribute('data-ds-dark-theme')
}

/**
 * Settings store.
 *
 * \`get()\` is the persisted object (every mode and scheme); \`active()\` is the slice
 * that applies to the mode and scheme currently on screen, which is what the
 * renderer and the settings row both read. \`active()\` returns a cached object so
 * it is safe as a \`useSyncExternalStore\` snapshot.
 */
export function createSettingsStore() {
  let settings = readSettings()
  let scheme = isDark() ? 'dark' : 'light'
  let snapshot = null
  const listeners = new Set()

  const derive = () => Object.freeze({
    enabled: settings.enabled,
    mode: settings.mode,
    speed: settings.speed,
    scheme,
    alpha: settings.alpha[settings.mode][scheme],
    /** Default for the current mode+scheme, so the row can show what "默认" is. */
    alphaDefault: DEFAULT_ALPHA[settings.mode][scheme],
    gridOpacity: settings.gridOpacity[scheme],
    gridDefault: DEFAULT_GRID[scheme],
  })

  const notify = () => {
    snapshot = null
    for (const listener of listeners) listener()
  }

  return {
    get: () => settings,
    active: () => (snapshot ??= derive()),
    modeDefaults: (mode) => DEFAULT_ALPHA[mode],
    /** Follow the host theme; the next \`active()\` resolves the other pair. */
    setScheme: (next) => {
      if (next === scheme) return
      scheme = next
      notify()
    },
    set: (update) => {
      const mode = update.mode ?? settings.mode
      const alpha = update.alpha !== undefined
        ? { ...settings.alpha, [mode]: { ...settings.alpha[mode], [scheme]: update.alpha } }
        : settings.alpha
      const gridOpacity = update.gridOpacity !== undefined
        ? { ...settings.gridOpacity, [scheme]: update.gridOpacity }
        : settings.gridOpacity
      settings = normalizeSettings({
        ...settings,
        ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
        ...(update.mode !== undefined ? { mode: update.mode } : {}),
        ...(update.speed !== undefined ? { speed: update.speed } : {}),
        alpha,
        gridOpacity,
      })
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)) } catch {}
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
