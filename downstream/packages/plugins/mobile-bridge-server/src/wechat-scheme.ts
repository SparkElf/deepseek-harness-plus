/**
 * WeChat URL Scheme generation so scanning a QR with WeChat opens the bridge
 * mini program with the pairing query. Access tokens are cached until shortly
 * before expiry.
 * @module @sparkelf/dsh-mobile-bridge-server/wechat-scheme
 */

import type { WechatConfig } from './wechat.ts'

interface TokenCache {
  token: string
  expiresAt: number
}

let cache: TokenCache | undefined

/** Fetch (or reuse) the client-credential access token. */
export async function accessToken(config: WechatConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (cache !== undefined && cache.expiresAt > Date.now() + 60_000) return cache.token
  const url = 'https://api.weixin.qq.com/cgi-bin/token'
    + `?grant_type=client_credential&appid=${encodeURIComponent(config.appId)}&secret=${encodeURIComponent(config.appSecret)}`
  const response = await fetchImpl(url)
  const body = await response.json() as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
  if (!body.access_token) throw new Error('wechat token: ' + String(body.errcode ?? 'missing'))
  cache = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000 }
  return cache.token
}

/** Generate a URL Scheme that opens the mini program at pages/bridge with query. */
export async function generateScheme(config: WechatConfig, query: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const token = await accessToken(config, fetchImpl)
  const response = await fetchImpl(`https://api.weixin.qq.com/wxa/generatescheme?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jump_wxa: { path: 'pages/bridge/bridge', query, expire_type: 1, expire_interval: 30 } }),
  })
  const body = await response.json() as { errcode?: number; errmsg?: string; openlink?: string }
  if (body.errcode) throw new Error('wechat scheme: ' + (body.errmsg ?? String(body.errcode)))
  if (!body.openlink) throw new Error('wechat scheme: missing openlink')
  return body.openlink
}
