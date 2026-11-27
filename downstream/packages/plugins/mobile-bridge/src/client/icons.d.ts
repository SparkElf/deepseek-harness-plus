/**
 * Type augmentation for icons the runtime provides but upstream's declarations omit.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` ships every `Icon*` symbol in its built `lib/index.js`,
 * yet `lib/types/index.d.ts` declares no icon at all. Importing one compiles against a declaration
 * that says it is missing while it works at runtime.
 *
 * This augments the existing module rather than redeclaring it: a bare `declare module` would
 * replace every other export, which broke `Button` and `Modal` as well. Delete once upstream's
 * declarations list what its runtime exports.
 */
import '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType, SVGProps } from 'react'

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export const IconStopFillRegular: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>
}
