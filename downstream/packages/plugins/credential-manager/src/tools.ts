/**
 * Model-facing credential tools.
 *
 * Every tool asks the approval seam before it touches the store, including the
 * read tools: the plugin's contract is that a model cannot enumerate or mutate
 * third-party credentials without a decision recorded by the Host. Delete
 * carries a second, tool-level confirmation (`confirm` + exact `confirm_name`)
 * on top of the approval; the store enforces both independently.
 *
 * No tool accepts a secret reference to be resolved and no tool returns secret
 * values. `secret` is write-only input. `credential_get` returns metadata plus
 * the template's field names, which is what a model needs to prepare a later
 * create without ever seeing a value.
 */
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { notFoundError, validationError } from './errors.ts'
import { CREDENTIAL_TEMPLATES, templateFor } from './templates.ts'
import type { CredentialManagerStore } from './store.ts'
import { CREDENTIAL_TYPES, type CredentialConfig, type CredentialSecretInput, type CredentialType } from './types.ts'

type ToolJson = null | boolean | number | string | ToolJson[] | { [key: string]: ToolJson }
const OPEN = { type: 'object', additionalProperties: true } as const

function toolJson<T>(value: T): Record<string, ToolJson> {
  return value as unknown as Record<string, ToolJson>
}

function text(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export interface CredentialApprovalRequest {
  toolName: string
  exec: ToolRunContext
  reason: string
}

/** Injected by `apply`; tests supply a deterministic fake. */
export type CredentialApprovalGate = (request: CredentialApprovalRequest) => Promise<void>

export interface CredentialToolDeps {
  store: CredentialManagerStore
  approve: CredentialApprovalGate
}

function configFromArgs(value: Record<string, unknown> | undefined, field: string): CredentialConfig {
  if (value === undefined) return {}
  const config: CredentialConfig = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') config[key] = item
    else throw validationError(field + '.' + key + ' must be a string, number, boolean, or null')
  }
  return config
}

function secretsFromArgs(value: Record<string, unknown> | undefined): CredentialSecretInput {
  if (value === undefined) return {}
  const secrets: CredentialSecretInput = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw validationError('secret.' + key + ' must be a string')
    secrets[key] = item
  }
  return secrets
}

function templateSummary(type: CredentialType): Record<string, unknown> {
  const template = templateFor(type)
  return {
    type: template.type,
    label: template.label,
    description: template.description,
    configFields: template.configFields,
    secretFields: template.secretFields,
    authMethods: template.authMethods,
  }
}

