"""Apply the 「工作流广场」 patch to a built ui-schedule client bundle.

Derived from `@deepseek-ai/dsh-client-ui-schedule@0.2.1-rc.2`, whose `lib/client.js` carries
the same three anchors the 0.2.1-alpha.2 build did; the anchors are located by content, so a
later build that keeps them needs no edit here. The deployed package ships only `lib/`, so --
like the other entries under `patches/manual/` -- this edits the built artifact rather than
TypeScript source.

Idempotent: a marker string makes a second run a no-op, which is what
`apply-manual-patches.sh` relies on when it checks whether a patch is already in place.

The five edits, in order:

1. add the `statusFilter.plaza` string to both dictionaries;
2. append a fourth tab button to the existing tab strip, **only when a plugin contributes a
   `schedule.manager.tabs` entry** -- with no contributor the strip is the stock three tabs;
3. declare the `schedule.manager.tabs` child slot on the page's `main` registration, and pass
   the page a `plazaAvailable()` probe so the button can ask the live slot table;
4. render the contributed body in place of the search field when that tab is selected;
5. hide the page's empty state while the plaza tab is selected.
"""
import sys

MARKER = 'task-manager-plaza-body'

PLAZA_TAB_BUTTON = """.concat(props.plazaAvailable?.() === true ? [(0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: clsx(TaskManagerPage_module_css_default.filterTab, statusFilter === "plaza" && TaskManagerPage_module_css_default.filterTabActive),
												"aria-pressed": statusFilter === "plaza",
												"data-testid": "task-manager-plaza-tab",
												onClick: () => {
													setStatusFilter("plaza");
												},
												children: t("statusFilter.plaza")
											})] : [])"""

PLAZA_BODY_GUARD = ('statusFilter === "plaza" ? (0, react_jsx_runtime.jsx)("div", {\n'
                    '\t\t\t\t\t\t\t\t\t"data-testid": "task-manager-plaza-body",\n'
                    '\t\t\t\t\t\t\t\t\tchildren: props.renderSlot("schedule.manager.tabs", {})\n'
                    '\t\t\t\t\t\t\t\t}) : ')


def apply(src: str) -> str:
    if MARKER in src:
        return src

    # ---- 1. locale strings ----
    before = src
    src = src.replace('"statusFilter.all": "All",',
                      '"statusFilter.all": "All",\n\t\t\t"statusFilter.plaza": "Workflow plaza",', 1)
    src = src.replace('"statusFilter.all": "全部",',
                      '"statusFilter.all": "全部",\n\t\t\t"statusFilter.plaza": "工作流广场",', 1)
    if src == before:
        raise SystemExit('locale anchor not found')

    # ---- 2. append the fourth tab, when a contribution exists ----
    # The strip's `children:` value is `[...].map(...)` -- one array-valued expression, so
    # `.concat(...)` appends to it without restructuring; the three status tabs stay its first
    # elements, in order. The appended array is empty unless a plugin has registered into
    # `schedule.manager.tabs`, which is what keeps an un-contributed page identical to stock.
    needle = 'children: t(value === "all" ? "statusFilter.all" : `status.${value}`)'
    i = src.find(needle)
    if i == -1:
        raise SystemExit('status tab anchor not found')
    j = src.find('}, value))', i)
    if j == -1:
        raise SystemExit('status tab map close not found')
    value_end = j + len('}, value))')
    src = src[:value_end] + PLAZA_TAB_BUTTON + src[value_end:]

    # ---- 3. declare the child slot, and give the page the probe the button uses ----
    # `renderSlot` is delivered to the PAGE COMPONENT as a prop (PropsRenderSlots), not to
    # `inject`; capturing it in `inject` yields undefined and the tab crashes on click. The
    # probe reads the slot table at render time, so a plugin that registers later still shows
    # up on the next render of the page.
    registration = '''ctx.slots.inject("main", () => ctx.slots.register({
\t\t\t\tname: "main",
\t\t\t\tkey: PANEL_ID,
\t\t\t\tlocale: MANAGER_NS,
\t\t\t\tinject: () => ({'''
    if registration not in src:
        raise SystemExit('main slot registration not found')
    src = src.replace(registration, '''ctx.slots.inject("main", () => ctx.slots.register({
\t\t\t\tname: "main",
\t\t\t\tkey: PANEL_ID,
\t\t\t\tlocale: MANAGER_NS,
\t\t\t\tchildren: {
\t\t\t\t\t"schedule.manager.tabs": {
\t\t\t\t\t\tkind: "single",
\t\t\t\t\t\tscope: "root"
\t\t\t\t\t}
\t\t\t\t},
\t\t\t\tinject: () => ({
\t\t\t\t\tplazaAvailable: () => ctx.slots.entriesOfSlot("schedule.manager.tabs").length > 0,''', 1)

    # ---- 4. render the contributed body ----
    search = 'className: TaskManagerPage_module_css_default.searchField,'
    k = src.find(search)
    if k == -1:
        raise SystemExit('search field anchor not found')
    body_open = src.rfind('(0, react_jsx_runtime.jsxs)("div", {', 0, k)
    if body_open == -1:
        raise SystemExit('body wrapper not found')
    src = src[:body_open] + PLAZA_BODY_GUARD + src[body_open:]

    # ---- 5. hide the empty state while the plaza is selected ----
    # The body tail is three siblings: search field, list, and -- inside that list -- the
    # empty block. Gating only the search field left the empty block visible under the
    # plaza, which is the reported defect. `CatalogFeedback` is gated for the same reason.
    empty_marker = 'status === "ready" && rows.length === 0 && (0, react_jsx_runtime.jsxs)("div", {'
    if empty_marker not in src:
        raise SystemExit('empty state anchor not found')
    src = src.replace(empty_marker, 'statusFilter !== "plaza" && ' + empty_marker, 1)
    feedback_marker = 'selected === void 0 && (0, react_jsx_runtime.jsx)(CatalogFeedback, {'
    if feedback_marker in src:
        src = src.replace(feedback_marker, 'statusFilter !== "plaza" && ' + feedback_marker, 1)

    return src


def main() -> None:
    path = sys.argv[1]
    with open(path, encoding='utf-8') as handle:
        original = handle.read()
    patched = apply(original)
    if patched == original:
        print(f'{path}: already applied')
        return
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(patched)
    print(f'{path}: patched')


if __name__ == '__main__':
    main()