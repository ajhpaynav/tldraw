import type { MermaidNodeRenderMapper } from '@tldraw/mermaid'
import {
	Box,
	BoxModel,
	DefaultFontFaces,
	Editor,
	Group2d,
	TLGeoShapeGeoStyle,
	TLRichText,
	TLShape,
	TLShapeId,
	VecLike,
	getArrowBindings,
	getPointsFromDrawSegments,
	renderPlaintextFromRichText,
} from 'tldraw'
import { EdgeJudgment, NodeJudgment, SketchJudgments, buildMermaid } from './buildMermaid'
import {
	ARROW_ENDS,
	ArrowEnds,
	COMMON_LABELS,
	NODE_SHAPES,
	NodeShape,
	arrowQuestions,
	nodeQuestions,
} from './questions'
import { LabelReading, readHandwriting } from './readLabel'
import { renderCrop } from './renderCrop'
import { SketchGraph, SketchStroke, SketchText, segmentSketch } from './segmentSketch'
import { TypeSafeLogEntry, askAboutImage, getChoice, getNoul } from './typesafe'

/** Space around each crop, in screen pixels. */
const CROP_PADDING = 12
/** Space around a connector's crop, so the shapes it touches show, in screen pixels. */
const CONNECTOR_CROP_PADDING = 48
const START_NODE_COLOR = '#dc1e1e'
const END_NODE_COLOR = '#1e3cdc'
/** Shape meta key marking a diagram drawn by this example, holding its sketch's page bounds. */
const DIAGRAM_META = 'sketchToMermaid'

export interface SketchConversion {
	source: string
	notes: string[]
	graph: SketchGraph
	/** Every TypeSafe request and response, for inspecting and replaying answers. */
	log: TypeSafeLogEntry[]
	/** Page bounds of the strokes and text that were read. */
	bounds: Box
}

const SKETCH_SHAPE_TYPES = ['draw', 'text', 'geo', 'note', 'arrow', 'line']

/** The selected sketch shapes, or all of them on the page when nothing is selected. */
export function getSketchShapes(editor: Editor): TLShape[] {
	const isSketchShape = (shape: TLShape) =>
		SKETCH_SHAPE_TYPES.includes(shape.type) &&
		!editor.isShapeOrAncestorLocked(shape) &&
		!shape.meta[DIAGRAM_META]
	// [1]
	if (editor.isIn('select')) {
		const selected = [...editor.getShapeAndDescendantIds(editor.getSelectedShapeIds())]
			.map((id) => editor.getShape(id)!)
			.filter(isSketchShape)
		if (selected.length > 0) return selected
	}
	return editor.getCurrentPageShapes().filter(isSketchShape)
}

/**
 * What segmentSketch needs from each shape: drawn strokes as points, typed text as text, and
 * tldraw shapes and arrows as points plus what they already say about themselves.
 */
function getSketchInput(editor: Editor, shapes: TLShape[]) {
	const strokes: SketchStroke[] = []
	const texts: SketchText[] = []
	const getText = (richText: TLRichText) => renderPlaintextFromRichText(editor, richText).trim()
	for (const shape of shapes) {
		if (editor.isShapeOfType(shape, 'draw')) {
			const { segments, scaleX, scaleY } = shape.props
			const points = editor
				.getShapePageTransform(shape)
				.applyToPoints(getPointsFromDrawSegments(segments, scaleX, scaleY))
			strokes.push({ id: shape.id, points })
		} else if (editor.isShapeOfType(shape, 'text')) {
			const text = getText(shape.props.richText)
			const bounds = editor.getShapePageBounds(shape)
			if (text && bounds) texts.push({ id: shape.id, text, bounds })
		} else if (editor.isShapeOfType(shape, 'geo') || editor.isShapeOfType(shape, 'note')) {
			const points = getPathPoints(editor, shape)
			const nodeShape = editor.isShapeOfType(shape, 'geo')
				? getGeoNodeShape(shape.props.geo, shape.props.w, shape.props.h)
				: 'rectangle'
			strokes.push({
				id: shape.id,
				points: [...points, points[0]],
				known: { type: 'node', shape: nodeShape, text: getText(shape.props.richText) },
			})
		} else if (editor.isShapeOfType(shape, 'arrow')) {
			const bindings = getArrowBindings(editor, shape)
			strokes.push({
				id: shape.id,
				points: getPathPoints(editor, shape),
				known: {
					type: 'connector',
					arrowheads: {
						start: shape.props.arrowheadStart !== 'none',
						end: shape.props.arrowheadEnd !== 'none',
					},
					boundTo: { start: bindings.start?.toId, end: bindings.end?.toId },
					text: getText(shape.props.richText),
				},
			})
		} else if (editor.isShapeOfType(shape, 'line')) {
			strokes.push({
				id: shape.id,
				points: getPathPoints(editor, shape),
				known: { type: 'connector', arrowheads: { start: false, end: false }, boundTo: {} },
			})
		}
	}
	return { strokes, texts }
}

