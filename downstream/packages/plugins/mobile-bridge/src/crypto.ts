/**
 * Shared E2EE primitives for the desktop plugin and the phone service worker:
 * HKDF-SHA256 key derivation from the user passphrase plus the per-pairing
 * secret, and AES-256-GCM authenticated encryption with a random nonce
 * prepended. Runs on both WebCrypto (browser) and node webcrypto globals.
 * @module @sparkelf/dsh-mobile-bridge/crypto
 */

/** Derive the 256-bit session key from passphrase and pairing secret. */
export async function deriveKey(userKey: string, pairingSecret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`dsh-mobile-bridge/v1:${userKey}:${pairingSecret}`),
    'HKDF',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('dsh-mobile-bridge'), info: new Uint8Array(0) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Encrypt one JSON payload; output is base64(nonce || ciphertext). */
export async function encryptJSON(key: CryptoKey, value: unknown): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  )
  const out = new Uint8Array(nonce.length + ciphertext.byteLength)
  out.set(nonce, 0)
  out.set(new Uint8Array(ciphertext), nonce.length)
  return bytesToBase64(out)
}

/** Decrypt one base64(nonce || ciphertext) payload back to JSON. */
export async function decryptJSON<T>(key: CryptoKey, blob: string): Promise<T> {
  const raw = base64ToBytes(blob)
  const nonce = raw.slice(0, 12)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    raw.slice(12),
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}

/** Base64 for bytes, portable across browser and node. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Inverse of {@link bytesToBase64}. */
export function base64ToBytes(blob: string): Uint8Array {
  const binary = atob(blob)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
