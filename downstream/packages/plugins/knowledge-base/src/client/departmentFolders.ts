/**
 * The pure half of the tree's folder labels: which rows print a name instead of a slug.
 *
 * Kept apart from the rendering module for the reason stated in `permissionRows.ts`:
 * a component module reaches the primitives package, which imports CSS, and a Node test
 * runner cannot load a `.css` file. The label rules are the part worth testing without a
 * DOM, so they live where a plain import can reach them.
 *
 * @module @sparkelf/dsh-knowledge-base/client/departmentFolders
 */

/** The reader's own organization chain, as the Host reports it. */
export interface DepartmentPath {
  /** Codes from the organization root down to the caller's department. */
  codes: readonly string[]
  /** Display names, index-aligned with {@link codes}. */
  names: readonly string[]
}

/**
 * Tree-relative paths of the caller's own department chain, mapped to their names.
 *
 * The department bucket stores folders by code (`nanning-psb`), because a code is a
 * stable slug: renaming a department cannot move a document. The reader, though, knows
 * their organization by name, so those same rows have to print 「南宁市公安局」 rather
 * than the slug.
 *
 * One entry per LEVEL rather than one for the leaf: the reader walks
 * 「部门」 → 「南宁市公安局」 → 「数字侦察支队」 → 「数据实战大队」, so each of those
 * three rows needs its own name.
 *
 * Only the caller's own chain is translated. A peer department's folder keeps printing
 * its code, because this build has no name for it: the whole organization tree is
 * readable only by an administrator, and deriving a "name" from a slug would put an
 * invented label in front of the reader.
 *
 * A mismatched pair is refused whole rather than zipped to the shorter length: a
 * partially labelled chain would put a correct name on one row and a raw code on the
 * next, which reads as a missing department rather than as a missing translation.
 *
 * @param codes - codes from the organization root down, as DataOps reported them.
 * @param names - display names, index-aligned.
 * @returns The lookup keyed by tree-relative path, or undefined when nothing is usable.
 */
export function departmentPathLabels(
  codes: readonly string[] | undefined,
  names: readonly string[] | undefined,
): ReadonlyMap<string, string> | undefined {
  if (codes === undefined || names === undefined) return undefined
  if (codes.length === 0 || codes.length !== names.length) return undefined
  const labels = new Map<string, string>()
  const segments: string[] = ['department']
  for (const [index, code] of codes.entries()) {
    if (typeof code !== 'string' || code.trim() === '') return undefined
    segments.push(code.trim())
    const name = names[index]
    if (typeof name !== 'string' || name.trim() === '') return undefined
    labels.set(segments.join('/'), name.trim())
  }
  return labels
}

/**
 * Resolve one tree-relative path to its printed label.
 *
 * Bucket labels are consulted first. The two maps address different rows today
 * (`department` for the bucket, `department/<code>` and deeper for the chain), so the
 * order changes no current label; it states that the audience name of a bucket is the
 * one thing a data value must not override.
 *
 * @param relPath - path relative to the knowledge root.
 * @param bucketLabels - the three audience names, keyed the same way.
 * @param chainLabels - the caller's department chain, from {@link departmentPathLabels}.
 * @returns The label to print, or undefined to print the row's own name.
 */
export function folderLabelOf(
  relPath: string,
  bucketLabels: Readonly<Record<string, string>> | undefined,
  chainLabels: ReadonlyMap<string, string> | undefined,
): string | undefined {
  return bucketLabels?.[relPath] ?? chainLabels?.get(relPath)
}
