// @vitest-environment jsdom
// AttachmentRail behavior in the jsdom lane: mixed item rendering and callbacks,
// arrow paging over stubbed scroll geometry (jsdom lays nothing out), the
// exclusive vertical-wheel pan, and the new-item end reveal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { AttachmentRail } from '../src/AttachmentRail.tsx'
import type { AttachmentRailItem, AttachmentRailLabels } from '../src/AttachmentRail.tsx'

afterEach(cleanup)

const observers: { callback: ResizeObserverCallback; observed: Element[] }[] = []
beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('ResizeObserver', class {
    observed: Element[] = []
    constructor(callback: ResizeObserverCallback) {
      observers.push({ callback, observed: this.observed })
    }

    observe(el: Element) { this.observed.push(el) }
    disconnect() { this.observed.length = 0 }
  })
})
afterEach(() => { vi.unstubAllGlobals() })

const labels: AttachmentRailLabels = {
  group: '待发送附件',
  open: '查看原图',
  scrollLeft: '向左滚动附件',
  scrollRight: '向右滚动附件',
}

function item(id: string): AttachmentRailItem {
  return { kind: 'image', id, previewUrl: `blob:${id}`, alt: `${id}.png`, removeLabel: `移除图片 ${id}.png` }
}

function documentItem(id: string): AttachmentRailItem {
  return {
    kind: 'document', id, name: `${id}.pdf`, typeLabel: 'PDF', detail: '12 KB', removeLabel: `移除文档 ${id}.pdf`,
  }
}

