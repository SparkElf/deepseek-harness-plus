/**
 * Keep the DataOps `allow` approval policy after an upstream DSH base upgrade.
 *
 * The DataOps profile's danger-full-access preset intentionally uses `allow`: operations that
 * would ask are approved once, without a prompt (see runtime-daemon/src/dataops-dsh-embedded.patch.yml).
 * Upstream `dsh-user-approval` and `dsh-permission-presets` only know `ask` and `never`, so an
 * upgrade silently disables the permission row and leaves every approval-dependent plugin
 * pending. This restores the three small differences on every tree a workspace actually loads.
 *
 * It is deliberately an in-place patch rather than a package override:
 *   - the runtime tree (/opt/dsh-plus) and the profile tree are separate copies;
 *   - `prepare_profile()` may replace the profile after an image refresh;
 *   - a version-specific tarball would be skipped by the next compatible base.
 *
 * Usage: node patch-approval-allow.mjs <tree> [<tree>...]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const roots = process.argv.slice(2)
if (roots.length === 0) throw new Error('usage: node patch-approval-allow.mjs <tree>...')

const replaceOnce = (file, from, to, label) => {
  const before = readFileSync(file, 'utf8')
  if (!before.includes(from)) {
    if (!before.includes(to)) console.warn(label + ': anchor not found in ' + file)
    return false
  }
  writeFileSync(file, before.replace(from, to), 'utf8')
  return true
}

const patchUserApproval = (root) => {
  const file = join(root, 'node_modules/@deepseek-ai/dsh-user-approval/lib/index.js')
  if (!existsSync(file)) return false
  let changed = false
  // The array may be written across lines: insert "allow" before the closing bracket.
  {
    const before = readFileSync(file, 'utf8')
    if (!/APPROVAL_POLICIES\s*=\s*\[[^\]]*"allow"/.test(before) && /APPROVAL_POLICIES\s*=\s*\[/.test(before)) {
      const next = before.replace(/(APPROVAL_POLICIES\s*=\s*\[)([\s\S]*?)(\])/, (match, open, body, close) => {
        const trimmed = body.replace(/\s+$/, '')
        return open + trimmed + (trimmed.endsWith(',') ? '' : ',') + '\n\t"allow"\n' + close
      })
      writeFileSync(file, next, 'utf8')
      changed = true
    }
  }
  changed = replaceOnce(file, 'const APPROVAL_POLICIES = ["ask", "never"];', 'const APPROVAL_POLICIES = ["ask", "never", "allow"];', 'user-approval policies') || changed
  changed = replaceOnce(file, 'z$1.enum(["ask", "never"]).nullable()', 'z$1.enum(["ask", "never", "allow"]).nullable()', 'user-approval config') || changed
  changed = replaceOnce(file, 'z.union(["ask", "never"]).default("ask")', 'z.union(["ask", "never", "allow"]).default("ask")', 'user-approval default') || changed
  const errorText = 'approval policy must be one of "ask" or "never"'
  if (readFileSync(file, 'utf8').includes(errorText)) {
    writeFileSync(file, readFileSync(file, 'utf8').replace(errorText, 'approval policy must be one of "ask", "never" or "allow"'), 'utf8')
    changed = true
  }
  const notice = 'const POLICY_NOTICE_NAMES = {\n\task: "ask the user for approval",\n\tnever: "never ask the user for approval"\n};'
  if (readFileSync(file, 'utf8').includes(notice)) {
    writeFileSync(file, readFileSync(file, 'utf8').replace(notice, 'const POLICY_NOTICE_NAMES = {\n\task: "ask the user for approval",\n\tnever: "never ask the user for approval",\n\tallow: "approve operations automatically without a prompt"\n};'), 'utf8')
    changed = true
  }
  return changed
}

const patchPermissionPresets = (root) => {
  let changed = false
  for (const relative of ['node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js', 'node_modules/@deepseek-ai/dsh-permission-presets/lib/types/index.js']) {
    const file = join(root, relative)
    if (!existsSync(file)) continue
    const before = readFileSync(file, 'utf8')
    let next = before
    if (relative.endsWith('lib/index.js')) {
      next = next.replace('z$1.union([z$1.literal("ask"), z$1.literal("never")]).nullable()', 'z$1.union([z$1.literal("ask"), z$1.literal("never"), z$1.literal("allow")]).nullable()')
      next = next.replace('sandbox: "danger-full-access",\n\t\t\t\t\tapproval: "never"', 'sandbox: "danger-full-access",\n\t\t\t\t\tapproval: "allow"')
      next = next.replace('sandbox: "danger-full-access",\n    approval: "never"', 'sandbox: "danger-full-access",\n    approval: "allow"')
    } else {
      next = next.replace("zod.union([zod.literal('ask'), zod.literal('never')]).nullable()", "zod.union([zod.literal('ask'), zod.literal('never'), zod.literal('allow')]).nullable()")
      next = next.replace("sandbox: 'danger-full-access', approval: 'never'", "sandbox: 'danger-full-access', approval: 'allow'")
    }
    if (next === before) continue
    writeFileSync(file, next, 'utf8')
    changed = true
  }
  return changed
}

let patched = 0
let found = 0
for (const root of roots) {
  if (existsSync(join(root, 'node_modules/@deepseek-ai/dsh-user-approval/lib/index.js'))
    || existsSync(join(root, 'node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js'))) found += 1
  const user = patchUserApproval(root)
  const presets = patchPermissionPresets(root)
  if (user || presets) {
    patched += 1
    console.log('patch-approval-allow: ' + root)
  }
}
if (found === 0) throw new Error('patch-approval-allow: no approval package found in the requested trees')
console.log('patch-approval-allow: patched ' + patched + ' tree(s)')
