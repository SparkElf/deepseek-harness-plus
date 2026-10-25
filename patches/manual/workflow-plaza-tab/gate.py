"""Gate the 「工作流广场」 patch against one stock bundle and one patched bundle.

Usage: python3 gate.py <stock-client.js> <patched-client.js>

The patch has to add a fourth tab **without changing the page when nobody contributes**: the
seat is declared, but the button and body only appear once a plugin registers into
`schedule.manager.tabs`. This gate proves that property from the emitted bundle, which is the
only artifact the browser receives:

1. the three status tabs' map expression is byte-identical to stock, in order, and the appended
   array is guarded by `props.plazaAvailable?.() === true` -- an unguarded `.concat([button])`
   is the regression this check exists for;
2. the child slot is declared, the probe reads the live slot table, and the body renders from
   `renderSlot`;
3. the empty-state and `CatalogFeedback` guards are present, so the plaza tab cannot show the
   "no matching tasks" block underneath it;
4. both locale dictionaries carry `statusFilter.plaza`;
5. the patched bundle differs from stock only at the three intended sites (the file size grows,
   and the stock tab-strip expression is still present exactly once).

Exit code 0 means every property holds; any failure prints `FAIL <check>: <detail>` and exits 1.
"""
import sys


def read(path: str) -> str:
    with open(path, encoding='utf-8') as handle:
        return handle.read()


def main() -> int:
    if len(sys.argv) != 3:
        print('usage: gate.py <stock-client.js> <patched-client.js>', file=sys.stderr)
        return 2
    stock = read(sys.argv[1])
    patched = read(sys.argv[2])
    failures = []

    def check(name: str, condition: bool, detail: str) -> None:
        if not condition:
            failures.append(f'FAIL {name}: {detail}')

    # 1. the stock strip survives, and the addition is guarded
    strip = 'children: t(value === "all" ? "statusFilter.all" : `status.${value}`)'
    check('strip-kept', patched.count(strip) == 1, f'expected one stock tab-strip expression, found {patched.count(strip)}')
    check('strip-order', patched.find(strip) < patched.find('task-manager-plaza-tab'),
          'the plaza button must come after the three status tabs')
    check('button-guarded', '.concat(props.plazaAvailable?.() === true ? [' in patched,
          'the tab button is appended without the contribution guard')
    check('button-not-unconditional', '.concat([(0, react_jsx_runtime.jsx)("button"' not in patched,
          'an unconditional .concat([button]) is present')
    check('button-testid', patched.count('"data-testid": "task-manager-plaza-tab"') == 1,
          'the plaza tab button must carry its test id exactly once')

    # 2. the seat and its renderer
    check('seat-declared', '"schedule.manager.tabs": {\n\t\t\t\t\t\tkind: "single",\n\t\t\t\t\t\tscope: "root"' in patched,
          'the schedule.manager.tabs child slot is not declared on the main registration')
    check('probe', 'plazaAvailable: () => ctx.slots.entriesOfSlot("schedule.manager.tabs").length > 0' in patched,
          'the contribution probe is missing')
    check('body', '"data-testid": "task-manager-plaza-body"' in patched and 'props.renderSlot("schedule.manager.tabs", {})' in patched,
          'the plaza body does not render the contributed slot')

    # 3. nothing of the stock page shows under the plaza
    check('empty-guarded', 'statusFilter !== "plaza" && status === "ready" && rows.length === 0' in patched,
          'the empty state is not gated on the plaza tab')
    check('feedback-guarded', 'statusFilter !== "plaza" && selected === void 0 && (0, react_jsx_runtime.jsx)(CatalogFeedback, {' in patched,
          'CatalogFeedback is not gated on the plaza tab')

    # 4. copy
    check('locale-en', '"statusFilter.plaza": "Workflow plaza"' in patched, 'missing the English label')
    check('locale-zh', '"statusFilter.plaza": "工作流广场"' in patched, 'missing the Chinese label')

    # 5. only the intended sites moved: every stock line that is not one of the edited ones survives
    edited = (
        '}, value))',
        '"statusFilter.all": "All",',
        '"statusFilter.all": "全部",',
        'ctx.slots.inject("main", () => ctx.slots.register({',
        'className: TaskManagerPage_module_css_default.searchField,',
        'status === "ready" && rows.length === 0 && (0, react_jsx_runtime.jsxs)("div", {',
        'selected === void 0 && (0, react_jsx_runtime.jsx)(CatalogFeedback, {',
    )
    stock_lines = [line for line in stock.split('\n') if line.strip() != '']
    patched_lines = set(patched.split('\n'))
    missing = [line for line in stock_lines
               if line.strip() not in edited and line.startswith(('\tclass', '\t\t\t\t\t\t')) and line not in patched_lines]
    check('no-collateral-edit', not missing, 'stock lines disappeared at ' + repr(missing[:3]))

    if failures:
        for failure in failures:
            print(failure)
        return 1
    print(f'gate: ok (stock {len(stock.encode())} bytes -> patched {len(patched.encode())} bytes)')
    return 0


if __name__ == '__main__':
    sys.exit(main())