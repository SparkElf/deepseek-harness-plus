import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The sidebar region must read as the same design system as the workspace region, which
 * is a claim about numbers copied from `ui-workspace`'s own stylesheet. Those numbers
 * cannot be asserted by rendering (no DOM environment ships here), so they are asserted
 * against the stylesheet this package owns.
 *
 * If `ui-workspace` changes a value, this fails and names the value rather than letting
 * the two regions drift apart silently.
 */
const CSS = readFileSync(new URL('../src/client/SidebarRooms.module.css', import.meta.url), 'utf8')

/**
 * Read every declaration block one selector owns, joined.
 *
 * A selector legitimately appears more than once — a size may be declared apart from its
 * layout — so the helper accumulates instead of stopping at the first block.
 */
const ruleOf = (selector: string): string => {
  const pattern = new RegExp(`\\.${selector}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'gu')
  const blocks = [...CSS.matchAll(pattern)].map((match) => match[1])
  if (blocks.length === 0) throw new Error(`no rule for .${selector}`)
  return blocks.join(' ').replace(/\s+/gu, ' ')
}

describe('sidebar region aligns with the workspace region', () => {
  it('uses the workspace section header geometry', () => {
    // ui-workspace: .sectionHeader{height:36px;gap:4px;margin-bottom:4px;padding-left:4px}
    const header = ruleOf('sectionHeader')
    expect(header).toContain('height: 36px')
    expect(header).toContain('gap: 4px')
    expect(header).toContain('margin-bottom: 4px')
    expect(header).toContain('padding-left: 4px')
  })

  it('does not shrink the section label to a caption', () => {
    // The workspace label carries no font-size of its own and inherits the sidebar's
    // 14px; a small fixed size here is what made the first attempt look like a lookalike.
    const label = ruleOf('sectionLabel')
    expect(label).not.toMatch(/font-size/u)
    expect(label).toContain('line-height: 20px')
    expect(label).toContain('max-width: 45%')
  })

  it('keeps the icon button and expanded search at the workspace sizes', () => {
    expect(ruleOf('iconButton')).toContain('width: 28px')
    expect(ruleOf('iconButton')).toContain('height: 28px')
    // `searchExpanded` shares one block with `search`, so the size lives on `.searchExpanded`.
    expect(ruleOf('searchExpanded')).toContain('height: 30px')
    expect(ruleOf('searchInput')).toContain('font-size: 13px')
  })

  it('keeps the session row height', () => {
    // ui-workspace: .sessionRow{height:32px}
    expect(CSS).toContain('height: 32px')
  })

  it('draws every colour from a DSH token rather than a literal palette', () => {
    // A hard-coded colour is what makes a panel stop following the theme.
    const declarations = CSS.replace(/\/\*[\s\S]*?\*\//gu, '')
    const literals = declarations.match(/#[0-9a-f]{3,8}\b/giu) ?? []
    // The only permitted literals are fallbacks inside var(), e.g. var(--x, #d29922).
    const bare = literals.filter((value) => !new RegExp(`var\\([^)]*${value}`, 'u').test(declarations))
    expect(bare).toEqual([])
  })

  it('fills the row container the seat gives it', () => {
    // The seat renders inside `sidebar.footer.action`, which the shell styles as a row
    // flex container. A column child there is content-sized unless it is told to grow,
    // which parked the header's trailing actions beside the label instead of against the
    // right edge.
    const root = ruleOf('root')
    expect(root).toContain('flex: 1 1 auto')
    expect(root).toContain('min-width: 0')
    expect(root).toContain('width: 100%')
  })

  it('renders the empty state the way the workspace region does', () => {
    // Copied from ui-workspace's `.emptyState`: centred column, glyph above the copy.
    const emptyState = ruleOf('emptyState')
    expect(emptyState).toContain('flex-direction: column')
    expect(emptyState).toContain('align-items: center')
    expect(emptyState).toContain('gap: 8px')
    expect(emptyState).toContain('font-size: 13px')
  })

  it('adds nothing to the empty state beyond the glyph and the copy', () => {
    // The workspace's empty state is an icon and a sentence, and nothing else. A link to
    // create a room would repeat the header's own button.
    const section = readFileSync(new URL('../src/client/SidebarRooms.tsx', import.meta.url), 'utf8')
    const start = section.indexOf('styles.emptyState')
    const block = section.slice(start, section.indexOf('</div>', start))
    expect(block).toContain('IconQueueOutlineRegular')
    expect(block).not.toContain('<button')
  })

  it('hides the collapsed search input instead of leaving a sliver', () => {
    // The input stays mounted while collapsed so the caret can move straight into it, and
    // `width: 0` alone still leaves a couple of pixels of caret visible after the search
    // glyph. Measured in the running app: the input sat 2px wide at the right of the
    // button and read as a stray colon.
    const input = ruleOf('searchInput')
    expect(input).toContain('width: 0')
    expect(input).toContain('opacity: 0')
    expect(input).toContain('pointer-events: none')
    // Open, it becomes visible again.
    expect(ruleOf('searchExpanded .searchInput')).toContain('opacity: 1')
  })

  it('does not let the search box grow inside its slot', () => {
    // The slot is what flexes; a growing inner box stretches past the 28px button.
    // `.search` shares its block with `.searchExpanded`, so match on the shared rule.
    expect(CSS).toMatch(/\.search,\s*\n\.searchExpanded \{[^}]*flex: none/u)
  })

  it('caps its own height, because the footer seat does not shrink', () => {
    // `footArea` is flex:none, so without a cap the room list grows until it crowds the
    // workspace region above it.
    expect(ruleOf('root')).toContain('max-height')
  })
})

describe('create dialog states what the fields decide', () => {
  const source = readFileSync(new URL('../src/client/CreateRoomDialog.tsx', import.meta.url), 'utf8')

  it('carries the working directory and preset to the server', () => {
    // Collecting the two fields and dropping them was the failure mode here: the room
    // would be created with the server default while the dialog implied otherwise.
    expect(source).toContain('cwd: cwd.trim()')
    expect(source).toContain('agentPreset: preset.trim()')
    expect(source).not.toContain('void cwd')
    expect(source).not.toContain('void preset')
  })

  it('warns about the working directory rather than hinting', () => {
    // Every member shares this scope, so the copy states the consequence.
    expect(source).toContain("t('createCwdHint')")
    expect(source).toContain('styles.warn')
  })

  it('shows the required notice that the switches are not access control', () => {
    expect(source).toContain("t('createNotice')")
  })

  it('offers the three policy dimensions, including the record-only trigger', () => {
    for (const key of ['createPolicy', 'createVisibility', 'createTrigger']) {
      expect(source).toContain(`t('${key}')`)
    }
    for (const key of ['triggerMention', 'triggerAlways', 'triggerNever']) {
      expect(source).toContain(key)
    }
  })
})

describe('room context menu follows the settled entry set', () => {
  const menu = readFileSync(new URL('../src/client/SidebarRooms.tsx', import.meta.url), 'utf8')

  it('offers the entries the design settled on', () => {
    for (const key of ['menuRename', 'menuInvite', 'menuSettings', 'menuMembers', 'copyRoomId', 'menuLeave']) {
      expect(menu, key).toContain(`t('${key}')`)
    }
  })

  it('omits the two official workspace entries that do not fit a room', () => {
    // Archiving duplicates "leave room", and forking copies history whose events carry no
    // member attribution — a room that looks continuous but whose older messages belong
    // to nobody. Neither is relabelled here; both are absent.
    expect(menu).not.toContain("t('archive')")
    expect(menu).not.toContain("t('fork')")
  })

    it('shows invite and leave only to a member', () => {
      // A room the operator left is still listed under the "show left rooms" filter, and
      // offering to leave it again would be a no-op the server rejects. The owner is excluded
      // here because the server refuses their leave outright.
      expect(menu).toMatch(/room\.joined && \(\s*<button[\s\S]{0,200}menuInvite/u)
      expect(menu).toMatch(/room\.joined && store\.selfId\(\) !== room\.ownerUserId/u)
      expect(menu).toMatch(/onRequestLeave/u)
    })

    it('offers the owner a transfer instead of a leave', () => {
      // A room without an owner has nobody who may change its settings, so the server refuses
      // to let the owner leave. Transferring is the way out, and it is the only entry the
      // owner gets in place of "leave room".
      expect(menu).toMatch(/room\.joined && store\.selfId\(\) === room\.ownerUserId/u)
      expect(menu).toMatch(/menuTransfer/u)
      expect(menu).toContain("kind: 'transfer'")
    })

  it('renames in place rather than through a second dialog', () => {
    expect(menu).toContain('renameTitle')
    expect(menu).toContain('store.rename')
  })

  it('lists the room shared folder with a size, not as bare names', () => {
    // The panel is one column: a file row has to say how big the file is without a table,
    // and the section must stay absent on a deployment that has no shared tree rather than
    // claiming "no files".
    const panel = readFileSync(new URL('../src/client/MembersPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('listRoomFiles')
    expect(panel).toContain('membersFilesTitle')
    expect(panel).toContain('formatBytes')
    expect(panel).toMatch(/state\.path === null/u)
  })

  it('re-applies a room model change to an already-open room', () => {
    // A session keeps the model it was opened with. Without re-applying on change, an operator
    // who fixes a rejected provider keeps watching the room fail on the credential they
    // already replaced — and the only visible symptom is the same auth error as before.
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('applyModelSelection')
    expect(source).toContain('modelKeyOf')
    // Compared, not written every poll: selectModel per three seconds would be a write storm.
    expect(source).toMatch(/runtime\.modelKey !== modelKeyOf\(room\)/u)
  })

  it('collapses any section so the panel survives a narrow sidebar', () => {
    // The right sidebar is draggable and this panel stacks three sections. Without folding, a
    // narrow column squeezes the roster until names collide; with it, each section reduces to
    // its title row.
    const panel = readFileSync(new URL('../src/client/MembersPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('CollapsibleSection')
    expect(panel).toContain('aria-expanded')
    // The label is the disclosure control, not a separate caret button: at 200px two targets
    // would leave neither big enough to hit.
    expect(panel).toMatch(/sectionToggle/u)
    // Three sections use it — announcement, files, roster.
    expect((panel.match(/<CollapsibleSection/gu) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('lets a member walk into a subfolder and back out', () => {
    // A room that organises its files into folders was previously a dead end: the directory
    // row rendered as a plain line with no way in, so everything below the first level was
    // invisible from the panel.
    const panel = readFileSync(new URL('../src/client/MembersPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('subPath')
    expect(panel).toContain('crumbs')
    expect(panel).toContain('joinPath')
    // The path travels to the server, which resolves and re-checks it against the room folder;
    // the browser never assembles an absolute path of its own.
    const api = readFileSync(new URL('../src/client/api.ts', import.meta.url), 'utf8')
    expect(api).toMatch(/listRoomFiles = \(roomId: string, path\?: string\)/u)
  })

  it('uploads into the room folder through a hidden file input', () => {
    // The native dialog is the only picker that hands back a File without a second permission
    // step, and the input must stay hidden: a visible one would be a duplicate control next to
    // the button that opens it.
    const panel = readFileSync(new URL('../src/client/MembersPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('uploadRoomFile')
    expect(panel).toContain('membersFileUploadFailed')
    expect(panel).toMatch(/type="file"/u)
    const css = readFileSync(new URL('../src/client/MembersPanel.module.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.filePicker\s*\{[^}]*display:\s*none/u)
  })

  it('opens a file preview in place instead of navigating away', () => {
    // The panel can stay open for a long time. A preview that replaced the panel would lose
    // the member list, and one that navigated would lose the room.
    const panel = readFileSync(new URL('../src/client/MembersPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('getRoomFile')
    expect(panel).toContain('membersFileTruncated')
    expect(panel).toContain('membersFileBinary')
    // A binary file must not be rendered as text: the backend reports textLike, the panel
    // branches on it.
    expect(panel).toMatch(/preview\.textLike/u)
  })

  it('offers a manual refresh for the shared folder', () => {
    // The folder changes when the room's agent writes a file; a panel that never re-read it
    // would show a stale list for the whole time it is open.
    const panel = readFileSync(new URL('../src/client/MembersPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('membersFilesRefresh')
    expect(panel).toContain('reloadKey')
  })

  it('shows unread as a badge and mentions in a separate style', () => {
    // The trailing slot holds either the member count or the unread badge, never both: a row
    // that grew a second trailing element would reflow every time a room gained unread.
    expect(menu).toContain('unreadCount')
    expect(menu).toContain('mentionCount')
    expect(menu).toContain('styles.unread')
    expect(menu).toContain('styles.unreadMentioned')
    // A room this account has not joined has no reading position, so it must never badge.
    expect(menu).toMatch(/room\.joined \? room\.unreadCount/u)
  })

  it('renders the rename field and its actions as a form, not as menu rows', () => {
    // A bare menu row as the commit step made the dialog read like a list, and a content-box
    // field overflowed the panel by its own border and padding. Both are layout contracts this
    // package has regressed on before, so assert the classes the stylesheet actually defines.
    expect(menu).toContain('menuRename')
    expect(menu).toContain('menuInput')
    expect(menu).toContain('menuActions')
    expect(menu).toContain('menuConfirm')
    expect(menu).toContain('menuCancel')
  })
})

describe('room dialogs', () => {
  const dialogs = readFileSync(new URL('../src/client/RoomDialogs.tsx', import.meta.url), 'utf8')

  it('writes the three policy dimensions, not a subset', () => {
    expect(dialogs).toContain('invitePolicy')
    expect(dialogs).toContain('discoverability')
    expect(dialogs).toContain('agentTrigger')
    for (const key of ['triggerMention', 'triggerAlways', 'triggerNever']) {
      expect(dialogs).toContain(key)
    }
  })

  it('repeats the notice that the switches are not access control', () => {
    expect(dialogs).toContain("t('createNotice')")
  })

  it('invites the accounts the picker chose, not raw typed ids', () => {
    // The dialog used to send whatever the operator typed, split on whitespace: a typo
    // became a failed invite and there was no way to see who was about to be added. Ids now
    // come from candidates the server resolved, so only real accounts are ever sent.
    expect(dialogs).toContain('inviteMembers(roomId, chosen.map((member) => member.userId))')
    expect(dialogs).toContain('searchInviteCandidates(roomId, query)')
  })
})

describe('右键菜单不被滚动容器裁剪', () => {
  it('renders the room menu through a portal, not inside the scrolling list', () => {
    // The room list scrolls (`overflow-y: auto`). A positioned menu inside it is clipped at
    // the box's edge, so the lower rooms lost their bottom entries — the menu appeared cut
    // off. The portal moves it outside every clipping ancestor.
    const tsx = readFileSync(new URL('../src/client/SidebarRooms.tsx', import.meta.url), 'utf8')
    expect(tsx).toContain("from 'react-dom'")
    expect(tsx).toMatch(/createPortal\(/u)
    expect(tsx).toMatch(/document\.body/u)
  })

  it('positions the portal against the row that opened it', () => {
    // Captured at open time rather than read during render, so scrolling the list while the
    // menu is open does not drag the menu away from the row the operator aimed at.
    const tsx = readFileSync(new URL('../src/client/SidebarRooms.tsx', import.meta.url), 'utf8')
    expect(tsx).toMatch(/getBoundingClientRect\(\)/u)
    expect(tsx).toMatch(/anchor: DOMRect/u)
  })

  it('keeps the view menu inline, where nothing clips it', () => {
    // Its anchor sits in the header, outside the scrolling list, so the portal would only
    // add indirection — it keeps its own absolute positioning class.
    const css = readFileSync(new URL('../src/client/SidebarRooms.module.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.menuLayer\s*\{[^}]*position:\s*fixed/u)
    expect(css).toMatch(/\.menuInline\s*\{[^}]*position:\s*absolute/u)
  })
})
