from pathlib import Path
import re
import subprocess

BASE_FIX_COMMIT = '3e31b3f5e5ab80919de558074bfbba93abdcd899'


def run_checked(*args: str) -> None:
    subprocess.run(args, check=True)


# Reuse the already exercised convergence patch from the immediately preceding
# PR head. This wrapper is temporary too: the workflow deletes it before the
# verified tree is committed.
legacy = subprocess.check_output(
    ['git', 'show', f'{BASE_FIX_COMMIT}:.github/pr84-static-fix.py'],
    text=True,
)
exec(compile(legacy, f'{BASE_FIX_COMMIT}:.github/pr84-static-fix.py', 'exec'), {'__name__': '__main__'})


# The English graph/catalog pages are generated, while their Chinese peers are
# reviewed bilingual counterparts. Generate the changed English pages first,
# then carry the machine-owned portions across before recording a new pairing.
run_checked('pnpm', 'run', 'gen-config-catalog')
run_checked('pnpm', 'run', 'gen-doc-graphs')
run_checked('pnpm', 'run', 'gen-module-graph')


def sync_first_fence(english_path: str, chinese_path: str, info: str) -> None:
    marker = f'```{info}\n'
    english = Path(english_path).read_text()
    chinese = Path(chinese_path).read_text()

    english_start = english.index(marker)
    english_end = english.index('\n```', english_start) + len('\n```')
    chinese_start = chinese.index(marker)
    chinese_end = chinese.index('\n```', chinese_start) + len('\n```')

    Path(chinese_path).write_text(
        chinese[:chinese_start]
        + english[english_start:english_end]
        + chinese[chinese_end:]
    )


sync_first_fence('docs/capability-seams.md', 'docs/capability-seams.zh.md', 'mermaid')
sync_first_fence('docs/module-graph.md', 'docs/module-graph.zh.md', 'mermaid')


def sync_table_rows_after(
    english_path: str,
    chinese_path: str,
    row_prefixes: tuple[str, ...],
    anchor_prefix: str,
    replacements: tuple[tuple[str, str], ...] = (),
) -> None:
    english_lines = Path(english_path).read_text().splitlines()
    chinese_file = Path(chinese_path)
    chinese_text = chinese_file.read_text()
    trailing_newline = chinese_text.endswith('\n')
    chinese_lines = chinese_text.splitlines()

    selected: list[str] = []
    for prefix in row_prefixes:
        matches = [line for line in english_lines if line.startswith(prefix)]
        if len(matches) != 1:
            raise SystemExit(
                f'{english_path}: expected one table row starting {prefix!r}, found {len(matches)}'
            )
        row = matches[0]
        for old, new in replacements:
            row = row.replace(old, new)
        selected.append(row)

    # Idempotent when a prior convergence attempt already inserted the rows.
    chinese_lines = [
        line for line in chinese_lines
        if not any(line.startswith(prefix) for prefix in row_prefixes)
    ]
    anchors = [index for index, line in enumerate(chinese_lines) if line.startswith(anchor_prefix)]
    if len(anchors) != 1:
        raise SystemExit(
            f'{chinese_path}: expected one table anchor starting {anchor_prefix!r}, found {len(anchors)}'
        )
    insertion = anchors[0] + 1
    chinese_lines[insertion:insertion] = selected
    rendered = '\n'.join(chinese_lines)
    if trailing_newline:
        rendered += '\n'
    chinese_file.write_text(rendered)


sync_table_rows_after(
    'docs/capability-seams.md',
    'docs/capability-seams.zh.md',
    ('| `ctx.documentParser` |',),
    '| `ctx.attachments` |',
    ((
        'Parser providers convert already-durable document originals into transient final artifacts; Host admission persists those artifacts and owns the aggregate direct-context budget before publishing the user message.',
        '解析器提供方把已持久化的原始文档转换为临时最终产物；Host admission 持久化这些产物，并在发布用户消息前负责聚合的直接上下文预算。',
    ),),
)
sync_table_rows_after(
    'docs/module-graph.md',
    'docs/module-graph.zh.md',
    (
        '| [`document-parser`](../packages/attachment/document-parser) |',
        '| [`document-parser-mineru`](../packages/attachment/document-parser-mineru) |',
    ),
    '| [`attachment-local`](../packages/attachment/attachment-local) |',
)


