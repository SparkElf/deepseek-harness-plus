import { describe, expect, it, vi } from 'vitest'
import {
  WORKFLOW_MODEL_STORAGE_KEY,
  findModelOption,
  initialModelOption,
  modelKeyOf,
  readRememberedModel,
  rememberModel,
  toWorkflowModelCatalog,
} from '../src/client/workflows/modelChoice.ts'

const RAW = {
  default: { provider: 'dashscope', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'max' },
  groups: [
    {
      id: 'dashscope',
      name: 'DashScope',
      models: [
        {
          id: 'deepseek-v4.1-flash-1017',
          name: 'DeepSeek V4.1 Flash 1017',
          description: 'fast',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' },
        },
        { id: 'qwen', name: 'Qwen' },
      ],
    },
    { id: 'tokensfree', name: 'TokensFree', models: [{ id: 'free', name: 'Free' }] },
  ],
  failures: [{ id: 'broken', name: 'Broken', message: 'catalog down' }],
}

describe('workflow model catalog', () => {
  it('maps provider groups, display names, reasoning efforts and failures', () => {
    const view = toWorkflowModelCatalog(RAW as never)
    expect(view.default).toEqual(RAW.default)
    expect(view.groups.map(group => group.providerName)).toEqual(['DashScope', 'TokensFree'])
    expect(view.groups[0]?.models[0]).toMatchObject({
      key: modelKeyOf({ provider: 'dashscope', model: 'deepseek-v4.1-flash-1017' }),
      providerName: 'DashScope',
      modelName: 'DeepSeek V4.1 Flash 1017',
      description: 'fast',
      reasoningEfforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }],
      defaultEffort: 'max',
    })
    expect(view.failures).toEqual([{ provider: 'broken', message: 'catalog down' }])
  })

  it('returns an empty catalog for an unavailable Host catalog', () => {
    expect(toWorkflowModelCatalog(undefined)).toEqual({ groups: [], failures: [] })
  })

  it('finds a model by provider+model key', () => {
    const view = toWorkflowModelCatalog(RAW as never)
    expect(findModelOption(view, modelKeyOf({ provider: 'tokensfree', model: 'free' }))?.modelName).toBe('Free')
    expect(findModelOption(view, modelKeyOf({ provider: 'gone', model: 'x' }))).toBeUndefined()
  })

  it('prefers the workspace default over a remembered model', () => {
    const view = toWorkflowModelCatalog(RAW as never)
    // The regression: a remembered tokensfree route must not override dashscope default.
    expect(initialModelOption(view, { provider: 'tokensfree', model: 'free' })?.provider).toBe('dashscope')
    expect(initialModelOption(view, { provider: 'dashscope', model: 'qwen' })?.model).toBe('deepseek-v4.1-flash-1017')
    expect(initialModelOption(view, undefined)?.model).toBe('deepseek-v4.1-flash-1017')
  })

  it('falls back to a usable remembered model when the default is absent or bad', () => {
    const withoutDefault = toWorkflowModelCatalog({ groups: RAW.groups } as never)
    expect(initialModelOption(withoutDefault, { provider: 'dashscope', model: 'qwen' })?.model).toBe('qwen')
    const badDefault = toWorkflowModelCatalog({
      default: { provider: 'tokensfree', model: 'free' },
      groups: RAW.groups,
    } as never)
    expect(initialModelOption(badDefault, { provider: 'dashscope', model: 'qwen' })?.model).toBe('qwen')
    expect(initialModelOption({ groups: [], failures: [] }, { provider: 'x', model: 'y' })).toBeUndefined()
  })

  it('never chooses a remembered tokensfree route when a usable model exists', () => {
    const withoutDefault = toWorkflowModelCatalog({ groups: RAW.groups } as never)
    expect(initialModelOption(withoutDefault, { provider: 'tokensfree', model: 'free' })?.provider).toBe('dashscope')
    expect(initialModelOption(withoutDefault, undefined)?.provider).toBe('dashscope')
  })

  it('remembers and restores a selection through storage', () => {
    const storage = new Map<string, string>()
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    }
    const selection = { provider: 'dashscope', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'max' }
    rememberModel(selection, adapter)
    expect(storage.get(WORKFLOW_MODEL_STORAGE_KEY)).toBe(JSON.stringify(selection))
    expect(readRememberedModel(adapter)).toEqual(selection)
  })

  it('ignores malformed or incomplete stored values', () => {
    const adapter = (value: string) => ({ getItem: () => value })
    expect(readRememberedModel(adapter('{'))).toBeUndefined()
    expect(readRememberedModel(adapter('{"provider":"","model":"x"}'))).toBeUndefined()
    expect(readRememberedModel(adapter('{"provider":"p","model":""}'))).toBeUndefined()
  })

  it('never throws when storage is unavailable', () => {
    const broken = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(readRememberedModel(broken)).toBeUndefined()
    expect(() => rememberModel({ provider: 'p', model: 'm' }, broken)).not.toThrow()
  })

  it('uses localStorage when no explicit storage is passed', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
    })
    try {
      rememberModel({ provider: 'p', model: 'm' })
      expect(readRememberedModel()).toEqual({ provider: 'p', model: 'm' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
