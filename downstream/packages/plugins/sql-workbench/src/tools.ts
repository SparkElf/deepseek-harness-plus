import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SqlContext } from './context.ts'
import type { SqlWorkbenchRuntime } from './runtime.ts'
import type { ConnectionConfig, JsonValue } from './types.ts'

function sessionIdOf(exec: ToolRunContext): string {
  const agent = exec.agent as Agent | undefined
  if (agent === undefined) throw new Error('SQL tools require an initiating agent')
  return agent.session.id
}

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const openObjectSchema = { type: 'object', additionalProperties: true } as const

function jsonObject<T>(promise: Promise<T>): Promise<Record<string, JsonValue>> {
  return promise as unknown as Promise<Record<string, JsonValue>>
}

function jsonArray<T>(promise: Promise<T[]>): Promise<Array<Record<string, JsonValue>>> {
  return promise as unknown as Promise<Array<Record<string, JsonValue>>>
}

/** 注册 AI 与当前查询、数据源目录和查询执行联动的模型工具。 */
export function registerSqlTools(ctx: SqlContext, runtime: SqlWorkbenchRuntime): () => void {
  const disposers: Array<() => void> = []
  const register = (tool: ReturnType<typeof defineTool>): void => { disposers.push(ctx.tools.register(tool)) }

  register(defineTool({
    name: 'sql_list_connections',
    description: 'List SQL data sources configured in the SQL workbench. Returns non-secret connection metadata; passwords are never exposed.',
    parameters: {},
    output: { schema: { type: 'array', items: openObjectSchema }, render: renderJson },
    execute: () => jsonArray(runtime.store.listConnections()),
  }))

  register(defineTool({
    name: 'sql_list_catalog',
    description: 'Read databases, schemas, tables, views, columns, types, defaults, and definitions from one configured SQL data source.',
    parameters: {
      connection_id: { type: 'string', required: true, description: 'Connection id from sql_list_connections.' },
    },
    output: { schema: openObjectSchema, render: renderJson },
    execute: (args: { connection_id: string }) => jsonObject(runtime.catalog(args.connection_id)),
  }))

  register(defineTool({
    name: 'sql_get_current_query',
    description: 'Read the current SQL draft for this conversation. This is the default query that subsequent SQL editing requests must continue modifying.',
    parameters: {},
    output: { schema: openObjectSchema, render: renderJson },
    execute: (_args, exec) => jsonObject(runtime.current(sessionIdOf(exec))),
  }))

  register(defineTool({
    name: 'sql_create_query',
    description: 'Create a new unsaved SQL draft and make it the current query for this conversation. Use this when the user asks to generate a query and no current draft exists, or explicitly asks for another/new query.',
    parameters: {
      connection_id: { type: 'string', required: true, description: 'Data source connection id.' },
      name: { type: 'string', required: true, description: 'Short query tab name.' },
      sql: { type: 'string', required: true, description: 'Complete SQL draft text.' },
    },
    output: { schema: openObjectSchema, render: renderJson },
    execute: (args: { connection_id: string; name: string; sql: string }, exec) =>
      jsonObject(runtime.createDraft(sessionIdOf(exec), args.connection_id, args.name, args.sql)),
  }))

  register(defineTool({
    name: 'sql_update_current_query',
    description: 'Replace the current SQL draft for this conversation. This is the default action for every follow-up request that changes, refines, fixes, or extends the previously generated query. It never saves the query.',
    parameters: {
      sql: { type: 'string', required: true, description: 'Complete replacement SQL text.' },
      name: { type: 'string', description: 'New query tab name when the user also asks to rename it.' },
    },
    output: { schema: openObjectSchema, render: renderJson },
    execute: (args: { sql: string; name?: string }, exec) =>
      jsonObject(runtime.updateCurrent(sessionIdOf(exec), args.sql, args.name)),
  }))

  register(defineTool({
    name: 'sql_run_query',
    description: 'Execute SQL against a configured data source and return every result row. When sql or connection_id is omitted, use the current query draft and its data source.',
    parameters: {
      connection_id: { type: 'string', description: 'Connection id. Omit to use the current query data source.' },
      sql: { type: 'string', description: 'SQL text. Omit to execute the current query draft.' },
    },
    output: { schema: openObjectSchema, render: renderJson },
    execute: (args: { connection_id?: string; sql?: string }, exec) =>
      jsonObject(runtime.runCurrent(sessionIdOf(exec), args.sql, args.connection_id)),
  }))

  /** Ensure a mutating tool runs for a real agent and the user approved this exact call. */
  const approve = async (tool: string, exec: ToolRunContext, reason: string): Promise<void> => {
    if (exec.agent === undefined) throw new Error(tool + ' requires an initiating agent')
    const outcome = await ctx.approval.request({
      agent: exec.agent,
      toolName: tool,
      callId: exec.callId,
      signal: exec.signal,
      reason,
    })
    if (outcome !== 'allowed-once') throw new Error(tool + ' approval was ' + outcome)
  }

  /** Resolve one DSH credential reference without ever returning the value to the model. */
  const resolveCredential = async (tool: string, ref: string): Promise<string> => {
    const resolved = await ctx.credentials.resolve(ref)
    if (resolved?.value === undefined || resolved.value === '') throw new Error(tool + ': credentialRef is not configured: ' + ref)
    return resolved.value
  }

  /** Write one audit line; the durable tool-call log remains the primary record. */
  const audit = (tool: string, exec: ToolRunContext, detail: Record<string, unknown>): void => {
    try {
      ctx.logger.info('[audit] ' + tool + ' ' + JSON.stringify({
        sessionId: exec.agent === undefined ? null : (exec.agent as Agent).session.id,
        callId: exec.callId,
        ...detail,
      }))
    } catch { /* audit must never take the tool down */ }
  }

  const sanitize = (connection: ConnectionConfig): Record<string, JsonValue> => {
    const { password: _password, ...metadata } = connection as ConnectionConfig & { password?: string }
    return metadata as unknown as Record<string, JsonValue>
  }

  register(defineTool({
    name: 'sql_save_connection',
    description: 'Create or update a SQL workbench connection from non-secret metadata. Never accepts a password: pass credential_ref naming a DSH credential (configure secrets in the DSH Credentials UI). The write requires user approval and is audited; the saved connection never echoes a secret.',
    parameters: {
      connection_id: { type: 'string', description: 'Existing connection id to update; omit to create.' },
      name: { type: 'string', required: true, description: 'Display name.' },
      kind: { type: 'string', required: true, description: 'sqlite, postgres, mysql, mariadb, doris, or oracle.' },
      host: { type: 'string', description: 'Host for network databases.' },
      port: { type: 'number', description: 'Port; defaults to the driver default.' },
      user: { type: 'string', description: 'Database user.' },
      database: { type: 'string', description: 'Database name (or service name for Oracle).' },
      file: { type: 'string', description: 'SQLite file path (only for kind=sqlite).' },
      description: { type: 'string', description: 'Optional description.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      version_hint: { type: 'string', description: 'Optional server version hint.' },
      credential_ref: { type: 'string', description: 'DSH credential reference holding the password (e.g. DATAOPS_DB_PASSWORD). Never pass the password itself.' },
    },
    output: { schema: openObjectSchema, render: renderJson },
    execute: async (args: {
      connection_id?: string; name: string; kind: string; host?: string; port?: number; user?: string
      database?: string; file?: string; description?: string; tags?: string[]; version_hint?: string; credential_ref?: string
    }, exec) => {
      const tool = 'sql_save_connection'
      await approve(tool, exec, 'Save SQL connection ' + args.name)
      const id = args.connection_id ?? ''
      const existing = id === '' ? undefined : await runtime.store.connection(id)
      const description = args.description ?? existing?.description ?? ''
      const tags = args.tags ?? existing?.tags ?? []
      const versionHint = args.version_hint ?? existing?.versionHint ?? ''
      let connection: ConnectionConfig
      if (args.kind === 'sqlite') {
        const file = args.file ?? (existing !== undefined && 'file' in existing ? existing.file : '')
        if (file === '') throw new Error(tool + ': file is required for sqlite')
        connection = { id, name: args.name, kind: 'sqlite', file, description, tags, versionHint }
      } else {
        const kind = args.kind as 'postgres' | 'mysql' | 'mariadb' | 'doris' | 'oracle'
        if (!['postgres', 'mysql', 'mariadb', 'doris', 'oracle'].includes(kind)) throw new Error(tool + ': unsupported kind ' + args.kind)
        const host = args.host ?? (existing !== undefined && 'host' in existing ? existing.host : '')
        const user = args.user ?? (existing !== undefined && 'user' in existing ? existing.user : '')
        const database = args.database ?? (existing !== undefined && 'database' in existing ? existing.database : '')
        if (host === '' || user === '' || database === '') throw new Error(tool + ': host, user and database are required')
        const port = args.port ?? (existing !== undefined && 'port' in existing ? existing.port : undefined)
        const credentialRef = args.credential_ref ?? existing?.credentialRef
        const base = { id, name: args.name, kind, host, user, database, description, tags, versionHint, ...(port === undefined ? {} : { port }), ...(credentialRef === undefined ? {} : { credentialRef }) }
        connection = kind === 'oracle'
          ? { ...base, kind: 'oracle', serviceName: database } as ConnectionConfig
          : base as ConnectionConfig
      }
      const saved = await runtime.saveConnection(sessionIdOf(exec), connection)
      audit(tool, exec, { connectionId: saved.id, kind: saved.kind, credentialRef: 'credentialRef' in saved ? saved.credentialRef ?? null : null })
      return sanitize(saved)
    },
  }))

  register(defineTool({
    name: 'sql_test_connection',
    description: 'Test a saved SQL connection by id. Resolves the stored credential (or credential_ref) on the Host and returns ok, durationMs and an error message; the password is never returned. Use this after sql_save_connection.',
    parameters: {
      connection_id: { type: 'string', required: true, description: 'Connection id from sql_list_connections.' },
    },
    output: { schema: openObjectSchema, render: renderJson },
    execute: async (args: { connection_id: string }, exec) => {
      sessionIdOf(exec)
      const connection = await runtime.store.connection(args.connection_id)
      if (connection.credentialRef !== undefined) {
        (connection as ConnectionConfig & { password?: string }).password = await resolveCredential('sql_test_connection', connection.credentialRef)
      }
      const started = Date.now()
      try {
        const result = await runtime.test(connection)
        const value = { ok: true, connectionId: args.connection_id, durationMs: result.durationMs, rowCount: result.rowCount }
        audit('sql_test_connection', exec, { connectionId: args.connection_id, ok: true, durationMs: value.durationMs })
        return value
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        audit('sql_test_connection', exec, { connectionId: args.connection_id, ok: false, elapsedMs: Date.now() - started })
        return { ok: false, connectionId: args.connection_id, durationMs: Date.now() - started, error: message }
      }
    },
  }))

  register(defineTool({
    name: 'sql_delete_connection',
    description: 'Delete one SQL workbench connection and its stored credential. Requires user approval; the result is audited.',
    parameters: {
      connection_id: { type: 'string', required: true, description: 'Connection id to delete.' },
    },
    output: { schema: openObjectSchema, render: renderJson },
    execute: async (args: { connection_id: string }, exec) => {
      await approve('sql_delete_connection', exec, 'Delete SQL connection ' + args.connection_id)
      await runtime.deleteConnection(sessionIdOf(exec), args.connection_id)
      audit('sql_delete_connection', exec, { connectionId: args.connection_id })
      return { deleted: args.connection_id }
    },
  }))


  return () => { for (const dispose of disposers) dispose() }
}
