import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * OfficeCLI has no native global style-pack or default-template switch: `create` always emits
 * Word's stock baseline, `merge` only substitutes {{placeholders}}, and `style` edits one
 * document's `/styles` part. A style pack is therefore a blank, fully styled DOCX template plus
 * this create wrapper. See infra/docker-workspace/officecli/ in the DataOps repo for the packs.
 */

export const DEFAULT_STYLE_PACK = 'gbt9704-2012'

export interface StylePackInfo {
  name: string
  title: string
  description: string
  template: string
}

function packsRoot(): string {
  const configured = process.env.OFFICECLI_STYLE_PACKS_DIR?.trim()
  return configured !== undefined && configured !== '' ? configured : '/opt/officecli/style-packs'
}

async function readPack(name: string): Promise<StylePackInfo> {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw new Error(`invalid style pack name: ${name}`)
  const dir = path.join(packsRoot(), name)
  const template = path.join(dir, 'template.docx')
  try {
    await stat(template)
  } catch {
    throw new Error(`unknown style pack '${name}' (expected ${template})`)
  }
  let manifest: Record<string, unknown> = {}
  try {
    manifest = JSON.parse(await readFile(path.join(dir, 'pack.json'), 'utf8')) as Record<string, unknown>
  } catch {
    // A pack without a manifest is still usable; the template is the contract.
  }
  return {
    name,
    title: typeof manifest.title === 'string' ? manifest.title : name,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    template,
  }
}

export async function listStylePacks(): Promise<StylePackInfo[]> {
  let entries
  try {
    entries = await readdir(packsRoot(), { withFileTypes: true })
  } catch {
    return []
  }
  const packs: StylePackInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      packs.push(await readPack(entry.name))
    } catch {
      // Skip directories that are not complete packs.
    }
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name))
}

export function formatStylePackList(packs: StylePackInfo[]): string {
  if (packs.length === 0) return `No style packs found under ${packsRoot()}`
  return packs.map(pack => `${pack.name}\t${pack.title}`).join('\n')
}

export interface CreatedFromStylePack {
  file: string
  stylePack: string
  template: string
}

/** Copy a blank style-pack template to `file`. Never modifies an existing file without force. */
export async function createDocxFromStylePack(
  file: string,
  stylePack = DEFAULT_STYLE_PACK,
  force = false,
): Promise<CreatedFromStylePack> {
  if (file.trim() === '') throw new Error('create requires an output file path')
  const target = path.resolve(file)
  if (path.extname(target).toLowerCase() !== '.docx') {
    throw new Error(`officecli-create only writes .docx files: ${target}`)
  }
  let pack: StylePackInfo
  try {
    pack = await readPack(stylePack)
  } catch (error) {
    const available = await listStylePacks()
    const names = available.map(item => item.name).join(', ') || 'none'
    throw new Error(`${error instanceof Error ? error.message : String(error)}; available: ${names}`)
  }
  if (!force) {
    try {
      await stat(target)
      throw new Error(`file exists: ${target} (pass --force to overwrite)`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('file exists:')) throw error
      // ENOENT: the target does not exist yet.
    }
  }
  await mkdir(path.dirname(target), { recursive: true })
  if (force) await rm(target, { force: true })
  await copyFile(pack.template, target)
  return { file: target, stylePack: pack.name, template: pack.template }
}