#!/usr/bin/env node
/**
 * Regression check for the OfficeCLI DOCX style packs.
 *
 * Fails when a generated DOCX would render a blue heading:
 *   - any w:themeColor / accent reference in styles or runs
 *   - a Heading1..6 / Title / FawenJiguan color other than 000000 (red-header's red flag is allowed)
 *   - a missing heading style (Word would synthesise its blue latent style)
 * It also asserts the GB/T 9704 page geometry and body/title/heading fonts.
 *
 * Usage:
 *   node check-style-packs.mjs [--packs-dir <dir>] [--binary <officecli>] [--workdir <dir>]
 *
 * Exit code 0 = pass, 1 = failure. Prints one PASS/FAIL line per assertion.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packsDir = path.resolve(arg('--packs-dir', path.join(here, 'style-packs')))
const createBin = path.join(here, 'bin/officecli-create')
const binaryArg = arg('--binary', undefined) ?? process.env.OFFICECLI_BIN
const binary = binaryArg ? path.resolve(binaryArg) : findBinary()

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

function findBinary() {
  const candidates = [
    process.env.OFFICECLI_BIN,
    '/usr/local/lib/dataops/officecli-engine',
    '/opt/dsh-plus/node_modules/@officecli/officecli/vendor/officecli',
    '/opt/dataops-dsh-profile-template/node_modules/@officecli/officecli/vendor/officecli',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('officecli binary not found; pass --binary or set OFFICECLI_BIN')
}

function run(bin, args, options = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function part(file, name) {
  return run('unzip', ['-p', file, name])
}

function styleBlock(xml, id) {
  const match = xml.match(new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?</w:style>`))
  if (!match) throw new Error(`style ${id} not found`)
  return match[0]
}

const BLUE_HEX = '2F5496|365F91|1F4E79|4472C4|5B9BD5|0563C1|0000FF|0070C0|8EA9DB|1F3864'
const failures = []
const passes = []

function check(label, ok, detail = '') {
  if (ok) {
    passes.push(label)
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(label)
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function assertNoBlue(label, xml) {
  check(`${label}: no w:themeColor`, !/w:themeColor/i.test(xml))
  const blue = xml.match(new RegExp(`w:color w:val="(${BLUE_HEX})"`, 'i'))
  check(`${label}: no blue w:color`, blue === null, blue ? `found ${blue[1]}` : '')
}

function inspectStyles(pack, template) {
  const xml = part(template, 'word/styles.xml')
  assertNoBlue(`${pack}/styles.xml`, xml)

  const ids = ['Title', 'Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6']
  for (const id of ids) {
    let block = ''
    try {
      block = styleBlock(xml, id)
    } catch {
      check(`${pack}: ${id} style exists`, false)
      continue
    }
    check(`${pack}: ${id} style exists`, true)
    const color = block.match(/<w:color w:val="([0-9A-Fa-f]{6})"/)
    check(`${pack}: ${id} color is 000000`, color?.[1]?.toUpperCase() === '000000', color?.[1] ?? 'missing')
  }

  const normal = styleBlock(xml, 'Normal')
  check(`${pack}: Normal eastAsia FangSong_GB2312`, /w:eastAsia="FangSong_GB2312"/.test(normal))
  check(`${pack}: Normal size 16pt`, /<w:sz w:val="32"/.test(normal))
  const title = styleBlock(xml, 'Title')
  check(`${pack}: Title 22pt`, /<w:sz w:val="44"/.test(title))
  check(`${pack}: Title 方正小标宋简体`, /w:eastAsia="方正小标宋简体"/.test(title))
  const h1 = styleBlock(xml, 'Heading1')
  check(`${pack}: Heading1 SimHei`, /w:eastAsia="SimHei"/.test(h1))
  check(`${pack}: Heading1 16pt`, /<w:sz w:val="32"/.test(h1))

  const document = part(template, 'word/document.xml')
  check(`${pack}: template body is blank`, !/<w:p\b/.test(document))
  const pgMar = document.match(/<w:pgMar\b[^>]*\/>/)?.[0] ?? ''
  for (const [key, value] of [['top', '2098'], ['bottom', '1984'], ['left', '1587'], ['right', '1474']]) {
    check(`${pack}: margin${key}=${value} twips`, new RegExp(`w:${key}="${value}"`).test(pgMar), pgMar)
  }
  const docGrid = document.match(/<w:docGrid\b[^>]*\/>/)?.[0] ?? ''
  check(`${pack}: 22-line docGrid linePitch=578`, /w:linePitch="578"/.test(docGrid), docGrid)
  check(`${pack}: 22-line docGrid type=lines`, /w:type="lines"/.test(docGrid))

  const settings = part(template, 'word/settings.xml')
  check(`${pack}: even/odd page-number footers enabled`, /<w:evenAndOddHeaders\s*\/>/.test(settings))
}

function inspectGenerated(pack, sample) {
  const styles = part(sample, 'word/styles.xml')
  const document = part(sample, 'word/document.xml')
  assertNoBlue(`${pack}/generated document.xml`, document)
  assertNoBlue(`${pack}/generated styles.xml`, styles)

  for (const id of ['Title', 'Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6']) {
    const pStyle = new RegExp(`<w:pStyle w:val="${id}"\\s*/>`).test(document)
    check(`${pack}: sample paragraph uses ${id}`, pStyle)
  }
  check(`${pack}: sample has no direct heading color`, !/<w:rPr>[\s\S]*?<w:color w:val="(?!000000)[0-9A-Fa-f]{6}"/.test(document))
}

function createFromWrapper(dir, name, extra = []) {
  const file = path.join(dir, name)
  run(createBin, [file, '--packs-dir', packsDir, ...extra], { env: { ...process.env, OFFICECLI_BIN: binary } })
  return file
}

function fillHeadings(file, { close = true } = {}) {
  const commands = [
    ['Title', '测试文档标题'],
    ['Heading1', '一、一级标题'],
    ['Heading2', '（一）二级标题'],
    ['Heading3', '1. 三级标题'],
    ['Heading4', '四级标题'],
    ['Heading5', '五级标题'],
    ['Heading6', '六级标题'],
  ].map(([style, text]) => ({
    command: 'add',
    parent: '/body',
    type: 'paragraph',
    props: { style, text },
  }))
  run(binary, ['batch', file, '--commands', JSON.stringify(commands)])
  run(binary, ['save', file])
  if (close) run(binary, ['close', file])
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function main() {
  if (!existsSync(packsDir)) throw new Error(`style-pack directory not found: ${packsDir}`)
  if (!existsSync(createBin)) throw new Error(`officecli-create not found: ${createBin}`)
  const work = mkdtempSync(path.join(tmpdir(), 'officecli-style-check-'))
  try {
    for (const pack of ['gbt9704-2012', 'red-header', 'gbt9704-letter', 'gbt9704-minutes']) {
      const template = path.join(packsDir, pack, 'template.docx')
      check(`${pack}: template exists`, existsSync(template), template)
      if (!existsSync(template)) continue
      inspectStyles(pack, template)
    }

    const defaultDoc = createFromWrapper(work, 'default.docx')
    check('default create uses gbt9704-2012 template byte-for-byte', sha256(defaultDoc) === sha256(path.join(packsDir, 'gbt9704-2012/template.docx')))
    fillHeadings(defaultDoc)
    inspectGenerated('gbt9704-2012', defaultDoc)

    const redDoc = createFromWrapper(work, 'red-header.docx', ['--style-pack', 'red-header'])
    check('--style-pack red-header selects the red-header template', sha256(redDoc) === sha256(path.join(packsDir, 'red-header/template.docx')))
    fillHeadings(redDoc)
    inspectGenerated('red-header', redDoc)
    const redStyles = part(redDoc, 'word/styles.xml')
    const flag = styleBlock(redStyles, 'FawenJiguan')
    check('red-header: FawenJiguan exists', true)
    check('red-header: FawenJiguan red flag', /<w:color w:val="FF0000"/.test(flag))

    const letterDoc = createFromWrapper(work, 'letter.docx', ['--style-pack', 'gbt9704-letter'])
    check('--style-pack gbt9704-letter selects the letter template', sha256(letterDoc) === sha256(path.join(packsDir, 'gbt9704-letter/template.docx')))
    fillHeadings(letterDoc)
    inspectGenerated('gbt9704-letter', letterDoc)
    const letterStyles = part(letterDoc, 'word/styles.xml')
    for (const id of ['ZhuSong', 'LuoKuan', 'ChengWenRiQi', 'FuJianShuoMing']) {
      check(`gbt9704-letter: ${id} exists`, letterStyles.includes(`w:styleId="${id}"`))
    }
    check('gbt9704-letter: LuoKuan right-aligned', /<w:jc w:val="right"\s*\/>/.test(styleBlock(letterStyles, 'LuoKuan')))
    check('gbt9704-letter: no red flag style', !letterStyles.includes('w:styleId="FawenJiguan"'))
    check('gbt9704-letter: no red separator style', !letterStyles.includes('w:styleId="HongXian"'))

    const minutesDoc = createFromWrapper(work, 'minutes.docx', ['--style-pack', 'gbt9704-minutes'])
    check('--style-pack gbt9704-minutes selects the minutes template', sha256(minutesDoc) === sha256(path.join(packsDir, 'gbt9704-minutes/template.docx')))
    fillHeadings(minutesDoc)
    inspectGenerated('gbt9704-minutes', minutesDoc)
    const minutesStyles = part(minutesDoc, 'word/styles.xml')
    for (const id of ['JiYaoDate', 'JiYaoFenSong', 'BanJi']) {
      check(`gbt9704-minutes: ${id} exists`, minutesStyles.includes(`w:styleId="${id}"`))
    }
    check('gbt9704-minutes: JiYaoDate centered', /<w:jc w:val="center"\s*\/>/.test(styleBlock(minutesStyles, 'JiYaoDate')))
    check('gbt9704-minutes: BanJi has black top border', /w:top[^>]*w:val="single"/.test(styleBlock(minutesStyles, 'BanJi')))
    check('gbt9704-minutes: no red flag style', !minutesStyles.includes('w:styleId="FawenJiguan"'))

    // Recreating over a path a resident still holds must release it first; otherwise the
    // resident's next save writes the old document back over the fresh template.
    const reuseDoc = createFromWrapper(work, 'reuse.docx')
    fillHeadings(reuseDoc, { close: false })
    run(createBin, [reuseDoc, '--force', '--packs-dir', packsDir], { env: { ...process.env, OFFICECLI_BIN: binary } })
    check('force recreate releases a live resident (old content gone)', !part(reuseDoc, 'word/document.xml').includes('一、一级标题'))
    run(binary, ['add', reuseDoc, '/body', '--type', 'paragraph', '--prop', 'text=重建后的新内容'])
    run(binary, ['save', reuseDoc])
    run(binary, ['close', reuseDoc])
    const reuseXml = part(reuseDoc, 'word/document.xml')
    check('force recreate keeps only the new content', reuseXml.includes('重建后的新内容') && !reuseXml.includes('一、一级标题'))

    check('unknown style pack is rejected', (() => {
      try {
        run(createBin, [path.join(work, 'bad.docx'), '--packs-dir', packsDir, '--style-pack', 'missing'], { env: { ...process.env, OFFICECLI_BIN: binary } })
        return false
      } catch {
        return true
      }
    })())
    check('existing file is not overwritten without --force', (() => {
      try {
        run(createBin, [defaultDoc, '--packs-dir', packsDir], { env: { ...process.env, OFFICECLI_BIN: binary } })
        return false
      } catch {
        return true
      }
    })())
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  console.log(`\n${passes.length} passed, ${failures.length} failed`)
  if (failures.length > 0) process.exit(1)
}

main()