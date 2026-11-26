/**
 * Who a knowledge document belongs to, derived from where it is stored.
 *
 * The list route reports a path and a location, not an owner: ownership is a property of
 * the bucket, and every rule below is a rule about that bucket. Keeping the derivation
 * here (rather than in the row renderer) does two things. It stays testable without a
 * DOM, and it keeps the answer honest — nothing is invented when the information is not
 * there, because a wrong owner is worse than an unflattering one.
 *
 * @module @sparkelf/dsh-knowledge-base/client/ownerLabel
 */

/** What the caller knows about itself, as far as ownership is concerned. */
export interface OwnerContext {
  /** The caller's DataOps id, so `personal/<id>` can be recognised as one's own folder. */
  callerId?: string
  /** The caller's own department code, for naming the department bucket. */
  departmentCode?: string
  /** The caller's own department name; falls back to the code when absent. */
  departmentName?: string
}

/** One resolved owner cell. */
export interface OwnerLabel {
  /** Which rule produced the label, so the renderer can style it without re-parsing. */
  kind: 'global' | 'department' | 'self' | 'person' | 'unknown'
  /** The text to show. */
  label: string
}

/** The bucket prefix of a view path, or `undefined` when the path has no recognised one. */
function bucketSegments(relPath: string): string[] {
  return relPath.split('/').filter(segment => segment !== '')
}

/**
 * Resolve the owner of one document.
 *
 * `labels` carries the three strings this module cannot know: what to call the shared
 * bucket, what to call the caller's own folder, and what to show when a path is outside
 * every bucket. Passing them in keeps the module free of locale plumbing.
 */
export function ownerLabelOf(
  relPath: string,
  context: OwnerContext,
  labels: { global: string; self: string; unknown: string },
): OwnerLabel {
  const segments = bucketSegments(relPath)
  const bucket = segments[0]

  // `global/...` is the shared bucket: every reader sees it, so nobody in particular owns
  // it. Saying "global" is accurate; naming a person would not be.
  if (bucket === 'global') return { kind: 'global', label: labels.global }

  // `department/<code>/...` belongs to that department. The nesting introduced for the
  // organisation hierarchy puts ancestor codes first, so the owning department is the
  // deepest segment before the file — but only when the path shape says so. A path like
  // `department/report.md` (the legacy flat layout) names no department, and guessing one
  // from the file name would be a fabrication.
  if (bucket === 'department') {
    const owner = segments.length >= 3 ? segments[segments.length - 2] : undefined
    if (owner !== undefined && owner !== '') {
      const own = context.departmentCode
      if (own !== undefined && own !== '' && owner === own) {
        return { kind: 'department', label: context.departmentName ?? owner }
      }
      return { kind: 'department', label: owner }
    }
    // A flat `department/<file>` path names no department segment, but it is still this
    // reader's own department tree: a view only carries the caller's own chain. Naming
    // that department is accurate; calling it unowned would not be.
    return { kind: 'department', label: context.departmentName ?? labels.unknown }
  }

  // `personal/<id>/...` belongs to that person. The caller's own folder is worth naming
  // differently, because "我" is the answer the reader is looking for most of the time.
  if (bucket === 'personal') {
    const owner = segments.length >= 3 ? segments[segments.length - 2] : undefined
    if (owner !== undefined && owner !== '') {
      const own = context.callerId
      if (own !== undefined && own !== '' && owner === own) {
        return { kind: 'self', label: labels.self }
      }
      return { kind: 'person', label: owner }
    }
    // The view drops the owner segment from personal paths (`personal/<file>`), so a
    // two-segment path can only be the caller's own folder — a view never carries
    // another person's bucket. Reporting "me" is the only reading that is not a guess.
    return { kind: 'self', label: labels.self }
  }

  return { kind: 'unknown', label: labels.unknown }
}
