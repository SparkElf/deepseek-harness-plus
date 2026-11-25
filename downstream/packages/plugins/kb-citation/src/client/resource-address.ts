/**
 * File resource address for the right Sidebar.
 *
 * The document-preview tab is claimed by the file address, not by a `file:` URL. Encoding each
 * segment keeps Chinese filenames and `#`/`?` intact; a leading `/` is kept so the host resolves
 * the path against the session's workspace root.
 */
export const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/** Build the session-scoped address the document preview tab opens. */
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return FILE_ADDRESS_PREFIX + 'session/' + encodeSegment(sessionId) + '/' + normalized.split('/').map(encodeSegment).join('/')
}

/** Legacy absolute-scope address, usable when no Session id is available to a click delegate. */
export function absoluteFileAddress(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
  return FILE_ADDRESS_PREFIX + 'absolute/' + normalized.split('/').map(encodeSegment).join('/')
}
