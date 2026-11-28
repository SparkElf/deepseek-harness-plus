import { RIGHT_BG_ANIM_CSS } from './css.js'
import { MODES, RANGES, createSettingsStore } from './settings.js'
import { createWallpaperProfile, isDarkScheme, readHostBackground } from './wallpaper-profile.js'
import { createOfficialInteractionSources } from './anim/interaction-sources.js'
import { createOfficialPointerField } from './anim/pointer-field.js'
import { createOfficialElasticGrid } from './anim/elastic-grid.js'

/**
 * Browser half of dsh-right-bg-anim.
 *
 * It mounts exactly one decorative layer — the fluid film and the elastic grid —
 * into the official centre column, and enables it only while the column shows a
 * NEW session (\`data-phase="hero"\`). The film is transparent, so the host's own
 * background stays visible and both colour schemes look intentional.
 *
 * Nothing else in the GUI is touched: no theme tokens, no palette lock, no
 * global CSS. The only official element this plugin styles is the conversation
 * root, and only inside the hero phase (see css.js).
 *
 * The settings row (settings.general.item) exposes the composition mode and the
 * strengths; it renders through the host's own settings list, so it inherits the
 * official look.
 */

const PLUGIN_ID = 'dsh-right-bg-anim'
const STYLE_SELECTOR = 'style[data-plugin-css="dsh-right-bg-anim/anim.css"]'
const CENTER_COLUMN_SELECTOR = '[data-dsh-center-col]'
const HERO_SELECTOR = "[data-slot='main.conversation'] > *[data-phase='hero']"
const LAYER_CLASS = 'dsh-right-bg-anim'
const DARK_ATTRIBUTE = 'data-ds-dark-theme'
const SETTINGS_SLOT = 'settings.general.item'
/** Hard dependency: the slot registry backing ctx.slots. */
export const inject = ['slots']

