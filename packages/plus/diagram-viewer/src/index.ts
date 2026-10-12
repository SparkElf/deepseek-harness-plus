/**
 * Host half of the diagram viewer.
 *
 * The renderer runs entirely in the browser, so this face registers nothing; it exists because
 * every profile bundle publishes a Host entry, and the bundle patch's entry resolves through it.
 */
export function apply(): void {
  // No Host-side registration: the sidebar owns the registry and the client half fills it.
}
