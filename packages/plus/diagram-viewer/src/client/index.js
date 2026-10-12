window.__ModuleLoader__.load({
	id: "@sparkelf/dsh-client-ui-diagram-viewer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { createElement, useMemo } = require("react");
		/**
		 * draw.io and XMind previews for the workspace sidebar.
		 *
		 * The sidebar matches a path against the file viewers external plugins register through
		 * `ctx.betterSidebar`, and falls back to its catch-all code viewer when nothing claims the
		 * extension. An unclaimed .drawio or .xmind therefore opens as raw XML or as a decoded archive,
		 * so this plugin claims both extensions and draws them as boxes and connectors.
		 */

		const DRAWIO_ID = 'diagram-viewer:drawio'
		const XMIND_ID = 'diagram-viewer:xmind'

		/** Decode the entities mxGraph XML carries and drop embedded markup. */
		function plainLabel(value) {
		  return value
		    .replaceAll('&lt;', '<')
		    .replaceAll('&gt;', '>')
		    .replaceAll('&quot;', '"')
		    .replaceAll('&apos;', "'")
		    .replaceAll('&#10;', ' ')
		    .replaceAll('&amp;', '&')
		    .replace(/<[^>]*>/gu, ' ')
		    .replace(/\s+/gu, ' ')
		    .trim()
		}

		/** Read one attribute value out of a start tag. */
		function attribute(tag, name) {
		  const match = new RegExp(name + '="([^"]*)"', 'u').exec(tag)
		  return match === null ? '' : match[1]
		}

		/** Read a draw.io document into nodes and edges. */
		function parseDrawio(xml) {
		  const cells = xml.match(/<mxCell\b[^>]*>/gu) ?? []
		  const nodes = []
		  const edges = []
		  for (const cell of cells) {
		    const id = attribute(cell, 'id')
		    if (id === '') continue
		    const label = plainLabel(attribute(cell, 'value'))
		    if (/edge="1"/u.test(cell)) {
		      const from = attribute(cell, 'source')
		      const to = attribute(cell, 'target')
		      if (from !== '' && to !== '') edges.push({ from, to, label })
		      continue
		    }
		    if (/vertex="1"/u.test(cell) && label !== '') nodes.push({ id, label, depth: 0 })
		  }
		  return { nodes, edges }
		}

		/** Read an XMind topic tree into nodes and edges. */
		function parseXmind(json) {
		  const nodes = []
		  const edges = []
		  let counter = 0
		  const walk = (topic, parent, depth) => {
		    const id = String(topic.id ?? 'topic-' + counter++)
		    const label = plainLabel(String(topic.title ?? ''))
		    if (label !== '') nodes.push({ id, label, depth })
		    if (parent !== null) edges.push({ from: parent, to: id, label: '' })
		    for (const child of topic.children?.attached ?? []) walk(child, id, depth + 1)
		  }
		  for (const sheet of json) {
		    // XMind 2021+ wraps the map in `rootTopic`; the older/legacy writer serialises the
		    // sheet itself as the root topic, which this archive is.
		    if (sheet.rootTopic !== undefined) walk(sheet.rootTopic, null, 0)
		    else walk(sheet, null, 0)
		  }
		  return { nodes, edges }
		}

		/** Decode base64 into a UTF-8 string. */
		function decodeBase64(value) {
		  const binary = atob(value)
		  const bytes = new Uint8Array(binary.length)
		  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
		  return new TextDecoder('utf-8').decode(bytes)
		}

		/**
		 * Pull the content.json member out of an XMind archive.
		 *
		 * The entry may be stored or deflated, so both branches are handled; anything else falls back to
		 * the raw bytes, which is what a stored archive carries.
		 */
		async function readXmind(json) {
		  const bytes = Uint8Array.from(atob(json), (character) => character.charCodeAt(0))
		  const view = new DataView(bytes.buffer)
		  let offset = 0
		  while (offset + 30 <= bytes.byteLength) {
		    if (view.getUint32(offset, true) !== 0x04034b50) break
		    const method = view.getUint16(offset + 8, true)
		    const compressedSize = view.getUint32(offset + 18, true)
		    const nameLength = view.getUint16(offset + 26, true)
		    const extraLength = view.getUint16(offset + 28, true)
		    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength))
		    const start = offset + 30 + nameLength + extraLength
		    if (name === 'content.json') {
		      const body = bytes.subarray(start, start + compressedSize)
		      // Method 0 stores the member verbatim; method 8 is raw deflate, which needs inflating.
		      if (method === 0) return new TextDecoder('utf-8').decode(body)
		      const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
		      return new TextDecoder('utf-8').decode(await new Response(stream).arrayBuffer())
		    }
		    offset = start + compressedSize
		  }
		  return ''
		}

		/** Draw one parsed diagram as boxes and routed links. */
		function DiagramCanvas({ diagram }) {
		  const width = 720
		  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, diagram.nodes.length))))
		  const positions = new Map()
		  diagram.nodes.forEach((node, index) => {
		    positions.set(node.id, {
		      x: 40 + (index % columns) * 220,
		      y: 30 + Math.floor(index / columns) * 110,
		    })
		  })
		  const height = 60 + Math.ceil(Math.max(1, diagram.nodes.length) / columns) * 110
		  return createElement('svg', {
		    viewBox: '0 0 ' + width + ' ' + height,
		    style: { width: '100%', height: 'auto', background: 'transparent' },
		    role: 'img',
		  }, [
		    ...diagram.edges.map((edge, index) => {
		      const from = positions.get(edge.from)
		      const to = positions.get(edge.to)
		      if (from === undefined || to === undefined) return null
		      return createElement('line', {
		        key: 'e' + index,
		        x1: from.x + 80, y1: from.y + 22, x2: to.x + 80, y2: to.y + 22,
		        stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-opacity': 0.55,
		      })
		    }),
		    ...diagram.nodes.map((node, index) => {
		      const at = positions.get(node.id)
		      return createElement('g', { key: 'n' + index }, [
		        createElement('rect', {
		          key: 'r', x: at.x, y: at.y, width: 160, height: 44, rx: 6,
		          fill: 'none', stroke: 'currentColor', 'stroke-opacity': 0.45,
		        }),
		        createElement('text', {
		          key: 't', x: at.x + 80, y: at.y + 27, 'text-anchor': 'middle',
		          'font-size': 12, fill: 'currentColor',
		        }, node.label),
		      ])
		    }),
		  ])
		}

		/** Render one diagram payload. */
		function DiagramView({ kind, data }) {
		  const diagram = useMemo(() => {
		    try {
		      if (kind === 'drawio') return parseDrawio(data)
		      return parseXmind(JSON.parse(data))
		    } catch (error) {
		      return { nodes: [], edges: [], error: String(error) }
		    }
		  }, [kind, data])
		  if (diagram.error !== undefined) {
		    return createElement('div', { style: { padding: 16, opacity: 0.7 } }, diagram.error)
		  }
		  if (diagram.nodes.length === 0) {
		    return createElement('div', { style: { padding: 16, opacity: 0.7 } }, '没有可显示的图形节点')
		  }
		  return createElement('div', { style: { padding: 12, overflow: 'auto' } },
		    createElement(DiagramCanvas, { diagram }))
		}

		/**
		 * Read one file through the sidebar's own transport.
		 *
		 * A text read carries the decoded text; a binary read carries the file bytes base64-encoded,
		 * which must stay encoded until the consumer decides how to interpret it — decoding here
		 * would run the bytes through UTF-8 and corrupt an archive.
		 * @returns the text, or the base64 bytes for a binary file.
		 */
		async function readFile(scope, path, signal) {
		  const response = await fetch('/sidebar/api/fs.read', {
		    method: 'POST',
		    credentials: 'same-origin',
		    headers: { 'content-type': 'application/json' },
		    body: JSON.stringify({ sessionId: scope.sessionId, path }),
		    signal,
		  })
		  if (!response.ok) throw new Error('cannot read ' + path + ': ' + response.status)
		  const payload = await response.json()
		  const value = payload.value ?? {}
		  return value.kind === 'binary' ? String(value.head ?? '') : String(value.content ?? '')
		}

		/** Case-insensitive extension test on a sidebar path. */
		function hasExt(path, exts) {
		  const name = String(path ?? '').toLowerCase()
		  return exts.some((ext) => name.endsWith('.' + ext))
		}

		/** True when the sniffed head carries the PKZIP local-file signature (`PK\x03\x04`). */
		function isZip(head) {
		  return head !== undefined && head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b
		}

		/**
		 * Register both diagram viewers on the sidebar's own file viewer registry.
		 *
		 * The sidebar's client half activates after this entry, so the entry declares
		 * `betterSidebar` in its exported inject list and Cordis waits for the service before
		 * running apply. Reading it eagerly inside apply would find nothing and register no viewer.
		 */
		function apply(ctx) {
		  /**
		   * Register one viewer.
		   *
		   * `detect` is mandatory, not decorative: when the sidebar reads a file whose bytes look
		   * binary it re-runs this matcher against the sniffed head instead of trusting the extension,
		   * and a viewer without a matcher is skipped by that second pass. XMind is a zip, so without
		   * `detect` the tab would fall through to the plain download card.
		   */
		  const register = (id, exts, kind, title, detect) => {
		    ctx.effect(() => ctx.betterSidebar.registerFileViewer({
		      id,
		      title,
		      exts,
		      priority: 10,
		      fetchStrategy: 'custom',
		      detect,
		      load: async (path, scope, signal) => {
		        const raw = await readFile(scope, path, signal)
		        // XMind arrives base64 (a zip); draw.io arrives as the XML text itself.
		        return kind === 'xmind' ? await readXmind(raw) : raw
		      },
		      component: ({ customData }) => createElement(DiagramView, { kind, data: String(customData ?? '') }),
		    }))
		  }
		  register(DRAWIO_ID, ['drawio', 'dio'], 'drawio', 'draw.io', (path) => hasExt(path, ['drawio', 'dio']))
		  register(XMIND_ID, ['xmind'], 'xmind', 'XMind', (path, head) => hasExt(path, ['xmind']) || isZip(head))
		}
		/** Cordis service dependencies: the sidebar's own file viewer registry. */
		const inject = ["betterSidebar"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
