/**
 * The names of the bookkeeping files this plugin writes into a caller's view.
 *
 * A standalone module rather than a constant exported from `views.ts`: the client
 * needs these names to exclude them from the file tree, and `views.ts` imports
 * `node:fs/promises`, which the client bundle refuses. Keeping the list here means the
 * browser bundle stays free of Node builtins while the list still has one home.
 *
 * The Host derives its side from this same list -- see `VIEW_METADATA_NAMES` in
 * `views.ts`, which is checked against the `*PathFor` helpers at module load so a
 * renamed file cannot silently drop out of the set.
 *
 * Only names that live in the VIEW directory belong here. `.kb-pending` is absent on
 * purpose: it sits under the authoritative root, is never linked into a view, and an
 * exclusion entry for it could never match anything.
 *
 * @module @sparkelf/dsh-knowledge-base/viewMetadata
 */

/** File names the explorer must not list, in a stable order. */
export const VIEW_METADATA_FILENAMES = [
  '.kb-audit.jsonl',
  '.kb-settings.json',
  '.kb-tree-state.json',
  '.kb-favorites.json',
  '.kb-trash.json',
  '.pinned.json',
  '.view-mode.json',
] as const
