/**
 * Credential type templates.
 *
 * A template is the whole contract for one credential family: which non-secret
 * configuration fields the form and the tools may set, which secret field names
 * exist, and which of them an authentication variant requires. Adding a family
 * is a data change here, not a new code path in the store.
 */
import type { CredentialAuthMethod, CredentialConfig, CredentialTemplate, CredentialType } from './types.ts'
import { CREDENTIAL_TYPES } from './types.ts'

const API_KEY: CredentialAuthMethod = { value: 'api-key', label: 'API Key', secretFields: ['apiKey'], requiredSecrets: ['apiKey'] }
const BEARER: CredentialAuthMethod = { value: 'bearer', label: 'Bearer Token', secretFields: ['token'], requiredSecrets: ['token'] }
const PASSWORD: CredentialAuthMethod = { value: 'password', label: '用户名 / 密码', secretFields: ['password'], requiredSecrets: ['password'] }
const BASIC: CredentialAuthMethod = { value: 'basic', label: 'HTTP Basic', secretFields: ['password'], requiredSecrets: ['password'] }
const NONE: CredentialAuthMethod = { value: 'none', label: '无需认证', secretFields: [], requiredSecrets: [] }
const HEADER: CredentialAuthMethod = { value: 'header', label: '自定义请求头', secretFields: ['headerValue'], requiredSecrets: ['headerValue'] }
const SSH_PASSWORD: CredentialAuthMethod = { value: 'password', label: '密码', secretFields: ['password'], requiredSecrets: ['password'] }
const SSH_KEY: CredentialAuthMethod = { value: 'private-key', label: '私钥', secretFields: ['privateKey', 'passphrase'], requiredSecrets: ['privateKey'] }
const CUSTOM: CredentialAuthMethod = { value: 'custom', label: '自定义密钥', secretFields: ['secret', 'secondary'], requiredSecrets: ['secret'] }

const DATABASE_ENGINES = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'mariadb', label: 'MariaDB' },
  { value: 'oracle', label: 'Oracle' },
  { value: 'sqlserver', label: 'SQL Server' },
  { value: 'doris', label: 'Apache Doris' },
  { value: 'clickhouse', label: 'ClickHouse' },
] as const

