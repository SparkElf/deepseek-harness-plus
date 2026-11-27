#!/usr/bin/env node
/**
 * DataOps administration, one action per run.
 *
 * A script rather than a DSH tool because the work is a fixed sequence of HTTP calls
 * with a login in the middle: a tool would have to keep a session alive across calls
 * and expose the token to the model, while a one-shot process can log in, act, and exit
 * with the credential gone from memory.
 *
 * Credentials arrive from the environment or, as a documented fallback, from a CLI flag.
 * They are never read from a file, never written anywhere, and never printed -- every
 * output path passes through `redact`/`scrub`.
 *
 * Usage:
 *   DATAOPS_ADMIN_USER=... DATAOPS_ADMIN_PASSWORD=... \
 *     node dataops-admin.mjs list-users --base-url http://127.0.0.1:3101
 */
import { parseArgs } from 'node:util'
import { ACTIONS, findAction, planAction, API_PREFIX } from './lib/actions.mjs'
import { checkSuperAdmin, interpretLogin, isSessionExpired } from './lib/auth.mjs'
import { maskToken, redact, scrub } from './lib/redact.mjs'

const EXIT_OK = 0
const EXIT_USAGE = 2
const EXIT_AUTH = 3
const EXIT_FORBIDDEN = 4
const EXIT_FAILED = 5

/** Write one line to stdout. Kept in one place so redaction cannot be forgotten. */
function say(line = '') {
  process.stdout.write(`${line}\n`)
}

/** Write one line to stderr. */
function warn(line) {
  process.stderr.write(`${line}\n`)
}

/** Print the usage block. */
function usage() {
  say('万相数据AI中台管理 — 用法：node dataops-admin.mjs <动作> [选项]')
  say('')
  say('环境变量：')
  say('  DATAOPS_ADMIN_USER       必填，管理账号用户名')
  say('  DATAOPS_ADMIN_PASSWORD   必填，管理账号密码（推荐；--password 会出现在进程列表里）')
  say('  DATAOPS_BASE_URL         可选，后端地址，默认 http://127.0.0.1:3101')
  say('')
  say('通用选项：')
  say('  --base-url <url>   后端地址，覆盖 DATAOPS_BASE_URL')
  say('  --dry-run          只打印将要发送的请求，不登录、不发送')
  say('  --yes              确认执行写操作；读取类动作不需要')
  say('')
  say('动作：')
  for (const action of Object.values(ACTIONS)) {
    say(`  ${action.name.padEnd(16)} ${action.summary}`)
  }
}

/**
 * Normalize `--roles a --roles b` into an array while leaving single values scalar.
 *
 * @param raw - the parsed option value.
 * @returns array of values.
 */
function toList(raw) {
  if (raw === undefined) return []
  return Array.isArray(raw) ? raw : [raw]
}

/**
 * Send one request and return status plus parsed body.
 *
 * @param baseUrl - backend origin.
 * @param plan - the planned request.
 * @param token - access token, or undefined for the login call.
 * @param secrets - literal secrets to scrub from any error text.
 * @returns `{ status, body, text }`.
 */
async function send(baseUrl, plan, token, secrets) {
  const url = `${baseUrl.replace(/\/+$/u, '')}${API_PREFIX}${plan.path}`
  const headers = { accept: 'application/json' }
  if (plan.body !== undefined) headers['content-type'] = 'application/json'
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, {
    method: plan.method,
    headers,
    ...(plan.body === undefined ? {} : { body: JSON.stringify(plan.body) }),
  })
  const text = await response.text()
  let body
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }
  return { status: response.status, body, text: scrub(text.slice(0, 200), secrets) }
}

/** Print a plan, with secrets masked, exactly as it would be sent. */
function printPlan(plan, secrets) {
  say(`  ${plan.method} ${API_PREFIX}${plan.path}`)
  if (plan.body !== undefined) {
    const shown = redact(plan.body)
    const text = JSON.stringify(shown, null, 1)
    say(`  body: ${scrub(text, secrets)}`)
  }
}

