import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = []
  readonly close = vi.fn()

  constructor(readonly url: string) {
    super()
    FakeEventSource.instances.push(this)
  }
}

type BrowserGlobals = {
  EventSource?: typeof EventSource
  location?: { reload(): void }
  document?: { baseURI: string; querySelectorAll(selector: string): Element[] }
}

const originalEventSource = globalThis.EventSource
const originalLocation = globalThis.location
const originalDocument = globalThis.document

afterEach(() => {
  FakeEventSource.instances.length = 0
  if (originalEventSource === undefined) delete (globalThis as unknown as BrowserGlobals).EventSource
  else globalThis.EventSource = originalEventSource
  if (originalLocation === undefined) delete (globalThis as unknown as BrowserGlobals).location
  else globalThis.location = originalLocation
  if (originalDocument === undefined) delete (globalThis as unknown as BrowserGlobals).document
  else globalThis.document = originalDocument
})

describe('client HMR runtime reconnect', () => {
  it('keeps plugin rebuilds in-page and reloads once after the SSE channel reconnects', () => {
    const reload = vi.fn()
    ;(globalThis as unknown as BrowserGlobals).EventSource = FakeEventSource as unknown as typeof EventSource
    ;(globalThis as unknown as BrowserGlobals).location = { reload }
    ;(globalThis as unknown as BrowserGlobals).document = {
      baseURI: 'https://example.test/dataops/dsh/',
      querySelectorAll: () => [],
    }
    let dispose: (() => void) | undefined
    const ctx = {
      modules: { invalidate: vi.fn(), prefetch: vi.fn() },
      loader: { entries: () => [] },
      logger: { warn: vi.fn(), error: vi.fn() },
      effect: (mount: () => () => void) => { dispose = mount() },
    }

    apply(ctx as never)
    const source = FakeEventSource.instances[0]
    expect(source?.url).toBe('https://example.test/dataops/dsh/plugins/events')
    source?.dispatchEvent(new Event('open'))
    expect(reload).not.toHaveBeenCalled()
    source?.dispatchEvent(new Event('message'))
    expect(reload).not.toHaveBeenCalled()
    source?.dispatchEvent(new Event('error'))
    source?.dispatchEvent(new Event('open'))
    source?.dispatchEvent(new Event('open'))
    expect(reload).toHaveBeenCalledOnce()

    dispose?.()
    expect(source?.close).toHaveBeenCalledOnce()
  })
})
