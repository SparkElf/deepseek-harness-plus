/**
 * Compact search over the DataOps OpenAPI document.
 *
 * The document can be tens of thousands of lines; a model needs the operation that answers its
 * question, not the whole contract. This module reads `paths` and returns only the fields that
 * identify and parametrize a matching operation: method, path, operationId, summary, tags,
 * parameters, request-body shape and security. It never executes anything and never accepts a
 * URL: the caller names the fixed `/api/openapi.json` document, and the search stays inside it.
 *
 * @module api-docs
 */

/** JSON-safe content a tool may return. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** One compact parameter row. */
export interface ApiDocParameter {
  name: string
  in: string
  required: boolean
  type: string
}

/** A compact request-body description. */
export interface ApiDocRequestBody {
  required: boolean
  contentTypes: string[]
  schema: ApiDocSchemaSummary | null
}

/** A compact schema projection: enough to see the fields a call needs. */
export interface ApiDocSchemaSummary {
  type?: string
  ref?: string
  required?: string[]
  properties?: Array<{ name: string; type: string; required: boolean }>
}

/** One operation as the tool returns it. */
export interface ApiDocOperation {
  method: string
  path: string
  operationId: string | null
  summary: string | null
  tags: string[]
  parameters: ApiDocParameter[]
  requestBody: ApiDocRequestBody | null
  security: Json[]
}

/** Everything the tool needs to report one search. */
export interface ApiDocsSearchResult {
  title: string | null
  version: string | null
  openapi: string | null
  total: number
  returned: number
  truncated: boolean
  results: ApiDocOperation[]
}

/** Filters accepted by {@link searchOpenApiDocument}. */
export interface ApiDocsFilters {
  query?: string
  tag?: string
  path?: string
  operation_id?: string
  method?: string
}

/** Raised when the upstream body is not an OpenAPI document this module can search. */
export class ApiDocsUnavailableError extends Error {}

/** HTTP methods a path item may declare, in a stable presentation order. */
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const

/** Cap on returned operations, so one broad query cannot flood a model turn. */
const MAX_RESULTS = 50

/** Cap on projected schema properties. */
const MAX_PROPERTIES = 25

/** Cap on projected parameters. */
const MAX_PARAMETERS = 25

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined

const normalized = (value: string | undefined): string => (value ?? '').trim().toLowerCase()

/** Split a query into whitespace-separated keywords; an empty query matches everything. */
const keywords = (query: string | undefined): string[] =>
  normalized(query).split(/\s+/u).filter(token => token !== '')

/** Resolve one local JSON pointer such as `#/components/schemas/ReviewQuery`. */
function resolvePointer(document: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  let current: unknown = document
  for (const raw of ref.slice(2).split('/')) {
    if (!isRecord(current)) return undefined
    const key = decodeURIComponent(raw).replace(/~1/gu, '/').replace(/~0/gu, '~')
    current = current[key]
  }
  return current
}

/** Resolve one `$ref` object one level, leaving a non-reference value unchanged. */
function dereference(value: unknown, document: Record<string, unknown>, depth = 0): unknown {
  if (!isRecord(value) || typeof value.$ref !== 'string' || depth >= 4) return value
  return dereference(resolvePointer(document, value.$ref), document, depth + 1)
}

/** The final segment of a local reference, used as a stable type label. */
function refName(ref: string): string {
  const segment = ref.split('/').pop() ?? ref
  return decodeURIComponent(segment).replace(/~1/gu, '/').replace(/~0/gu, '~')
}

/** A short type label for one schema, resolving one local reference chain when useful. */
function schemaType(schema: unknown, document: Record<string, unknown>, depth = 0): string {
  const resolved = dereference(schema, document, depth)
  if (!isRecord(resolved)) return 'unknown'
  if (typeof resolved.type === 'string') {
    if (resolved.type === 'array' && isRecord(resolved.items)) {
      return schemaType(resolved.items, document, depth + 1) + '[]'
    }
    return resolved.type
  }
  if (isRecord(resolved.properties)) return 'object'
  if (resolved.items !== undefined) return 'array'
  if (typeof resolved.$ref === 'string') return refName(resolved.$ref)
  return 'unknown'
}