/** Install this plugin's single stylesheet, idempotently. */
function installStyle() {
  const existing = document.querySelector(STYLE_SELECTOR)
  if (existing !== null) return () => {}

  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = `${PLUGIN_ID}/anim.css`
  tag.textContent = RIGHT_BG_ANIM_CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

/**
 * The settings row. Rendered by the host inside its own settings list, so it
 * uses the host's spacing and colours and only adds what it needs.
 */
function RightBgAnimSettings(props) {
  const React = require('react')
  const settings = React.useSyncExternalStore(props.store.subscribe, props.store.active, props.store.active)
  const set = props.store.set
  const range = RANGES
  /* Each slider shows the value for the CURRENT mode and scheme, and marks the
     mode's own default, so a mode switch visibly lands on that mode's default
     instead of carrying over a number tuned for the other one. */
  const slider = (label, value, fallback, kind, onChange) => React.createElement('label', { className: 'dsh-right-bg-anim-slider' },
    React.createElement('span', null,
      `${label} ${Math.round(value * 100) / 100}`,
      Math.abs(value - fallback) > 0.001 ? `（该模式默认 ${fallback}）` : '',
    ),
    React.createElement('input', {
      type: 'range', min: String(range[kind].min), max: String(range[kind].max), step: String(range[kind].step),
      value: String(value), disabled: !settings.enabled,
      onChange: (event) => { onChange(Number(event.target.value)) },
    }),
  )
  return React.createElement('section', { 'data-dsh-right-bg-anim-settings': '' },
    React.createElement('div', { className: 'dsh-right-bg-anim-row' },
      React.createElement('div', { className: 'dsh-right-bg-anim-copy' },
        React.createElement('strong', null, '新会话背景动画'),
        React.createElement('span', null, '仅在新会话的主内容区显示，不影响侧边栏与其他界面。'),
      ),
      React.createElement('label', { className: 'dsh-right-bg-anim-row' },
        React.createElement('input', {
          type: 'checkbox', checked: settings.enabled,
          onChange: (event) => { set({ enabled: event.target.checked }) },
        }),
        React.createElement('span', null, '启用'),
      ),
    ),
    React.createElement('label', { className: 'dsh-right-bg-anim-row' },
      React.createElement('span', null, '效果模式'),
      React.createElement('select', {
        value: settings.mode, disabled: !settings.enabled,
        onChange: (event) => { set({ mode: event.target.value }) },
      },
      ...MODES.map(mode => React.createElement('option', { key: mode, value: mode },
        mode === 'glass' ? '玻璃薄膜（保留底色）' : '调制雾感（只改明暗）'))),
    ),
    slider('明显程度', settings.alpha, settings.alphaDefault, 'alpha', (value) => { set({ alpha: value }) }),
    slider('网格强度', settings.gridOpacity, settings.gridDefault, 'gridOpacity', (value) => { set({ gridOpacity: value }) }),
    slider('流动速度', settings.speed, 1, 'speed', (value) => { set({ speed: value }) }),
  )
}

/** Mount the layer into \`center\` and own its animation lifecycle. */
function mountLayer(center, reducedMotion, store) {
  const layer = document.createElement('div')
  layer.className = LAYER_CLASS
  layer.setAttribute('aria-hidden', 'true')
  center.insertBefore(layer, center.firstChild)

  const interaction = createOfficialInteractionSources(reducedMotion, layer)
  const field = createOfficialPointerField(reducedMotion, interaction, layer)
  const grid = createOfficialElasticGrid(reducedMotion, interaction, layer)
  field.setIntensity(1)

  /** Re-resolve palette, mode attribute and per-effect enablement from one state. */
  const apply = () => {
    const dark = isDarkScheme()
    /* Track the host scheme BEFORE reading, so \`active()\` resolves the pair that
       belongs to what the user is looking at. */
    store.setScheme(dark ? 'dark' : 'light')
    const settings = store.active()
    layer.dataset.mode = settings.mode
    layer.dataset.scheme = dark ? 'dark' : 'light'
    layer.toggleAttribute('data-enabled', settings.enabled)
    field.setProfile(createWallpaperProfile({
      baseHex: readHostBackground(),
      dark: isDarkScheme(),
      mode: settings.mode,
      alpha: settings.alpha,
      strength: settings.alpha,
    }))
    field.setSpeed?.(settings.speed)
    grid.setTint(dark ? '255, 255, 255' : '18, 18, 22')
    grid.setOpacity?.(settings.gridOpacity)
    sync()
  }

  /*
   * The hero phase is the only phase that shows the decoration. It is also the
   * only phase whose official background we clear (see css.js), so the two
   * decisions must come from one predicate.
   */
  const sync = () => {
    const settings = store.active()
    const heroActive = settings.enabled && center.querySelector(HERO_SELECTOR) !== null
    layer.toggleAttribute('data-active', heroActive)
    field.setEnabled(heroActive)
    grid.setEnabled(heroActive)
  }
  apply()
  const unsubscribe = store.subscribe(apply)

  const phaseObserver = new MutationObserver(sync)
  phaseObserver.observe(center, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-phase'],
  })

  /*
   * The host flips colour scheme by toggling body[data-ds-dark-theme]; the film
   * and the grid re-read their palette from that one marker so a live theme
   * switch is reflected without a reload.
   */
  const schemeObserver = new MutationObserver(apply)
  schemeObserver.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })

  return () => {
    unsubscribe()
    schemeObserver.disconnect()
    phaseObserver.disconnect()
    grid.destroy()
    field.destroy()
    interaction.destroy()
    layer.remove()
  }
}

/** The plugin entry: one effect owning stylesheet, layer, settings row and observers. */
export function apply(ctx) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return

  ctx.effect(() => {
    const removeStyle = installStyle()
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    const store = createSettingsStore()
    let stopLayer = null
    let disposed = false

    const disposeSettings = ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
      name: SETTINGS_SLOT,
      id: 'dsh-right-bg-anim',
      order: 40,
      inject: () => ({ store }),
    }, RightBgAnimSettings))

    const adopt = (center) => {
      if (disposed) return
      document.querySelectorAll(`.${LAYER_CLASS}`).forEach(stale => { stale.remove() })
      stopLayer = mountLayer(center, reducedMotion, store)
    }

    /* The shell may not have rendered the frame yet: wait for the anchor. */
    const center = document.querySelector(CENTER_COLUMN_SELECTOR)
    const anchorObserver = center === null
      ? new MutationObserver(() => {
        const found = document.querySelector(CENTER_COLUMN_SELECTOR)
        if (found === null) return
        anchorObserver.disconnect()
        adopt(found)
      })
      : null
    if (center !== null) adopt(center)
    else anchorObserver.observe(document.documentElement, { childList: true, subtree: true })

    return () => {
      disposed = true
      anchorObserver?.disconnect()
      disposeSettings?.()
      stopLayer?.()
      removeStyle()
      document.querySelectorAll(`.${LAYER_CLASS}`).forEach(stale => { stale.remove() })
    }
  }, 'right-bg-anim: hero-stage fluid film and elastic grid')
}