/** Main entry. */
async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage()
    return EXIT_OK
  }
  const verb = argv[0]
  let action
  try {
    action = findAction(verb)
  } catch (error) {
    warn(`✗ ${error.message}`)
    return EXIT_USAGE
  }

  let parsed
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      allowPositionals: false,
      strict: true,
      options: {
        'base-url': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        search: { type: 'string' },
        role: { type: 'string' },
        department: { type: 'string' },
        page: { type: 'string' },
        'page-size': { type: 'string' },
        username: { type: 'string' },
        'display-name': { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        roles: { type: 'string', multiple: true },
        'user-id': { type: 'string' },
        'new-password': { type: 'string' },
        'updated-at': { type: 'string' },
      },
    })
  } catch (error) {
    warn(`✗ 参数错误：${error.message}`)
    return EXIT_USAGE
  }

  const values = parsed.values
  const user = process.env.DATAOPS_ADMIN_USER ?? ''
  const password = process.env.DATAOPS_ADMIN_PASSWORD ?? ''
  const baseUrl = values['base-url'] ?? process.env.DATAOPS_BASE_URL ?? 'http://127.0.0.1:3101'
  const secrets = [password, values['new-password'] ?? '']

  // Plan first: a usage error must not need credentials to surface.
  let planned
  try {
    planned = planAction(verb, { ...values, roles: toList(values.roles), pageSize: values['page-size'] }, { yes: values.yes })
  } catch (error) {
    warn(`✗ ${error.message}`)
    return EXIT_USAGE
  }
  const { plan, confirmed } = planned

  if (values['dry-run']) {
    say(`DRY RUN — 不会登录，也不会发送请求（${action.kind === 'write' ? '写操作' : '只读'}）`)
    printPlan(plan, secrets)
    if (action.kind === 'write') say('  加 --yes 才会真正执行。')
    return EXIT_OK
  }

  if (action.kind === 'write' && !confirmed) {
    say(`未确认：这是写操作，不会执行。将要发送的请求：`)
    printPlan(plan, secrets)
    say('  确认无误后加 --yes 重跑。')
    return EXIT_USAGE
  }

  if (user === '' || password === '') {
    warn('✗ 缺少凭据：请设置 DATAOPS_ADMIN_USER 与 DATAOPS_ADMIN_PASSWORD')
    warn('  提示：--password 参数会出现在进程列表中，优先使用环境变量。')
    return EXIT_USAGE
  }

  // ---- login ----
  let login
  try {
    login = await send(baseUrl, {
      method: 'POST',
      path: '/auth/login',
      body: { account: user, password },
    }, undefined, secrets)
  } catch (error) {
    warn(`✗ 无法连接后端 ${baseUrl}：${scrub(String(error.message ?? error), secrets)}`)
    return EXIT_FAILED
  }

  const outcome = interpretLogin(login.status, login.body)
  if (outcome.kind === 'mfa') {
    warn('✗ 该账号启用了多因素认证（MFA），本脚本无法完成登录。')
    warn(`  后端要求的方式：${outcome.methods.join(', ') || '(未说明)'}`)
    warn('  请改用未启用 MFA 的超级管理员账号，或先在门户中为该账号关闭 MFA。')
    return EXIT_AUTH
  }
  if (outcome.kind === 'rejected') {
    warn(`✗ 登录失败：${outcome.message}`)
    return EXIT_AUTH
  }

  const token = outcome.accessToken
  say(`✓ 已登录：${user}（令牌 ${maskToken(token)}）`)

  // ---- the super-admin gate ----
  const gate = checkSuperAdmin(outcome.user)
  if (!gate.allowed) {
    warn(`✗ 拒绝执行：${gate.message}`)
    warn('  说明：这是本脚本的策略，不是后端的安全边界——直接调用 API 仍可绕过。')
    return EXIT_FORBIDDEN
  }
  say(`✓ 权限检查通过：${gate.roles.join(' / ')}`)

  // ---- the action ----
  say(`→ ${action.name}${action.kind === 'write' ? '（写操作）' : ''}`)
  let result
  try {
    result = await send(baseUrl, plan, token, secrets)
  } catch (error) {
    warn(`✗ 请求失败：${scrub(String(error.message ?? error), secrets)}`)
    return EXIT_FAILED
  }

  if (isSessionExpired(result.status)) {
    // No automatic re-login: repeating a password login looks like a spray to the
    // backend's rate limiter and can lock the account out.
    warn('✗ 登录态失效（HTTP 401），请重新运行并提供凭据。不会自动重试。')
    return EXIT_AUTH
  }
  if (result.status === 403) {
    warn('✗ 权限不足：该账号无管理权限。')
    warn(`  后端返回：${result.text || '(空)'}`)
    warn('  该操作需要超级管理员账号。')
    return EXIT_FORBIDDEN
  }
  if (result.status < 200 || result.status >= 300) {
    warn(`✗ 请求失败：HTTP ${String(result.status)}`)
    warn(`  响应前 200 字：${result.text || '(空)'}`)
    return EXIT_FAILED
  }

  say(`✓ 完成（HTTP ${String(result.status)}）`)
  if (result.body !== undefined) {
    say(scrub(JSON.stringify(redact(result.body), null, 1), secrets))
  }
  return EXIT_OK
}

main().then(code => { process.exitCode = code }).catch(error => {
  warn(`✗ 未预期的错误：${String(error?.message ?? error)}`)
  process.exitCode = EXIT_FAILED
})