/** A shape's outline or path in page space, without its label's box. */
function getPathPoints(editor: Editor, shape: TLShape) {
	const geometry = editor.getShapeGeometry(shape)
	const path = geometry instanceof Group2d ? geometry.children[0] : geometry
	return editor.getShapePageTransform(shape).applyToPoints(path.vertices)
}

function getGeoNodeShape(geo: TLGeoShapeGeoStyle, w: number, h: number): NodeShape {
	switch (geo) {
		case 'ellipse':
			return Math.max(w, h) / Math.min(w, h) < 1.3 ? 'circle' : 'stadium'
		case 'oval':
			return 'stadium'
		case 'diamond':
			return 'diamond'
		case 'hexagon':
			return 'hexagon'
		case 'rhombus':
		case 'rhombus-2':
			return 'parallelogram'
		default:
			return 'rectangle'
	}
}

export async function convertSketch(
	editor: Editor,
	{ labelHints = [] }: { labelHints?: string[] } = {}
): Promise<SketchConversion> {
	const shapes = getSketchShapes(editor)
	// [2]
	const { strokes, texts } = getSketchInput(editor, shapes)
	const graph = segmentSketch(strokes, texts)
	const { scale } = graph
	if (graph.nodes.length === 0) {
		throw new Error(
			'No shapes found. Draw boxes, circles or diamonds, or use the rectangle and ellipse tools, and join them with lines or arrows.'
		)
	}

	const points = new Map(strokes.map((s) => [s.id, s.points]))
	const getStrokes = (ids: string[]) => ids.map((id) => points.get(id)!)
	const getBounds = (ids: string[]) => Box.Common(ids.map((id) => Box.FromPoints(points.get(id)!)))
	const nodesById = new Map(graph.nodes.map((n) => [n.id, n]))
	const candidates = dedupe([...labelHints, ...COMMON_LABELS])
	const log: TypeSafeLogEntry[] = []

	// [3]
	const nodeJudgments = graph.nodes.map(async (node): Promise<[string, NodeJudgment]> => {
		if (node.shape) return [node.id, { isOutline: 1, shape: node.shape }]
		const png = renderCrop(
			[{ color: 'black', strokes: getStrokes([...node.outline, ...node.label]) }],
			node.bounds,
			CROP_PADDING * scale
		)
		const answers = await askAboutImage('node', png, nodeQuestions(), log)
		const shape = getChoice(answers.shape).choice
		return [
			node.id,
			{
				isOutline: getNoul(answers.is_outline),
				shape: Object.hasOwn(NODE_SHAPES, shape) ? (shape as NodeShape) : 'rectangle',
			},
		]
	})

	// [4]
	const edgeJudgments = graph.edges.map(async (edge): Promise<[string, EdgeJudgment]> => {
		if (edge.arrowheads) return [edge.id, { ends: getKnownEnds(edge.arrowheads) }]
		const png = renderCrop(
			[
				{ color: START_NODE_COLOR, strokes: getStrokes(nodesById.get(edge.from)!.outline) },
				{ color: END_NODE_COLOR, strokes: getStrokes(nodesById.get(edge.to)!.outline) },
				{ color: 'black', strokes: getStrokes(edge.strokes) },
			],
			edge.bounds,
			CONNECTOR_CROP_PADDING * scale
		)
		const answers = await askAboutImage('sketch', png, arrowQuestions(), log)
		const a = getChoice(answers.ends).probabilities
		const b = getChoice(answers.ends_reversed).probabilities
		const ends = Object.fromEntries(
			(Object.keys(ARROW_ENDS) as ArrowEnds[]).map((k) => [k, ((a[k] ?? 0) + (b[k] ?? 0)) / 2])
		) as Record<ArrowEnds, number>
		return [edge.id, { ends }]
	})

	// [5]
	const labelReadings = [...graph.nodes, ...graph.edges]
		.filter((item) => !item.text && item.label.length > 0)
		.map(async (item): Promise<[string, LabelReading]> => {
			const png = renderCrop(
				[{ color: 'black', strokes: getStrokes(item.label) }],
				getBounds(item.label),
				CROP_PADDING * scale
			)
			return [item.id, await readHandwriting(png, candidates, log)]
		})

	// One Promise.all over all three, so a failure in one group can't leave the others' rejections
	// unhandled.
	const [nodes, edges, labels] = await Promise.all([
		Promise.all(nodeJudgments),
		Promise.all(edgeJudgments),
		Promise.all(labelReadings),
	])
	const judgments: SketchJudgments = {
		nodes: new Map(nodes),
		edges: new Map(edges),
		labels: new Map(labels),
	}
	const { source, notes, nodeCount } = buildMermaid(graph, judgments)
	if (nodeCount === 0) {
		throw new Error(`TypeSafe didn't recognize any of the outlines as shapes. ${notes.join(' ')}`)
	}
	const bounds = Box.Common(
		shapes.map((shape) => editor.getShapePageBounds(shape)).filter((b): b is Box => !!b)
	)
	return { source, notes, graph, log, bounds }
}