function stubGeometry(rail: HTMLElement, { scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
  Object.defineProperty(rail, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(rail, 'clientWidth', { value: clientWidth, configurable: true })
  let scrollLeft = 0
  Object.defineProperty(rail, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => { scrollLeft = value },
  })
  const scrollBy = vi.fn((options: { left: number }) => {
    scrollLeft = Math.max(0, Math.min(scrollWidth - clientWidth, scrollLeft + options.left))
  })
  rail.scrollBy = scrollBy as unknown as typeof rail.scrollBy
  return { scrollBy, setScrollLeft: (value: number) => { scrollLeft = value } }
}

describe('AttachmentRail', () => {
  it('renders image thumbnails and document cards in one rail and routes callbacks', () => {
    const onOpen = vi.fn()
    const onRemove = vi.fn()
    const items = [item('a'), documentItem('report'), item('b')]
    const view = render(<AttachmentRail items={items} labels={labels} onOpen={onOpen} onRemove={onRemove} />)
    const rail = view.getByRole('group', { name: '待发送附件' })
    expect([...rail.querySelectorAll('img')].map(img => img.getAttribute('alt'))).toEqual(['a.png', 'b.png'])
    expect(view.getByText('report.pdf')).toBeTruthy()
    expect(view.getByText('PDF')).toBeTruthy()
    expect(view.getByText('12 KB')).toBeTruthy()
    fireEvent.click(view.getAllByTitle('查看原图')[0]!)
    expect(onOpen).toHaveBeenCalledWith(items[0])
    fireEvent.click(view.getByRole('button', { name: '移除文档 report.pdf' }))
    expect(onRemove).toHaveBeenCalledWith(items[1])
  })

  it('shows edge arrows from scroll geometry and pages a viewport at a time', () => {
    const view = render(
      <AttachmentRail items={[item('a'), item('b'), item('c')]} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    const rail = view.getByRole('group', { name: '待发送附件' })
    const { scrollBy } = stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
    expect(view.queryByLabelText('向右滚动附件')).toBeNull()
    fireEvent.scroll(rail)
    fireEvent.scroll(rail)
    expect(view.queryByLabelText('向左滚动附件')).toBeNull()
    const right = view.getByLabelText('向右滚动附件')
    fireEvent.click(right)
    expect(scrollBy).toHaveBeenCalledWith({ left: 200, behavior: 'smooth' })
    fireEvent.scroll(rail)
    expect(view.queryByLabelText('向右滚动附件')).toBeNull()
    fireEvent.click(view.getByLabelText('向左滚动附件'))
    expect(scrollBy).toHaveBeenCalledWith({ left: -200, behavior: 'smooth' })
    fireEvent.scroll(rail)
    expect(view.queryByLabelText('向左滚动附件')).toBeNull()
    expect(view.getByLabelText('向右滚动附件')).toBeTruthy()
  })

  it('shows both arrows mid-scroll and recomputes when the rail itself resizes', () => {
    const view = render(
      <AttachmentRail items={[item('a'), item('b'), item('c')]} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    const rail = view.getByRole('group', { name: '待发送附件' })
    const { setScrollLeft } = stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
    setScrollLeft(100)
    expect(observers.at(-1)?.observed).toContain(rail)
    act(() => { observers.at(-1)!.callback([], undefined as never) })
    expect(view.getByLabelText('向左滚动附件')).toBeTruthy()
    expect(view.getByLabelText('向右滚动附件')).toBeTruthy()
  })

  it('keeps scrolling available when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const view = render(
      <AttachmentRail items={[item('a')]} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    expect(view.getByRole('group', { name: '待发送附件' })).toBeTruthy()
    view.unmount()
  })

  it('pans horizontally on a vertical wheel, consuming the event, with clamped normalized travel', () => {
    const view = render(
      <AttachmentRail items={[item('a'), item('b')]} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    const rail = view.getByRole('group', { name: '待发送附件' })
    const { scrollBy } = stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
    expect(fireEvent.wheel(rail, { deltaY: 30 })).toBe(false)
    expect(scrollBy).toHaveBeenCalledWith({ left: 30, behavior: 'auto' })
    fireEvent.wheel(rail, { deltaY: 500 })
    expect(scrollBy).toHaveBeenCalledWith({ left: 60, behavior: 'auto' })
    fireEvent.wheel(rail, { deltaY: -500 })
    expect(scrollBy).toHaveBeenCalledWith({ left: -60, behavior: 'auto' })
    fireEvent.wheel(rail, { deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE })
    expect(scrollBy).toHaveBeenCalledWith({ left: 32, behavior: 'auto' })
    fireEvent.wheel(rail, { deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_PAGE })
    expect(scrollBy).toHaveBeenCalledWith({ left: -60, behavior: 'auto' })
    expect(fireEvent.wheel(rail, { deltaX: 12, deltaY: 30 })).toBe(false)
    expect(scrollBy).toHaveBeenCalledWith({ left: 12, behavior: 'auto' })
    expect(fireEvent.wheel(rail, { deltaX: 12, deltaY: 0 })).toBe(true)
    fireEvent.wheel(rail, { deltaY: 0 })
    expect(scrollBy).toHaveBeenCalledTimes(6)
  })

  it('pages instantly under a reduced-motion preference, smoothly otherwise', () => {
    for (const [matches, behavior] of [[true, 'auto'], [false, 'smooth']] as const) {
      vi.stubGlobal('matchMedia', vi.fn(() => ({ matches }) as MediaQueryList))
      const view = render(
        <AttachmentRail items={[item('a'), item('b'), item('c')]} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
      )
      const rail = view.getByRole('group', { name: '待发送附件' })
      const { scrollBy } = stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
      fireEvent.scroll(rail)
      fireEvent.click(view.getByLabelText('向右滚动附件'))
      expect(scrollBy).toHaveBeenCalledWith({ left: 200, behavior })
      view.unmount()
    }
  })

  it('reveals the rail end when an item is added, not when one is removed', () => {
    const first = [item('a'), item('b')]
    const view = render(
      <AttachmentRail items={first} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    const rail = view.getByRole('group', { name: '待发送附件' })
    stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
    view.rerender(
      <AttachmentRail items={[...first, item('c')]} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    expect(rail.scrollLeft).toBe(200)
    view.rerender(
      <AttachmentRail items={first} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    expect(rail.scrollLeft).toBe(200)
  })
})
