/**
 * cURL import and export.
 *
 * Two directions, one module, because they have to agree: what the importer accepts is
 * what the exporter prints, and a parser that quietly drops a flag is worse than one that
 * refuses it. The parser is deliberately small -- it covers the flags a person actually
 * pastes from browser DevTools ("Copy as cURL"), not the whole curl manual.
 *
 * Shared by both halves: the client parses a pasted command into a draft, the host builds
 * the command from the SAVED request so the copy button reflects what was actually sent
 * (including environment substitution and authorization).
 *
 * @module @sparkelf/dsh-api-client/curl
 */

import type { ApiAuthKind, ApiAuthSecretInput, ApiBodyKind, ApiKeyValue, ApiMethod } from './types.ts'

/** A command the parser understood, in the shape a request draft needs. */
export interface ParsedCurl {
  method: ApiMethod
  url: string
  headers: ApiKeyValue[]
  body: { kind: ApiBodyKind; content: string }
  auth: { kind: ApiAuthKind; options: Record<string, string> }
  authSecret: ApiAuthSecretInput
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/gu
const METHODS: ApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/**
 * Replace `{{name}}` placeholders from one environment.
 *
 * A missing name is a refusal, not an empty string: sending a request to `{{baseUrl}}`
 * literally, or silently to `https://`, hides the mistake until the far end answers 404.
 * @param value - the text to interpolate.
 * @param variables - the active environment's values.
 * @returns the resolved text.
 */
export function interpolate(value: string, variables: Record<string, string>): string {
  return value.replace(TEMPLATE, (_match, key: string) => {
    if (!(key in variables)) throw new Error('API environment variable is not defined: ' + key)
    return variables[key] as string
  })
}

/**
 * Names referenced by one text that the environment does not define.
 * @param value - text that may contain `{{name}}`.
 * @param variables - the active environment's values.
 * @returns unique names, in first-appearance order.
 */
export function undefinedVariables(value: string, variables: Record<string, string>): string[] {
  const missing: string[] = []
  for (const match of value.matchAll(TEMPLATE)) {
    const key = match[1]?.trim() ?? ''
    if (key !== '' && !(key in variables) && !missing.includes(key)) missing.push(key)
  }
  return missing
}

/**
 * Split a shell command into words the way a POSIX shell would for the common cases.
 *
 * Quotes are removed, `\` escapes the next character, and a backslash-newline is a line
 * continuation -- DevTools emits those when the copy spans lines. Both quote styles are
 * honoured because a pasted cURL uses whichever the source page chose.
 * @param input - the command text.
 * @returns the words, with empty words dropped.
 */
export function tokenizeShell(input: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let started = false
  const push = (): void => { if (started) { words.push(current); current = ''; started = false } }
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] as string
    if (quote === "'") {
      if (character === "'") quote = null
      else current += character
      continue
    }
    if (quote === '"') {
      if (character === '"') { quote = null; continue }
      if (character === '\\') {
        const next = input[index + 1]
        if (next === '\n') { index += 1; continue }
        if (next !== undefined) { current += next; index += 1; continue }
      }
      current += character
      continue
    }
    if (character === "'" || character === '"') { quote = character; started = true; continue }
    if (character === '\\') {
      const next = input[index + 1]
      if (next === '\n') { index += 1; continue }
      if (next !== undefined) { current += next; index += 1; started = true; continue }
    }
    if (/\s/u.test(character)) { push(); continue }
    current += character
    started = true
  }
  push()
  return words
}

/** Flags that take the following word as their value. */
const VALUE_FLAGS = new Set([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary',
  '--data-urlencode', '--json', '-u', '--user', '-b', '--cookie', '-A', '--user-agent',
  '-e', '--referer', '--url', '-F', '--form', '--form-string', '-o', '--output',
])

/** Flags that are safe to ignore because they do not change the request's intent. */
const IGNORED_FLAGS = new Set([
  '-s', '--silent', '-S', '--show-error', '-k', '--insecure', '-L', '--location',
  '-i', '--include', '-v', '--verbose', '--compressed', '--globoff', '-g', '--no-buffer',
  '-N', '--fail', '-f', '--http1.1', '--http2', '--http2-prior-knowledge',
])

