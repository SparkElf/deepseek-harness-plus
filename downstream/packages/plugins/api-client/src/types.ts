export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
export type ApiBodyKind = 'none' | 'json' | 'text' | 'xml' | 'form' | 'multipart' | 'graphql' | 'binary'
export type ApiAuthKind = 'none' | 'basic' | 'bearer' | 'api-key' | 'oauth2' | 'aws-sigv4' | 'inherit'

export interface ApiWorkspace { id: string; name: string; description: string; collectionIds: string[]; environmentIds: string[] }
export interface ApiCollection { id: string; workspaceId: string; parentId: string | null; name: string; description: string; tags: string[]; requestIds: string[] }
export interface ApiEnvironmentVariable { key: string; value: string | null; credentialId: string | null; enabled: boolean; secret: boolean }
export interface ApiEnvironment { id: string; workspaceId: string; name: string; variables: ApiEnvironmentVariable[] }
export interface ApiKeyValue { key: string; value: string; enabled: boolean; description?: string }
export interface ApiMultipartPart extends ApiKeyValue { type: 'text' | 'file'; fileName?: string; contentType?: string; encoding?: 'plain' | 'base64' }
export interface ApiCookie { name: string; value: string; domain: string; path: string; hostOnly: boolean; secure: boolean; expiresAt: number | null }
export interface ApiRequest {
  id: string
  collectionId: string
  name: string
  description: string
  method: ApiMethod
  url: string
  query: ApiKeyValue[]
  headers: ApiKeyValue[]
  auth: { kind: ApiAuthKind; credentialId: string | null; options: Record<string, string> }
  body: { kind: ApiBodyKind; content: string }
  environmentId: string | null
}
export interface ApiAuthSecretInput { username?: string; password?: string; token?: string; key?: string; secret?: string }
export interface ApiResponse { id: string; requestId: string; status: number; statusText: string; durationMs: number; sizeBytes: number; headers: ApiKeyValue[]; body: string; bodyTruncated: boolean; receivedAt: number }
export interface ApiClientState { workspaces: ApiWorkspace[]; collections: ApiCollection[]; environments: ApiEnvironment[]; requests: ApiRequest[]; history: ApiResponse[] }
