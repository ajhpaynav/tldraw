import { useCallback, useRef, useState } from 'react'
import { Box, TLComponents, Tldraw, TldrawUiButton, useEditor, useToasts } from 'tldraw'
import 'tldraw/tldraw.css'
import {
	DiagramTarget,
	SketchConversion,
	convertSketch,
	insertMermaidDiagram,
} from './convertSketch'
import './drawing-to-mermaid.css'

// There's a guide at the bottom of this file!

/** Gap between the sketch and the diagram, in page units. */
const DIAGRAM_GAP = 120
/** Space kept around the sketch and diagram when the camera shows them, in screen pixels. */
const FIT_MARGIN = 64
/** The least room, in screen pixels, worth fitting the sketch and diagram into under the panel. */
const MIN_FIT_SIZE = 160
const MIN_ZOOM = 0.05

const components: TLComponents = { TopPanel: SketchToMermaidPanel }

export default function DrawingToMermaidExample() {
	return (
		<div className="tldraw__editor">
			{/* Keeps the sketch across reloads while you iterate on it. */}
			<Tldraw persistenceKey="drawing-to-mermaid" components={components} />
		</div>
	)
}

function SketchToMermaidPanel() {
	const editor = useEditor()
	const { addToast } = useToasts()
	const [busy, setBusy] = useState<'reading' | 'drawing' | null>(null)
	const [labelHints, setLabelHints] = useState('')
	const [conversion, setConversion] = useState<SketchConversion | null>(null)
	const [source, setSource] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [collapsed, setCollapsed] = useState(false)
	// [1]
	const [target, setTarget] = useState<DiagramTarget | null>(null)
	const panel = useRef<HTMLDivElement>(null)

	// [2]
	const showBelowPanel = useCallback(
		(bounds: Box) => {
			const viewport = editor.getViewportScreenBounds()
			const panelBottom = panel.current
				? panel.current.getBoundingClientRect().bottom - viewport.y
				: 0
			// With too little room left under the panel, use the whole viewport instead of shrinking
			// the shapes to nothing.
			const top = viewport.h - panelBottom >= 2 * FIT_MARGIN + MIN_FIT_SIZE ? panelBottom : 0
			const free = new Box(0, top, viewport.w, viewport.h - top)
			const zoom = Math.max(
				Math.min((free.w - 2 * FIT_MARGIN) / bounds.w, (free.h - 2 * FIT_MARGIN) / bounds.h, 1),
				MIN_ZOOM
			)
			editor.setCamera(
				{
					x: free.center.x / zoom - bounds.center.x,
					y: free.center.y / zoom - bounds.center.y,
					z: zoom,
				},
				{ animation: { duration: 300 } }
			)
		},
		[editor]
	)

	const draw = useCallback(
		async (text: string, next: DiagramTarget) => {
			setBusy('drawing')
			try {
				// [3]
				const selection = editor.getSelectedShapeIds()
				const ids = await insertMermaidDiagram(editor, text, next)
				editor.setSelectedShapes(selection.filter((id) => editor.getShape(id)))
				const bounds = ids.map((id) => editor.getShapePageBounds(id)).filter((b) => !!b)
				if (bounds.length > 0) showBelowPanel(Box.Common([...bounds, next.sketch]))
				setError(null)
			} catch (e) {
				setError(`Mermaid couldn't draw this source. ${e instanceof Error ? e.message : String(e)}`)
			} finally {
				setBusy(null)
			}
		},
		[editor, showBelowPanel]
	)

	const convert = useCallback(async () => {
		setBusy('reading')
		setError(null)
		try {
			const hints = labelHints
				.split(',')
				.map((h) => h.trim())
				.filter(Boolean)
			const result = await convertSketch(editor, { labelHints: hints })
			setConversion(result)
			setSource(result.source)
			setCollapsed(false)
			// [4]
			const next = {
				position: { x: result.bounds.maxX + DIAGRAM_GAP, y: result.bounds.minY },
				sketch: result.bounds,
			}
			setTarget(next)
			await draw(result.source, next)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
			setBusy(null)
		}
	}, [editor, labelHints, draw])

	const copy = useCallback(
		async (text: string, what: string) => {
			await navigator.clipboard.writeText(text)
			addToast({ title: `Copied ${what}`, severity: 'success' })
		},
		[addToast]
	)

	const requests = conversion?.log.length ?? 0
	const tokens = conversion?.log.reduce((sum, e) => sum + e.response.usage.input_tokens, 0) ?? 0

	return (
		<div ref={panel} className="drawing-to-mermaid tlui-menu">
			<div className="drawing-to-mermaid__row">
				<input
					className="drawing-to-mermaid__hints"
					placeholder="Labels you wrote, comma separated (optional)"
					value={labelHints}
					onChange={(e) => setLabelHints(e.target.value)}
				/>
				<TldrawUiButton type="primary" disabled={!!busy} onClick={convert}>
					{busy === 'reading'
						? 'Asking TypeSafe…'
						: busy === 'drawing'
							? 'Drawing…'
							: 'Sketch to Mermaid'}
				</TldrawUiButton>
			</div>
			{error && <div className="drawing-to-mermaid__error">{error}</div>}
			{conversion && !collapsed && (
				<>
					<textarea
						className="drawing-to-mermaid__source"
						value={source}
						spellCheck={false}
						onChange={(e) => setSource(e.target.value)}
					/>
					{conversion.notes.length > 0 && (
						<ul className="drawing-to-mermaid__notes">
							{conversion.notes.map((note) => (
								<li key={note}>{note}</li>
							))}
						</ul>
					)}
					<div className="drawing-to-mermaid__row">
						<TldrawUiButton
							type="normal"
							disabled={!!busy || !target}
							onClick={() => target && draw(source, target)}
						>
							Redraw diagram
						</TldrawUiButton>
						<TldrawUiButton type="normal" onClick={() => copy(source, 'Mermaid source')}>
							Copy Mermaid
						</TldrawUiButton>
						<TldrawUiButton
							type="low"
							onClick={() => copy(JSON.stringify(conversion.log, null, '\t'), 'TypeSafe log')}
						>
							Copy TypeSafe log
						</TldrawUiButton>
						<TldrawUiButton type="low" onClick={() => setCollapsed(true)}>
							Hide
						</TldrawUiButton>
					</div>
					<div className="drawing-to-mermaid__meta">
						{conversion.graph.nodes.length} nodes, {conversion.graph.edges.length} connectors ·{' '}
						{requests} TypeSafe requests · {tokens.toLocaleString()} input tokens
					</div>
				</>
			)}
			{conversion && collapsed && (
				<TldrawUiButton type="low" onClick={() => setCollapsed(false)}>
					Show Mermaid source
				</TldrawUiButton>
			)}
		</div>
	)
}

