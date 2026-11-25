/**
 * A member's picture, with a stable stand-in when there is none.
 *
 * The official component set ships no avatar, so the two places a person is drawn — the
 * member roster and the invite picker — would otherwise each invent their own. Keeping one
 * component means the fallback, the size and the accessibility name cannot drift apart
 * between them.
 *
 * The initials are computed in `rows.ts`, which is what lets them be tested without mounting
 * this component.
 *
 * The fallback is deliberately not a silhouette: DataOps has pictures for only some accounts, so
 * most rows land on initials, and a generic icon repeated down a list reads as "broken image"
 * rather than as a person. The circle is the portal's own blue with white initials, so a member
 * looks the same here as beside their name on the DataOps pages.
 *
 * @module @sparkelf/dsh-group-chat/client/Avatar
 */

import type { ReactNode } from 'react'
import { initialsOf } from './rows.ts'
import styles from './Avatar.module.css'

/** Sizes the callers use; the class is chosen here so the CSS owns the dimensions. */
export type AvatarSize = 'sm' | 'md'

export interface AvatarProps {
  /** The name to draw initials from and to describe the picture with. */
  readonly name: string
  /** The picture's URL, when DataOps has one. */
  readonly src?: string | null
  readonly size?: AvatarSize
}

/** One member's picture, or their initials when there is no picture to show. */
export const Avatar = (props: AvatarProps): ReactNode => {
  const { name, src, size = 'md' } = props
  const className = `${styles['avatar']} ${size === 'sm' ? styles['sm'] : styles['md']}`
  const fallback = (
    <span className={className} role="img" aria-label={name}>
      {initialsOf(name)}
    </span>
  )
  if (typeof src !== 'string' || src.length === 0) return fallback
  // The initials are always rendered underneath and the picture is layered on top, so a
  // picture that fails after the list has painted — an expired remote URL is the common
  // case — uncovers the initials rather than leaving an empty circle.
  return (
    <span className={styles['stack']}>
      {fallback}
      <img
        className={`${styles['avatar']} ${size === 'sm' ? styles['sm'] : styles['md']} ${styles['over']}`}
        src={src}
        alt=""
        aria-hidden="true"
        onError={(event) => { event.currentTarget.style.display = 'none' }}
      />
    </span>
  )
}
