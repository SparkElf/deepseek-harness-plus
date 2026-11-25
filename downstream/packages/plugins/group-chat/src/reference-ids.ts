/**
 * Trigger-source identities shared by both halves of the package.
 *
 * The composer declares a mention with the source that produced the chip, and the Host routes
 * only the ids that source owns, so the string is a contract rather than a label. It lives here
 * so the client bundle and the host bundle cannot drift apart.
 *
 * @module @sparkelf/dsh-group-chat/reference-ids
 */

/** The `@` source whose picks are roster members. */
export const MEMBER_MENTION_SOURCE = '@sparkelf/dsh-group-chat/member'
