/**
 * Host half of `@sparkelf/dsh-dataops-account`.
 *
 * The capability lives entirely in the browser: it reads the identity the DataOps
 * portal posts into the workbench iframe and owns the `settings.launcher` slot.
 * The host row exists only so the bundle can mount that client half.
 *
 * @module @sparkelf/dsh-dataops-account
 */

/** Register nothing; the profile row is what makes the client half load. */
export function apply(): void {}