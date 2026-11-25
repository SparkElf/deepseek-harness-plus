/** Opt-in paired-phone DOM geometry capture owned by Mobile Bridge. */

interface DiagnosticsStatus {
  domDiagnosticsEnabled: boolean
}

interface DiagnosticsCapability {
  mobile: boolean
  enabled: boolean
}

interface DiagnosticsCaptureResult {
  stored: boolean
}

type SubscribeStatus = (listener: (status: DiagnosticsStatus) => void) => () => void

async function loadDiagnosticsCapability(): Promise<DiagnosticsCapability> {
  const response = await fetch('/mobile/bridge/diagnostics/capability', { cache: 'no-store' })
  if (!response.ok) throw new Error(`Mobile DOM diagnostics capability failed with HTTP ${response.status}`)
  return await response.json() as DiagnosticsCapability
}

const MAX_ELEMENTS = 96
const INTERACTIVE_SELECTOR = 'button, input, textarea, select, a, [role], [aria-label]'

const STYLE_PROPERTIES = [
  'display',
  'position',
  'flex',
  'flex-direction',
  'flex-wrap',
  'align-items',
  'justify-content',
  'gap',
  'grid-template-columns',
  'overflow',
  'overflow-x',
  'overflow-y',
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
] as const

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
}

/** 单次遍历选择交互元素、data标记元素和少量祖先，避免诊断本身放大大页面开销。 */
function diagnosticElements(): HTMLElement[] {
  const all = [document.body, ...document.body.querySelectorAll('*')]
    .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement)
  const selected = new Set<HTMLElement>([document.body])
  for (const candidate of all) {
    const diagnosticSeed = candidate.matches(INTERACTIVE_SELECTOR)
      || [...candidate.attributes].some(attribute => attribute.name.startsWith('data-'))
    if (!diagnosticSeed) continue
    let current: HTMLElement | null = candidate
    for (let depth = 0; current !== null && depth < 4; depth += 1) {
      selected.add(current)
      current = current.parentElement
    }
  }
  return all.filter(candidate => selected.has(candidate) && isVisible(candidate)).slice(0, MAX_ELEMENTS)
}

function locatorFor(element: HTMLElement): string {
  const role = element.getAttribute('role')
  const dataAttributes = [...element.attributes]
    .map(attribute => attribute.name)
    .filter(name => name.startsWith('data-'))
    .slice(0, 3)
  const classes = [...element.classList].slice(0, 3).map(name => '.' + name)
  return [element.tagName.toLowerCase(), role ? '[role=' + role + ']' : '', ...dataAttributes.map(name => '[' + name + ']'), ...classes].join('')
}

/** 生成不含聊天文本、输入值和URL query的有界布局快照。 */
function snapshot(): Record<string, unknown> {
  return {
    path: window.location.pathname,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    elements: diagnosticElements().map(element => {
      const rect = element.getBoundingClientRect()
      const computed = getComputedStyle(element)
      return {
        locator: locatorFor(element),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') ?? '',
        label: (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '').slice(0, 160),
        classes: [...element.classList].slice(0, 8),
        dataAttributes: [...element.attributes]
          .map(attribute => attribute.name)
          .filter(name => name.startsWith('data-'))
          .slice(0, 12),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        styles: Object.fromEntries(STYLE_PROPERTIES.map(property => [property, computed.getPropertyValue(property)])),
      }
    }),
  }
}

/**
 * 仅在paired phone tunnel与桌面开关同时有效时安装事件驱动采集。
 * @param subscribeStatus - Mobile Bridge已有实时状态订阅。
 * @returns capability、SSE和DOM监听器的统一disposer。
 */
export async function installMobileDomDiagnostics(subscribeStatus: SubscribeStatus): Promise<() => void> {
  const capability = await loadDiagnosticsCapability()
  if (!capability.mobile) return () => {}

  let enabled = false
  let disposed = false
  let scheduled = false
  let firstFrame = 0
  let secondFrame = 0

  const postSnapshot = async (): Promise<void> => {
    const latest = await loadDiagnosticsCapability()
    if (!latest.mobile || !latest.enabled) {
      setEnabled(false)
      return
    }
    const result = await fetch('/mobile/bridge/diagnostics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot()),
    })
    if (!result.ok) throw new Error(`Mobile DOM diagnostics capture failed with HTTP ${result.status}: ${await result.text()}`)
    const capture = await result.json() as DiagnosticsCaptureResult
    if (!capture.stored) setEnabled(false)
  }

  const capture = (): void => {
    scheduled = false
    if (disposed || !enabled) return
    void postSnapshot().catch(error => { console.error('[dsh-mobile-bridge] mobile DOM diagnostics upload failed', error) })
  }

  const schedule = (): void => {
    if (disposed || !enabled || scheduled) return
    scheduled = true
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(capture)
    })
  }

  const setEnabled = (next: boolean): void => {
    if (enabled === next) return
    enabled = next
    if (next) {
      window.addEventListener('resize', schedule)
      document.addEventListener('click', schedule, true)
      document.addEventListener('input', schedule, true)
      document.addEventListener('change', schedule, true)
      schedule()
    } else {
      window.removeEventListener('resize', schedule)
      document.removeEventListener('click', schedule, true)
      document.removeEventListener('input', schedule, true)
      document.removeEventListener('change', schedule, true)
      scheduled = false
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }

  const unsubscribe = subscribeStatus(status => { setEnabled(status.domDiagnosticsEnabled) })
  setEnabled(capability.enabled)
  return () => {
    disposed = true
    setEnabled(false)
    unsubscribe()
  }
}
