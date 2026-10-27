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
	/** In the space of the stroke's parent. */
	recognition: R
	/** Maps the parent's space to page space. */
	parentTransform: Mat
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
		// [1]
		const points = editor
			.getShapeLocalTransform(shape)
			.applyToPoints(
				getPointsFromDrawSegments(shape.props.segments, shape.props.scaleX, shape.props.scaleY)
			)
		const recognition = recognizeStroke(points)
		const parentTransform = editor.getShapeParentTransform(shape)
		if (recognition.kind === 'line') lineStrokes.push({ shape, recognition, parentTransform })
		else if (recognition.kind === 'chevron') {
			chevronStrokes.push({ shape, recognition, parentTransform })
		} else if (recognition.kind !== 'unknown') {
			geoStrokes.push({ shape, recognition, parentTransform })
		}
	}

	const result = { converted: 0, total: strokes.length }
	if (geoStrokes.length === 0 && lineStrokes.length === 0) return result

	// [2]
	const markId = editor.markHistoryStoppingPoint('convert drawings to shapes')
	const created: TLShapeId[] = []
	const replaced = new Set<TLShapeId>()
	editor.run(() => {
		// [3]
		for (const stroke of geoStrokes) {
			created.push(createGeoShape(editor, stroke))
			replaced.add(stroke.shape.id)
		}

		const arrowheads = matchArrowheads(editor, lineStrokes, chevronStrokes)
		// Strokes that stay as ink are still shapes an arrow can connect to.
		const recognized = new Set(
			[...geoStrokes, ...lineStrokes, ...chevronStrokes].map((stroke) => stroke.shape.id)
		)
		for (const stroke of lineStrokes) {
			const drawnArrowheads = arrowheads.get(stroke.shape.id) ?? {}
			const id = createLineOrArrow(editor, stroke, drawnArrowheads, recognized)
			if (!id) continue
			created.push(id)
			replaced.add(stroke.shape.id)
			if (drawnArrowheads.start) replaced.add(drawnArrowheads.start)
			if (drawnArrowheads.end) replaced.add(drawnArrowheads.end)
		}

		// [4]
		editor.deleteShapes([...replaced])
		editor.setSelectedShapes([
			...created,
			...strokes.filter((shape) => !replaced.has(shape.id)).map((shape) => shape.id),
		])
	})

	// [5]
	if (created.length === 0) editor.bailToMark(markId)
	result.converted = replaced.size
	return result
}

function createGeoShape(editor: Editor, { shape, recognition }: Stroke<GeoStrokeRecognition>) {
	const { center, width, height, rotation, flipY } = recognition
	// [6]
	const { x, y } = Vec.Sub(center, Vec.Rot(new Vec(width / 2, height / 2), rotation))
	const id = createShapeId()
	editor.createShape<TLGeoShape>({
		id,
		type: 'geo',
		parentId: shape.parentId,
		index: getIndexAbove(editor, shape),
		x,
		y,
		rotation: canonicalizeRotation(rotation),
		opacity: shape.opacity,
		props: {
			geo: recognition.kind,
			w: Math.max(1, width),
			h: Math.max(1, height),
			flipY,
			dash: 'draw',
			color: shape.props.color,
			// A draw shape only shows its fill once tldraw has decided it's closed.
			fill: shape.props.isClosed ? shape.props.fill : 'none',
			size: shape.props.size,
			scale: shape.props.scale,
		},
	})

	// [7]
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
	{ shape, recognition, parentTransform }: Stroke<LineStrokeRecognition>,
	drawnArrowheads: DrawnArrowheads,
	recognized: Set<TLShapeId>
): TLShapeId | null {
	const { start, end } = recognition
	const pageStart = Mat.applyToPoint(parentTransform, start)
	const pageEnd = Mat.applyToPoint(parentTransform, end)
	const targets = {
		start: getConnectionTarget(editor, shape, pageStart, recognized),
		end: getConnectionTarget(editor, shape, pageEnd, recognized),
	}
	const arrowheadAtStart = recognition.arrowheadAtStart || !!drawnArrowheads.start
	const arrowheadAtEnd = recognition.arrowheadAtEnd || !!drawnArrowheads.end
	const isArrow = !!(targets.start || targets.end || arrowheadAtStart || arrowheadAtEnd)
	// A line shape can't bend, so an arc that doesn't become an arrow stays as ink.
	if (!isArrow && recognition.arcMidpoint) return null

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
	const pageEnds = { start: pageStart, end: pageEnd }
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
						normalizedAnchor: getNormalizedAnchor(editor, target, pageEnds[terminal]),
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
		const middle = editor.getPointInShapeSpace(
			arrow,
			Mat.applyToPoint(parentTransform, recognition.arcMidpoint)
		)
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
	pagePoint: VecLike,
	recognized: Set<TLShapeId>
) {
	const target = editor.getShapeAtPoint(pagePoint, {
		hitInside: true,
		margin: CONNECT_DISTANCE / editor.getZoomLevel(),
		filter: (shape) =>
			!recognized.has(shape.id) &&
			// Imprecise bindings aim at a shape's center, which only makes sense for closed shapes.
			editor.getShapeGeometry(shape).isClosed &&
			editor.canBindShapes({ fromShape: { type: 'arrow' }, toShape: shape, binding: 'arrow' }),
	})
	// The frame a stroke was drawn in isn't something it connects to. It's ruled out here rather than
	// in the filter so that it still stops the search from reaching shapes hidden behind it.
	return target && !editor.hasAncestor(stroke, target.id) ? target : undefined
}