def anchored_section(text: str, package: str) -> tuple[int, int, str] | None:
    heading = f'## `{package}`'
    heading_at = text.find(heading)
    if heading_at < 0:
        return None
    start = text.rfind('<a id="', 0, heading_at)
    if start < 0:
        raise SystemExit(f'config catalog: missing anchor before {package}')
    candidates = [
        pos
        for pos in (
            text.find('\n<a id="', heading_at + len(heading)),
            text.find('\n## ', heading_at + len(heading)),
        )
        if pos >= 0
    ]
    end = min(candidates) if candidates else len(text)
    return start, end, text[start:end].rstrip()


def localize_catalog_section(section: str) -> str:
    return (
        section
        .replace('\nRequires: ', '\n需要：')
        .replace('\nDepends on: ', '\n依赖：')
        .replace('\nSource: ', '\n来源：')
    )


def sync_catalog_package(package: str) -> None:
    english_path = Path('docs/config-catalog.md')
    chinese_path = Path('docs/config-catalog.zh.md')
    english = english_path.read_text()
    chinese = chinese_path.read_text()
    source = anchored_section(english, package)

    if source is not None:
        source_start, source_end, source_text = source
        localized = localize_catalog_section(source_text)
        existing = anchored_section(chinese, package)
        if existing is not None:
            existing_start, existing_end, _ = existing
            chinese_path.write_text(
                chinese[:existing_start] + localized + chinese[existing_end:]
            )
            return

        insertion: int | None = None
        for match in re.finditer(r'<a id="[^"]+"></a>', english[source_end:]):
            anchor = match.group(0)
            candidate = chinese.find(anchor)
            if candidate >= 0:
                insertion = candidate
                break
        if insertion is None:
            insertion = chinese.find('\n## 无配置的可加载插件')
        if insertion is None or insertion < 0:
            raise SystemExit(f'config catalog: cannot place {package} in Chinese peer')
        chinese_path.write_text(
            chinese[:insertion] + localized + '\n\n' + chinese[insertion:]
        )
        return

    # Defensive support for a package that the catalog classifies as a
    # config-free plugin or an abstract seam instead of a configured section.
    lines = english.splitlines()
    prefix = f'- `{package}`'
    try:
        line_index = next(i for i, line in enumerate(lines) if line.startswith(prefix))
    except StopIteration as error:
        raise SystemExit(f'config catalog: {package} is absent from generated English catalog') from error

    english_line = lines[line_index]
    localized_line = (
        english_line
        .replace(' — requires ', ' — 需要 ')
        .replace(' — abstract ', ' — 抽象 ')
    )
    existing_at = chinese.find(prefix)
    if existing_at >= 0:
        existing_end = chinese.find('\n', existing_at)
        if existing_end < 0:
            existing_end = len(chinese)
        chinese_path.write_text(
            chinese[:existing_at] + localized_line + chinese[existing_end:]
        )
        return

    summary_marker = (
        '## Seam 包（不可直接加载）'
        if ' — abstract ' in english_line
        else '## 无配置的可加载插件'
    )
    summary_at = chinese.find(summary_marker)
    if summary_at < 0:
        raise SystemExit(f'config catalog: missing Chinese summary for {package}')

    insertion = -1
    for following in lines[line_index + 1:]:
        if following.startswith('## '):
            break
        if not following.startswith('- `'):
            continue
        next_package = following.split('`', 2)[1]
        candidate = chinese.find(f'- `{next_package}`', summary_at)
        if candidate >= 0:
            insertion = candidate
            break
    if insertion < 0:
        next_heading = chinese.find('\n## ', summary_at + len(summary_marker))
        insertion = len(chinese) if next_heading < 0 else next_heading

    chinese_path.write_text(
        chinese[:insertion] + localized_line + '\n' + chinese[insertion:]
    )


sync_catalog_package('@deepseek-ai/dsh-document-parser')
sync_catalog_package('@deepseek-ai/dsh-document-parser-mineru')

for paired_path in (
    'docs/capability-seams.md',
    'docs/config-catalog.md',
    'docs/module-graph.md',
):
    run_checked('pnpm', 'run', 'verify-translation-pairing', '--write', paired_path)
