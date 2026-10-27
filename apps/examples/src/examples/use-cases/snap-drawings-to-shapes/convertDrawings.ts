import {
	Editor,
	Mat,
	TLArrowBinding,
	TLArrowShape,
	TLDrawShape,
	TLGeoShape,
	TLLineShape,
	TLShape,
	TLShapeId,
	Vec,
	VecLike,
	canonicalizeRotation,
	createShapeId,
	getArrowBindings,
	getArrowTerminalsInArrowSpace,
	getIndexBetween,
	getIndices,
	getPointsFromDrawSegments,
} from 'tldraw'
import {
	ChevronStrokeRecognition,
	GeoStrokeRecognition,
	LineStrokeRecognition,
	getBendThroughPoint,
	recognizeStroke,
} from './recognizeStroke'

/** How close, in screen pixels, the end of a stroke has to come to a shape to connect to it. */
const CONNECT_DISTANCE = 16
/** A V caps a line when its apex is within this many arm lengths of the line's end... */
const ARROWHEAD_REACH = 0.75
/** ...points the same way as the line, give or take 40°... */
const ARROWHEAD_ALIGNMENT = Math.cos((40 * Math.PI) / 180)
/** ...and is small next to it. */
const MAX_ARROWHEAD_RATIO = 0.6

interface Stroke<R> {
	shape: TLDrawShape
	recognition: R
}

interface DrawnArrowheads {
	start?: TLShapeId
	end?: TLShapeId
}

export interface ConversionResult {
	converted: number
	total: number
}

export function getConvertibleStrokes(editor: Editor): TLDrawShape[] {
	return editor
		.getSelectedShapes()
		.filter(
			(shape): shape is TLDrawShape =>
				editor.isShapeOfType(shape, 'draw') &&
				!editor.isShapeOrAncestorLocked(shape) &&
				!editor.findShapeAncestor(shape, (ancestor) => editor.isShapeOfType(ancestor, 'group'))
		)
}

export function convertDrawingsToShapes(editor: Editor): ConversionResult {
	const strokes = getConvertibleStrokes(editor)
	const geoStrokes: Stroke<GeoStrokeRecognition>[] = []
	const lineStrokes: Stroke<LineStrokeRecognition>[] = []
	const chevronStrokes: Stroke<ChevronStrokeRecognition>[] = []
	for (const shape of strokes) {
		const points = editor
			.getShapePageTransform(shape)
			.applyToPoints(
				getPointsFromDrawSegments(shape.props.segments, shape.props.scaleX, shape.props.scaleY)
			)
		const recognition = recognizeStroke(points)
		if (recognition.kind === 'line') lineStrokes.push({ shape, recognition })
		else if (recognition.kind === 'chevron') chevronStrokes.push({ shape, recognition })
		else if (recognition.kind !== 'unknown') geoStrokes.push({ shape, recognition })
	}

	const result = { converted: 0, total: strokes.length }
	if (geoStrokes.length === 0 && lineStrokes.length === 0) return result

	// [1]
	const markId = editor.markHistoryStoppingPoint('convert drawings to shapes')
	const created: TLShapeId[] = []
	const replaced = new Set<TLShapeId>()
	editor.run(() => {
		// [2]
		for (const stroke of geoStrokes) {
			created.push(createGeoShape(editor, stroke))
			replaced.add(stroke.shape.id)
		}

		const arrowheads = matchArrowheads(editor, lineStrokes, chevronStrokes)
		const sources = new Set(strokes.map((shape) => shape.id))
		for (const stroke of lineStrokes) {
			const drawnArrowheads = arrowheads.get(stroke.shape.id) ?? {}
			const id = createLineOrArrow(editor, stroke, drawnArrowheads, sources)
			if (!id) continue
			created.push(id)
			replaced.add(stroke.shape.id)
			if (drawnArrowheads.start) replaced.add(drawnArrowheads.start)
			if (drawnArrowheads.end) replaced.add(drawnArrowheads.end)
		}

		// [3]
		editor.deleteShapes([...replaced])
		editor.setSelectedShapes([
			...created,
			...strokes.filter((shape) => !replaced.has(shape.id)).map((shape) => shape.id),
		])
	})

	// [4]
	if (created.length === 0) editor.bailToMark(markId)
	result.converted = replaced.size
	return result
}

