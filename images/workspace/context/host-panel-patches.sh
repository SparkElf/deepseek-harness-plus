#!/bin/sh
# Host patches that let the knowledge page use the official right-hand file window.
#
# The knowledge page is a GLOBAL main panel. The host's right column hides itself
# whenever a global panel is selected, and even when shown, its width and the centre
# column's floor are sized for pages that keep their own content. The knowledge page is
# different: it renders every document through that window and keeps no content column,
# so the frame should give the window the whole remaining width.
#
# Two host packages are patched:
#
#   dsh-client-ui-sidebar-right  keeps the column alive for the knowledge panel
#   dsh-client-ui-layout         drops the centre floor and raises the column cap
#
# Both are idempotent: each patch checks for its own RESULT before applying, so running
# this twice is a no-op. Every other panel and page keeps the stock behaviour.
set -e
ROOT="${1:-/opt/dataops-dsh-profile-template/node_modules/@deepseek-ai}"
python3 - "$ROOT" <<'PY'
import re
import sys, os

root = sys.argv[1]
failures = []


def patch(name, rel, edits, optional=False):
    """Apply (old, new) pairs; skip any whose RESULT is already present.

    `optional` lets a surface whose upstream implementation was rewritten drop an
    anchor that no longer exists (rc.2 moved the layout grid) instead of failing
    the whole image build. A partially-applied patch still fails: only an absent
    anchor with the result also absent is skipped.
    """
    path = os.path.join(root, rel)
    if not os.path.exists(path):
        failures.append('%s: missing' % name)
        return
    text = open(path, encoding='utf-8', errors='replace').read()
    applied = skipped = 0
    for old, new in edits:
        # Check the result first: a rerun must not double-apply.
        if new in text:
            skipped += 1
            continue
        if text.count(old) != 1:
            if optional and text.count(old) == 0:
                skipped += 1
                print('  skipped %s: upstream anchor no longer present' % name)
                continue
            failures.append('%s: anchor count %d' % (name, text.count(old)))
            continue
        text = text.replace(old, new, 1)
        applied += 1
    if applied:
        open(path, 'w', encoding='utf-8').write(text)
        print('  patched %s (%d edit(s), %d already present)' % (name, applied, skipped))
    else:
        print('  already patched %s (%d edit(s))' % (name, skipped))


# `sidebar-right` used to need a patch here: the column gated its Session content on
# `activePanelId === null`, so the knowledge page rendered an empty right column.
#
# 2026-11-05: the source base this image builds (f3803c96) already implements that behaviour.
# `packages/client/ui-sidebar-right/src/client/shell/RightbarRoot.tsx:32-40` carries the fix and
# its own explanation ("A global main panel (the knowledge base) keeps the right column usable"),
# and the built bundle contains no `activePanelId === null` anchor at all -- the patch's selftest
# reported "FAILED: sidebar-right: anchor count 0". Do not add this patch back: an anchor that is
# absent because upstream absorbed the change is a result, not a regression.

