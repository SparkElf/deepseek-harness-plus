/**
 * The loading state, as a book whose page turns.
 *
 * The knowledge base is a library of documents, so a turning page says what is
 * happening in the product's own terms rather than with a generic spinner. The
 * animation is CSS and inline SVG: no animation library, because this plugin ships
 * as one bundled file and a dependency would grow it and add a supply-chain surface
 * for a decoration.
 *
 * The motion is a real 3D turn rather than a sequence of drawn frames: the leaf is a
 * zero-thickness plane inside a `perspective` container, rotated about the spine with
 * `rotateY`. That keeps the whole effect to two keyframes and makes the direction of
 * travel read correctly at any moment, which a frame sequence does not.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import styles from './KnowledgeLoading.module.css'

/** Props for the loading surface. */
export interface KnowledgeLoadingProps {
  /**
   * What is being loaded, in the reader's language.
   *
   * Optional because a card or a table cell may have no label of its own; the
   * animation then stands alone and the accessible name falls back to the shared
   * loading sentence.
   */
  label?: string
  /**
   * Accessible name for the animation itself.
   *
   * Required rather than derived: the animation is decorative, so it must either be
   * hidden from assistive technology or carry a name, and hiding it silently would
   * leave a screen-reader user with no announcement that anything is loading.
   */
  announce?: string
}

/**
 * Render the book-turning loading animation.
 * @param props - the optional label and the accessible announcement.
 * @returns The centred loading surface.
 */
export function KnowledgeLoading(props: KnowledgeLoadingProps) {
  return (
    <div className={styles.wrap} role="status" aria-live="polite">
      {/*
        The SVG is drawn in three parts so the layers can move independently in CSS:
        the open cover and its pages stay put, and only the leaf turns. Drawing the
        whole book in one path would force a single transform over all of it and lose
        the hinge.
      */}
      <svg
        className={styles.book}
        viewBox="0 0 64 48"
        width="64"
        height="48"
        aria-hidden="true"
        focusable="false"
      >
        {/* The back cover, slightly wider than the pages so the board edge shows. */}
        <rect className={styles.coverBack} x="4" y="6" width="56" height="36" rx="3" />
        {/* The page block resting on the left half, with a thin stack edge. */}
        <rect className={styles.pagesLeft} x="7" y="10" width="24" height="28" rx="1.5" />
        {/* Its mirror on the right, which the turning leaf uncovers. */}
        <rect className={styles.pagesRight} x="33" y="10" width="24" height="28" rx="1.5" />
        {/*
          The leaf. Its transform-origin is the spine (x = 32 of 64), so the rotation
          happens about the book's centre rather than about the shape's own middle,
          which is what makes it read as a page instead of a spinning card.
        */}
        <rect className={styles.leaf} x="33" y="10" width="23" height="28" rx="1.5" />
      </svg>
      {/*
        Rendered outside the SVG so it wraps and inherits the page's font rather than
        depending on SVG text layout, which does not wrap.
      */}
      {props.label !== undefined && props.label !== '' && (
        <p className={styles.label}>{props.label}</p>
      )}
      {/*
        The announcement is only needed when there is no visible label, or when it says
        something the label does not. A visible label is already in the accessibility
        tree, so repeating it here would have a screen reader say it twice.
      */}
      {(props.announce ?? '') !== '' && props.announce !== props.label && (
        <span className={styles.srOnly}>{props.announce}</span>
      )}
    </div>
  )
}
