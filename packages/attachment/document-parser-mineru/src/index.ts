/** MinerU implementation of the external document-parser seam. @module @deepseek-ai/dsh-document-parser-mineru */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-document-parser'
import { MinerUDocumentParserProvider } from './provider.ts'

export {
  MINERU_PROVIDER_ID,
  MinerUDocumentParserProvider,
} from './provider.ts'
export type { MinerUProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'document-parser-mineru'
/** Provider registers into the provider-neutral parser seam. */
export const inject = ['documentParser']

/** External MinerU endpoint and bounded synchronous parse policy. */
export interface Config {
  /** Absolute MinerU synchronous `/file_parse` endpoint. */
  endpoint: string
  /** Maximum wall-clock milliseconds for one parse. */
  timeoutMs: number
  /** Maximum compressed response and aggregate extracted output bytes. */
  maxResponseBytes: number
}

/** MinerU provider configuration has no implicit endpoint, timeout, or size policy. */
export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  timeoutMs: z.number().step(1).min(1).required(),
  maxResponseBytes: z.number().step(1).min(1).required(),
})

/** Register the MinerU provider into `ctx.documentParser`. */
export function apply(ctx: Context, config: Config): void {
  ctx.documentParser.registerProvider(new MinerUDocumentParserProvider(config))
}
