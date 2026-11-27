/**
 * Shared vocabulary of the sidebar's HTML preview surfaces (the editor's
 * html viewer and the changes tab's op render preview): the sandbox tokens
 * both preview iframes load with.
 */

/**
 * The sandbox tokens of an HTML preview iframe.
 *
 * ## Why `allow-same-origin` is granted (a deliberate weakening)
 *
 * The preview is served from the sidebar's own route
 * (`/sidebar/html/<sessionId>/<path>`), which authenticates with the session
 * cookie. Without `allow-same-origin` the iframe sits in an OPAQUE origin, so
 * the browser sends no cookie with its request, the route answers **403**, and
 * the reader sees an empty preview — reported for a long time as "refused to
 * connect", because that is how the browser renders a sandboxed 403.
 *
 * The cost is real and must be stated: `allow-scripts` PLUS `allow-same-origin`
 * together means the sandboxed document runs in THIS origin and can reach
 * session-scoped APIs. It is accepted here because the content is the reader's
 * OWN uploaded knowledge-base file, served inside an intranet deployment to an
 * already-authenticated session — not a third-party page. A deployment that
 * ever serves HTML from an untrusted source must not reuse these tokens.
 *
 * `allow-top-navigation` is still withheld: a previewed page must never hijack
 * the GUI. The editor viewer can disable the sandbox per-feature in the side
 * card settings (warned); the changes tab's op render preview always stays
 * sandboxed.
 */
export const HTML_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-downloads allow-modals'
