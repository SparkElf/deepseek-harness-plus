import ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'

const HOOKS = new Set(['useState','useEffect','useMemo','useRef','useCallback','useReducer','useLayoutEffect'])

/** Does this function return JSX anywhere (i.e. is it a component)? */
function returnsJsx(fn) {
  let found = false
  const visit = (n) => {
    if (ts.isReturnStatement(n) && n.expression) {
      let e = n.expression
      while (ts.isParenthesizedExpression(e)) e = e.expression
      if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) found = true
    }
    ts.forEachChild(n, visit)
  }
  visit(fn)
  return found
}

/** Collect hook calls that are NOT inside a nested function (so the component's own). */
function componentLevelHooks(fn) {
  const hooks = []
  const visit = (n, depth) => {
    if (depth > 0 && (ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isFunctionDeclaration(n))) return
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && HOOKS.has(n.expression.text)) {
      hooks.push({ name: n.expression.text, pos: n.getStart() })
    }
    ts.forEachChild(n, c => visit(c, depth + (ts.isFunctionLike(n) ? 1 : 0)))
  }
  if (fn.body) ts.forEachChild(fn.body, c => visit(c, 0))
  return hooks
}

/** All `return` statements reachable without entering a nested function. */
function componentLevelReturns(fn) {
  const returns = []
  const visit = (n) => {
    if (ts.isFunctionLike(n) && n !== fn) return
    if (ts.isReturnStatement(n)) returns.push(n.getStart())
    ts.forEachChild(n, visit)
  }
  if (fn.body) ts.forEachChild(fn.body, c => visit(c))
  return returns
}

let bad = 0
for (const file of readdirSync('src/client')) {
  if (!file.endsWith('.tsx')) continue
  const path = `src/client/${file}`
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  ts.forEachChild(sf, (node) => {
    if (!ts.isFunctionDeclaration(node) || !node.name) return
    if (!/^[A-Z]/.test(node.name.text)) return
    if (!returnsJsx(node)) return
    const returns = componentLevelReturns(node).sort((a,b)=>a-b)
    if (!returns.length) return
    const firstExit = returns[0]
    const after = componentLevelHooks(node).filter(h => h.pos > firstExit)
    if (after.length) {
      bad++
      const line = sf.getLineAndCharacterOfPosition(after[0].pos).line + 1
      console.log(`  ❌ ${file} ${node.name.text}: ${after[0].name} 在第一个 return 之后 (行 ${line})`)
    }
  })
}
if (!bad) console.log('  ✅ 所有组件：hook 都在第一个 return 之前')
