/**
 * Collection-tool contract after moving plan generation into the current model.
 *
 * The model writes the plan itself; DataOps only validates and executes. These cases pin the
 * tool surface: no `dataops_collect_plan`, no `model_id` parameter, a validate tool that calls
 * `/validate-plan` and returns the normalized plan verbatim, and an execute description that
 * points at validation rather than at a removed plan tool.
 *
 * @module tests/collect-tools.test
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { buildAiManagementTools } from '../src/tools.ts'
import type { DataOpsScope } from '../src/tool-scope.ts'

const SCOPE: DataOpsScope = {
  userId: 'u1',
  roleCodes: ['应用人员'],
  primaryRole: '应用人员',
  permissions: ['data:resource:manage'],
}

const exec = {
  agent: { session: { id: 'session-1' } },
  callId: 'call-1',
  signal: new AbortController().signal,
}

type Route = { status: number; body: unknown }

function setup(routes: Record<string, Route> = {}) {
  const calls: Array<{ path: string; method: string; body?: string }> = []
  const api = {
    request: async (path: string, init: RequestInit = {}) => {
      calls.push({
        path,
        method: init.method ?? 'GET',
        ...(typeof init.body === 'string' ? { body: init.body } : {}),
      })
      return routes[path] ?? { status: 404, body: { error: 'not found' } }
    },
  }
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    approval: { request: async () => 'allowed-once' },
  }
  const tools = buildAiManagementTools(
    ctx as never,
    api as never,
    () => SCOPE,
    { broadcast: () => ({}) } as never,
  )
  return { tools, byName: new Map(tools.map((tool) => [tool.name, tool.definition])), calls }
}

const parameterNames = (definition: { parameters: Record<string, unknown> }): string[] => {
  const properties = (definition.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  return Object.keys(properties)
}

describe('collect tool surface', () => {
  it('replaces the plan tool with validate_plan and removes preview model_id', () => {
    const { tools, byName } = setup()
    const names = tools.map((tool) => tool.name)

    expect(names).not.toContain('dataops_collect_plan')
    expect(names).toContain('dataops_collect_validate_plan')
    expect(parameterNames(byName.get('dataops_collect_preview')!)).toEqual(['file_path'])
    expect(parameterNames(byName.get('dataops_collect_validate_plan')!)).toEqual([
      'session_id',
      'data_source_urn',
      'target_schema',
      'target_table',
      'create_plan_json',
      'mappings_json',
    ])
    // The validate tool is model-free; an optional model id must not come back through it.
    expect(JSON.stringify(byName.get('dataops_collect_validate_plan')!.parameters)).not.toMatch(/model_id|modelId/iu)
  })

  it('tells execute to use the validated plan instead of a plan tool', () => {
    const { byName } = setup()
    const execute = byName.get('dataops_collect_execute')!
    expect(execute.description).toContain('dataops_collect_validate_plan')
    expect(execute.description).not.toContain('dataops_collect_plan')
    expect(JSON.stringify(execute.parameters)).not.toMatch(/dataops_collect_plan/u)
  })

  it('posts a model-written create plan to validate-plan and returns the normalized plan', async () => {
    const { byName, calls } = setup({
      '/api/resources/spreadsheet-import/validate-plan': {
        status: 200,
        body: {
          success: true,
          session: { sessionId: 's1' },
          plan: { mode: 'CREATE_TABLE', createTable: { tableName: 'customer_sales' }, createSql: 'CREATE TABLE ...' },
        },
      },
    })
    const validate = byName.get('dataops_collect_validate_plan')!

    const result = await validate.execute({
      session_id: 's1',
      data_source_urn: 'data-source:6',
      create_plan_json: JSON.stringify({
        tableName: 'customer_sales',
        tableChineseName: '客户销售',
        columns: [{ sourceKey: 'c1', name: 'customer_name', chineseName: '客户名称', dataType: 'TEXT' }],
      }),
    }, exec) as { plan: { mode: string } }

    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe('/api/resources/spreadsheet-import/validate-plan')
    expect(calls[0]?.method).toBe('POST')
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>
    expect(body.sessionId).toBe('s1')
    expect(body.dataSourceUrn).toBe('data-source:6')
    expect(body.createPlan).toMatchObject({ tableName: 'customer_sales' })
    expect(body).not.toHaveProperty('modelId')
    expect(body).not.toHaveProperty('model_id')
    expect(result.plan.mode).toBe('CREATE_TABLE')
    expect(result).not.toHaveProperty('model')
  })

  it('posts an existing-table mapping with targetTable and mappings', async () => {
    const { byName, calls } = setup({
      '/api/resources/spreadsheet-import/validate-plan': {
        status: 200,
        body: { success: true, session: {}, plan: { mode: 'EXISTING_TABLE', mappings: [] } },
      },
    })
    const validate = byName.get('dataops_collect_validate_plan')!

    await validate.execute({
      session_id: 's1',
      data_source_urn: 'data-source:6',
      target_schema: 'wanxiang_demo',
      target_table: 'customer_sales',
      mappings_json: '[{"sourceKey":"c1","targetColumn":"customer_name","confidence":"HIGH","targetDataType":"text"}]',
    }, exec)

    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>
    expect(body.targetTable).toEqual({ schema: 'wanxiang_demo', table: 'customer_sales' })
    expect(body.mappings).toEqual([{ sourceKey: 'c1', targetColumn: 'customer_name' }])
    expect(body).not.toHaveProperty('createPlan')
  })

  it('rejects shapes the backend would reject, before any request', async () => {
    const { byName, calls } = setup()
    const validate = byName.get('dataops_collect_validate_plan')!

    await expect(validate.execute({ session_id: 's1' }, exec)).rejects.toThrow(/create_plan_json is required/u)
    await expect(validate.execute({
      session_id: 's1',
      target_table: 'customer_sales',
      mappings_json: '[{"sourceKey":"c1","targetColumn":"customer_name"}]',
    }, exec)).rejects.toThrow(/target_schema is required/u)
    await expect(validate.execute({
      session_id: 's1',
      target_schema: 'wanxiang_demo',
      target_table: 'customer_sales',
    }, exec)).rejects.toThrow(/mappings_json is required/u)
    await expect(validate.execute({
      session_id: 's1',
      target_schema: 'wanxiang_demo',
      target_table: 'customer_sales',
      mappings_json: '[{"sourceKey":"c1"}]',
    }, exec)).rejects.toThrow(/mappings_json\[0\] needs sourceKey and targetColumn/u)
    expect(calls).toHaveLength(0)
  })
})

describe('collect skill document', () => {
  it('links the three reference files instead of inlining them', async () => {
    const skill = await readFile(new URL('../skills/dataops-collect/SKILL.md', import.meta.url), 'utf8')
    for (const name of ['plan-schema', 'append', 'execution']) {
      expect(skill).toContain(`references/${name}.md`)
      const reference = await readFile(
        new URL(`../skills/dataops-collect/references/${name}.md`, import.meta.url),
        'utf8',
      )
      expect(reference.length).toBeGreaterThan(500)
    }
    // The removed shared-model path must not creep back into the instructions.
    expect(skill).not.toContain('dataops_collect_plan')
    expect(skill).not.toMatch(/model_id|共享 AI 模型/u)
  })

  it('reads append target columns through the DataOps MCP resource tools', async () => {
    const append = await readFile(
      new URL('../skills/dataops-collect/references/append.md', import.meta.url),
      'utf8',
    )
    expect(append).toContain('mcp__dataops__search_resources')
    expect(append).toContain('mcp__dataops__describe_resource')
    expect(append).toContain('resourceRefs')
    expect(append).toContain('include: ["columns", "execution"]')
    // Guessing target columns is the failure this reference exists to prevent.
    expect(append).toMatch(/禁止.*猜|不要猜/u)
  })
})
describe('collect execute business domain', () => {
  it('passes model-inferred business domain metadata to DataOps', async () => {
    const { byName, calls } = setup({
      '/api/resources/spreadsheet-import/execute': {
        status: 200,
        body: { success: true, importedRows: 3, resource: { id: 9, urn: 'resource:9' } },
      },
    })
    const execute = byName.get('dataops_collect_execute')!

    await execute.execute({
      session_id: 's1',
      data_source_urn: 'data-source:6',
      mode: 'CREATE_TABLE',
      create_plan_json: JSON.stringify({
        tableName: 'finance_orders',
        tableChineseName: '财务订单',
        columns: [{ sourceKey: 'c1', name: 'amount', chineseName: '金额', dataType: 'DECIMAL' }],
      }),
      mappings_json: '[]',
      resource_name: '财务订单',
      business_domain: '财务域',
      domain_inference_source: 'MODEL',
      domain_inference_confidence: 'HIGH',
    }, exec)

    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>
    expect(body.businessDomain).toBe('财务域')
    expect(body.domainInferenceSource).toBe('MODEL')
    expect(body.domainInferenceConfidence).toBe('HIGH')
  })
})

describe('collect execute overwrite mode', () => {
  it('requires explicit confirmation and sends confirmOverwrite', async () => {
    const { byName } = setup({
      '/api/resources/spreadsheet-import/execute': { status: 200, body: { success: true, importedRows: 2, resource: { id: 1 } } },
    })
    const execute = byName.get('dataops_collect_execute')!
    await expect(execute.execute({
      session_id: 's1', data_source_urn: 'data-source:6', mode: 'OVERWRITE_TABLE',
      target_schema: 'public', target_table: 't', mappings_json: '[]',
    }, exec)).rejects.toThrow(/confirm_overwrite/u)
  })
})
