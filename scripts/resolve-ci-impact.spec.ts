import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'resolve-ci-impact.mjs')

function classify(changes: Array<{ status: string; path: string }>): Record<string, unknown> {
  const result = spawnSync(process.execPath, [script, '--changes-json', JSON.stringify(changes)], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  const plan: unknown = JSON.parse(result.stdout)
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) throw new TypeError('CI impact plan must be an object')
  return plan as Record<string, unknown>
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('PR CI impact resolver', () => {
  it('skips expensive jobs for documentation-only changes', () => {
    expect(classify([
      { status: 'M', path: 'docs/testing.md' },
      { status: 'A', path: '.agents/notes/implemented/process/example.i18n.yaml' },
    ])).toMatchObject({ mode: 'docs', coverage: 'skip', consumers: 'skip', nodeCompat: false, python: false, windows: false })
  })

  it('selects incremental coverage and reviewed Web cases for one mapped client package', () => {
    expect(classify([
      { status: 'M', path: 'packages/client/ui-goal/src/client/GoalBar.tsx' },
      { status: 'M', path: 'packages/client/ui-goal/tests/goal.client.spec.tsx' },
      { status: 'A', path: '.agents/notes/implemented/feature/goal.md' },
    ])).toMatchObject({
      mode: 'client',
      coverage: 'incremental',
      consumers: 'web',
      webTests: [
        'apps/web/tests/goal-bar.e2e.ts',
        'apps/web/tests/goal-command-presentation.e2e.ts',
        'apps/web/tests/goal-multi-turn-actions.e2e.ts',
      ],
    })
  })

  it('runs changed unit tests for a mapped non-TypeScript test fixture', () => {
    expect(classify([{ status: 'M', path: 'packages/client/ui-goal/tests/fixtures/goal.json' }])).toMatchObject({
      mode: 'client',
      coverage: 'incremental',
      consumers: 'web',
    })
  })

  it('runs an explicitly changed Web case without unrelated browser cases', () => {
    expect(classify([{ status: 'M', path: 'apps/web/tests/goal-bar.e2e.ts' }])).toMatchObject({
      mode: 'client',
      coverage: 'skip',
      consumers: 'web',
      webTests: ['apps/web/tests/goal-bar.e2e.ts'],
    })
  })

  it.each([
    ['unmapped client package', [{ status: 'M', path: 'packages/client/ui-sidebar/src/client/Sidebar.tsx' }]],
    ['client manifest', [{ status: 'M', path: 'packages/client/ui-sidebar/package.json' }]],
    ['deleted client source', [{ status: 'D', path: 'packages/client/ui-goal/src/client/GoalBar.tsx' }]],
    ['deleted documentation', [{ status: 'D', path: 'docs/testing.md' }]],
    ['Markdown test fixture outside a reviewed package', [{ status: 'M', path: 'packages/client/ui-sidebar/tests/fixtures/prompt.md' }]],
    ['shared runtime package', [{ status: 'M', path: 'packages/core/agent-loop/src/index.ts' }]],
    ['CI implementation', [{ status: 'M', path: '.github/workflows/ci.yml' }]],
    ['mixed client and host paths', [
      { status: 'M', path: 'packages/client/ui-goal/src/client/GoalBar.tsx' },
      { status: 'M', path: 'packages/host/webserver/src/index.ts' },
    ]],
  ] as const)('fails open to the full matrix for %s', (_label, changes) => {
    expect(classify([...changes])).toMatchObject({ mode: 'full', coverage: 'full', consumers: 'full', nodeCompat: true, python: true, windows: true })
  })

  it('reads the real merge-base name-status stream and writes GitHub outputs', () => {
    const repository = mkdtempSync(join(tmpdir(), 'dsh-ci-impact-'))
    try {
      git(repository, ['init'])
      git(repository, ['config', 'user.email', 'ci-impact@example.invalid'])
      git(repository, ['config', 'user.name', 'CI Impact'])
      mkdirSync(join(repository, 'docs'))
      writeFileSync(join(repository, 'docs', 'guide.md'), 'first\n')
      git(repository, ['add', '.'])
      git(repository, ['commit', '-m', 'base'])
      const base = git(repository, ['rev-parse', 'HEAD'])
      writeFileSync(join(repository, 'docs', 'guide.md'), 'second\n')
      git(repository, ['add', '.'])
      git(repository, ['commit', '-m', 'head'])
      const head = git(repository, ['rev-parse', 'HEAD'])
      const githubOutput = join(repository, 'github-output')

      const result = spawnSync(process.execPath, [
        script,
        '--base', base,
        '--head', head,
        '--github-output', githubOutput,
      ], { cwd: repository, encoding: 'utf8' })

      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'docs', mergeBase: base, changedCount: 1 })
      expect(readFileSync(githubOutput, 'utf8')).toContain('mode=docs\ncoverage=skip\n')

      const forced = spawnSync(process.execPath, [script, '--base', base, '--head', head, '--force-full'], {
        cwd: repository,
        encoding: 'utf8',
      })
      expect(forced.status).toBe(0)
      expect(JSON.parse(forced.stdout)).toMatchObject({ mode: 'full', mergeBase: base, reason: 'forced complete matrix' })
    } finally {
      rmSync(repository, { recursive: true, force: true })
    }
  })

  it('rejects malformed change records at the CLI boundary', () => {
    const result = spawnSync(process.execPath, [script, '--changes-json', JSON.stringify([{ status: 'M', path: '/absolute' }])], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('invalid repository-relative path')
  })
})
