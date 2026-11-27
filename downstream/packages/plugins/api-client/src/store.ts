import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { WorkbenchVault } from '@sparkelf/dsh-workbench-vault'
import type { ApiAuthSecretInput, ApiClientState, ApiCollection, ApiCookie, ApiEnvironment, ApiEnvironmentVariable, ApiRequest, ApiResponse, ApiWorkspace } from './types.ts'

interface StoredData extends ApiClientState { version: 1; cookies: ApiCookie[] }

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith('/') || pathname === '/') return '/'
  const lastSlash = pathname.lastIndexOf('/')
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash)
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith('.' + domain)
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  return pathname === cookiePath || (pathname.startsWith(cookiePath) && (cookiePath.endsWith('/') || pathname[cookiePath.length] === '/'))
}

function parseSetCookie(url: URL, header: string, now: number): ApiCookie | null {
  const segments = header.split(';')
  const pair = segments.shift()?.trim() ?? ''
  const separator = pair.indexOf('=')
  if (separator <= 0) return null
  const name = pair.slice(0, separator).trim()
  if (name === '') return null
  const cookie: ApiCookie = {
    name,
    value: pair.slice(separator + 1).trim(),
    domain: url.hostname.toLowerCase(),
    path: defaultCookiePath(url.pathname),
    hostOnly: true,
    secure: false,
    expiresAt: null,
  }
  let maxAge: number | null = null
  for (const segment of segments) {
    const [rawName, ...rawValue] = segment.trim().split('=')
    const attribute = rawName?.toLowerCase()
    const value = rawValue.join('=').trim()
    if (attribute === 'domain') {
      const domain = value.toLowerCase().replace(/^\./u, '')
      if (domain === '' || !domainMatches(url.hostname.toLowerCase(), domain)) return null
      cookie.domain = domain
      cookie.hostOnly = false
    } else if (attribute === 'path' && value.startsWith('/')) cookie.path = value
    else if (attribute === 'secure') cookie.secure = true
    else if (attribute === 'expires') {
      const expires = Date.parse(value)
      if (Number.isFinite(expires)) cookie.expiresAt = expires
    } else if (attribute === 'max-age' && /^-?\d+$/u.test(value)) maxAge = Number(value)
  }
  if (maxAge !== null) cookie.expiresAt = maxAge <= 0 ? 0 : now + maxAge * 1000
  return cookie
}

export class ApiClientStore {
  private readonly dataFile: string
  private readonly vault: WorkbenchVault
  private data: StoredData | undefined
  private mutations: Promise<void> = Promise.resolve()

  constructor(options: { dataFile?: string; vault?: WorkbenchVault } = {}) {
    this.dataFile = options.dataFile ?? join(homedir(), '.dsh', 'api-client.json')
    this.vault = options.vault ?? new WorkbenchVault()
  }

  private async load(): Promise<StoredData> {
    if (this.data !== undefined) return this.data
    await mkdir(dirname(this.dataFile), { recursive: true })
    const loaded = existsSync(this.dataFile)
      ? JSON.parse(await readFile(this.dataFile, 'utf8')) as StoredData
      : { version: 1 as const, workspaces: [], collections: [], environments: [], requests: [], history: [], cookies: [] }
    if (loaded.version !== 1) throw new Error('Unsupported API Client data format')
    loaded.cookies ??= []
    this.data = loaded
    return loaded
  }

