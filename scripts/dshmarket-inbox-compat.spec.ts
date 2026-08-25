import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

interface RegistryPlugin {
  name: string
  owner: string
  category: string | string[]
  description: Record<string, string>
  npm?: string | null
}

interface MarketDataApi {
  installedForCatalog: (
    installed: Record<string, string>,
    bundles: readonly string[],
  ) => Record<string, string>
  pluginCategories: (plugin: RegistryPlugin) => string[]
  visiblePlugins: (
    plugins: RegistryPlugin[],
    options: {
      category: string
      query: string
      lang: string
      categories?: Record<string, Record<string, string>>
      sort: string
    },
  ) => RegistryPlugin[]
}

const require = createRequire(import.meta.url)
const marketManifest = require.resolve('dshmarket/package.json', {
  paths: [resolve(import.meta.dirname, '../packages/bundle/web-app')],
})
const market = await import(
  pathToFileURL(join(dirname(marketManifest), 'src/client/market-data.ts')).href,
) as MarketDataApi

it('projects installation-provided bundles into catalog matching only', () => {
  const managed = { local: '^1.0.0', shared: 'workspace:*' }

  expect(market.installedForCatalog(managed, ['dsh-better-sidebar', 'shared'])).toEqual({
    'dsh-better-sidebar': '*',
    shared: 'workspace:*',
    local: '^1.0.0',
  })
  expect(managed).toEqual({ local: '^1.0.0', shared: 'workspace:*' })
})

it('keeps the released multi-category normalization, filtering, and label search', () => {
  const plugin: RegistryPlugin = {
    name: 'dsh-skills',
    owner: 'example',
    category: ['tool', 'skill', 'skill'],
    description: { en: 'Reusable prompts' },
  }
  const options = {
    category: 'skill',
    query: '技能包',
    lang: 'en',
    categories: { skill: { en: 'Skills', zh: '技能包' } },
    sort: 'registry',
  }

  expect(market.pluginCategories(plugin)).toEqual(['tool', 'skill'])
  expect(market.visiblePlugins([plugin], options)).toEqual([plugin])
})
