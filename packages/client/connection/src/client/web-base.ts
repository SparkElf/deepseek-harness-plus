/** Resolve DSH logical browser routes against the runtime-injected document base. */

const INTERNAL_BASE = 'http://dsh.internal/'

/**
 * Convert a logical root path such as `/api/session.list` into the physical
 * browser URL for this document. Reverse-proxy mounts are represented only by
 * document.baseURI; callers never concatenate the deployment prefix.
 */
export function resolveWebUrl(path: string): URL {
  const documentBase = typeof document === 'undefined' ? undefined : document.baseURI
  if (documentBase !== undefined) return new URL(path.replace(/^\/+/, ''), documentBase)
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  const base = origin !== undefined && origin !== 'null' ? `${origin}/` : INTERNAL_BASE
  return new URL(path.replace(/^\/+/, ''), base)
}
