/**
 * File-backed identities, stable desktop bridges, mobile devices, session
 * tokens, and short-lived email verification codes.
 * @module @sparkelf/dsh-mobile-bridge-server/store
 */

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One registered login identity. */
export interface UserRecord {
  key: string
  provider: string
  externalId: string
}

/** One desktop installation authorized to reconnect under a stable id. */
export interface BridgeRecord {
  id: string
  tokenHash: string
  createdAt: number
}

/** One paired phone browser. Online state is projected by the relay runtime. */
export interface DeviceRecord {
  id: string
  bridgeId: string
  name: string
  ip: string
  pairedAt: number
  lastSeenAt: number
}

interface TokenRecord {
  userKey: string
  deviceId: string | null
}

interface CodeRecord {
  code: string
  expiresAt: number
}

interface StoreDocument {
  version: 2
  users: Record<string, UserRecord>
  tokens: Record<string, TokenRecord>
  codes: Record<string, CodeRecord>
  bridges: Record<string, BridgeRecord>
  devices: Record<string, DeviceRecord>
}

interface LegacyStoreDocument {
  users?: Record<string, UserRecord & { bridge?: string | null }>
  codes?: Record<string, CodeRecord>
}

/** Verification code lifetime in milliseconds. */
export const CODE_TTL_MS = 5 * 60_000

/** File-backed account and device store with atomic writes. */
export class UserStore {
  private doc: StoreDocument

  constructor(private file: string, private tokenSecret: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoreDocument | LegacyStoreDocument
      if ('version' in parsed && parsed.version === 2) {
        this.doc = parsed
      } else {
        const legacy = parsed as LegacyStoreDocument
        const users = Object.fromEntries(Object.entries(legacy.users ?? {}).map(([key, user]) => [key, {
          key: user.key,
          provider: user.provider,
          externalId: user.externalId,
        }]))
        this.doc = { version: 2, users, tokens: {}, codes: legacy.codes ?? {}, bridges: {}, devices: {} }
        this.save()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.doc = { version: 2, users: {}, tokens: {}, codes: {}, bridges: {}, devices: {} }
    }
  }

  private save(): void {
    const tmp = join(this.file + '.tmp')
    writeFileSync(tmp, JSON.stringify(this.doc, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  private mintToken(key: string): string {
    const token = createHmac('sha256', this.tokenSecret).update(key + ':' + randomBytes(8).toString('hex')).digest('hex')
    this.doc.tokens[token] = { userKey: key, deviceId: null }
    this.save()
    return token
  }

  private bridgeTokenHash(token: string): string {
    return createHmac('sha256', this.tokenSecret).update('bridge:' + token).digest('hex')
  }

  /** Register a desktop identity on first use or authenticate its existing token. */
  authenticateBridge(id: string, token: string): void {
    const tokenHash = this.bridgeTokenHash(token)
    const record = this.doc.bridges[id]
    if (record === undefined) {
      this.doc.bridges[id] = { id, tokenHash, createdAt: Date.now() }
      this.save()
      return
    }
    const expected = Buffer.from(record.tokenHash, 'hex')
    const actual = Buffer.from(tokenHash, 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('invalid bridge credentials')
  }

  /** Authenticate an existing desktop identity without creating one. */
  verifyBridge(id: string, token: string): void {
    const record = this.doc.bridges[id]
    if (record === undefined) throw new Error('invalid bridge credentials')
    const expected = Buffer.from(record.tokenHash, 'hex')
    const actual = Buffer.from(this.bridgeTokenHash(token), 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('invalid bridge credentials')
  }

  /** Mint a six-digit verification code for one email, replacing any pending one. */
  issueEmailCode(email: string): string {
    const key = email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) throw new Error('invalid email')
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.doc.codes[key] = { code, expiresAt: Date.now() + CODE_TTL_MS }
    this.save()
    return code
  }

  /** Verify and consume one email code; wrong or expired codes fail loudly. */
  consumeEmailCode(email: string, code: string): void {
    const key = email.trim().toLowerCase()
    const pending = this.doc.codes[key]
    const expected = Buffer.from(pending?.code ?? '------')
    const attempt = Buffer.from(code.padEnd(6, '-'))
    const valid = pending !== undefined && pending.expiresAt > Date.now()
      && expected.length === attempt.length && timingSafeEqual(expected, attempt)
    if (!valid) throw new Error('invalid or expired code')
    delete this.doc.codes[key]
    this.save()
  }

  /** Log in through a verified identity, creating the identity on first sight. */
  loginExternal(provider: string, externalId: string): string {
    const key = provider + ':' + externalId
    if (this.doc.users[key] === undefined) this.doc.users[key] = { key, provider, externalId }
    return this.mintToken(key)
  }

  /** Resolve a session token to its login identity. */
  userFor(token: string): string | undefined {
    return this.doc.tokens[token]?.userKey
  }

  /** Pair a token with a new or previously authenticated phone device. */
  bindDevice(token: string, bridgeId: string, details: { name: string; ip: string }, existingDeviceId?: string): DeviceRecord {
    const session = this.doc.tokens[token]
    if (session === undefined) throw new Error('unknown token')
    const existing = existingDeviceId === undefined ? undefined : this.doc.devices[existingDeviceId]
    const now = Date.now()
    const device = existing?.bridgeId === bridgeId
      ? { ...existing, name: details.name, ip: details.ip, lastSeenAt: now }
      : { id: randomBytes(12).toString('hex'), bridgeId, name: details.name, ip: details.ip, pairedAt: now, lastSeenAt: now }
    this.doc.devices[device.id] = device
    session.deviceId = device.id
    this.save()
    return device
  }

  /** Resolve a session token to its active phone device. */
  deviceFor(token: string): DeviceRecord | undefined {
    const deviceId = this.doc.tokens[token]?.deviceId
    return deviceId === null || deviceId === undefined ? undefined : this.doc.devices[deviceId]
  }

  /** Resolve a phone session to the stable desktop bridge id. */
  bridgeFor(token: string): string | null {
    return this.deviceFor(token)?.bridgeId ?? null
  }

  /** Record the latest address and activity time for a paired device. */
  touchDevice(id: string, ip: string): DeviceRecord {
    const device = this.doc.devices[id]
    if (device === undefined) throw new Error('unknown device')
    const next = { ...device, ip, lastSeenAt: Date.now() }
    this.doc.devices[id] = next
    this.save()
    return next
  }

  /** List all devices paired with one stable desktop bridge. */
  devicesForBridge(bridgeId: string): DeviceRecord[] {
    return Object.values(this.doc.devices)
      .filter(device => device.bridgeId === bridgeId)
      .sort((left, right) => right.pairedAt - left.pairedAt)
  }

  /** Remove one device and revoke every session token associated with it. */
  revokeDevice(bridgeId: string, deviceId: string): void {
    const device = this.doc.devices[deviceId]
    if (device === undefined || device.bridgeId !== bridgeId) throw new Error('unknown device')
    delete this.doc.devices[deviceId]
    for (const [token, session] of Object.entries(this.doc.tokens)) {
      if (session.deviceId === deviceId) delete this.doc.tokens[token]
    }
    this.save()
  }

  /** Stable fingerprint for persistence diagnostics. */
  fingerprint(): string {
    return createHash('sha256').update(JSON.stringify(this.doc)).digest('hex').slice(0, 12)
  }
}
