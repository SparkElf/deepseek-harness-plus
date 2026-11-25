import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// The recovery prompt is prose the model obeys, so it stays a literal in the Host entry.
const promptSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const prompt = /const SUPERVISOR_RECOVERY_PROMPT = '([^']*)'/.exec(promptSource)?.[1]

test('recovery prompt re-arms a paused goal before resuming work', () => {
  assert.ok(prompt, 'SUPERVISOR_RECOVERY_PROMPT must stay one single-quoted literal in src/index.ts')
  assert.match(prompt, /若本会话存在目标（goal），先把已暂停的目标重新设置为执行/)
})

test('recovery prompt keeps the established recovery instructions', () => {
  assert.ok(prompt, 'SUPERVISOR_RECOVERY_PROMPT must stay one single-quoted literal in src/index.ts')
  for (const phrase of ['先确认已完成的操作', '避免重复执行', '继续完成剩余任务', '若原任务已经全部完成，回复“已完成”']) {
    assert.ok(prompt.includes(phrase), 'recovery prompt must keep: ' + phrase)
  }
})
