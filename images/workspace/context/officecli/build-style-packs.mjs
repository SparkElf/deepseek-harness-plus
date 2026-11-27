#!/usr/bin/env node
/**
 * Regenerate the OfficeCLI DOCX style-pack templates.
 *
 * OfficeCLI has no native global style-pack / default-template switch: `create` always emits
 * Word's stock baseline (Normal only, Heading styles undefined or Word-blue), and `merge` only
 * substitutes {{placeholders}}. The supported style surface is per-document `/styles` plus
 * section properties, so a style pack here is a real blank DOCX that the create wrapper copies.
 *
 * Usage:
 *   node build-style-packs.mjs [--packs-dir <dir>] [--binary <officecli>]
 *
 * The script is idempotent. It rebuilds every template from scratch, then rewrites the
 * section docGrid to the GB/T 9704 22-lines x 28-chars grid. Run it after changing a pack's
 * style recipe and commit the regenerated template.docx files.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

const packsRoot = path.resolve(arg('--packs-dir', path.join(here, 'style-packs')))
const binaryArg = arg('--binary', undefined) ?? process.env.OFFICECLI_BIN
const binary = binaryArg ? path.resolve(binaryArg) : findBinary()

function findBinary() {
  const candidates = [
    '/usr/local/lib/dataops/officecli-engine',
    '/opt/dsh-plus/node_modules/@officecli/officecli/vendor/officecli',
    '/opt/dataops-dsh-profile-template/node_modules/@officecli/officecli/vendor/officecli',
    path.join(repoRoot, 'packages/officecli/node_modules/@officecli/officecli/vendor/officecli'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('officecli binary not found; pass --binary or set OFFICECLI_BIN')
}

function run(args) {
  try {
    execFileSync(binary, args, { stdio: 'inherit' })
  } catch (error) {
    throw new Error(`officecli ${args.join(' ')} failed: ${error.message}`)
  }
}

function freshDocx(file) {
  rmSync(file, { force: true })
  run(['create', file])
}

function batch(file, commands) {
  run(['batch', file, '--commands', JSON.stringify(commands)])
}

function saveAndClose(file) {
  run(['save', file])
  run(['close', file])
}

const MM = {
  top: '3.7cm',
  bottom: '3.5cm',
  left: '2.8cm',
  right: '2.6cm',
  footer: '2.8cm',
}

/** GB/T 9704 body baseline: 3号 (16pt) 仿宋_GB2312, fixed 28.9pt line = 22 lines on 225mm. */
const BODY = {
  font: 'FangSong_GB2312',
  size: '16pt',
  lineSpacing: '28.9pt',
  lineRule: 'exact',
  firstLineIndent: '32pt',
}

function style(id, name, props) {
  return { command: 'add', parent: '/styles', type: 'style', props: { id, name, ...props } }
}

const BASE_STYLES = [
  {
    command: 'set',
    path: '/styles/Normal',
    props: {
      font: BODY.font,
      'font.ea': BODY.font,
      size: BODY.size,
      lineSpacing: BODY.lineSpacing,
      lineRule: BODY.lineRule,
      firstLineIndent: BODY.firstLineIndent,
      spaceBefore: '0',
      spaceAfter: '0',
      align: 'justify',
      widowControl: 'true',
    },
  },
  style('Title', 'Title', {
    basedOn: 'Normal',
    next: 'Normal',
    qFormat: 'true',
    font: '方正小标宋简体',
    'font.ea': '方正小标宋简体',
    size: '22pt',
    bold: 'false',
    color: '#000000',
    align: 'center',
    firstLineIndent: '0',
    lineSpacing: '33pt',
    lineRule: 'exact',
    spaceBefore: '0',
    spaceAfter: '0',
  }),
  style('Heading1', 'heading 1', {
    basedOn: 'Normal',
    next: 'Normal',
    qFormat: 'true',
    outlineLvl: '0',
    keepNext: 'true',
    keepLines: 'true',
    font: 'SimHei',
    'font.ea': 'SimHei',
    size: '16pt',
    bold: 'false',
    color: '#000000',
    firstLineIndent: BODY.firstLineIndent,
    lineSpacing: BODY.lineSpacing,
    lineRule: BODY.lineRule,
    spaceBefore: '0',
    spaceAfter: '0',
  }),
  style('Heading2', 'heading 2', {
    basedOn: 'Normal',
    next: 'Normal',
    qFormat: 'true',
    outlineLvl: '1',
    keepNext: 'true',
    keepLines: 'true',
    font: 'KaiTi_GB2312',
    'font.ea': 'KaiTi_GB2312',
    size: '16pt',
    bold: 'false',
    color: '#000000',
    firstLineIndent: BODY.firstLineIndent,
    lineSpacing: BODY.lineSpacing,
    lineRule: BODY.lineRule,
    spaceBefore: '0',
    spaceAfter: '0',
  }),
  style('Heading3', 'heading 3', {
    basedOn: 'Normal',
    next: 'Normal',
    qFormat: 'true',
    outlineLvl: '2',
    keepNext: 'true',
    keepLines: 'true',
    font: BODY.font,
    'font.ea': BODY.font,
    size: '16pt',
    bold: 'true',
    color: '#000000',
    firstLineIndent: BODY.firstLineIndent,
    lineSpacing: BODY.lineSpacing,
    lineRule: BODY.lineRule,
    spaceBefore: '0',
    spaceAfter: '0',
  }),
]

