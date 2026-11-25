export type SshAuthKind = 'password' | 'private-key' | 'agent'
export type SshEnvironment = 'development' | 'testing' | 'staging' | 'production' | 'other'

export interface SshCluster { id: string; name: string; description: string; tags: string[]; hostIds: string[] }
export interface SshHost {
  id: string
  name: string
  description: string
  tags: string[]
  clusterId: string | null
  environment: SshEnvironment
  hostname: string
  port: number
  username: string
  authKind: SshAuthKind
  credentialId: string | null
  credentialConfigured: boolean
  jumpHostId: string | null
  knownHostFingerprint: string | null
  keepAliveSeconds: number
  /** Directory the terminal starts in; empty means the remote login default. */
  defaultDirectory?: string
}
export interface SshCredentialInput { password?: string; privateKey?: string; passphrase?: string }
export interface SshManagerState { clusters: SshCluster[]; hosts: SshHost[] }
export interface SshTerminalSession { id: string; hostId: string; title: string; cwd: string | null; connectedAt: number; state: 'connecting' | 'connected' | 'disconnected' | 'failed'; exited: boolean; exitCode?: number | null; signal?: string | null }
export interface SshCommandRequest { hostIds: string[]; command: string; cwd?: string; environment?: Record<string, string>; timeoutMs: number; confirmation: 'always' | 'mutating' | 'never' }
export interface SshCommandResult { hostId: string; exitCode: number | null; signal: string | null; stdout: string; stderr: string; durationMs: number; truncated: boolean }

export type SshFileType = 'directory' | 'file' | 'symlink' | 'other'
export interface SshFileEntry { name: string; path: string; type: SshFileType; size: number; modifiedAt: number; mode: number }
export interface SshFileListing { hostId: string; path: string; entries: SshFileEntry[] }
export interface SshFileDownload { hostId: string; path: string; name: string; size: number; data: string }
export interface SshFileUpload { hostId: string; path: string; size: number }

export type SshPortForwardDirection = 'local' | 'remote'
export type SshPortForwardState = 'active' | 'disconnected' | 'failed'
export interface SshPortForwardRequest { hostId: string; direction: SshPortForwardDirection; bindHost: string; bindPort: number; targetHost: string; targetPort: number }
export interface SshPortForward { id: string; hostId: string; direction: SshPortForwardDirection; bindHost: string; bindPort: number; targetHost: string; targetPort: number; createdAt: number; state: SshPortForwardState; error?: string }