LAYOUT_EDITS = [
    # 0) Expose the active panel so the surrounding hook code can resolve it.
    (
        '\t\t\tconst layoutInfo = useStore((state) => state.layoutInfo);',
        '\t\t\tconst layoutInfo = useStore((state) => state.layoutInfo);\n'
        '\t\t\t// The knowledge page hands its documents to the right-hand file window, so it\n'
        '\t\t\t// has no content column of its own to reserve space for.\n'
        '\t\t\tconst activePanelId = usePanelInfo((info) => info.activePanelId);',
    ),
    # 1) The reader opening is driven from <html data-kb-reader-open>, which the knowledge
    # plugin sets outside React. Mirror it into state so the frame re-renders on the same
    # paint, instead of keeping the width computed before the reader existed.
    (
        '\t\t\tconst frameRef = (0, react.useRef)(null);\n'
        '\t\t\tconst viewport = layoutInfo.viewportWidth;',
        '\t\t\tconst frameRef = (0, react.useRef)(null);\n'
        '\t\t\tconst viewport = layoutInfo.viewportWidth;\n'
        '\t\t\t// The knowledge page sets `data-kb-reader-open` on <html> from its own code, so\n'
        '\t\t\t// React has no way to know it changed. Mirroring it into state is what lets the\n'
        '\t\t\t// grid be recomputed on the same paint that opens the reader; without it the\n'
        '\t\t\t// third track keeps whatever width the previous layout produced.\n'
        '\t\t\tconst [readerOpen, setReaderOpen] = (0, react.useState)(() => document.documentElement.hasAttribute("data-kb-reader-open"));\n'
        '\t\t\t(0, react.useEffect)(() => {\n'
        '\t\t\t\tconst html = document.documentElement;\n'
        '\t\t\t\tconst sync = () => setReaderOpen(html.hasAttribute("data-kb-reader-open"));\n'
        '\t\t\t\tsync();\n'
        '\t\t\t\tconst observer = new MutationObserver(sync);\n'
        '\t\t\t\tobserver.observe(html, { attributes: true, attributeFilter: ["data-kb-reader-open"] });\n'
        '\t\t\t\treturn () => observer.disconnect();\n'
        '\t\t\t}, []);',
    ),
    # 2) While a document is open the reader replaces the content column, so one track must
    # hold the whole remainder. `normal.rightbar` is a user preference and is regularly
    # narrower than that remainder; a track wider than the panel is the blank column.
    (
        '\t\t\tconst normal = computeColumns(viewport, !layoutInfo.rightbarShown && narrow ? 0 : sidebarPreference, rightbarPreference, collapsedWidth, centeredSidebar);',
        '\t\t\tconst normal = computeColumns(viewport, !layoutInfo.rightbarShown && narrow ? 0 : sidebarPreference, rightbarPreference, collapsedWidth, centeredSidebar);\n'
        '\t\t\t/**\n'
        '\t\t\t * Widths while a document is open in the right-hand reader.\n'
        '\t\t\t *\n'
        '\t\t\t * In this mode the reader replaces the content column, so the knowledge rail\n'
        '\t\t\t * (280) plus the sidebar must be followed by ONE track holding everything else.\n'
        '\t\t\t * `normal.rightbar` cannot be used: it is derived from a user preference and is\n'
        '\t\t\t * regularly narrower than the remainder, and a track wider than the panel is\n'
        '\t\t\t * exactly the blank column that shows up beside the document.\n'
        '\t\t\t *\n'
        '\t\t\t * Exported as one object so the grid and the slot width are the same number by\n'
        '\t\t\t * construction rather than by two expressions that must be kept in step.\n'
        '\t\t\t */\n'
        '\t\t\tconst readerSidebarWidth = sidebarCollapsed ? collapsedWidth : normal.sidebar;\n'
        '\t\t\tconst readerRightbarWidth = Math.max(0, viewport - readerSidebarWidth - 280);\n'
        '\t\t\tconst readerColumns = readerOpen ? {\n'
        '\t\t\t\tsidebar: readerSidebarWidth,\n'
        '\t\t\t\tcenter: 280,\n'
        '\t\t\t\trightbar: readerRightbarWidth\n'
        '\t\t\t} : null;\n'
        '\t\t\tconst layoutCols = readerColumns ?? normal;',
    ),
    # 3) The grid: stock formula off-reader, the computed three tracks in reader mode.
    (
        '\t\t\t\t\tgridTemplateColumns: `${cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : 400}px, 1fr) minmax(0px, ${rightbarMax}px)`',
        '\t\t\t\t\t// Both values come from `layoutCols`, so the track the grid reserves and the\n'
        '\t\t\t\t\t// width the panel is told are the same number. Splitting them is what\n'
        '\t\t\t\t\t// produced an unpainted strip beside the document.\n'
        '\t\t\t\t\t"--dsh-reader-track": `${layoutCols.rightbar}px`,\n'
        '\t\t\t\t\tgridTemplateColumns: readerColumns === null\n'
        '\t\t\t\t\t\t? `${cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : 400}px, 1fr) minmax(0px, ${rightbarMax}px)`\n'
        '\t\t\t\t\t\t: `${readerColumns.sidebar}px 280px ${readerColumns.rightbar}px`',
    ),
    # 4) The rightbar slot reports the same width the grid reserved, including whether
    # it can be shown at all.
    (
        '\t\t\t\t\t\t\twidth: normal.rightbar,\n'
        '\t\t\t\t\t\t\tviewportWidth: viewport,\n'
        '\t\t\t\t\t\t\tcanShow: normal.rightbar > 0',
        '\t\t\t\t\t\t\twidth: layoutCols.rightbar,\n'
        '\t\t\t\t\t\t\tviewportWidth: viewport,\n'
        '\t\t\t\t\t\t\tcanShow: layoutCols.rightbar > 0',
    ),
    # 5) Reader mode drops the grid transition (a mid-animation paint is visible) and pins
    # the rail to the same 280 the JS formula uses.
    #
    # The frame's CSS class carries a build hash (0.2.1-alpha.2 ships `_422GfG`, 0.2.1-rc.2 ships
    # `YI-6GG`), so the rule is derived from the file below rather than written here: a pinned
    # hash stops matching on the next release and the whole step fails with "anchor count 0".
]