/** Where `point` sits in the target's bounds, from (0, 0) at the top left to (1, 1) at the bottom right. */
function getNormalizedAnchor(editor: Editor, target: TLShape, pagePoint: VecLike) {
	const { bounds } = editor.getShapeGeometry(target)
	const local = editor.getPointInShapeSpace(target, pagePoint)
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
	// A line and its arrowhead can sit in different parents, so compare them on the page.
	const pageChevrons = chevrons.map(({ shape, recognition, parentTransform }) => ({
		id: shape.id,
		apex: Mat.applyToPoint(parentTransform, recognition.apex),
		direction: Vec.Rot(recognition.direction, parentTransform.rotation()),
		size: recognition.size,
	}))

	const candidates: {
		line: TLShapeId
		terminal: 'start' | 'end'
		chevron: TLShapeId
		distance: number
	}[] = []
	for (const { shape, recognition, parentTransform } of lines) {
		const length = Vec.Dist(recognition.start, recognition.end)
		for (const terminal of ['start', 'end'] as const) {
			const hasHook =
				terminal === 'start' ? recognition.arrowheadAtStart : recognition.arrowheadAtEnd
			if (hasHook) continue
			const point = Mat.applyToPoint(parentTransform, recognition[terminal])
			const outward = Vec.Rot(
				terminal === 'start' ? recognition.startDirection : recognition.endDirection,
				parentTransform.rotation()
			)
			for (const chevron of pageChevrons) {
				const distance = Vec.Dist(chevron.apex, point)
				const reach = Math.max(
					ARROWHEAD_REACH * chevron.size,
					CONNECT_DISTANCE / editor.getZoomLevel()
				)
				if (
					distance <= reach &&
					Vec.Dpr(chevron.direction, outward) >= ARROWHEAD_ALIGNMENT &&
					chevron.size <= MAX_ARROWHEAD_RATIO * length
				) {
					candidates.push({ line: shape.id, terminal, chevron: chevron.id, distance })
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
Strokes are recognized in their parent's space, so a stroke drawn inside a rotated frame snaps
to the frame's axes rather than the page's. Points that get hit-tested or compared across
parents are moved onto the page with the parent's transform.

[2]
Everything between this stopping point and the next one is a single undo step, including the
selection change. We only mark once we know there is something to convert, so pressing the
shortcut on strokes that can't be recognized doesn't leave an empty step in the undo stack.

[3]
Closed strokes become geo shapes first, so that lines and arrows created afterwards can connect to
them as well as to shapes that were already on the canvas.

[4]
The strokes are deleted last because their replacements are placed relative to them, at an index
just above theirs.

[5]
Arcs that don't touch a shape and have no arrowhead stay as ink, so it's possible to get here
without creating anything. `bailToMark` drops the stopping point along with the selection change.

[6]
A geo shape's x and y are its top-left corner in its parent's space, and it rotates about that
corner, so we work back from the fitted center.

[7]
Arrows that were already attached to the stroke stay attached to the shape that replaces it.

[8]
Arrowheads go where they were drawn. A connecting stroke with none drawn gets one where it ended.

[9]
Imprecise bindings aim the arrow at each shape's center. `normalizedAnchor` still matters for the
cases where tldraw falls back to the anchor: both ends on one shape, or one shape inside the other.

[10]
Bindings move the arrow's terminals to the centers of the shapes, so the bend is worked out from
where the terminals ended up rather than from the stroke's own ends.
*/