/** Project one schema into a bounded summary without following cycles forever. */
function summarizeSchema(
  schema: unknown,
  document: Record<string, unknown>,
  depth = 0,
): ApiDocSchemaSummary | null {
  if (!isRecord(schema)) return null
  const ref = typeof schema.$ref === 'string' ? refName(schema.$ref) : undefined
  const resolved = dereference(schema, document, depth)
  if (!isRecord(resolved)) return ref === undefined ? null : { ref }

  const required = strings(resolved.required) ?? []
  const requiredSet = new Set(required)
  const properties = isRecord(resolved.properties)
    ? Object.entries(resolved.properties)
      .slice(0, MAX_PROPERTIES)
      .map(([name, property]) => ({
        name,
        type: schemaType(property, document, depth + 1),
        required: requiredSet.has(name),
      }))
    : undefined

  const type = typeof resolved.type === 'string'
    ? resolved.type
    : isRecord(resolved.properties)
      ? 'object'
      : resolved.items === undefined ? undefined : 'array'

  return {
    ...(type === undefined ? {} : { type }),
    ...(ref === undefined ? {} : { ref }),
    ...(required.length === 0 ? {} : { required }),
    ...(properties === undefined ? {} : { properties }),
  }
}

/** Merge path-level and operation-level parameters; the operation wins on name+location. */
function summarizeParameters(
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  document: Record<string, unknown>,
): ApiDocParameter[] {
  const merged = new Map<string, ApiDocParameter>()
  for (const source of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(source)) continue
    for (const raw of source) {
      const parameter = dereference(raw, document)
      if (!isRecord(parameter)) continue
      if (typeof parameter.name !== 'string' || typeof parameter.in !== 'string') continue
      const schema = parameter.schema !== undefined ? parameter.schema : parameter
      merged.set(parameter.in + ':' + parameter.name, {
        name: parameter.name,
        in: parameter.in,
        required: parameter.required === true,
        type: schemaType(schema, document),
      })
    }
  }
  return [...merged.values()].slice(0, MAX_PARAMETERS)
}

/** Describe the request body's chosen media type and bounded schema fields. */
function summarizeRequestBody(
  operation: Record<string, unknown>,
  document: Record<string, unknown>,
): ApiDocRequestBody | null {
  const body = dereference(operation.requestBody, document)
  if (!isRecord(body) || !isRecord(body.content)) return null
  const contentTypes = Object.keys(body.content)
  if (contentTypes.length === 0) return null
  const preferred = contentTypes.includes('application/json') ? 'application/json' : contentTypes[0]!
  const media = body.content[preferred]
  const schema = isRecord(media) ? summarizeSchema(media.schema, document) : null
  return {
    required: body.required === true,
    contentTypes,
    schema,
  }
}

/** The security requirement list that applies to one operation. */
function summarizeSecurity(
  operation: Record<string, unknown>,
  document: Record<string, unknown>,
): Json[] {
  const source = Array.isArray(operation.security)
    ? operation.security
    : Array.isArray(document.security) ? document.security : []
  return source.filter(isRecord) as Json[]
}

/** Read one operation into its compact projection. */
function compactOperation(
  method: string,
  path: string,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  document: Record<string, unknown>,
): ApiDocOperation {
  return {
    method: method.toUpperCase(),
    path,
    operationId: typeof operation.operationId === 'string' ? operation.operationId : null,
    summary: typeof operation.summary === 'string' ? operation.summary : null,
    tags: strings(operation.tags) ?? [],
    parameters: summarizeParameters(pathItem, operation, document),
    requestBody: summarizeRequestBody(operation, document),
    security: summarizeSecurity(operation, document),
  }
}

/** One operation before its parameters and schemas are projected. */
interface OperationCandidate {
  /** Lowercase HTTP method, used for the method filter. */
  method: string
  path: string
  operationId: string | null
  summary: string | null
  tags: string[]
  description: string
  pathItem: Record<string, unknown>
  operation: Record<string, unknown>
  /** Position in the document, so equal relevance keeps the document's own order. */
  index: number
}

