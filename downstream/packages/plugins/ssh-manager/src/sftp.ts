import { posix } from 'node:path'
import type { FileEntryWithStats, SFTPWrapper } from 'ssh2'
import { SshManagerStore } from './store.ts'
import { openSshConnection, type SshConnection } from './transport.ts'
import type { SshFileDownload, SshFileEntry, SshFileListing, SshFileType, SshFileUpload } from './types.ts'

function remotePath(value: string): string {
  const path = value.trim()
  if (path === '' || path.includes('\0')) throw new Error('Remote path is required')
  return path
}

function fileType(entry: FileEntryWithStats): SshFileType {
  if (entry.attrs.isDirectory()) return 'directory'
  if (entry.attrs.isFile()) return 'file'
  if (entry.attrs.isSymbolicLink()) return 'symlink'
  return 'other'
}

function childPath(parent: string, name: string): string {
  if (parent === '/') return '/' + name
  return posix.join(parent, name)
}

async function withSftp<T>(store: SshManagerStore, hostId: string, operation: (sftp: SFTPWrapper, connection: SshConnection) => Promise<T>): Promise<T> {
  const connection = await openSshConnection(store, hostId)
  let sftp: SFTPWrapper | undefined
  try {
    sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      connection.client.sftp((error, channel) => { if (error !== undefined) reject(error); else resolve(channel) })
    })
    return await operation(sftp, connection)
  } finally {
    sftp?.end()
    connection.close()
  }
}

export async function listSftpFiles(store: SshManagerStore, hostId: string, requestedPath = '.'): Promise<SshFileListing> {
  const path = remotePath(requestedPath)
  return withSftp(store, hostId, async sftp => {
    const list = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
      sftp.readdir(path, (error, entries) => { if (error !== undefined) reject(error); else resolve(entries) })
    })
    const entries: SshFileEntry[] = list
      .filter(entry => entry.filename !== '.' && entry.filename !== '..')
      .map(entry => ({ name: entry.filename, path: childPath(path, entry.filename), type: fileType(entry), size: entry.attrs.size, modifiedAt: entry.attrs.mtime * 1000, mode: entry.attrs.mode }))
      .sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'directory' ? -1 : right.type === 'directory' ? 1 : left.name.localeCompare(right.name))
    return { hostId, path, entries }
  })
}

export async function downloadSftpFile(store: SshManagerStore, hostId: string, requestedPath: string): Promise<SshFileDownload> {
  const path = remotePath(requestedPath)
  return withSftp(store, hostId, async sftp => {
    const contents = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(path, (error, data) => { if (error !== undefined) reject(error); else resolve(data) })
    })
    return { hostId, path, name: posix.basename(path), size: contents.byteLength, data: contents.toString('base64') }
  })
}

export async function uploadSftpFile(store: SshManagerStore, hostId: string, requestedPath: string, data: string): Promise<SshFileUpload> {
  const path = remotePath(requestedPath)
  if (typeof data !== 'string') throw new Error('Upload data must be base64 text')
  const contents = Buffer.from(data, 'base64')
  return withSftp(store, hostId, async sftp => {
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, contents, error => { if (error !== undefined) reject(error); else resolve() })
    })
    return { hostId, path, size: contents.byteLength }
  })
}
