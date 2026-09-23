/**
 * A placeholder that stands in for a capability a deployment omits.
 *
 * npm expresses package substitution through \`overrides\` and has no removal
 * semantics, so a deployment that must not install a capability points its override at
 * this package instead. The substituted name never reaches the installation, which is
 * what makes the omission auditable: a scan of the tree finds the placeholder rather
 * than the capability.
 *
 * The module deliberately exports nothing. Loading it in place of a real plugin fails
 * at the mount step with a missing-export error, which is the intended outcome: a
 * deployment that omitted a capability must not silently mount a stub for it.
 *
 * @module @sparkelf/dsh-omitted
 */
export {}