/*
Draw a flowchart with the draw tool (press D): boxes, diamonds, circles and other shapes, joined by
lines or arrows. Write labels inside shapes and next to connectors, by hand or with the text tool.
Then press "Sketch to Mermaid". convertSketch.ts splits the strokes into nodes, connectors and
labels, asks TypeSafe about each piece, builds Mermaid source from the answers and draws it next
to the sketch with @tldraw/mermaid.

TypeSafe requests go through a proxy in the examples app's dev server, which adds the API key from
TYPESAFE_API_KEY. Put it in apps/examples/.env.local and restart `pnpm dev`.

[1]
Where the last conversion's diagram goes, and the sketch it came from. It's kept even when
drawing fails, so you can fix the source and press "Redraw diagram". Drawing again replaces the
diagram from the same sketch instead of stacking a new one on top (see insertMermaidDiagram).

[2]
Like zoomToBounds, but fitting into the part of the viewport below this panel, which would
otherwise cover the top of the diagram.

[3]
@tldraw/mermaid selects the diagram it draws. Putting the user's selection back means pressing
"Sketch to Mermaid" again converts the same strokes, rather than the whole page.

[4]
The diagram goes to the right of the sketch, so the two can be compared. The source stays
editable: fix a label or an arrow in the textarea and press "Redraw diagram".
*/