  private async persist(): Promise<void> {
    const temporary = this.dataFile + '.next-' + process.pid.toString()
    await writeFile(temporary, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.dataFile)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation)
    this.mutations = result.then(() => undefined, () => undefined)
    return result
  }

  async state(): Promise<ApiClientState> {
    await this.mutations
    const data = await this.load()
    return {
      workspaces: data.workspaces.map(item => ({ ...item, collectionIds: [...item.collectionIds], environmentIds: [...item.environmentIds] })),
      collections: data.collections.map(item => ({ ...item, tags: [...item.tags], requestIds: [...item.requestIds] })),
      environments: data.environments.map(item => ({ ...item, variables: item.variables.map(variable => ({ ...variable, value: variable.secret ? null : variable.value })) })),
      requests: data.requests.map(item => ({ ...item, query: item.query.map(value => ({ ...value })), headers: item.headers.map(value => ({ ...value })), auth: { ...item.auth, options: { ...item.auth.options } }, body: { ...item.body } })),
      history: data.history.map(item => ({ ...item, headers: item.headers.map(value => ({ ...value })) })),
    }
  }

  async saveWorkspace(input: ApiWorkspace): Promise<ApiWorkspace> {
    return this.enqueue(async () => {
      const data = await this.load()
      const workspace: ApiWorkspace = { ...input, id: input.id === '' ? randomUUID() : input.id, name: input.name.trim(), description: input.description.trim(), collectionIds: [...new Set(input.collectionIds)], environmentIds: [...new Set(input.environmentIds)] }
      if (workspace.name === '') throw new Error('API workspace name is required')
      const index = data.workspaces.findIndex(item => item.id === workspace.id)
      if (index === -1) data.workspaces.push(workspace)
      else data.workspaces[index] = workspace
      await this.persist()
      return workspace
    })
  }

  async saveCollection(input: ApiCollection): Promise<ApiCollection> {
    return this.enqueue(async () => {
      const data = await this.load()
      if (!data.workspaces.some(workspace => workspace.id === input.workspaceId)) throw new Error('API workspace not found: ' + input.workspaceId)
      if (input.parentId !== null && !data.collections.some(collection => collection.id === input.parentId && collection.workspaceId === input.workspaceId)) throw new Error('API parent collection not found: ' + input.parentId)
      const collection: ApiCollection = { ...input, id: input.id === '' ? randomUUID() : input.id, name: input.name.trim(), description: input.description.trim(), tags: [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))], requestIds: [...new Set(input.requestIds)] }
      if (collection.name === '') throw new Error('API collection name is required')
      if (collection.parentId === collection.id) throw new Error('API collection cannot be its own parent')
      for (let parentId = collection.parentId; parentId !== null;) {
        if (parentId === collection.id) throw new Error('API collection hierarchy cannot contain a cycle')
        parentId = data.collections.find(item => item.id === parentId)?.parentId ?? null
      }
      const index = data.collections.findIndex(item => item.id === collection.id)
      const previous = index === -1 ? undefined : data.collections[index]
      if (index === -1) data.collections.push(collection)
      else data.collections[index] = collection
      data.workspaces = data.workspaces.map(workspace => ({
        ...workspace,
        collectionIds: workspace.id === collection.workspaceId
          ? [...new Set([...workspace.collectionIds, collection.id])]
          : workspace.id === previous?.workspaceId ? workspace.collectionIds.filter(id => id !== collection.id) : workspace.collectionIds,
      }))
      await this.persist()
      return collection
    })
  }

  async saveEnvironment(input: ApiEnvironment): Promise<ApiEnvironment> {
    return this.enqueue(async () => {
      const data = await this.load()
      if (!data.workspaces.some(workspace => workspace.id === input.workspaceId)) throw new Error('API workspace not found: ' + input.workspaceId)
      const id = input.id === '' ? randomUUID() : input.id
      const previous = data.environments.find(item => item.id === id)
      const variables: ApiEnvironmentVariable[] = []
      for (const variable of input.variables) {
        const key = variable.key.trim()
        if (key === '') continue
        const credentialId = variable.secret ? variable.credentialId ?? id + ':' + key : null
        if (variable.secret && variable.value !== null && variable.value !== '') await this.vault.set('api-environment', credentialId as string, { value: variable.value })
        if (!variable.secret && variable.credentialId !== null) await this.vault.delete('api-environment', variable.credentialId)
        variables.push({ ...variable, key, value: variable.secret ? null : variable.value, credentialId })
      }
      const retainedCredentials = new Set(variables.flatMap(variable => variable.credentialId === null ? [] : [variable.credentialId]))
      for (const variable of previous?.variables ?? []) if (variable.credentialId !== null && !retainedCredentials.has(variable.credentialId)) await this.vault.delete('api-environment', variable.credentialId)
      const environment: ApiEnvironment = { ...input, id, name: input.name.trim(), variables }
      if (environment.name === '') throw new Error('API environment name is required')
      const index = data.environments.findIndex(item => item.id === id)
      if (index === -1) data.environments.push(environment)
      else data.environments[index] = environment
      data.workspaces = data.workspaces.map(workspace => ({
        ...workspace,
        environmentIds: workspace.id === environment.workspaceId
          ? [...new Set([...workspace.environmentIds, environment.id])]
          : workspace.id === previous?.workspaceId ? workspace.environmentIds.filter(existingId => existingId !== environment.id) : workspace.environmentIds,
      }))
      await this.persist()
      return environment
    })
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      const environment = data.environments.find(item => item.id === environmentId)
      if (environment === undefined) return
      for (const variable of environment.variables) if (variable.credentialId !== null) await this.vault.delete('api-environment', variable.credentialId)
      data.environments = data.environments.filter(item => item.id !== environmentId)
      data.workspaces = data.workspaces.map(workspace => ({ ...workspace, environmentIds: workspace.environmentIds.filter(id => id !== environmentId) }))
      data.requests = data.requests.map(request => request.environmentId === environmentId ? { ...request, environmentId: null } : request)
      await this.persist()
    })
  }

  async deleteCollection(collectionId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      const ids = new Set([collectionId])
      let changed = true
      while (changed) { changed = false; for (const collection of data.collections) if (collection.parentId !== null && ids.has(collection.parentId) && !ids.has(collection.id)) { ids.add(collection.id); changed = true } }
      const requests = data.requests.filter(request => ids.has(request.collectionId))
      for (const request of requests) if (request.auth.credentialId !== null) await this.vault.delete('api-auth', request.auth.credentialId)
      const requestIds = new Set(requests.map(request => request.id))
      data.requests = data.requests.filter(request => !requestIds.has(request.id))
      data.history = data.history.filter(response => !requestIds.has(response.requestId))
      data.collections = data.collections.filter(collection => !ids.has(collection.id)).map(collection => ({ ...collection, requestIds: collection.requestIds.filter(id => !requestIds.has(id)) }))
      data.workspaces = data.workspaces.map(workspace => ({ ...workspace, collectionIds: workspace.collectionIds.filter(id => !ids.has(id)) }))
      await this.persist()
    })
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      const collectionIds = new Set(data.collections.filter(collection => collection.workspaceId === workspaceId).map(collection => collection.id))
      const environments = data.environments.filter(environment => environment.workspaceId === workspaceId)
      const requests = data.requests.filter(request => collectionIds.has(request.collectionId))
      for (const environment of environments) for (const variable of environment.variables) if (variable.credentialId !== null) await this.vault.delete('api-environment', variable.credentialId)
      for (const request of requests) if (request.auth.credentialId !== null) await this.vault.delete('api-auth', request.auth.credentialId)
      const requestIds = new Set(requests.map(request => request.id))
      data.workspaces = data.workspaces.filter(workspace => workspace.id !== workspaceId)
      data.collections = data.collections.filter(collection => !collectionIds.has(collection.id))
      data.environments = data.environments.filter(environment => environment.workspaceId !== workspaceId)
      data.requests = data.requests.filter(request => !requestIds.has(request.id))
      data.history = data.history.filter(response => !requestIds.has(response.requestId))
      await this.persist()
    })
  }

  async saveRequest(input: ApiRequest, authSecret?: ApiAuthSecretInput): Promise<ApiRequest> {
    return this.enqueue(async () => {
      const data = await this.load()
      const collection = data.collections.find(item => item.id === input.collectionId)
      if (collection === undefined) throw new Error('API collection not found: ' + input.collectionId)
      if (input.environmentId !== null && !data.environments.some(environment => environment.id === input.environmentId && environment.workspaceId === collection.workspaceId)) throw new Error('API environment not found: ' + input.environmentId)
      const id = input.id === '' ? randomUUID() : input.id
      const previous = data.requests.find(item => item.id === id)
      const credentialId = input.auth.kind === 'none' || input.auth.kind === 'inherit' ? null : input.auth.credentialId ?? id
      if (authSecret !== undefined && Object.values(authSecret).some(value => value !== undefined && value !== '')) await this.vault.set('api-auth', credentialId as string, authSecret as Record<string, unknown>)
      if (previous?.auth.credentialId !== null && previous?.auth.credentialId !== undefined && previous.auth.credentialId !== credentialId) await this.vault.delete('api-auth', previous.auth.credentialId)
      const request: ApiRequest = { ...input, id, name: input.name.trim(), url: input.url.trim(), query: input.query.map(value => ({ ...value })), headers: input.headers.map(value => ({ ...value })), auth: { ...input.auth, credentialId, options: { ...input.auth.options } }, body: { ...input.body } }
      if (request.name === '' || request.url === '') throw new Error('API request name and URL are required')
      const index = data.requests.findIndex(item => item.id === id)
      if (index === -1) data.requests.push(request)
      else data.requests[index] = request
      data.collections = data.collections.map(item => ({
        ...item,
        requestIds: item.id === request.collectionId
          ? [...new Set([...item.requestIds, request.id])]
          : item.id === previous?.collectionId ? item.requestIds.filter(existingId => existingId !== request.id) : item.requestIds,
      }))
      await this.persist()
      return request
    })
  }

  async deleteRequest(requestId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      const request = data.requests.find(item => item.id === requestId)
      if (request === undefined) return
      data.requests = data.requests.filter(item => item.id !== requestId)
      data.collections = data.collections.map(collection => ({ ...collection, requestIds: collection.requestIds.filter(id => id !== requestId) }))
      data.history = data.history.filter(response => response.requestId !== requestId)
      if (request.auth.credentialId !== null) await this.vault.delete('api-auth', request.auth.credentialId)
      await this.persist()
    })
  }

  async request(requestId: string): Promise<ApiRequest> {
    const request = (await this.state()).requests.find(item => item.id === requestId)
    if (request === undefined) throw new Error('API request not found: ' + requestId)
    return request
  }

  async environmentValues(environmentId: string | null): Promise<Record<string, string>> {
    if (environmentId === null) return {}
    const environment = (await this.state()).environments.find(item => item.id === environmentId)
    if (environment === undefined) throw new Error('API environment not found: ' + environmentId)
    const values: Record<string, string> = {}
    for (const variable of environment.variables) {
      if (!variable.enabled) continue
      if (!variable.secret) values[variable.key] = variable.value ?? ''
      else if (variable.credentialId !== null) values[variable.key] = (await this.vault.get<{ value: string }>('api-environment', variable.credentialId))?.value ?? ''
    }
    return values
  }

  async authSecret(request: ApiRequest): Promise<ApiAuthSecretInput | undefined> {
    return request.auth.credentialId === null ? undefined : this.vault.get<ApiAuthSecretInput & Record<string, unknown>>('api-auth', request.auth.credentialId)
  }

  async cookieHeader(url: URL, now = Date.now()): Promise<string> {
    await this.mutations
    const data = await this.load()
    const hostname = url.hostname.toLowerCase()
    return data.cookies
      .filter(cookie => (cookie.expiresAt === null || cookie.expiresAt > now)
        && (cookie.hostOnly ? cookie.domain === hostname : domainMatches(hostname, cookie.domain))
        && pathMatches(url.pathname, cookie.path)
        && (!cookie.secure || url.protocol === 'https:'))
      .sort((left, right) => right.path.length - left.path.length)
      .map(cookie => cookie.name + '=' + cookie.value)
      .join('; ')
  }

  async storeResponseCookies(url: URL, setCookieHeaders: string[], now = Date.now()): Promise<void> {
    if (setCookieHeaders.length === 0) return
    await this.enqueue(async () => {
      const data = await this.load()
      for (const header of setCookieHeaders) {
        const cookie = parseSetCookie(url, header, now)
        if (cookie === null) continue
        data.cookies = data.cookies.filter(item => !(item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path))
        if (cookie.expiresAt === null || cookie.expiresAt > now) data.cookies.push(cookie)
      }
      data.cookies = data.cookies.filter(cookie => cookie.expiresAt === null || cookie.expiresAt > now)
      await this.persist()
    })
  }

  async addHistory(response: ApiResponse): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      // Recent 20 is the product's promise (the UI labels it "recent"); keeping more would
      // grow the state document without a surface that can reach the older rows.
      data.history = [response, ...data.history.filter(item => item.id !== response.id)].slice(0, 20)
      await this.persist()
    })
  }
}