/** Whether one operation passes every supplied filter. */
function matches(
  operation: OperationCandidate,
  filters: { tag: string; path: string; operationId: string; method: string },
  tokens: string[],
): boolean {
  if (filters.tag !== '' && !operation.tags.some(tag => tag.toLowerCase() === filters.tag)) return false
  if (filters.path !== '' && !operation.path.toLowerCase().includes(filters.path)) return false
  if (filters.operationId !== '' && !(operation.operationId ?? '').toLowerCase().includes(filters.operationId)) return false
  if (filters.method !== '' && operation.method !== filters.method) return false
  if (tokens.length === 0) return true
  const haystack = [
    operation.path,
    operation.operationId ?? '',
    operation.summary ?? '',
    operation.description,
    operation.tags.join(' '),
  ].join(' ').toLowerCase()
  return tokens.every(token => haystack.includes(token))
}

/** Relevance used only to order matches; equal scores keep the document order. */
function scoreOf(operation: OperationCandidate, tokens: string[]): number {
  if (tokens.length === 0) return 0
  let score = 0
  const operationId = (operation.operationId ?? '').toLowerCase()
  const path = operation.path.toLowerCase()
  const summary = (operation.summary ?? '').toLowerCase()
  const tags = operation.tags.map(tag => tag.toLowerCase())
  const description = operation.description.toLowerCase()
  for (const token of tokens) {
    if (operationId === token) score += 5
    else if (operationId.includes(token)) score += 3
    if (path.includes(token)) score += 2
    if (summary.includes(token)) score += 1
    if (tags.some(tag => tag.includes(token))) score += 1
    if (description.includes(token)) score += 2
  }
  return score
}

/**
 * Search one parsed OpenAPI document.
 * @param document - Parsed `/api/openapi.json` body.
 * @param filters - Keyword, tag, path, operationId and method filters.
 * @returns Matching operations, bounded and ordered by relevance.
 * @throws ApiDocsUnavailableError when the document has no searchable `paths` object.
 */
export function searchOpenApiDocument(
  document: unknown,
  filters: ApiDocsFilters = {},
): ApiDocsSearchResult {
  if (!isRecord(document)) {
    throw new ApiDocsUnavailableError('DataOps API docs are unavailable: the response is not an OpenAPI document')
  }
  if (!isRecord(document.paths)) {
    throw new ApiDocsUnavailableError('DataOps API docs are unavailable: the document has no paths object')
  }

  const wanted = {
    tag: normalized(filters.tag),
    path: normalized(filters.path),
    operationId: normalized(filters.operation_id),
    method: normalized(filters.method),
  }
  const tokens = keywords(filters.query)

  // Filter on cheap fields first. A large document can hold thousands of operations, and only
  // the matches that survive the filters (and the result cap) need parameter/schema projection.
  const matched: Array<{ operation: OperationCandidate; score: number }> = []
  let index = 0
  for (const [path, rawPathItem] of Object.entries(document.paths)) {
    const pathItem = dereference(rawPathItem, document)
    if (!isRecord(pathItem)) continue
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method]
      if (!isRecord(operation)) continue
      const candidate: OperationCandidate = {
        method,
        path,
        operationId: typeof operation.operationId === 'string' ? operation.operationId : null,
        summary: typeof operation.summary === 'string' ? operation.summary : null,
        tags: strings(operation.tags) ?? [],
        description: typeof operation.description === 'string' ? operation.description : '',
        pathItem,
        operation,
        index,
      }
      index += 1
      if (!matches(candidate, wanted, tokens)) continue
      matched.push({ operation: candidate, score: scoreOf(candidate, tokens) })
    }
  }

  matched.sort((left, right) => right.score - left.score || left.operation.index - right.operation.index)
  const results = matched.slice(0, MAX_RESULTS).map(({ operation }) => (
    compactOperation(operation.method, operation.path, operation.pathItem, operation.operation, document)
  ))
  const info = isRecord(document.info) ? document.info : {}
  return {
    title: typeof info.title === 'string' ? info.title : null,
    version: typeof info.version === 'string' ? info.version : null,
    openapi: typeof document.openapi === 'string'
      ? document.openapi
      : typeof document.swagger === 'string' ? 'swagger ' + document.swagger : null,
    total: matched.length,
    returned: results.length,
    truncated: matched.length > results.length,
    results,
  }
}