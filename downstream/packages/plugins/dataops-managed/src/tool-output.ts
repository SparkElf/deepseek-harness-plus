/**
 * The canonical output contract shared by this plugin's model tools.
 *
 * Every managed tool returns one JSON value and renders it as pretty-printed text. Keeping the
 * schema and renderer in one place means a new tool cannot accidentally return a shape the tool
 * registry rejects.
 *
 * @module tool-output
 */

/** JSON-safe content a tool may return. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** One text block as the tool registry accepts it. */
export type ToolContent = { type: 'text'; text: string }

/** An open object schema: tools declare their canonical shape in code and docs. */
export const OPEN_OBJECT_SCHEMA = { type: 'object', additionalProperties: true } as const

/** Render one canonical value as pretty JSON text. */
export const renderJson = (_args: unknown, value: unknown): ToolContent[] => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]