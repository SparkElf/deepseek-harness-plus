/**
 * dsh-right-bg-anim — the ONLY stylesheet this plugin owns.
 *
 * Scope contract: every rule is anchored to the centre column, which the official
 * AppFrame already clips (`overflow: hidden`) and which starts exactly at the
 * sidebar's right edge. The decorative layer therefore cannot reach the sidebar
 * by construction, with no JS measurement and no sidebar width variable.
 *
 * The layer paints NOTHING of its own: it is a transparent film, so the official
 * background (`--dsw-alias-bg-base`) stays visible underneath in both schemes.
 */
export const RIGHT_BG_ANIM_CSS = String.raw`
/* The centre column becomes the positioning context for the layer. */
[data-dsh-center-col] {
  position: relative;
}

/* The decorative film: clipped by the centre column, fully transparent so the
   host background shows through. */
.dsh-right-bg-anim {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
  transition: opacity 240ms ease;
}

/* Raised only while a NEW session (hero phase) owns the centre column. */
.dsh-right-bg-anim[data-active] {
  opacity: 1;
}

/* One canvas per effect, filling the film. */
.dsh-right-bg-anim canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

/* Kept from upstream: the fluid fades out toward the bottom edge. */
.dsh-right-bg-anim .dsh-right-bg-anim-field {
  z-index: 0;
  -webkit-mask-image: linear-gradient(rgba(0, 0, 0, 0.99) 0%, rgba(0, 0, 0, 0.91) 8.98%, transparent 100%);
  mask-image: linear-gradient(rgba(0, 0, 0, 0.99) 0%, rgba(0, 0, 0, 0.91) 8.98%, transparent 100%);
}

/* Kept from upstream: the grid fades out toward the bottom edge. */
.dsh-right-bg-anim .dsh-right-bg-anim-grid {
  z-index: 5;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, rgba(0, 0, 0, 0.78) 58%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, rgba(0, 0, 0, 0.78) 58%, transparent 100%);
}

/* Every official element of the centre column paints above the film. */
[data-dsh-center-col] > [data-slot='main'] {
  position: relative;
  z-index: 1;
}

/* THE one official element this plugin touches, and only in the hero phase: the
   conversation root draws the base background over the whole column. Leaving it
   opaque would hide the film completely. The selector is phase-scoped on
   purpose: in every other phase (active conversation, panels) it does not match,
   the official background is untouched, and the film stays hidden. */
[data-dsh-center-col] [data-slot='main.conversation'] > *[data-phase='hero'] {
  background: transparent !important;
}

/* Same device gate as upstream: coarse pointers never see the decoration. */
@media (max-width: 767px), (hover: none), (pointer: coarse) {
  .dsh-right-bg-anim {
    display: none;
  }
}

/* ==== Settings row (rendered inside the official general settings list) ==== */

[data-dsh-right-bg-anim-settings] {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 0;
}

[data-dsh-right-bg-anim-settings] .dsh-right-bg-anim-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

[data-dsh-right-bg-anim-settings] .dsh-right-bg-anim-row > label {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

[data-dsh-right-bg-anim-settings] .dsh-right-bg-anim-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

[data-dsh-right-bg-anim-settings] .dsh-right-bg-anim-copy strong {
  font-size: 14px;
  font-weight: 500;
}

[data-dsh-right-bg-anim-settings] .dsh-right-bg-anim-copy span {
  font-size: 12px;
  opacity: 0.66;
}

[data-dsh-right-bg-anim-settings] .dsh-right-bg-anim-slider {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 8px;
}

[data-dsh-right-bg-anim-settings] .dsh-right-bg-anim-slider span {
  grid-column: 1 / -1;
  font-size: 12px;
  opacity: 0.66;
}

[data-dsh-right-bg-anim-settings] input[type='range'] {
  width: 100%;
}

[data-dsh-right-bg-anim-settings] select {
  min-width: 132px;
}

/* ==== Modulation mode ==== */

/* The film keeps no colour of its own: it modulates the LUMINANCE of whatever
   the host paints underneath, which reads as mist rather than as paint.

   The blend mode must follow the scheme. soft-light is inert at both ends of the
   backdrop (measured: ~1.6/255 on #151517, ~0 on #ffffff), so a single mode
   cannot serve both: on the dark page the mist LIFTS via soft-light, on the light
   page it SINKS via multiply. The ramp in wallpaper-profile.js is inverted to
   match, so "明显程度" means the same thing in both schemes. */
.dsh-right-bg-anim[data-mode='modulation'][data-scheme='dark'] {
  mix-blend-mode: soft-light;
}

.dsh-right-bg-anim[data-mode='modulation'][data-scheme='light'] {
  mix-blend-mode: multiply;
}

/* Disabled means the layer stays mounted but shows nothing, so re-enabling is
   instant and no canvas has to be rebuilt. */
.dsh-right-bg-anim:not([data-enabled]) {
  display: none;
}
`;