import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_STYLE_PACK,
  createDocxFromStylePack,
  formatStylePackList,
  listStylePacks,
} from './style-packs.js'
import { bundledSkillText, createSkillProviders } from './skills.js'
import { startOfficeKitBridge } from './office-kit-bridge.js'

const require = createRequire(import.meta.url)
const officecli = require('@officecli/officecli') as { binaryPath(): string }
const OFFICECLI_BINARY = officecli.binaryPath()
const PDF_EXPORTER = fileURLToPath(new URL('../plugins/officecli-pdf/officecli-pdf', import.meta.url))

interface OfficeCliResult {
  stdout: string
  stderr: string
}

interface CreateCommand {
  file?: string
  stylePack?: string
  force: boolean
  json: boolean
  minimal: boolean
  listStylePacks: boolean
  passthrough: string[]
}

/** 在当前 Harness 进程世界执行官方 OfficeCLI argv，并保留其原始输出。 */
function runOfficeCli(command: string[], signal: AbortSignal): Promise<OfficeCliResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // The package carries its exporter; pointing OfficeCLI at it works without a system install.
      OFFICECLI_PLUGIN_EXPORTER_PDF: PDF_EXPORTER,
    }
    const child = spawn(OFFICECLI_BINARY, command, {
      cwd: process.cwd(),
      env,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
      else reject(new Error(`OfficeCLI exited with code ${String(code)}\n${stderr || stdout}`))
    })
  })
}

const VALUE_FLAGS = new Set(['--type', '--locale'])

/**
 * Parse the subset of `create` this wrapper owns. `--style-pack` and `--list-style-packs` are
 * wrapper-only; every other argument is forwarded to the official binary unchanged.
 */
function parseCreateCommand(command: string[]): CreateCommand | null {
  if (command[0] !== 'create') return null
  const parsed: CreateCommand = {
    force: false,
    json: false,
    minimal: false,
    listStylePacks: false,
    passthrough: ['create'],
  }
  const args = command.slice(1)
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--style-pack') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('--style-pack requires a style pack name')
      parsed.stylePack = value
      index += 1
      continue
    }
    if (argument.startsWith('--style-pack=')) {
      parsed.stylePack = argument.slice('--style-pack='.length)
      continue
    }
    if (argument === '--list-style-packs') {
      parsed.listStylePacks = true
      continue
    }
    if (argument === '--force') {
      parsed.force = true
      parsed.passthrough.push(argument)
      continue
    }
    if (argument === '--json') {
      parsed.json = true
      parsed.passthrough.push(argument)
      continue
    }
    if (argument === '--minimal') {
      parsed.minimal = true
      parsed.passthrough.push(argument)
      continue
    }
    parsed.passthrough.push(argument)
    if (VALUE_FLAGS.has(argument) && index + 1 < args.length) {
      parsed.passthrough.push(args[index + 1])
      index += 1
      continue
    }
    if (!argument.startsWith('-') && parsed.file === undefined) parsed.file = argument
  }
  return parsed
}

function wantsHelp(command: string[]): boolean {
  return command.includes('--help') || command.includes('-h') || command.includes('-?')
}

function typeFlag(command: string[]): string | undefined {
  for (let index = 0; index < command.length; index += 1) {
    const argument = command[index]
    if (argument === '--type') return command[index + 1]
    if (argument.startsWith('--type=')) return argument.slice('--type='.length)
  }
  return undefined
}

function jsonEnvelope(message: string): string {
  return JSON.stringify({ success: true, data: message, message }, null, 2)
}

/**
 * `create --force` must not copy over a path a resident still holds: the resident's next save
 * would write its old document back over the fresh template. Native create refuses a locked
 * file; the template-copy path releases it explicitly first.
 */
async function releaseResident(file: string, signal: AbortSignal): Promise<void> {
  try {
    await runOfficeCli(['close', path.resolve(file)], signal)
  } catch {
    // No resident (or no file yet); the copy is safe.
  }
}

async function executeCreate(command: string[], signal: AbortSignal): Promise<OfficeCliResult> {
  const bundled = bundledSkillText(command)
  if (bundled !== undefined) return { stdout: bundled, stderr: '' }

  const parsed = parseCreateCommand(command)
  if (parsed === null || wantsHelp(command)) return runOfficeCli(command, signal)

  if (parsed.listStylePacks) {
    return { stdout: formatStylePackList(await listStylePacks()), stderr: '' }
  }

  const declaredType = typeFlag(command)?.toLowerCase()
  const extension = parsed.file === undefined ? '' : path.extname(parsed.file).toLowerCase()
  const isDocx = extension === '.docx' || (extension === '' && declaredType === 'docx')

  if (parsed.stylePack !== undefined && !isDocx) {
    throw new Error('--style-pack applies only to .docx output; xlsx/pptx keep the official create path')
  }

  if (isDocx && !parsed.minimal && parsed.file !== undefined) {
    if (parsed.force) await releaseResident(parsed.file, signal)
    const created = await createDocxFromStylePack(
      parsed.file,
      parsed.stylePack ?? DEFAULT_STYLE_PACK,
      parsed.force,
    )
    const message = `Created: ${created.file} (style-pack: ${created.stylePack})`
    return { stdout: parsed.json ? jsonEnvelope(message) : message, stderr: '' }
  }

  // xlsx/pptx and explicit --minimal keep the official behavior.
  return runOfficeCli(parsed.passthrough, signal)
}