for (let level = 4; level <= 6; level += 1) {
  BASE_STYLES.push(style(`Heading${level}`, `heading ${level}`, {
    basedOn: 'Normal',
    next: 'Normal',
    qFormat: 'true',
    outlineLvl: String(level - 1),
    keepNext: 'true',
    keepLines: 'true',
    font: BODY.font,
    'font.ea': BODY.font,
    size: '16pt',
    bold: 'true',
    color: '#000000',
    firstLineIndent: BODY.firstLineIndent,
    lineSpacing: BODY.lineSpacing,
    lineRule: BODY.lineRule,
    spaceBefore: '0',
    spaceAfter: '0',
  }))
}

const SECTION = {
  command: 'set',
  path: '/section[1]',
  props: {
    pageWidth: '21cm',
    pageHeight: '29.7cm',
    marginTop: MM.top,
    marginBottom: MM.bottom,
    marginLeft: MM.left,
    marginRight: MM.right,
    marginFooter: MM.footer,
    pageNumFmt: 'decimal',
    pageStart: '1',
  },
}

function addPageNumberFooter(type, align) {
  return [
    {
      command: 'add',
      parent: '/',
      type: 'footer',
      props: {
        type,
        text: '— ',
        field: 'page',
        align,
        font: 'SimSun',
        size: '14pt',
        color: '#000000',
      },
    },
  ]
}

function addTrailingDash(index) {
  return {
    command: 'add',
    parent: `/footer[${index}]/p[1]`,
    type: 'run',
    props: { text: ' —' },
  }
}

/**
 * Rewrite sectPr/docGrid to the GB/T 9704 22-line grid. The 28 chars per line come from the
 * 16 pt body font and 156 mm text width; a linesAndChars grid makes LibreOffice distribute CJK
 * glyphs across the full width, so the portable form is a line grid with linePitch = 28.9 pt.
 */
