// @ts-nocheck
/**
 * The session id of the conversation composer currently rendered.
 *
 * The right-Sidebar pane carries its own session id, which is not the id
 * `sessions.scope()` accepts for the composer beside it. `conversation.input.dock` is a
 * session-scoped seat, so the invisible bridge registered there is the one place that
 * learns the real composer session id; the workbench reads it before falling back.
 */
let composerSessionId: string | undefined

/** Record the composer's session id; called by the dock bridge on every mount. */
export function setComposerSessionId(value: string | undefined): void {
  composerSessionId = value
}

/** The composer session id, or undefined outside a conversation composer. */
export function getComposerSessionId(): string | undefined {
  return composerSessionId
}