# rc.2 (and 0.2.9-alpha.91) ship the layout client minified. The formatted anchors in
# LAYOUT_EDITS no longer match, but the frame still has to publish the sidebar track:
# the reader CSS below sizes the first column from it. Without this edit the CSS falls
# back to 280px while the sidebar occupant can be wider, so a dragged sidebar would
# clip. The anchor is the exact minified style literal, verified against the bundle
# shipped in 0.2.9-alpha.91.
RC2_EDITS = [
    (
        'style:{...windowsTitlebar?{"--dsh-windows-sidebar-width":`${cols.sidebar}px`}:{},gridTemplateColumns:',
        'style:{...windowsTitlebar?{"--dsh-windows-sidebar-width":`${cols.sidebar}px`}:{},'
        '"--dsh-sidebar-track":`${cols.sidebar}px`,gridTemplateColumns:',
    ),
]


def frame_style_edits():
    """Reader-mode CSS, with the frame's hashed class read from the bundle it patches.

    The reader gives the knowledge rail (280) and the document the whole remainder.
    The old rule wrote the never-set `--dsh-reader-track` into grid-template-columns;
    an invalid var() there computes to `none`, and the frame's three grid-column items
    fall into auto-sized implicit tracks. The left sidebar then stretches to ~654px and
    leaves a ~370px blank strip between the navigation and the knowledge page. The
    rules below replace that block in place, use `1fr` for the document track, and make
    the right-hand panel fill the track (its saved 756px width used to hang over the
    knowledge rail).
    """
    path = os.path.join(root, 'dsh-client-ui-layout/lib/client.js')
    if not os.path.exists(path):
        failures.append('layout: missing')
        return []
    text = open(path, encoding='utf-8', errors='replace').read()
    if ':not([data-rightbar-fullscreen]) [data-rightbar-col] [data-sidebar-right-panel]{width:100%' in text:
        return []
    match = re.search(r'\.([A-Za-z0-9_-]+)_frame\[data-dragging\]\{transition:none\}', text)
    if match is None:
        failures.append('layout: frame class not found')
        return []
    frame = '.%s_frame' % match.group(1)
    # v1 of this patch sized the panel to the reader track even in the right column's
    # fullscreen presentation (the overlay stayed 1120px instead of 100vw). Upgrade
    # that selector in place; the rest of the block is already correct.
    v1_panel = (
        'html[data-kb-reader-open] ' + frame
        + ':not([data-rightbar-collapsed]) [data-rightbar-col] [data-sidebar-right-panel]'
        + '{width:100% !important;--dsh-sidebar-width:100% !important}'
    )
    v2_panel = (
        'html[data-kb-reader-open] ' + frame
        + ':not([data-rightbar-collapsed]):not([data-rightbar-fullscreen])'
        + ' [data-rightbar-col] [data-sidebar-right-panel]'
        + '{width:100% !important;--dsh-sidebar-width:100% !important}'
    )
    if v1_panel in text:
        return [(v1_panel, v2_panel)]
    new_css = (
        'html[data-kb-reader-open] ' + frame + '{transition:none !important}'
        'html[data-kb-reader-open] ' + frame
        + ':not([data-sidebar-drawer]):not([data-sidebar-collapsed]):not([data-rightbar-collapsed])'
        + '{grid-template-columns:var(--dsh-sidebar-track,280px) 280px minmax(0,1fr) !important}'
        'html[data-kb-reader-open] ' + frame
        + ':not([data-sidebar-drawer])[data-sidebar-collapsed]:not([data-rightbar-collapsed])'
        + '{grid-template-columns:56px 280px minmax(0,1fr) !important}'
        'html[data-kb-reader-open] ' + frame
        + ':not([data-rightbar-collapsed]):not([data-rightbar-fullscreen])'
        + ' [data-rightbar-col] [data-sidebar-right-panel]'
        + '{width:100% !important;--dsh-sidebar-width:100% !important}'
        'html[data-kb-reader-open] ' + frame + ' [data-side="rightbar"]{display:none !important}'
    )
    old_reader = re.search(
        re.escape('html[data-kb-reader-open] ' + frame + '{transition:none !important}')
        + re.escape('html[data-kb-reader-open] ' + frame + ':not([data-sidebar-collapsed])')
        + r'\{grid-template-columns:[^}]*!important\}'
        + re.escape('html[data-kb-reader-open] ' + frame + '[data-sidebar-collapsed]')
        + r'\{grid-template-columns:[^}]*!important\}',
        text,
    )
    if old_reader is not None:
        return [(old_reader.group(0), new_css)]
    old = frame + '[data-dragging]{transition:none}'
    return [(old, old + new_css)]