function createGeoShape(editor: Editor, { shape, recognition }: Stroke<GeoStrokeRecognition>) {
	const { center, width, height, rotation, flipY } = recognition
	// [5]
	const parentTransform = editor.getShapeParentTransform(shape)
	const pageTopLeft = Vec.Sub(center, Vec.Rot(new Vec(width / 2, height / 2), rotation))
	const { x, y } = Mat.applyToPoint(Mat.Inverse(parentTransform), pageTopLeft)
	const id = createShapeId()
	editor.createShape<TLGeoShape>({
		id,
		type: 'geo',
		parentId: shape.parentId,
		index: getIndexAbove(editor, shape),
		x,
		y,
		rotation: canonicalizeRotation(rotation - parentTransform.rotation()),
		opacity: shape.opacity,
		props: {
			geo: recognition.kind,
			w: Math.max(1, width),
			h: Math.max(1, height),
			flipY,
			dash: 'draw',
			color: shape.props.color,
			fill: shape.props.fill,
			size: shape.props.size,
			scale: shape.props.scale,
		},
	})

	// [6]
	for (const binding of editor.getBindingsToShape<TLArrowBinding>(shape, 'arrow')) {
		editor.updateBinding<TLArrowBinding>({
			id: binding.id,
			type: 'arrow',
			toId: id,
			props: { isPrecise: false },
		})
	}
	return id
}

function createLineOrArrow(
	editor: Editor,
	{ shape, recognition }: Stroke<LineStrokeRecognition>,
	drawnArrowheads: DrawnArrowheads,
	sources: Set<TLShapeId>
): TLShapeId | null {
	const startTarget = getConnectionTarget(editor, shape, recognition.start, sources)
	const endTarget = getConnectionTarget(editor, shape, recognition.end, sources)
	// [7]
	const crossesOneShape = startTarget && startTarget === endTarget && !recognition.arcMidpoint
	const targets = crossesOneShape ? {} : { start: startTarget, end: endTarget }
	const arrowheadAtStart = recognition.arrowheadAtStart || !!drawnArrowheads.start
	const arrowheadAtEnd = recognition.arrowheadAtEnd || !!drawnArrowheads.end
	const isArrow = !!(targets.start || targets.end || arrowheadAtStart || arrowheadAtEnd)
	// A line shape can't bend, so an arc that doesn't become an arrow stays as ink.
	if (!isArrow && recognition.arcMidpoint) return null

	const start = editor.getPointInParentSpace(shape, recognition.start)
	const end = editor.getPointInParentSpace(shape, recognition.end)
	const id = createShapeId()
	const base = {
		id,
		parentId: shape.parentId,
		index: getIndexAbove(editor, shape),
		x: start.x,
		y: start.y,
		rotation: 0,
		opacity: shape.opacity,
	}
	const { color, size, fill, scale } = shape.props

	if (!isArrow) {
		const [first, last] = getIndices(2)
		editor.createShape<TLLineShape>({
			...base,
			type: 'line',
			props: {
				dash: 'draw',
				spline: 'line',
				color,
				size,
				scale,
				points: {
					[first]: { id: first, index: first, x: 0, y: 0 },
					[last]: { id: last, index: last, x: end.x - start.x, y: end.y - start.y },
				},
			},
		})
		return id
	}

	editor.createShape<TLArrowShape>({
		...base,
		type: 'arrow',
		props: {
			kind: 'arc',
			dash: 'draw',
			color,
			size,
			fill,
			scale,
			// [8]
			arrowheadStart: arrowheadAtStart ? 'arrow' : 'none',
			arrowheadEnd: arrowheadAtEnd || !arrowheadAtStart ? 'arrow' : 'none',
			start: { x: 0, y: 0 },
			end: { x: end.x - start.x, y: end.y - start.y },
			bend: 0,
		},
	})

	// [9]
	editor.createBindings(
		(['start', 'end'] as const).flatMap((terminal) => {
			const target = targets[terminal]
			if (!target) return []
			return [
				{
					type: 'arrow' as const,
					fromId: id,
					toId: target.id,
					props: {
						terminal,
						normalizedAnchor: getNormalizedAnchor(editor, target, recognition[terminal]),
						isPrecise: false,
						isExact: false,
						snap: 'none' as const,
					},
				},
			]
		})
	)

	// [10]
	if (recognition.arcMidpoint) {
		const arrow = editor.getShape<TLArrowShape>(id)!
		const terminals = getArrowTerminalsInArrowSpace(editor, arrow, getArrowBindings(editor, arrow))
		const middle = editor.getPointInShapeSpace(arrow, recognition.arcMidpoint)
		editor.updateShape<TLArrowShape>({
			id,
			type: 'arrow',
			props: { bend: getBendThroughPoint(terminals.start, terminals.end, middle) },
		})
	}
	return id
}

