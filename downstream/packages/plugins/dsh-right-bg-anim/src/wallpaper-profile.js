import { OFFICIAL_FLUID_PROFILE } from './anim/fluid-profile.js'

/**
 * How the decorative film is composited, and how visible it is.
 *
 * TWO MODES, both driven by the same fluid simulation:
 *
 * \`glass\` — a translucent tinted sheet laid over the background. The fluid owns a
 * colour and the host background stays the dominant surface underneath it. This
 * is the default because it is the only mode that reads correctly on the near
 * black (\`#151517\`) dark scheme.
 *
 * \`modulation\` — the sheet keeps no colour of its own and composites with
 * \`mix-blend-mode: soft-light\`, so it only modulates the LUMINANCE of whatever
 * the host paints underneath. This reads as mist drifting over the page.
 *
 * Measured constraint that shapes both modes: soft-light on \`#151517\` is almost
 * inert at mid grey. A neutral 0x80 sheet moves the page by ~1.6/255, while a
 * 0xB0 sheet moves it ~7.4 and 0xD8 moves it ~19.9 (alpha 0.8 measured on the
 * real host). The modulation ramp therefore runs in the upper grey band, and the
 * user's strength setting scales how far into that band it reaches.
 */

/** Fallback host background when the token is not readable yet. */
const FALLBACK_LIGHT = '#ffffff'
const FALLBACK_DARK = '#151517'

/** Parse \`#rgb\` / \`#rrggbb\` into a 0..1 RGB triple; undefined for anything else. */
export function parseHexColor(value) {
  const text = String(value ?? '').trim()
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
  if (match === null) return undefined
  const digits = match[1].length === 3
    ? match[1].split('').map(character => character + character).join('')
    : match[1]
  return [
    Number.parseInt(digits.slice(0, 2), 16) / 255,
    Number.parseInt(digits.slice(2, 4), 16) / 255,
    Number.parseInt(digits.slice(4, 6), 16) / 255,
  ]
}

function mix(from, to, amount) {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ]
}

function toHex(rgb) {
  return '#' + rgb
    .map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0'))
    .join('')
}

function clampUnit(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Glass tints.
 *
 * Light: ink. The trough is the page itself, so only the water body darkens it.
 * Dark: cold glass. The trough is the page and the crest is a cool slate sheen —
 * deliberately not white, which is what made earlier attempts read as paint.
 */
const LIGHT_INK = [0.04, 0.04, 0.05]
const DARK_SHEEN = [0.46, 0.52, 0.62]

/**
 * Modulation ramps, one per scheme.
 *
 * soft-light is inert at BOTH extremes of the backdrop: measured on the real host
 * a mid-grey sheet moves a #151517 page by only ~1.6/255 and a #ffffff page by
 * nothing at all. One blend mode therefore cannot serve both schemes, so the ramp
 * and the mode are chosen together:
 *
 * - dark backdrop → \`soft-light\` LIFTS the page; trough sits at the blend identity
 *   (0.5) and strength pushes body/crest up. Measured: 0xB0 ≈ +7, 0xD8 ≈ +20.
 * - light backdrop → \`multiply\` SINKS the page; the identity is white (1.0) and
 *   strength pushes body/crest down. Measured: 0x80 ≈ -102, 0x60 ≈ -127.
 */
const MODULATION = Object.freeze({
  dark: Object.freeze({ trough: 0.50, body: 0.69, crest: 0.85, minBody: 0.56 }),
  light: Object.freeze({ trough: 1.00, body: 0.44, crest: 0.30, minBody: 0.80 }),
})

/** Blend mode per scheme, applied by CSS through the layer's data-scheme. */
export const MODULATION_BLEND = Object.freeze({ dark: 'soft-light', light: 'multiply' })

/** Specular strength — a believable glass reflection, not upstream's fog. */
const SPECULAR = Object.freeze({
  glowIntensity: 0.07,
  lightCore: 0.06,
  lightHalo: 0.08,
  bloomStrength: 0.15,
  bloomThreshold: 0.72,
  bloomRange: 0.14,
})

/** Grid tint per scheme: dark lines on the light page, light lines on the dark one. */
const GRID_TINT = Object.freeze({ light: '18, 18, 22', dark: '255, 255, 255' })

/** True while the host renders the dark palette. */
export function isDarkScheme() {
  return document.body.hasAttribute('data-ds-dark-theme')
}

/**
 * Read the host's base background colour — the surface this film sits on.
 * @returns the resolved \`#rrggbb\` string, or undefined when unreadable.
 */
export function readHostBackground() {
  const styles = [getComputedStyle(document.body), getComputedStyle(document.documentElement)]
  for (const style of styles) {
    const declared = style.getPropertyValue('--dsw-alias-bg-base').trim()
    if (parseHexColor(declared) !== undefined) return declared
  }
  return undefined
}

/**
 * Build the profile for one mode, scheme and strength.
 * @param options - resolved inputs.
 * @param options.baseHex - host background colour.
 * @param options.dark - whether the host renders the dark palette.
 * @param options.mode - \`glass\` or \`modulation\`.
 * @param options.alpha - film opacity, 0..1.
 * @param options.strength - contrast of the ramp, 0..1.
 * @returns a frozen profile for the fluid renderer.
 */
export function createWallpaperProfile({ baseHex, dark, mode, alpha, strength }) {
  const base = parseHexColor(baseHex) ?? parseHexColor(dark ? FALLBACK_DARK : FALLBACK_LIGHT)
  const amount = clampUnit(Number.isFinite(strength) ? strength : 0.5, 0, 1)
  const opacity = clampUnit(Number.isFinite(alpha) ? alpha : 0.04, 0, 1)
  const colors = mode === 'modulation'
    ? modulationRamp(amount, dark)
    : glassRamp(base, dark, amount)
  return Object.freeze({
    ...OFFICIAL_FLUID_PROFILE,
    ...SPECULAR,
    opacity,
    gridTint: dark ? GRID_TINT.dark : GRID_TINT.light,
    colors,
    glowColors: Object.freeze([colors[2], colors[1], colors[0]]),
  })
}

/** Grey ramp for the modulation mode; strength scales the reach away from identity. */
function modulationRamp(amount, dark) {
  const band = dark ? MODULATION.dark : MODULATION.light
  const body = band.minBody + (band.body - band.minBody) * amount
  const crest = body + (band.crest - body) * (0.45 + amount * 0.55)
  return Object.freeze([band.trough, body, crest, body, band.trough].map(gray))
}

/** Tinted ramp for the glass mode; strength scales how far the crest departs. */
function glassRamp(base, dark, amount) {
  const scale = 0.35 + amount * 1.3
  const trough = base
  const body = dark ? mix(base, DARK_SHEEN, 0.55 * scale) : mix(base, LIGHT_INK, 0.85 * scale)
  const crest = dark ? mix(base, DARK_SHEEN, 1.0 * scale) : mix(base, LIGHT_INK, 0.55 * scale)
  return Object.freeze([trough, body, crest, body, trough].map(toHex))
}

/** One grey level as \`#rrggbb\`, which is what the shader loader accepts. */
function gray(level) {
  const channel = Math.round(clampUnit(level, 0, 1) * 255).toString(16).padStart(2, '0')
  return '#' + channel + channel + channel
}