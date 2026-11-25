/**
 * Bridge server entry: reads MOBILE_BRIDGE_PORT (default 8787),
 * MOBILE_BRIDGE_DATA (store json path), MOBILE_BRIDGE_SECRET (token HMAC
 * secret; required, no insecure default). Email login needs SMTP_HOST,
 * SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM; WeChat login needs
 * WECHAT_APP_ID and WECHAT_APP_SECRET. Absent groups stay disabled.
 * @module @sparkelf/dsh-mobile-bridge-server
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import nodemailer from 'nodemailer'
import { createBridgeServer } from './server.ts'
import { UserStore } from './store.ts'
import { wechatConfigFromEnv, wechatMiniprogramVerifier, wechatVerifier } from './wechat.ts'

const secret = process.env.MOBILE_BRIDGE_SECRET ?? ''
if (secret.length < 16) {
  console.error('MOBILE_BRIDGE_SECRET must be at least 16 chars')
  process.exit(1)
}
const data = process.env.MOBILE_BRIDGE_DATA ?? 'mobile-bridge-users.json'
mkdirSync(dirname(data) === '.' ? '.' : dirname(data), { recursive: true })
const port = Number(process.env.MOBILE_BRIDGE_PORT ?? 8787)

const smtpHost = (process.env.SMTP_HOST ?? '').trim()
const mailer = smtpHost.length > 0
  ? async (email: string, code: string) => {
    const transport = nodemailer.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT ?? 465),
      secure: Number(process.env.SMTP_PORT ?? 465) === 465,
      ...process.env.SMTP_USERNAME === undefined ? {} : {
        auth: { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD ?? '' },
      },
    })
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? 'bridge@localhost',
      to: email,
      subject: 'DeepSeek Harness 登录验证码',
      text: `您的验证码是 ${code}，五分钟内有效。`,
    })
    await transport.close()
  }
  : undefined
if (mailer === undefined) console.log('[mobile-bridge] email login disabled (no SMTP_HOST)')

const wechat = wechatConfigFromEnv()
const wechatKind = (process.env.WECHAT_KIND ?? 'miniprogram').trim()
if (wechat === undefined) console.log('[mobile-bridge] wechat login disabled (no WECHAT_APP_ID/SECRET)')

const server = createBridgeServer(new UserStore(data, secret), {
  ...mailer === undefined ? {} : { mailer },
  ...wechat === undefined ? {} : {
    externalAuth: {
      wechat: wechatKind === 'open' ? wechatVerifier(wechat) : wechatMiniprogramVerifier(wechat),
    },
    wechatScheme: wechat,
  },
})
server.listen(port, () => {
  console.log(`[mobile-bridge] listening on :${port}`)
})
