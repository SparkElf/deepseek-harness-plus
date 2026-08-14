/**
 * Search provider that follows the provider and model selected for the current agent.
 * The first supported route is OpenAI Responses with the built-in web search tool.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent-default-model'

/** Provider id used by the web seam for the current model route. */
export const CURRENT_MODEL_PROVIDER_ID = 'current-model'

interface RouteProfile {
  api?: string
  baseURL?: string
  apiKeyEnv?: string
}

interface ResponseAnnotation {
  type?: unknown
  url?: unknown
  title?: unknown
}

interface ResponseContent {
  type?: unknown
  text?: unknown
  annotations?: unknown
}

interface ResponseOutputItem {
  type?: unknown
  text?: unknown
  content?: unknown
}

interface ResponsesPayload {
  output?: unknown
  output_text?: unknown
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function selectionOf(ctx: Context): ModelSelection | undefined {
  const agent = ctx.get('agents')?.currentInitiator()
  const provider = agent?.options.provider
  const model = agent?.options.model
  if (provider !== undefined && model !== undefined) return { provider, model }
  return ctx.get('agentDefaultModel')?.currentSelection()
}

function routeOf(ctx: Context, selection: ModelSelection): RouteProfile | undefined {
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  const descriptor = settings.describe({ redactSecrets: true })
    .find((entry: SettingsDescriptor) => String(entry.ns) === 'llm-pi-ai')
  const value = recordOf(descriptor?.value)
  const providers = recordOf(value?.providers)
  const profile = recordOf(providers?.[selection.provider])
  if (profile === undefined) return undefined
  return {
    ...typeof profile.api === 'string' ? { api: profile.api } : {},
    ...typeof profile.baseURL === 'string' ? { baseURL: profile.baseURL } : {},
    ...typeof profile.apiKeyEnv === 'string' ? { apiKeyEnv: profile.apiKeyEnv } : {},
  }
}

function currentRoute(ctx: Context): { selection: ModelSelection; profile: RouteProfile } | undefined {
  const selection = selectionOf(ctx)
  if (selection === undefined) return undefined
  const profile = routeOf(ctx, selection)
  return profile === undefined ? undefined : { selection, profile }
}

function endpoint(baseURL: string): string {
  return baseURL.replace(/\/+$/u, '') + '/responses'
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function responseSources(output: readonly ResponseOutputItem[]): { answer: string | undefined; sources: WebSearchSource[] } {
  const answer: string[] = []
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const item of output) {
    const itemType = stringValue(item.type)
    if (itemType !== 'message') continue
    const content = Array.isArray(item.content) ? item.content as ResponseContent[] : []
    for (const part of content) {
      if (stringValue(part.type) !== 'output_text') continue
      const text = stringValue(part.text)
      if (text !== undefined) answer.push(text)
      const annotations = Array.isArray(part.annotations) ? part.annotations as ResponseAnnotation[] : []
      for (const annotation of annotations) {
        if (stringValue(annotation.type) !== 'url_citation') continue
        const url = stringValue(annotation.url)
        if (url === undefined || seen.has(url)) continue
        seen.add(url)
        const title = stringValue(annotation.title)
        sources.push({ url, ...title === undefined ? {} : { title } })
      }
    }
  }
  return { answer: answer.length === 0 ? undefined : answer.join('\n'), sources }
}

/** OpenAI Responses search provider bound to the selected provider/model route. */
export class CurrentModelSearchProvider implements WebSearchProvider {
  readonly id = CURRENT_MODEL_PROVIDER_ID

  constructor(private readonly ctx: Context) {}

  available(): boolean {
    const route = currentRoute(this.ctx)
    return route?.profile.api === 'openai-responses' && route.profile.baseURL !== undefined
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const route = currentRoute(this.ctx)
    if (route === undefined) {
      throw new WebError('the current provider/model route is unavailable', 'WEB_PROVIDER_UNAVAILABLE')
    }
    if (route.profile.api !== 'openai-responses' || route.profile.baseURL === undefined) {
      throw new WebError('the current provider uses no supported Responses web-search protocol', 'WEB_PROVIDER_UNSUPPORTED')
    }
    const apiKeyEnv = stringValue(route.profile.apiKeyEnv)
    if (apiKeyEnv === undefined) {
      throw new WebError('the current provider has no credential reference', 'WEB_PROVIDER_CREDENTIAL_MISSING')
    }
    const credentials = this.ctx.get('credentials')
    const resolved = credentials === undefined
      ? undefined
      : await credentials.resolve(credentialRef(apiKeyEnv))
    if (resolved === undefined) {
      throw new WebError('the current provider credential is not configured', 'WEB_PROVIDER_CREDENTIAL_MISSING')
    }
    const response = await fetch(endpoint(route.profile.baseURL), {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: 'Bearer ' + resolved.value,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: route.selection.model,
        input: request.query,
        tools: [{ type: 'web_search_preview' }],
      }),
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) {
      throw new WebError('current model search failed with HTTP ' + String(response.status), 'WEB_PROVIDER_ERROR')
    }
    const payload = await response.json() as ResponsesPayload
    const output = Array.isArray(payload.output) ? payload.output as ResponseOutputItem[] : []
    const mapped = responseSources(output)
    const fallback = stringValue(payload.output_text)
    const content = mapped.answer ?? fallback
    return {
      ...content === undefined ? {} : { content },
      sources: mapped.sources,
      truncated: false,
    }
  }
}
