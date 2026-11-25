import { describe, expect, it } from 'vitest'
import {
  displayToolName,
  toolProgressFromUpdate,
  toolProgressPhase,
  toolProgressText,
} from '../../src/connector/tool-progress.ts'

describe('tool progress mapping', () => {
  it('maps known tool families to fixed Chinese phases', () => {
    expect(toolProgressText('list_resources')).toBe('正在查询数据资源')
    expect(toolProgressText('mcp__data-query__data_query')).toBe('正在查询数据资源')
    expect(toolProgressText('execute_sql')).toBe('正在执行 SQL')
    expect(toolProgressText('sql_query')).toBe('正在执行 SQL')
    expect(toolProgressText('kb_search')).toBe('正在检索知识库')
    expect(toolProgressText('memory_context')).toBe('正在检索知识库')
    expect(toolProgressText('officecli')).toBe('正在处理文档')
    expect(toolProgressText('pdf_extract')).toBe('正在处理文档')
  })

  it('shows the sanitized actual tool name for unknown tools', () => {
    expect(displayToolName('mcp__browser-bridge__browser_navigate')).toBe('browser_navigate')
    expect(toolProgressText('mcp__browser-bridge__browser_navigate')).toBe('正在调用 browser_navigate')
    expect(toolProgressText('some_custom_tool')).toBe('正在调用 some_custom_tool')
    expect(displayToolName('  mcp__server__a_very_long_tool_name_that_exceeds_forty_chars_12345  ')).toHaveLength(40)
    expect(toolProgressText('')).toBe('正在调用 工具')
  })

  it('ignores arguments, results, paths and ids', () => {
    const update = {
      type: 'tool',
      name: 'mcp__data-query__data_query',
      arguments: '{"sql":"select * from secret_table","path":"/workspace/x"}',
      callId: 'call-123',
      text: 'secret result',
    }
    expect(toolProgressFromUpdate(update)).toBe('正在查询数据资源')
    expect(toolProgressFromUpdate({ type: 'tool-result', toolName: 'x', text: 'secret' })).toBeUndefined()
    expect(toolProgressFromUpdate({ type: 'assistant-message', text: 'secret' })).toBeUndefined()
  })

  it('keeps phase classification stable for case and separators', () => {
    expect(toolProgressPhase('SQL_QUERY')).toBe('sql')
    expect(toolProgressPhase('Kb_File')).toBe('knowledge')
    expect(toolProgressPhase('unknown')).toBe('tool')
  })
})