function applyDocGrid(file) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gbt9704-'))
  try {
    execFileSync('unzip', ['-q', file, '-d', dir])
    const documentPath = path.join(dir, 'word/document.xml')
    const xml = readFileSync(documentPath, 'utf8')
    const patched = xml.replace(
      /<w:docGrid\b[^>]*\/>/,
      '<w:docGrid w:type="lines" w:linePitch="578" />',
    )
    if (patched === xml) throw new Error(`no w:docGrid found in ${file}`)
    writeFileSync(documentPath, patched)
    rmSync(file, { force: true })
    execFileSync('zip', ['-q', '-r', file, '.'], { cwd: dir })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function buildGbt9704(file) {
  freshDocx(file)
  batch(file, [...BASE_STYLES, SECTION])
  batch(file, [
    ...addPageNumberFooter('default', 'right'),
    addTrailingDash(1),
  ])
  batch(file, [
    ...addPageNumberFooter('even', 'left'),
    addTrailingDash(2),
  ])
  saveAndClose(file)
  applyDocGrid(file)
}

function buildRedHeader(file) {
  cpSync(path.join(packsRoot, 'gbt9704-2012/template.docx'), file)
  batch(file, [
    style('FawenJiguan', '发文机关标志', {
      basedOn: 'Title',
      next: 'Normal',
      font: '方正小标宋简体',
      'font.ea': '方正小标宋简体',
      size: '36pt',
      bold: 'false',
      color: '#FF0000',
      align: 'center',
      firstLineIndent: '0',
      lineSpacing: '44pt',
      lineRule: 'exact',
    }),
    style('FawenZihao', '发文字号', {
      basedOn: 'Normal',
      next: 'Normal',
      font: BODY.font,
      'font.ea': BODY.font,
      size: '16pt',
      color: '#000000',
      align: 'center',
      firstLineIndent: '0',
      lineSpacing: BODY.lineSpacing,
      lineRule: BODY.lineRule,
    }),
    style('HongXian', '红色分隔线', {
      basedOn: 'Normal',
      next: 'Normal',
      firstLineIndent: '0',
    }),
    style('BanJi', '版记', {
      basedOn: 'Normal',
      next: 'Normal',
      font: BODY.font,
      'font.ea': BODY.font,
      size: '14pt',
      color: '#000000',
      firstLineIndent: '0',
    }),
  ])
  for (const [pathName, border] of [
    ['/styles/HongXian', { 'pbdr.bottom': 'single;18;#FF0000' }],
    ['/styles/BanJi', { 'pbdr.top': 'single;6;#000000', 'pbdr.bottom': 'single;6;#000000' }],
  ]) {
    run(['set', file, pathName, ...Object.entries(border).map(([k, v]) => ['--prop', `${k}=${v}`]).flat()])
  }
  saveAndClose(file)
}

/**
 * 函（GB/T 9704 书信版式）：沿用普通公文的字体、页边距与 22 行网格，只补主送机关、
 * 落款、成文日期、附件说明四个角色；不含红头、发文字号、红色分隔线。
 */
function buildGbt9704Letter(file) {
  cpSync(path.join(packsRoot, 'gbt9704-2012/template.docx'), file)
  batch(file, [
    style('ZhuSong', '主送机关', {
      basedOn: 'Normal',
      next: 'Normal',
      font: BODY.font,
      'font.ea': BODY.font,
      size: '16pt',
      color: '#000000',
      align: 'left',
      firstLineIndent: '0',
      lineSpacing: BODY.lineSpacing,
      lineRule: BODY.lineRule,
      spaceBefore: '0',
      spaceAfter: '0',
    }),
    style('LuoKuan', '落款', {
      basedOn: 'Normal',
      next: 'Normal',
      font: BODY.font,
      'font.ea': BODY.font,
      size: '16pt',
      color: '#000000',
      align: 'right',
      firstLineIndent: '0',
      lineSpacing: BODY.lineSpacing,
      lineRule: BODY.lineRule,
      spaceBefore: '0',
      spaceAfter: '0',
    }),
    style('ChengWenRiQi', '成文日期', {
      basedOn: 'Normal',
      next: 'Normal',
      font: BODY.font,
      'font.ea': BODY.font,
      size: '16pt',
      color: '#000000',
      align: 'right',
      firstLineIndent: '0',
      lineSpacing: BODY.lineSpacing,
      lineRule: BODY.lineRule,
      spaceBefore: '0',
      spaceAfter: '0',
    }),
    style('FuJianShuoMing', '附件说明', {
      basedOn: 'Normal',
      next: 'Normal',
      font: BODY.font,
      'font.ea': BODY.font,
      size: '16pt',
      color: '#000000',
      align: 'left',
      firstLineIndent: BODY.firstLineIndent,
      lineSpacing: BODY.lineSpacing,
      lineRule: BODY.lineRule,
      spaceBefore: '0',
      spaceAfter: '0',
    }),
  ])
  saveAndClose(file)
}

/**
 * 纪要（GB/T 9704 会议纪要版式）：沿用普通公文的字体、页边距与 22 行网格，补标题下
 * 成文日期、分送范围和版记；不含红头、发文字号、红色分隔线。
 */
function buildGbt9704Minutes(file) {
  cpSync(path.join(packsRoot, 'gbt9704-2012/template.docx'), file)
  batch(file, [
    style('JiYaoDate', '成文日期（标题下）', {
      basedOn: 'Normal',
      next: 'Normal',
      font: BODY.font,
      'font.ea': BODY.font,
      size: '16pt',
      color: '#000000',
      align: 'center',
      firstLineIndent: '0',
      lineSpacing: BODY.lineSpacing,
      lineRule: BODY.lineRule,
      spaceBefore: '0',
      spaceAfter: '0',
    }),
    style('JiYaoFenSong', '分送', {
      basedOn: 'Normal',
      next: 'Normal',
      font: BODY.font,
      'font.ea': BODY.font,
      size: '14pt',
      color: '#000000',
      align: 'left',
      firstLineIndent: '0',
      lineSpacing: BODY.lineSpacing,
      lineRule: BODY.lineRule,
      spaceBefore: '0',
      spaceAfter: '0',
    }),
    style('BanJi', '版记', {
      basedOn: 'Normal',
      next: 'Normal',
      font: BODY.font,
      'font.ea': BODY.font,
      size: '14pt',
      color: '#000000',
      firstLineIndent: '0',
    }),
  ])
  for (const [pathName, border] of [
    ['/styles/BanJi', { 'pbdr.top': 'single;6;#000000', 'pbdr.bottom': 'single;6;#000000' }],
  ]) {
    run(['set', file, pathName, ...Object.entries(border).map(([k, v]) => ['--prop', `${k}=${v}`]).flat()])
  }
  saveAndClose(file)
}

function writeManifests() {
  writeFileSync(path.join(packsRoot, 'gbt9704-2012/pack.json'), `${JSON.stringify({
    name: 'gbt9704-2012',
    title: '党政机关公文格式（GB/T 9704-2012）',
    description: '全局默认版式：A4，上37mm/下35mm/左28mm/右26mm，正文三号仿宋_GB2312，标题二号方正小标宋简体，22行×28字，标题与页脚均为黑色。',
    template: 'template.docx',
    page: {
      size: 'A4',
      marginTopMm: 37,
      marginBottomMm: 35,
      marginLeftMm: 28,
      marginRightMm: 26,
      linesPerPage: 22,
      charsPerLine: 28,
    },
    body: { style: 'Normal', font: 'FangSong_GB2312', sizePt: 16, lineSpacingPt: 28.9 },
    titleStyle: { style: 'Title', font: '方正小标宋简体', sizePt: 22 },
    headings: {
      Heading1: { font: 'SimHei', sizePt: 16, color: '000000' },
      Heading2: { font: 'KaiTi_GB2312', sizePt: 16, color: '000000' },
      Heading3: { font: 'FangSong_GB2312', sizePt: 16, bold: true, color: '000000' },
      Heading4: { font: 'FangSong_GB2312', sizePt: 16, bold: true, color: '000000' },
      Heading5: { font: 'FangSong_GB2312', sizePt: 16, bold: true, color: '000000' },
      Heading6: { font: 'FangSong_GB2312', sizePt: 16, bold: true, color: '000000' },
    },
    pageNumber: { font: 'SimSun', sizePt: 14, color: '000000', odd: 'right', even: 'left' },
  }, null, 2)}\n`)
  writeFileSync(path.join(packsRoot, 'red-header/pack.json'), `${JSON.stringify({
    name: 'red-header',
    title: '红头文件（GB/T 9704-2012 + 红头元素）',
    description: '在 gbt9704-2012 基线上增加发文机关标志、发文字号、红色分隔线、版记样式；正文与标题仍为黑色。',
    basedOn: 'gbt9704-2012',
    template: 'template.docx',
    extraStyles: {
      FawenJiguan: { description: '发文机关标志，二号方正小标宋，红色', color: 'FF0000' },
      FawenZihao: { description: '发文字号，三号仿宋，居中，黑色', color: '000000' },
      HongXian: { description: '红色分隔线段落，下边框 2.25pt 红色', color: 'FF0000' },
      BanJi: { description: '版记，四号仿宋，上下黑色边框', color: '000000' },
    },
  }, null, 2)}\n`)
  writeFileSync(path.join(packsRoot, 'gbt9704-letter/pack.json'), `${JSON.stringify({
    name: 'gbt9704-letter',
    title: '函（GB/T 9704-2012 书信版式）',
    description: '在 gbt9704-2012 基线上增加主送机关、落款、成文日期、附件说明版式；不含红头、发文字号、红色分隔线。',
    basedOn: 'gbt9704-2012',
    template: 'template.docx',
    letter: {
      applicable: ['复函', '商洽函', '询问函', '答复函'],
      layout: [
        '标题（Title，二号方正小标宋，居中）',
        '主送机关（ZhuSong，顶格，结尾冒号）',
        '正文（Normal，首行缩进 2 字）',
        '附件说明（FuJianShuoMing，左空 2 字）',
        '落款（LuoKuan，右对齐）',
        '成文日期（ChengWenRiQi，右对齐）',
      ],
      styles: {
        ZhuSong: { description: '主送机关，三号仿宋_GB2312，顶格，黑色' },
        LuoKuan: { description: '发文机关署名/落款，三号仿宋_GB2312，右对齐，黑色' },
        ChengWenRiQi: { description: '成文日期，三号仿宋_GB2312，右对齐，黑色' },
        FuJianShuoMing: { description: '附件说明，三号仿宋_GB2312，左空 2 字，黑色' },
      },
      forbidden: ['FawenJiguan', 'FawenZihao', 'HongXian'],
    },
  }, null, 2)}\n`)
  writeFileSync(path.join(packsRoot, 'gbt9704-minutes/pack.json'), `${JSON.stringify({
    name: 'gbt9704-minutes',
    title: '纪要（GB/T 9704-2012 会议纪要版式）',
    description: '在 gbt9704-2012 基线上增加标题下成文日期、分送、版记版式；不含红头、发文字号、红色分隔线。',
    basedOn: 'gbt9704-2012',
    template: 'template.docx',
    minutes: {
      applicable: ['会议纪要', '专题会议纪要', '办公会议纪要'],
      layout: [
        '标题（Title，二号方正小标宋，居中）',
        '成文日期（JiYaoDate，标题下居中，可加圆括号）',
        '正文（Normal，首行缩进 2 字）',
        '分送（JiYaoFenSong，版记上方，四号仿宋）',
        '版记（BanJi，四号仿宋，上下黑色边框）',
      ],
      styles: {
        JiYaoDate: { description: '标题下成文日期，三号仿宋_GB2312，居中，黑色' },
        JiYaoFenSong: { description: '分送范围，四号仿宋_GB2312，黑色' },
        BanJi: { description: '版记，四号仿宋_GB2312，上下黑色边框' },
      },
      forbidden: ['FawenJiguan', 'FawenZihao', 'HongXian'],
    },
  }, null, 2)}\n`)
}

function main() {
  if (!existsSync(binary)) throw new Error(`officecli binary not found: ${binary}`)
  const only = arg('--only', '')
  const requested = only === '' ? ['gbt9704-2012', 'red-header', 'gbt9704-letter', 'gbt9704-minutes'] : only.split(',').map(value => value.trim())
  for (const pack of requested) {
    mkdirSync(path.join(packsRoot, pack), { recursive: true })
  }
  if (requested.includes('gbt9704-2012')) buildGbt9704(path.join(packsRoot, 'gbt9704-2012/template.docx'))
  if (requested.includes('red-header')) buildRedHeader(path.join(packsRoot, 'red-header/template.docx'))
  if (requested.includes('gbt9704-letter')) buildGbt9704Letter(path.join(packsRoot, 'gbt9704-letter/template.docx'))
  if (requested.includes('gbt9704-minutes')) buildGbt9704Minutes(path.join(packsRoot, 'gbt9704-minutes/template.docx'))
  writeManifests()
  console.log(`style packs rebuilt under ${packsRoot}: ${requested.join(', ')}`)
}

main()