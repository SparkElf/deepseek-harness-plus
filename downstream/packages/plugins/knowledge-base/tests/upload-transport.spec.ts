// @ts-nocheck
/**
 * 上传传输层：百分比进度必须来自真实字节数，且不能把界面刷爆。
 *
 * 用户明确要百分比进度条。`fetch` 拿不到字节级回调，所以传输层换成 `XMLHttpRequest`
 * + `upload.onprogress` —— 这是浏览器唯一会报"已发送多少字节"的 API。
 *
 * 这里全部用 XHR 桩驱动，不发真实网络：要验证的是"进度事件如何变成状态"，不是网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROGRESS_INTERVAL_MS,
  shouldReportProgress,
  uploadJsonWithProgress,
  uploadPercent,
} from '../src/client/uploadTransport.ts'

/** A stand-in for one XMLHttpRequest, driven by the test. */
interface StubRequest {
  upload: { onprogress: ((event: ProgressEvent) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  ontimeout: (() => void) | null
  status: number
  responseText: string
  open: (method: string, url: string, async: boolean) => void
  setRequestHeader: (name: string, value: string) => void
  send: (body: string) => void
  opened?: { method: string; url: string }
  headers: Record<string, string>
  sentBody?: string
}

/** Install a stub XHR on the global object and hand back the instance. */
function installStub(): StubRequest {
  const request: StubRequest = {
    upload: { onprogress: null },
    onload: null,
    onerror: null,
    onabort: null,
    ontimeout: null,
    status: 0,
    responseText: '',
    headers: {},
    open(method, url, async) { request.opened = { method, url, async } },
    setRequestHeader(name, value) { request.headers[name] = value },
    send(body) { request.sentBody = body },
  }
  const Stub = function (this: StubRequest) { return request } as unknown as new () => XMLHttpRequest
  vi.stubGlobal('XMLHttpRequest', Stub)
  return request
}

/** Fire a progress event on the stub. */
function progress(request: StubRequest, loaded: number, total: number, computable = true): void {
  request.upload.onprogress?.({
    loaded, total, lengthComputable: computable,
  } as ProgressEvent)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a percentage is only reported when it is actually known', () => {
  it('computes the share of bytes sent', () => {
    expect(uploadPercent(0, 100, true)).toBe(0)
    expect(uploadPercent(25, 100, true)).toBe(25)
    expect(uploadPercent(100, 100, true)).toBe(100)
  })

  it('refuses to invent a number for an unknown total', () => {
    // 这是关键：没有总长时报 `lengthComputable: false`，编一个百分比就是撒谎。
    expect(uploadPercent(500, 0, false)).toBeUndefined()
    expect(uploadPercent(500, 0, true)).toBeUndefined()
  })

  it('clamps a trailing chunk instead of showing over 100%', () => {
    expect(uploadPercent(120, 100, true)).toBe(100)
  })

  it('ignores nonsense values', () => {
    expect(uploadPercent(Number.NaN, 100, true)).toBeUndefined()
    expect(uploadPercent(-5, 100, true)).toBeUndefined()
    expect(uploadPercent(5, -100, true)).toBeUndefined()
  })
})

describe('progress reporting is throttled', () => {
  it('reports the first sample immediately', () => {
    expect(shouldReportProgress(1000, undefined)).toBe(true)
  })

  it('drops samples that arrive too soon', () => {
    // 每个 onprogress 都是一次 React 渲染；大文件的原始频率是几百次。
    expect(shouldReportProgress(1050, 1000)).toBe(false)
    expect(shouldReportProgress(1099, 1000)).toBe(false)
  })

  it('reports again once the interval has passed', () => {
    expect(shouldReportProgress(1000 + PROGRESS_INTERVAL_MS, 1000)).toBe(true)
    expect(shouldReportProgress(5000, 1000)).toBe(true)
  })
})

describe('the upload transport reports progress and result', () => {
  it('posts the same JSON body to the same route as before', async () => {
    const request = installStub()
    const pending = uploadJsonWithProgress('/knowledge-base/api/upload', { relPath: 'a.md', content: 'x' }, () => undefined)
    expect(request.opened?.method).toBe('POST')
    expect(request.opened?.url).toBe('/knowledge-base/api/upload')
    expect(request.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request.sentBody ?? '{}')).toEqual({ relPath: 'a.md', content: 'x' })
    request.status = 200
    request.responseText = '{}'
    request.onload?.()
    await expect(pending).resolves.toEqual({ status: 200, body: {} })
  })

  it('advances the reported percentage as bytes go out', async () => {
    // 这条钉住"进度回调能推进状态"：三次采样应产生三个不同的百分比。
    const request = installStub()
    const seen: number[] = []
    const pending = uploadJsonWithProgress('/u', {}, percent => { seen.push(percent) })

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    progress(request, 10, 100)
    vi.spyOn(Date, 'now').mockReturnValue(now + PROGRESS_INTERVAL_MS)
    progress(request, 50, 100)
    vi.spyOn(Date, 'now').mockReturnValue(now + PROGRESS_INTERVAL_MS * 2)
    progress(request, 100, 100)

    expect(seen).toEqual([10, 50, 100])
    request.onload?.()
    await pending
  })

  it('throttles a burst of events down to the interval', async () => {
    // 一个 100 次的爆发只能透出被节流后的少量采样。
    const request = installStub()
    const seen: number[] = []
    const pending = uploadJsonWithProgress('/u', {}, percent => { seen.push(percent) })

    const now = Date.now()
    // Every event carries a distinct byte count but they all arrive within one interval.
    for (let i = 1; i <= 100; i += 1) {
      vi.spyOn(Date, 'now').mockReturnValue(now + i)
      progress(request, i, 1000)
    }
    expect(seen.length).toBe(1)

    request.onload?.()
    await pending
  })

  it('does not report progress for an unknown total', async () => {
    const request = installStub()
    const seen: number[] = []
    const pending = uploadJsonWithProgress('/u', {}, percent => { seen.push(percent) })
    progress(request, 10, 0, false)
    progress(request, 20, 0, false)
    expect(seen).toEqual([])
    request.onload?.()
    await pending
  })

  it('reports the status and body of a refusal', async () => {
    // 失败语义必须和之前一致：状态码 + 解析出的 body，交给 `failureReason`。
    const request = installStub()
    const pending = uploadJsonWithProgress('/u', {}, () => undefined)
    request.status = 409
    request.responseText = JSON.stringify({ error: 'a document already exists', code: 'exists' })
    request.onload?.()
    await expect(pending).resolves.toEqual({
      status: 409,
      body: { error: 'a document already exists', code: 'exists' },
    })
  })

  it('survives a body that is not JSON', async () => {
    // 网关 502 返回 HTML：解析失败必须回落成 undefined，而不是抛异常。
    const request = installStub()
    const pending = uploadJsonWithProgress('/u', {}, () => undefined)
    request.status = 502
    request.responseText = '<html>Bad Gateway</html>'
    const attempt = await (async () => { request.onload?.(); return pending })()
    expect(attempt.status).toBe(502)
    expect(attempt.body).toBeUndefined()
    expect(attempt.transportError).toBeUndefined()
  })

  it('turns a network failure into a transport error instead of a status', async () => {
    // 断网时 status 是 0；调用方据此显示"网络请求失败"而不是"HTTP 0"。
    const request = installStub()
    const pending = uploadJsonWithProgress('/u', {}, () => undefined)
    request.onerror?.()
    const attempt = await pending
    expect(attempt.status).toBe(0)
    expect(attempt.transportError).toBeDefined()
    expect(attempt.transportError?.trim()).not.toBe('')
  })

  it('settles once even if more than one terminal event fires', async () => {
    // XHR 可能先 error 再 loadend；重复 resolve 会让调用方看到两次结果。
    const request = installStub()
    const pending = uploadJsonWithProgress('/u', {}, () => undefined)
    request.onerror?.()
    request.status = 200
    request.onload?.()
    const attempt = await pending
    expect(attempt.transportError).toBeDefined()
  })
})