const output = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      stdout: { type: 'string', required: true },
      stderr: { type: 'string', required: true },
    },
  },
  render: (_args: unknown, value: OfficeCliResult) => [{
    type: 'text' as const,
    text: [value.stdout, value.stderr].filter(Boolean).join('\n') || 'OfficeCLI completed.',
  }],
} as const

export const name = 'officecli'
export const inject = ['tools', 'skills']

/** 注册 OfficeCLI 工具；命令语义继续由官方二进制定义。 */
export function apply(ctx: Context): void {
  // The exporter is a separate OfficeCLI child process; this loopback bridge lends it the
  // Host's officeKit converter. It is idempotent, resolves officeKit per request, and a
  // missing service only fails an export, never skill/tool registration.
  // A bare test context has no lifecycle; only a real Host owns the bridge's listener.
  if (typeof ctx.effect === 'function') startOfficeKitBridge(ctx)
  for (const provider of createSkillProviders()) ctx.skills.registerProvider(() => provider)

  ctx.tools.register(defineTool({
    name: 'officecli',
    description: 'Run the official OfficeCLI binary to create, read, validate, and modify original DOCX, XLSX, or PPTX files. Pass a pre-split argv array without the leading officecli command. `create` of a .docx defaults to the gbt9704-2012 style-pack template (GB/T 9704-2012 page geometry, fonts, black headings); pass --style-pack <name> to switch, or --minimal for the raw Word baseline. Before editing, load the matching bundled skill (`word`, `excel`, `pptx`, or a scene skill such as `data-dashboard` / `financial-model`) through the DSH skill loader; `officecli load_skill` is answered with the same Wanxiang-customized text. Use help for element schemas. Use absolute workspace file paths. Do not create HTML, PNG, PDF, or Univer preview copies. End a completed workflow with save and include each original file path in the final response.',
    parameters: {
      command: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'OfficeCLI argv, for example ["create", "/workspace/report.docx"] or ["validate", "/workspace/report.docx", "--json"].',
      },
    },
    output,
    execute: async (args: { command: string[] }, exec: ToolRunContext) => {
      if (args.command.length === 0) throw new Error('officecli command requires at least one argv item')
      return await executeCreate(args.command, exec.signal)
    },
    presentCall: args => ({
      card: 'generic',
      title: 'OfficeCLI',
      kind: 'other',
      rawInput: { command: args.command },
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'officecli-create',
    description: 'Create a blank DOCX from an OfficeCLI style-pack template, then edit it with the officecli tool. Default style pack gbt9704-2012 (GB/T 9704-2012: A4, 37/35/28/26 mm margins, 3号仿宋 body, 2号小标宋 title, black Heading 1–6/Title, 22 lines × 28 chars, page-number footer). Use --style-pack red-header for 红头文件. This is the preferred create path for Chinese government and ordinary Word documents: default gbt9704-2012, --style-pack gbt9704-letter for 函, --style-pack gbt9704-minutes for 纪要, --style-pack red-header for 红头文件. Use officecli create only for xlsx/pptx or an explicit --minimal raw baseline.',
    parameters: {
      file: { type: 'string', description: 'Absolute (or workspace-relative) .docx path to create.' },
      style_pack: { type: 'string', description: `Style pack name: gbt9704-2012 (default), gbt9704-letter for 函, gbt9704-minutes for 纪要, red-header for 红头.` },
      force: { type: 'boolean', description: 'Overwrite an existing file. Default false.' },
      list: { type: 'boolean', description: 'List installed style packs instead of creating a file.' },
    },
    output,
    execute: async (args: { file?: string; style_pack?: string; force?: boolean; list?: boolean }, exec: ToolRunContext) => {
      if (args.list === true) {
        return { stdout: formatStylePackList(await listStylePacks()), stderr: '' }
      }
      if (args.file === undefined || args.file.trim() === '') {
        throw new Error('officecli-create requires a .docx file path')
      }
      if (args.force === true) await releaseResident(args.file, exec.signal)
      const created = await createDocxFromStylePack(
        args.file,
        args.style_pack ?? DEFAULT_STYLE_PACK,
        args.force === true,
      )
      return {
        stdout: `Created: ${created.file} (style-pack: ${created.stylePack})`,
        stderr: '',
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'OfficeCLI create',
      kind: 'other',
      rawInput: { file: args.file, style_pack: args.style_pack ?? DEFAULT_STYLE_PACK },
    }),
  }))
}