function getConnectionTarget(
	editor: Editor,
	stroke: TLDrawShape,
	point: VecLike,
	sources: Set<TLShapeId>
) {
	return editor.getShapeAtPoint(point, {
		hitInside: true,
		margin: CONNECT_DISTANCE / editor.getZoomLevel(),
		filter: (target) =>
			!sources.has(target.id) &&
			// The frame a stroke was drawn in isn't something it connects to.
			!editor.hasAncestor(stroke, target.id) &&
			// Imprecise bindings aim at a shape's center, which only makes sense for closed shapes.
			editor.getShapeGeometry(target).isClosed &&
			editor.canBindShapes({ fromShape: { type: 'arrow' }, toShape: target, binding: 'arrow' }),
	})
}

/** Where `point` sits in the target's bounds, from (0, 0) at the top left to (1, 1) at the bottom right. */
function getNormalizedAnchor(editor: Editor, target: TLShape, point: VecLike) {
	const { bounds } = editor.getShapeGeometry(target)
	const local = editor.getPointInShapeSpace(target, point)
	return {
		x: bounds.w ? Math.min(1, Math.max(0, (local.x - bounds.minX) / bounds.w)) : 0.5,
		y: bounds.h ? Math.min(1, Math.max(0, (local.y - bounds.minY) / bounds.h)) : 0.5,
	}
}

/** Pairs each V-shaped stroke with the line end it caps, closest pairs first. */
function matchArrowheads(
	editor: Editor,
	lines: Stroke<LineStrokeRecognition>[],
	chevrons: Stroke<ChevronStrokeRecognition>[]
) {
	const candidates: {
		line: TLShapeId
		terminal: 'start' | 'end'
		chevron: TLShapeId
		distance: number
	}[] = []
	for (const { shape, recognition } of lines) {
		const length = Vec.Dist(recognition.start, recognition.end)
		for (const terminal of ['start', 'end'] as const) {
			const hasHook =
				terminal === 'start' ? recognition.arrowheadAtStart : recognition.arrowheadAtEnd
			if (hasHook) continue
			const outward = terminal === 'start' ? recognition.startDirection : recognition.endDirection
			for (const chevron of chevrons) {
				const { apex, direction, size } = chevron.recognition
				const distance = Vec.Dist(apex, recognition[terminal])
				const reach = Math.max(ARROWHEAD_REACH * size, CONNECT_DISTANCE / editor.getZoomLevel())
				if (
					distance <= reach &&
					Vec.Dpr(direction, outward) >= ARROWHEAD_ALIGNMENT &&
					size <= MAX_ARROWHEAD_RATIO * length
				) {
					candidates.push({ line: shape.id, terminal, chevron: chevron.shape.id, distance })
				}
			}
		}
	}

	const matches = new Map<TLShapeId, DrawnArrowheads>()
	const usedChevrons = new Set<TLShapeId>()
	for (const { line, terminal, chevron } of candidates.sort((a, b) => a.distance - b.distance)) {
		const arrowheads = matches.get(line) ?? {}
		if (usedChevrons.has(chevron) || arrowheads[terminal]) continue
		arrowheads[terminal] = chevron
		matches.set(line, arrowheads)
		usedChevrons.add(chevron)
	}
	return matches
}

/** An index just above the stroke and below whatever sat above it, so the new shape takes its place. */
function getIndexAbove(editor: Editor, shape: TLShape) {
	const siblings = editor.getSortedChildIdsForParent(shape.parentId)
	const above = siblings[siblings.indexOf(shape.id) + 1]
	return getIndexBetween(shape.index, above ? editor.getShape(above)?.index : undefined)
}

/*
[1]
Everything between this stopping point and the next one is a single undo step, including the
selection change. We only mark once we know there is something to convert, so pressing the
shortcut on strokes that can't be recognized doesn't leave an empty step in the undo stack.

[2]
Closed strokes become geo shapes first, so that lines and arrows created afterwards can connect to
them as well as to shapes that were already on the canvas.

[3]
The strokes are deleted last because their replacements are placed relative to them: in their
parent's space, at an index just above theirs.

[4]
Arcs that don't touch a shape and have no arrowhead stay as ink, so it's possible to get here
without creating anything. `bailToMark` drops the stopping point along with the selection change.

[5]
A geo shape's x and y are its top-left corner in its parent's space, and it rotates about that
corner. We work out the corner in page space from the fitted center, then move it into the parent,
which may be a rotated frame.

[6]
Arrows that were already attached to the stroke stay attached to the shape that replaces it.

[7]
A straight stroke that starts and ends on the same shape was drawn across it, not between shapes.
An arced one is a loop from the shape back to itself.

[8]
Arrowheads go where they were drawn. A connecting stroke with none drawn gets one where it ended.

[9]
Imprecise bindings aim the arrow at each shape's center. `normalizedAnchor` still matters for the
cases where tldraw falls back to the anchor: both ends on one shape, or one shape inside the other.

[10]
Bindings move the arrow's terminals to the centers of the shapes, so the bend is worked out from
where the terminals ended up rather than from the stroke's own ends.
*/
