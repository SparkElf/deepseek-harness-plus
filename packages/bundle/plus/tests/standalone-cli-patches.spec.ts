import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The built command, because that is what an installation runs.
 *
 * These assertions cover the wiring the unit test cannot see: a start must reach the
 * patch step. Replacing that call with a no-op leaves the unit test green.
 */
const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const built = existsSync(bin)

/**
 * Lay out an npm installation whose distribution declares one npm patch.
 *
 * The command resolves the installation from its own file, so the fixture carries a
 * copy of the built library at the path npm would have created; a synthetic
 * \`@deepseek-ai/dsh\` beside it is what marks the installation root.
 * @returns the entry to run, the home to run with, and the file the patch changes.
 */
function launchableInstallation(): { entry: string; home: string; patched: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plus-cli-patch-'))
  const distribution = join(root, 'node_modules', '@sparkelf', 'dsh-plus')
  const patchPackage = join(distribution, 'node_modules', '@sparkelf', 'dsh-patch-demo')
  const home = join(root, 'home')
  // The profile links the consumer's node_modules rather than holding its own, so the
  // patched package lives where an npm installation would have put it.
  const target = join(root, 'node_modules', 'demo-target')

  mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  mkdirSync(join(patchPackage, 'patches'), { recursive: true })
  mkdirSync(target, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'consumer', private: true }))
  cpSync(dirname(bin), join(distribution, 'lib'), { recursive: true })
  // The built command imports its runtime dependencies; an npm installation carries
  // them in the same tree, so the fixture links the repository's copies rather than
  // reproducing a node_modules it does not own.
  mkdirSync(join(distribution, 'node_modules'), { recursive: true })
  for (const dependency of ['semver', 'yaml']) {
    symlinkSync(
      fileURLToPath(new URL('../../../../node_modules/' + dependency, import.meta.url)),
      join(distribution, 'node_modules', dependency),
      'dir',
    )
  }
  writeFileSync(join(distribution, 'package.json'), JSON.stringify({
    name: '@sparkelf/dsh-plus',
    version: '1.0.0',
    dshPlus: {
      patchPackages: ['@sparkelf/dsh-patch-demo'],
      // The installer reads the distribution's declared DSH compatibility
      // before it patches anything, so the fixture declares it too.
      compatibility: { dsh: '>=0.1.6-alpha.1' },
      profile: { bundles: [], dependencies: {}, allowBuilds: {} },
    },
  }))
  writeFileSync(join(patchPackage, 'package.json'), JSON.stringify({
    name: '@sparkelf/dsh-patch-demo',
    version: '1.0.0',
    dshPatch: {
      formatVersion: 1,
      variants: [{
        id: 'demo',
        dsh: '>=0.1.0',
        target: { kind: 'npm', name: 'demo-target', range: '1.0.0' },
        file: './patches/demo.patch',
      }],
    },
  }))
  const patched = join(target, 'index.js')
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'demo-target', version: '1.0.0' }))
  writeFileSync(patched, 'const value = "original"\n')
  writeFileSync(join(patchPackage, 'patches', 'demo.patch'), [
    'diff --git a/index.js b/index.js',
    '--- a/index.js',
    '+++ b/index.js',
    '@@ -1 +1 @@',
    '-const value = "original"',
    '+const value = "patched"',
    '',
  ].join('\n'))
  return { entry: join(distribution, 'lib', 'bin.js'), home, patched, root }
}

describe.skipIf(!built)('standalone start applies the declared npm patches', () => {
  it('patches the installed package before the server starts', { timeout: 60_000 }, async () => {
    // A standalone installation runs no apply step, so this path is the only owner the
    // npm half of a distribution's patch set has. Without it a published patch never
    // reaches the copy the launcher loads, which is how a fixed defect stayed broken
    // for every registry installation.
    const { entry, home, patched, root } = launchableInstallation()
    try {
      // The patch step runs before the server starts and the server then stays up, so
      // the child is stopped as soon as the line under test appears rather than waited
      // out; the assertion reads output produced before that point.
      const output = await new Promise<string>((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [entry, 'start', '--port', '0', '--no-open'], {
          cwd: dirname(entry),
          env: { ...process.env, DSH_HOME: home, HOME: home },
        })
        let text = ''
        const finish = (): void => {
          child.kill('SIGKILL')
          resolvePromise(text)
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          rejectPromise(new Error('the command did not reach the patch step: ' + text))
        }, 45_000)
        child.stdout.on('data', (chunk: Buffer) => {
          text += chunk.toString()
          if (text.includes('Applied the reviewed patch')) {
            clearTimeout(timer)
            finish()
          }
        })
        child.stderr.on('data', (chunk: Buffer) => { text += chunk.toString() })
        child.on('error', (error) => {
          clearTimeout(timer)
          rejectPromise(error)
        })
        child.on('exit', () => {
          clearTimeout(timer)
          resolvePromise(text)
        })
      })
      expect(output).toContain('Applied the reviewed patch @sparkelf/dsh-patch-demo')
      expect(readFileSync(patched, 'utf8')).toContain('patched')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