/**
 * Parse a pasted `curl` command into the fields a request draft needs.
 *
 * Unknown flags that take a value are consumed with their value rather than left as
 * stray words; treating `--some-option value` as a URL would create a request to
 * "value". Flags with no recognised meaning are ignored on purpose: refusing the whole
 * paste because of `-s` would make the importer useless for DevTools output.
 * @param input - the pasted command.
 * @returns the parsed request fields.
 * @throws when the text is not a curl command or names no URL.
 */
export function parseCurl(input: string): ParsedCurl {
  const words = tokenizeShell(input.trim())
  if (words.length === 0) throw new Error('the pasted text is empty')
  const command = words[0]?.toLowerCase()
  if (command !== 'curl' && command !== 'curl.exe') throw new Error('the pasted text is not a curl command')
  let method: ApiMethod | null = null
  let url = ''
  let body = ''
  let bodyIsJson = false
  let bodyIsForm = false
  let basic: ApiAuthSecretInput = {}
  const headers: ApiKeyValue[] = []
  const addHeader = (raw: string): void => {
    const separator = raw.indexOf(':')
    if (separator <= 0) return
    headers.push({ key: raw.slice(0, separator).trim(), value: raw.slice(separator + 1).trim(), enabled: true })
  }
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] as string
    if (!word.startsWith('-')) { if (url === '') url = word; continue }
    const [flag, inline] = word.startsWith('--') && word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined]
    const value = (): string => {
      if (inline !== undefined) return inline
      const next = words[index + 1]
      if (next === undefined) throw new Error('curl option ' + flag + ' needs a value')
      index += 1
      return next
    }
    if (flag === '-X' || flag === '--request') { const requested = value().toUpperCase(); if (!METHODS.includes(requested as ApiMethod)) throw new Error('unsupported HTTP method: ' + requested); method = requested as ApiMethod; continue }
    if (flag === '-H' || flag === '--header') { addHeader(value()); continue }
    if (flag === '-d' || flag === '--data' || flag === '--data-raw' || flag === '--data-binary' || flag === '--data-urlencode') { body = body === '' ? value() : body + '&' + value(); continue }
    if (flag === '--json') { body = value(); bodyIsJson = true; continue }
    if (flag === '-F' || flag === '--form' || flag === '--form-string') { throw new Error('multipart form data is not supported by the cURL importer yet'); }
    if (flag === '-u' || flag === '--user') { const pair = value(); const separator = pair.indexOf(':'); basic = { username: separator < 0 ? pair : pair.slice(0, separator), password: separator < 0 ? '' : pair.slice(separator + 1) }; continue }
    if (flag === '-b' || flag === '--cookie') { addHeader('Cookie: ' + value()); continue }
    if (flag === '-A' || flag === '--user-agent') { addHeader('User-Agent: ' + value()); continue }
    if (flag === '-e' || flag === '--referer') { addHeader('Referer: ' + value()); continue }
    if (flag === '--url') { url = value(); continue }
    if (IGNORED_FLAGS.has(flag)) continue
    if (VALUE_FLAGS.has(flag)) { value(); continue }
  }
  if (url.trim() === '') throw new Error('the curl command has no URL')
  if (method === null) method = body === '' ? 'GET' : 'POST'
  const contentType = headers.find(header => header.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? ''
  let kind: ApiBodyKind = 'none'
  if (body !== '') {
    if (bodyIsJson || contentType.includes('json') || (contentType === '' && /^[[{]/u.test(body.trim()))) kind = 'json'
    else if (bodyIsForm || contentType.includes('application/x-www-form-urlencoded')) kind = 'form'
    else if (contentType.includes('xml')) kind = 'xml'
    else kind = 'text'
  }
  return {
    method,
    url,
    headers,
    body: { kind, content: body },
    auth: basic.username === undefined ? { kind: 'none', options: {} } : { kind: 'basic', options: {} },
    authSecret: basic,
  }
}

/**
 * Quote one word for a POSIX shell.
 * @param value - the literal text.
 * @returns the word, safe to paste into a terminal.
 */
export function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_./:=?&%@+,~-]+$/u.test(value)) return value
  return "'" + value.replace(/'/gu, "'\\''") + "'"
}
