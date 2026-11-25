import { describe, expect, it } from 'vitest'
import { wechatConfigFromEnv, wechatMiniprogramVerifier, wechatVerifier } from './wechat.ts'
import { generateScheme } from './wechat-scheme.ts'

function stubFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
}

describe('wechat verifiers', () => {
  it('open-platform verifier returns unionid when present, openid otherwise', async () => {
    const withUnion = wechatVerifier({ appId: 'a', appSecret: 's' }, stubFetch({ access_token: 't', openid: 'od-1', unionid: 'uu-1' }))
    await expect(withUnion({ code: 'c1' })).resolves.toBe('uu-1')
    const openOnly = wechatVerifier({ appId: 'a', appSecret: 's' }, stubFetch({ access_token: 't', openid: 'od-2' }))
    await expect(openOnly({ code: 'c2' })).resolves.toBe('od-2')
  })

  it('miniprogram verifier uses jscode2session and surfaces provider errors', async () => {
    const verify = wechatMiniprogramVerifier({ appId: 'a', appSecret: 's' }, stubFetch({ openid: 'mp-1' }))
    await expect(verify({ code: 'wx-code' })).resolves.toBe('mp-1')
    const failing = wechatMiniprogramVerifier({ appId: 'a', appSecret: 's' }, stubFetch({ errcode: 40029, errmsg: 'invalid code' }))
    await expect(failing({ code: 'bad' })).rejects.toThrow(/invalid code/)
    await expect(verify({})).rejects.toThrow(/missing/)
  })

  it('generates a URL Scheme from the openlink', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url)
      if (target.includes('/cgi-bin/token')) return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 7200 }), { status: 200 })
      return new Response(JSON.stringify({ errcode: 0, openlink: 'weixin://dl/business/?t=abc' }), { status: 200 })
    }) as typeof fetch
    await expect(generateScheme({ appId: 'a', appSecret: 's' }, 'pair=xyz', fetchImpl)).resolves.toBe('weixin://dl/business/?t=abc')
  })

  it('enables only when env carries both credentials', () => {
    expect(wechatConfigFromEnv({})).toBeUndefined()
    expect(wechatConfigFromEnv({ WECHAT_APP_ID: 'a', WECHAT_APP_SECRET: 'b' })).toEqual({ appId: 'a', appSecret: 'b' })
  })
})
