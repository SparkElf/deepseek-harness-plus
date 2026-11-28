import { OFFICIAL_ELASTIC_GRID_PROFILE } from './elastic-grid-profile.js'
import { OFFICIAL_FLUID_PROFILE } from './fluid-profile.js'

export const OFFICIAL_INTERACTION_SOURCE_COUNT = 1

function clampInteraction(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

function makeSource(id, kind, fluidRadius, fluidStrength, gridRadius, gridStrength) {
  return {
    id,
    kind,
    x: 0.5,
    y: 0.5,
    vx: 0,
    vy: 0,
    active: false,
    fluidRadius,
    fluidStrength,
    gridRadius,
    gridStrength,
  }
}

/**
 * Owns the single browser pointer lifecycle shared by every decorative layer.
 * Sources use top-left normalized CONTAINER coordinates and stable object slots.
 * @param reducedMotion - host reduced-motion preference.
 * @param container - decorative layer's box; the sources' coordinate space.
 */
export function createOfficialInteractionSources(reducedMotion, container) {
  const sources = [
    makeSource(
      'pointer',
      'pointer',
      OFFICIAL_FLUID_PROFILE.mouseRadius,
      OFFICIAL_FLUID_PROFILE.mouseStrength,
      OFFICIAL_ELASTIC_GRID_PROFILE.pointerRadius,
      OFFICIAL_ELASTIC_GRID_PROFILE.repulsion,
    ),
  ]
  const listeners = new Set()
  const finePointerQuery = window.matchMedia?.('(hover: hover) and (pointer: fine)')
  let destroyed = false

  const notify = () => {
    if (destroyed) return
    for (const listener of listeners) listener(sources)
  }
  const canTrackPointer = () => !reducedMotion && finePointerQuery?.matches !== false
  const rectOf = () => container.getBoundingClientRect()
  /** True while the viewport point lies inside the decorative layer's box. */
  const isInside = (left, top) => {
    const rect = rectOf()
    return left >= rect.left && left <= rect.right && top >= rect.top && top <= rect.bottom
  }
  const setPointer = (event) => {
    const pointer = sources[0]
    if (!isInside(event.clientX, event.clientY)) {
      stopPointer()
      return
    }
    const rect = rectOf()
    pointer.x = clampInteraction((event.clientX - rect.left) / Math.max(1, rect.width))
    pointer.y = clampInteraction((event.clientY - rect.top) / Math.max(1, rect.height))
    pointer.active = canTrackPointer()
    notify()
  }
  const stopPointer = () => {
    const pointer = sources[0]
    if (!pointer.active) return
    pointer.active = false
    notify()
  }
  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') stopPointer()
  }
  const onPointerCapabilityChange = () => {
    if (!canTrackPointer()) stopPointer()
  }

  /* Listen on the window, never on the layer: the layer is pointer-events:none
     and sits BESIDE the official content rather than above it, so pointer events
     never reach it. The container rectangle is applied as a filter instead, which
     is how the pointer stays scoped to the right-hand column. */
  window.addEventListener('pointermove', setPointer, { passive: true })
  window.addEventListener('pointerdown', setPointer, { passive: true })
  window.addEventListener('pointerleave', stopPointer, { passive: true })
  window.addEventListener('pointercancel', stopPointer, { passive: true })
  window.addEventListener('blur', stopPointer, { passive: true })
  document.addEventListener('visibilitychange', onVisibilityChange, { passive: true })
  finePointerQuery?.addEventListener?.('change', onPointerCapabilityChange)

  return {
    getSources: () => sources,
    getActiveCount: () => {
      let count = 0
      for (const source of sources) count += source.active ? 1 : 0
      return count
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    destroy: () => {
      destroyed = true
      window.removeEventListener('pointermove', setPointer)
      window.removeEventListener('pointerdown', setPointer)
      window.removeEventListener('pointerleave', stopPointer)
      window.removeEventListener('pointercancel', stopPointer)
      window.removeEventListener('blur', stopPointer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      finePointerQuery?.removeEventListener?.('change', onPointerCapabilityChange)
      listeners.clear()
    },
  }
}