// tldraw has no stadium geo; its pill-shaped oval is closer than the default ellipse.
const mapNodeToRenderSpec: MermaidNodeRenderMapper = ({ kind }) =>
	kind === 'stadium' ? { variant: 'geo', geo: 'oval' } : undefined

/** Where a diagram goes, and the page bounds of the sketch it was made from. */
export interface DiagramTarget {
	position: VecLike
	sketch: Box
}

/**
 * Creates the diagram with its top-left corner at `target.position`, as one undo step, and
 * returns the ids of the new shapes. A diagram this example drew earlier from an overlapping
 * sketch on the same page is replaced.
 */
export async function insertMermaidDiagram(
	editor: Editor,
	source: string,
	target: DiagramTarget
): Promise<TLShapeId[]> {
	const { createMermaidDiagram, MermaidDiagramError } = await import('@tldraw/mermaid')
	const markId = editor.markHistoryStoppingPoint('sketch to mermaid')
	// [6]
	editor.deleteShapes(
		editor.getCurrentPageShapes().filter((shape) => {
			const sketch = shape.meta[DIAGRAM_META] as BoxModel | undefined
			return sketch && Box.From(sketch).collides(target.sketch)
		})
	)
	const before = new Set(editor.getCurrentPageShapeIds())
	try {
		// Labels are measured as they're created. Before the draw font has loaded, they'd be
		// measured in a fallback font and clipped once it arrives. A sketch with no typed text
		// may not have loaded it yet.
		await editor.fonts.ensureFontIsLoaded(DefaultFontFaces.tldraw_draw.normal.normal)
		await createMermaidDiagram(editor, source, {
			blueprintRender: { position: target.position, centerOnPosition: false, mapNodeToRenderSpec },
		})
	} catch (e) {
		// Puts back the diagram being replaced.
		editor.bailToMark(markId)
		// [7]
		if (e instanceof MermaidDiagramError && e.type === 'parse') {
			const mermaid = (await import('mermaid')).default
			await mermaid.parse(source)
		}
		throw e
	}
	const created = [...editor.getCurrentPageShapeIds()].filter((id) => !before.has(id))
	const { x, y, w, h } = target.sketch
	editor.updateShapes(
		created.map((id) => {
			const shape = editor.getShape(id)!
			return { ...shape, meta: { ...shape.meta, [DIAGRAM_META]: { x, y, w, h } } }
		})
	)
	return created
}

/** Certain answers for a tldraw arrow, whose arrowheads are in its props. */
function getKnownEnds({ from, to }: { from: boolean; to: boolean }): Record<ArrowEnds, number> {
	const ends: ArrowEnds =
		from && to ? 'both_ends' : to ? 'toward_blue' : from ? 'toward_red' : 'no_arrowhead'
	return { toward_blue: 0, toward_red: 0, both_ends: 0, no_arrowhead: 0, [ends]: 1 }
}

function dedupe(labels: string[]) {
	const seen = new Set<string>()
	return labels.filter((label) => {
		const key = label.trim().toLowerCase()
		if (!key || seen.has(key)) return false
		seen.add(key)
		return true
	})
}

/*
[1]
Switching to the draw tool keeps the old selection, so the selection only counts while the select
tool is active. Otherwise every sketch shape on the page is read.

[2]
Drawings and tldraw's own shapes can be mixed. A rectangle, ellipse or note from the toolbar is a
node whose shape and label are known exactly, and an arrow or line is a connector whose ends and
arrowheads are known, so none of them need TypeSafe. They still take part in the geometry: a
drawn line can join two tldraw rectangles, and handwriting inside one is its label.

[3]
One request per drawn node, with the node's outline and anything drawn inside it as the state.
The requests are small and fast (about a quarter of a second each), and keeping each image on its
own means no question has to find its node among others.

[4]
Each drawn connector is drawn in black between its two nodes, with the node where the stroke
starts in red and the node where it ends in blue. TypeSafe says which ends have arrowheads; it is
asked with the options in both orders, and the two answers are averaged.

[5]
Typed text is exact, so only handwritten labels are sent. See readLabel.ts.

[6]
The diagram to replace is found in the store, not remembered by the panel, so it stays right
after undo and redo, and when the panel remounts. Only diagrams on this page, drawn from a sketch
that overlaps this one, are replaced: converting a second sketch keeps the first one's diagram.

[7]
@tldraw/mermaid reports a parse error without mermaid's message. Parsing again without
suppressing errors throws the real message, with the line it failed on.
*/
