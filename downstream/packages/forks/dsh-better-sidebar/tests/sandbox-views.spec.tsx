/**
 * Sandbox-contract tests for the two built-in web surfaces (HTML preview
 * iframe and the browser tab iframe). The iframe sandbox — no
 * top-navigation, and (deliberately) `allow-same-origin` so the sidebar's
 * own fence accepts the frame's requests — is the PRIMARY security boundary
 * of both features; these tests pin the exact attribute so a refactor cannot
 * silently widen it. The HTML preview asks before its first load; the
 * side-card setting can drop the sandbox per feature without asking.
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

import type { Context } from '../src/context-types.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { HTML_IFRAME_SANDBOX } from '../src/client/html-preview.ts'
import { DiffPane, HtmlRenderPreview } from '../src/client/changes/DiffPane.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'

setupReactAct()

const CTX = {} as Context

// The copy assertions below pin the zh strings: force the zh locale (the
// test environment's navigator may be the real Node one with an en locale).
beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

function viewerProps(store: ReturnType<typeof createSidebarStore>, overrides: Partial<FileViewerProps> = {}): FileViewerProps {
  return {
    ctx: CTX,
    store,
    scope: { sessionId: 's1', cwd: '/p' },
    path: '/p/a/index.html',
    title: 'index.html',
    viewerId: 'html',
    content: '<h1>hi</h1>',
    ...overrides,
  }
}

describe('HTML preview iframe sandbox', () => {
  // The preview asks before the FIRST load: the page must never run
  // sandboxed and then be unlocked after its scripts already ran.
  function mountEditor(store: ReturnType<typeof createSidebarStore>, overrides: Partial<FileViewerProps> = {}) {
    return renderRoot(createElement(TextEditor, viewerProps(store, overrides)))
  }

  function dialogButton(label: string): HTMLButtonElement {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(candidate => candidate.textContent?.trim() === label)
    if (button === undefined) throw new Error(`dialog button not found: ${label}`)
    return button
  }

  it('asks before the first load, then frames the preview with the exact sandbox tokens', () => {
    const store = createSidebarStore()
    const mounted = mountEditor(store)
    try {
      // Nothing is framed while the question is open.
      expect(mounted.container.querySelector('iframe')).toBeNull()
      expect(document.body.textContent).toContain('是否启用沙箱限制？')
      act(() => { dialogButton('启用沙箱').click() })
      const iframe = mounted.container.querySelector('iframe')
      expect(iframe).not.toBeNull()
      // The sandbox tokens are exactly the exported constant...
      expect(iframe?.getAttribute('sandbox')).toBe(HTML_IFRAME_SANDBOX)
      // ...which must never contain the tokens that let a previewed page HIJACK the GUI.
      expect(HTML_IFRAME_SANDBOX).not.toContain('allow-top-navigation')
      // `allow-same-origin` IS present, deliberately. Without it the frame is an opaque origin,
      // its requests carry `Origin: null`, and the sidebar's own fence refuses them: the preview
      // answered 200 and still rendered as an empty box. The isolation that remains is the
      // sandbox itself plus the route's own CSP. This is a weaken-the-isolation decision, so it
      // is asserted rather than left implicit -- see html-preview.ts for the reasoning.
      expect(HTML_IFRAME_SANDBOX).toContain('allow-same-origin')
      // Cross-origin framing by construction: route-src (never srcdoc).
      expect(iframe?.getAttribute('src')).toBe(new URL('/sidebar/html/s1/p/a/index.html', window.location.href).toString())
      expect(mounted.container.innerHTML).not.toContain('srcdoc=')
      // Referrer + permissions policy stay locked even when sandboxed.
      expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
      expect(iframe?.getAttribute('allow')).toBe('')
    } finally {
      mounted.unmount()
    }
  })

  it('declining the prompt frames the unsandboxed preview (and offers no restore here)', () => {
    const store = createSidebarStore()
    const mounted = mountEditor(store)
    try {
      act(() => { dialogButton('不启用').click() })
      const iframe = mounted.container.querySelector('iframe')
      expect(iframe).not.toBeNull()
      expect(iframe?.hasAttribute('sandbox')).toBe(false)
      expect(document.body.textContent).not.toContain('是否启用沙箱限制？')
    } finally {
      mounted.unmount()
    }
  })

  it('drops the sandbox attribute without asking when the global setting is on', () => {
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), htmlViewerNoSandbox: true })
    const mounted = mountEditor(store)
    try {
      expect(document.body.textContent).not.toContain('是否启用沙箱限制？')
      const iframe = mounted.container.querySelector('iframe')
      expect(iframe).not.toBeNull()
      expect(iframe?.hasAttribute('sandbox')).toBe(false)
    } finally {
      mounted.unmount()
    }
  })

  it('markdown preview keeps rendering markdown, not an iframe', () => {
    const store = createSidebarStore()
    const mounted = mountEditor(store, {
      viewerId: 'markdown',
      path: '/p/readme.md',
      content: '# hi',
    })
    try {
      expect(mounted.container.querySelector('iframe')).toBeNull()
      expect(mounted.container.innerHTML).not.toContain('/sidebar/html/')
      // The markdown is rendered into markup, not framed.
      expect(mounted.container.innerHTML).toContain('<h1')
    } finally {
      mounted.unmount()
    }
  })
})

describe('changes tab HTML render preview sandbox', () => {
  function opProps(path: string) {
    return {
      target: {
        kind: 'op' as const,
        path,
        op: { callId: 'c1', kind: 'read' as const, path, time: 0, running: false, isError: false, read: '<content>1: <html><body>hi</body></html></content>' },
      },
      scope: { sessionId: 's1', cwd: '/p' },
      ctx: CTX,
      height: 300,
      onHeightCommit: () => {},
      onClose: () => {},
      onExpand: () => {},
    }
  }

  it('render iframe is ALWAYS sandboxed (no escape hatch) with the route src, never srcdoc', () => {
    const html = renderToString(createElement(HtmlRenderPreview, { src: '/sidebar/html/s1/p/a/index.html', title: '/p/a/index.html' }))
    const iframe = /<iframe[^>]*>/.exec(html)?.[0]
    expect(iframe).toBeDefined()
    // The sandbox tokens are exactly the shared constant — and unlike the
    // editor viewer this surface has NO no-sandbox escape hatch.
    expect(iframe).toContain(`sandbox="${HTML_IFRAME_SANDBOX}"`)
    // Same deliberate token set as the viewer (see html-preview.ts): the sandbox attribute must
    // exist on this surface too, and the only withheld token is top-navigation.
    expect(HTML_IFRAME_SANDBOX).not.toContain('allow-top-navigation')
    expect(HTML_IFRAME_SANDBOX).not.toContain('allow-top-navigation')
    // Cross-origin framing by construction: route-src (never srcdoc). The src
    // here is the caller's literal (DiffPane passes htmlUrl(...)); this surface
    // only frames what it is given.
    expect(iframe).toContain('src="/sidebar/html/s1/p/a/index.html"')
    expect(iframe).not.toContain('srcdoc=')
    expect(iframe).toContain('referrerPolicy="no-referrer"')
    expect(iframe).toContain('allow=""')
  })

  it('html op targets show the render toggle (off by default, no iframe); non-html and error targets show none', () => {
    const htmlOpHtml = renderToString(createElement(DiffPane, opProps('/p/a/index.html')))
    expect(htmlOpHtml).toContain('渲染')
    expect(htmlOpHtml).not.toContain('<iframe')
    const md = renderToString(createElement(DiffPane, opProps('/p/a/readme.md')))
    expect(md).not.toContain('渲染')
    const errorProps = opProps('/p/a/index.html')
    const html = renderToString(createElement(DiffPane, {
      ...errorProps,
      target: { ...errorProps.target, op: { ...errorProps.target.op, isError: true, errorText: 'boom' } },
    }))
    expect(html).not.toContain('渲染')
  })
})