patch('layout', 'dsh-client-ui-layout/lib/client.js', LAYOUT_EDITS + RC2_EDITS + frame_style_edits(), optional=True)


# The `@` file picker in the conversation composer lists workspace paths through
# `dsh-file-reference-local`. Its walk classifies each `readdir` entry with
# `isDirectory()`/`isFile()`, and a `Dirent` describes a SYMLINK rather than its
# target: both answer false, so every symlinked directory is dropped from the
# index. The workspace keeps its shared content behind exactly those links
# (`kb` -> the knowledge share, `group-shared` -> the room directory), so the
# picker offered `skills/`, `outputs/`, `kb-backup-*` and none of the actual
# documents. A second guard refused the drill for the same reason.
#
# Read-only discovery is patched; nothing is written and no content is exposed
# that the filesystem did not already answer for the same cwd.
REFERENCE_EDITS = [
    # 0) `stat` follows a link; `lstat`/`readdir` do not.
    (
        'import { lstat, readdir } from "node:fs/promises";',
        'import { lstat, readdir, stat } from "node:fs/promises";',
    ),
    # 1) One classifier for both call sites, inserted ahead of the search defaults.
    (
        '/** Default maximum file and directory candidates rendered for one query. */',
        '/**\n'
        ' * Classify a directory entry, following a symbolic link to its target.\n'
        ' *\n'
        ' * `readdir({ withFileTypes: true })` reports the link\'s own metadata, so a\n'
        ' * symlink\'s `isDirectory()`/`isFile()` are both false and the caller would\n'
        ' * drop it. A link to a directory IS a directory to the reader -- the\n'
        ' * workspace\'s own `kb` and `group-shared` are exactly that -- so the target is\n'
        ' * stat\'ed once and the entry classified by what it points at.\n'
        ' *\n'
        ' * The target is NOT required to live under the workspace root: pointing\n'
        ' * outside it is the purpose of these links. What this refuses is a link whose\n'
        ' * target cannot be resolved -- missing, ELOOP, permission-denied -- which\n'
        ' * yields "other" and is skipped by every caller, so a broken link resolves to\n'
        ' * nothing instead of to a row that fails on open.\n'
        ' *\n'
        ' * @param {import("node:fs").Dirent} entry\n'
        ' * @param {string} full - absolute path of the entry as listed.\n'
        ' * @returns {Promise<"directory"|"file"|"other">}\n'
        ' */\n'
        'async function classifyEntry(entry, full) {\n'
        '\tif (entry.isDirectory()) return "directory";\n'
        '\tif (entry.isFile()) return "file";\n'
        '\tif (!entry.isSymbolicLink()) return "other";\n'
        '\ttry {\n'
        '\t\tconst target = await stat(full);\n'
        '\t\tif (target.isDirectory()) return "directory";\n'
        '\t\tif (target.isFile()) return "file";\n'
        '\t\treturn "other";\n'
        '\t} catch (_error) {\n'
        '\t\treturn "other";\n'
        '\t}\n'
        '}\n'
        '\n'
        '/** Default maximum file and directory candidates rendered for one query. */',
    ),
    # 2) The INDEX walk: classify before branching, and descend a linked directory.
    (
        '\t\t\t\tconst path = directory.relative === "" ? entry.name : `${directory.relative}/${entry.name}`;\n'
        '\t\t\t\tif (entry.isDirectory()) {',
        '\t\t\t\tconst path = directory.relative === "" ? entry.name : `${directory.relative}/${entry.name}`;\n'
        '\t\t\t\tconst kind = await classifyEntry(entry, join(directory.absolute, entry.name));\n'
        '\t\t\t\tif (kind === "directory") {',
    ),
    (
        '\t\t\t\t} else if (entry.isFile()) indexed.push({\n'
        '\t\t\t\t\tpath,\n'
        '\t\t\t\t\tkind: "file"\n'
        '\t\t\t\t});',
        '\t\t\t\t} else if (kind === "file") indexed.push({\n'
        '\t\t\t\t\tpath,\n'
        '\t\t\t\t\tkind: "file"\n'
        '\t\t\t\t});',
    ),
    # 3) The per-LEVEL listing a drill reads.
    (
        '\t\t\tif (entry.name.startsWith(".") && !fragment.startsWith(".")) continue;\n'
        '\t\t\tif (entry.isDirectory()) {',
        '\t\t\tif (entry.name.startsWith(".") && !fragment.startsWith(".")) continue;\n'
        '\t\t\tconst kind = await classifyEntry(entry, join(absolute, entry.name));\n'
        '\t\t\tif (kind === "directory") {',
    ),
    (
        '\t\t\t} else if (entry.isFile()) candidates.push({\n'
        '\t\t\t\tpath: `${displayDirectory}${entry.name}`,\n'
        '\t\t\t\tkind: "file"\n'
        '\t\t\t});',
        '\t\t\t} else if (kind === "file") candidates.push({\n'
        '\t\t\t\tpath: `${displayDirectory}${entry.name}`,\n'
        '\t\t\t\tkind: "file"\n'
        '\t\t\t});',
    ),
    # 4) The DRILL guard: a link that resolves to a directory is traversable.
    #
    # The lexical path is already proven inside the root by the `fromRoot` check
    # above; the TARGET may legitimately be outside it, so no realpath containment
    # is imposed -- requiring one would forbid the very layout this exists for.
    (
        '\t\t\tconst status = await lstat(current);\n'
        '\t\t\tsignal.throwIfAborted();\n'
        '\t\t\tif (status.isSymbolicLink() || !status.isDirectory()) return void 0;',
        '\t\t\tconst status = await lstat(current);\n'
        '\t\t\tsignal.throwIfAborted();\n'
        '\t\t\tif (status.isSymbolicLink()) {\n'
        '\t\t\t\t/*\n'
        '\t\t\t\t * A link is followed when it resolves to a directory. A target that\n'
        '\t\t\t\t * does not resolve -- broken, ELOOP, unreadable -- refuses the drill,\n'
        '\t\t\t\t * which is the same answer a missing directory gets.\n'
        '\t\t\t\t */\n'
        '\t\t\t\tconst target = await stat(current).catch(() => void 0);\n'
        '\t\t\t\tsignal.throwIfAborted();\n'
        '\t\t\t\tif (target === void 0 || !target.isDirectory()) return void 0;\n'
        '\t\t\t\tcontinue;\n'
        '\t\t\t}\n'
        '\t\t\tif (!status.isDirectory()) return void 0;',
    ),
]
patch('reference-local', 'dsh-file-reference-local/lib/index.js', REFERENCE_EDITS, optional=True)

if failures:
    for line in failures:
        print('  FAILED: %s' % line)
    sys.exit(1)
print('  host patches applied')
PY