export function createCredentialTools(deps: CredentialToolDeps): ToolDefinition[] {
  const approve = (toolName: string, exec: ToolRunContext, reason: string): Promise<void> => deps.approve({ toolName, exec, reason })

  const list = defineTool({
    name: 'credential_list',
    description: 'List stored third-party credential metadata (name, type, endpoint, tags, enabled state, secret presence). Never returns secret values.',
    parameters: {
      type: { type: 'string', enum: CREDENTIAL_TYPES, description: 'Optional credential type filter.' },
      search: { type: 'string', description: 'Case-insensitive match over name, description, type, and tags.' },
      enabled: { type: 'boolean', description: 'Optional enabled-state filter.' },
    },
    output: { schema: OPEN, render: (_args, value) => [{ type: 'text', text: text(value) }] },
    execute: async (args, exec) => {
      await approve('credential_list', exec, 'List credential inventory metadata')
      const credentials = await deps.store.list({
        type: args.type,
        search: args.search,
        enabled: args.enabled,
      })
      return toolJson({ count: credentials.length, credentials })
    },
  })

  const get = defineTool({
    name: 'credential_get',
    description: 'Read one credential by id. Returns metadata and the type template field names only; secret values are never returned.',
    parameters: {
      credential_id: { type: 'string', required: true, description: 'Credential id from credential_list.' },
    },
    output: { schema: OPEN, render: (_args, value) => [{ type: 'text', text: text(value) }] },
    execute: async (args, exec) => {
      await approve('credential_get', exec, 'Read one credential metadata record')
      const credential = await deps.store.get(args.credential_id)
      return toolJson({ credential, template: templateSummary(credential.type) })
    },
  })

  const create = defineTool({
    name: 'credential_create',
    description: 'Create a credential inventory entry. `secret` is write-only and encrypted by the Host; it is never returned. Prefer the Sidebar or secret_ref for raw secrets: a raw secret passed here is part of the model tool-call record. Requires approval.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique human-readable name.' },
      type: { type: 'string', required: true, enum: CREDENTIAL_TYPES },
      description: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      enabled: { type: 'boolean', description: 'Defaults to true.' },
      auth_kind: { type: 'string', description: 'Authentication variant from credential_templates.' },
      config: { type: 'object', additionalProperties: true, description: 'Non-secret configuration fields from the type template.' },
      secret: { type: 'object', additionalProperties: true, description: 'Write-only secret field values. Never logged or returned.' },
      secret_ref: { type: 'string', description: 'Optional DSH credential reference name; mutually exclusive with secret.' },
    },
    output: { schema: OPEN, render: (_args, value) => [{ type: 'text', text: text(value) }] },
    execute: async (args, exec) => {
      await approve('credential_create', exec, 'Create credential "' + args.name + '" (' + args.type + ')')
      const credential = await deps.store.create({
        name: args.name,
        type: args.type,
        description: args.description,
        tags: args.tags,
        enabled: args.enabled,
        authKind: args.auth_kind,
        config: configFromArgs(args.config, 'config'),
        secretRef: args.secret_ref,
      }, secretsFromArgs(args.secret))
      return toolJson({ created: true, credential })
    },
  })

  const update = defineTool({
    name: 'credential_update',
    description: 'Update credential metadata and optionally rotate its write-only secret. Omitted fields keep their current values; omitted secret fields keep their stored values. Requires approval.',
    parameters: {
      credential_id: { type: 'string', required: true },
      name: { type: 'string' },
      description: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      enabled: { type: 'boolean' },
      auth_kind: { type: 'string' },
      config: { type: 'object', additionalProperties: true, description: 'Replacement non-secret configuration for the type template.' },
      secret: { type: 'object', additionalProperties: true, description: 'Write-only secret values to add or rotate.' },
      secret_ref: { type: 'string', description: 'Set a DSH credential reference; empty string clears it.' },
    },
    output: { schema: OPEN, render: (_args, value) => [{ type: 'text', text: text(value) }] },
    execute: async (args, exec) => {
      await approve('credential_update', exec, 'Update credential ' + args.credential_id)
      const credential = await deps.store.update(args.credential_id, {
        name: args.name,
        description: args.description,
        tags: args.tags,
        enabled: args.enabled,
        authKind: args.auth_kind,
        config: args.config === undefined ? undefined : configFromArgs(args.config, 'config'),
        secretRef: args.secret_ref === undefined ? undefined : args.secret_ref === '' ? null : args.secret_ref,
      }, secretsFromArgs(args.secret))
      return toolJson({ updated: true, credential })
    },
  })

  const remove = defineTool({
    name: 'credential_delete',
    description: 'Delete one credential and its encrypted secret. Requires approval AND both confirm=true and confirm_name equal to the current credential name. This is intentionally hard to do accidentally.',
    parameters: {
      credential_id: { type: 'string', required: true },
      confirm: { type: 'boolean', required: true, description: 'Must be true; false is rejected.' },
      confirm_name: { type: 'string', required: true, description: 'Must exactly equal the credential name being deleted.' },
    },
    output: { schema: OPEN, render: (_args, value) => [{ type: 'text', text: text(value) }] },
    execute: async (args, exec) => {
      await approve('credential_delete', exec, 'Delete credential ' + args.credential_id)
      const credential = await deps.store.get(args.credential_id)
      const result = await deps.store.delete(args.credential_id, { confirmed: args.confirm, name: args.confirm_name })
      return toolJson({ credentialId: args.credential_id, name: credential.name, ...result })
    },
  })

  const test = defineTool({
    name: 'credential_test',
    description: 'Run a local validation test for one credential: required fields, URL shape, port range, and secret presence. The MVP never opens a network connection, so this cannot be used as an SSRF probe.',
    parameters: {
      credential_id: { type: 'string', required: true },
    },
    output: { schema: OPEN, render: (_args, value) => [{ type: 'text', text: text(value) }] },
    execute: async (args, exec) => {
      await approve('credential_test', exec, 'Validate credential ' + args.credential_id + ' locally')
      const result = await deps.store.test(args.credential_id)
      return toolJson({ credentialId: args.credential_id, ...result })
    },
  })

  const templates = defineTool({
    name: 'credential_templates',
    description: 'List supported credential types and their non-secret config fields, auth methods, and secret field names. Use this before credential_create.',
    parameters: {},
    output: { schema: OPEN, render: (_args, value) => [{ type: 'text', text: text(value) }] },
    execute: async (_args, exec) => {
      await approve('credential_templates', exec, 'List credential type templates')
      return toolJson({ templates: CREDENTIAL_TEMPLATES.map(template => templateSummary(template.type)) })
    },
  })

  return [list, get, create, update, remove, test, templates]
}

/** Guard used by `apply` to keep the delete contract visible at the registration site. */
export function assertDeleteGate(confirm: boolean, confirmName: string, name: string): void {
  if (confirm !== true) throw validationError('Deleting a credential requires confirm=true')
  if (confirmName !== name) throw validationError('confirm_name must exactly match the credential name')
}

export function requireCredentialId(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw notFoundError(String(value))
  return value
}