export const CREDENTIAL_TEMPLATES: readonly CredentialTemplate[] = [
  {
    type: 'prefect',
    label: 'Prefect',
    description: 'Prefect API 地址、工作空间与 API Key。',
    configFields: [
      { key: 'apiUrl', label: 'API 地址', type: 'url', required: true, placeholder: 'https://prefect.example.com/api' },
      { key: 'workspace', label: '工作空间', type: 'text', required: false, placeholder: 'default' },
      { key: 'username', label: '用户名（Basic）', type: 'text', required: false, placeholder: '仅 Basic 认证使用' },
    ],
    secretFields: [
      { key: 'apiKey', label: 'API Key', placeholder: 'pnu_…' },
      { key: 'password', label: '密码（Basic 认证）', placeholder: '仅 Basic 认证使用' },
    ],
    authMethods: [API_KEY, BASIC],
  },
  {
    type: 'dataops',
    label: 'DataOps',
    description: 'DataOps 平台地址、租户与访问令牌。',
    configFields: [
      { key: 'baseUrl', label: '平台地址', type: 'url', required: true, placeholder: 'https://dataops.example.com' },
      { key: 'tenant', label: '租户', type: 'text', required: false, placeholder: 'default' },
    ],
    secretFields: [{ key: 'token', label: '访问令牌', placeholder: 'eyJ…' }],
    authMethods: [BEARER],
  },
  {
    type: 'database',
    label: '数据库',
    description: '关系型 / OLAP 数据库连接信息与密码。',
    configFields: [
      { key: 'engine', label: '引擎', type: 'select', required: true, options: DATABASE_ENGINES, placeholder: 'postgres' },
      { key: 'host', label: '主机', type: 'text', required: true, placeholder: 'db.internal' },
      { key: 'port', label: '端口', type: 'number', required: true, placeholder: '5432' },
      { key: 'database', label: '数据库 / Schema', type: 'text', required: true, placeholder: 'analytics' },
      { key: 'username', label: '用户名', type: 'text', required: true, placeholder: 'readonly' },
      { key: 'ssl', label: '启用 TLS', type: 'boolean', required: false, placeholder: 'true' },
    ],
    secretFields: [{ key: 'password', label: '密码', placeholder: '••••••••' }],
    authMethods: [PASSWORD],
  },
  {
    type: 'http',
    label: 'HTTP API',
    description: '通用 HTTP 接口地址与认证方式。',
    configFields: [
      { key: 'baseUrl', label: '接口地址', type: 'url', required: true, placeholder: 'https://api.example.com/v1' },
      { key: 'username', label: '用户名（Basic）', type: 'text', required: false, placeholder: '仅 Basic 认证使用' },
      { key: 'headerName', label: '请求头名称', type: 'text', required: false, placeholder: 'X-API-Key' },
      { key: 'timeoutMs', label: '超时（毫秒）', type: 'number', required: false, placeholder: '10000' },
    ],
    secretFields: [
      { key: 'token', label: 'Bearer Token', placeholder: '••••••••' },
      { key: 'password', label: '密码', placeholder: '••••••••' },
      { key: 'headerValue', label: '请求头值', placeholder: '••••••••' },
    ],
    authMethods: [NONE, BEARER, BASIC, HEADER],
  },
  {
    type: 'ssh',
    label: 'SSH',
    description: 'SSH 主机、登录用户与密码或私钥。',
    configFields: [
      { key: 'host', label: '主机', type: 'text', required: true, placeholder: '10.0.0.12' },
      { key: 'port', label: '端口', type: 'number', required: true, placeholder: '22' },
      { key: 'username', label: '用户名', type: 'text', required: true, placeholder: 'deploy' },
    ],
    secretFields: [
      { key: 'password', label: '密码', placeholder: '••••••••' },
      { key: 'privateKey', label: '私钥', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----', multiline: true },
      { key: 'passphrase', label: '私钥口令', placeholder: '可选' },
    ],
    authMethods: [SSH_PASSWORD, SSH_KEY],
  },
  {
    type: 'custom',
    label: '自定义',
    description: '任意第三方系统的地址与非敏感扩展配置。',
    configFields: [
      { key: 'endpoint', label: '地址', type: 'url', required: false, placeholder: 'https://system.example.com' },
      { key: 'secretLabel', label: '密钥名称', type: 'text', required: false, placeholder: 'Access Key' },
    ],
    secretFields: [
      { key: 'secret', label: '主密钥', placeholder: '••••••••' },
      { key: 'secondary', label: '辅助密钥', placeholder: '可选' },
    ],
    authMethods: [CUSTOM],
  },
]

const BY_TYPE = new Map(CREDENTIAL_TEMPLATES.map(template => [template.type, template]))

export function isCredentialType(value: unknown): value is CredentialType {
  return typeof value === 'string' && (CREDENTIAL_TYPES as readonly string[]).includes(value)
}

export function templateFor(type: CredentialType): CredentialTemplate {
  const template = BY_TYPE.get(type)
  if (template === undefined) throw new Error('Unknown credential type: ' + String(type))
  return template
}

export function authMethodFor(template: CredentialTemplate, authKind: string | undefined): CredentialAuthMethod {
  const value = authKind ?? template.authMethods[0]?.value ?? 'custom'
  const method = template.authMethods.find(item => item.value === value)
  if (method === undefined) throw new Error('Unknown authentication method for ' + template.type + ': ' + value)
  return method
}

/** Defaults are non-secret and are safe to show before the user types anything. */
export function defaultConfigFor(type: CredentialType): CredentialConfig {
  switch (type) {
    case 'prefect':
      return { apiUrl: '', workspace: '', username: '' }
    case 'dataops':
      return { baseUrl: '', tenant: '' }
    case 'database':
      return { engine: 'postgres', host: '', port: 5432, database: '', username: '', ssl: true }
    case 'http':
      return { baseUrl: '', username: '', headerName: '', timeoutMs: 10000 }
    case 'ssh':
      return { host: '', port: 22, username: '' }
    case 'custom':
      return { endpoint: '', secretLabel: '' }
  }
}

export function defaultAuthKind(type: CredentialType): string {
  return templateFor(type).authMethods[0]?.value ?? 'custom'
}

/** Short, non-secret line the list and the model can use to recognize a credential. */
export function describeEndpoint(meta: { type: CredentialType; config: CredentialConfig }): string {
  const config = meta.config
  const stringValue = (key: string): string => (typeof config[key] === 'string' ? config[key] as string : '')
  switch (meta.type) {
    case 'prefect':
    case 'dataops':
      return stringValue(meta.type === 'prefect' ? 'apiUrl' : 'baseUrl')
    case 'http':
      return stringValue('baseUrl')
    case 'custom':
      return stringValue('endpoint')
    case 'database': {
      const engine = stringValue('engine')
      const host = stringValue('host')
      const port = typeof config.port === 'number' ? String(config.port) : ''
      const database = stringValue('database')
      return [engine, host + (port === '' ? '' : ':' + port), database].filter(Boolean).join(' · ')
    }
    case 'ssh': {
      const user = stringValue('username')
      const host = stringValue('host')
      const port = typeof config.port === 'number' ? String(config.port) : ''
      return (user === '' ? '' : user + '@') + host + (port === '' ? '' : ':' + port)
    }
  }
}