import { Vec, VecLike, centerOfCircleFromThreePoints } from 'tldraw'

// Recognizes a freehand stroke from its page-space points. It knows nothing about the editor, so
// every threshold below can be tuned against the fixtures in recognizeStroke.test.ts.

export type GeoStrokeKind = 'rectangle' | 'ellipse' | 'triangle' | 'diamond'

export interface GeoStrokeRecognition {
	kind: GeoStrokeKind
	/** Center of the fitted box, in page space. */
	center: Vec
	/** Size of the fitted box along its own rotated axes. */
	width: number
	height: number
	/** Clockwise, in radians. Zero for strokes drawn within a few degrees of axis-aligned. */
	rotation: number
	/** Triangles only: the apex points down rather than up. */
	flipY: boolean
	confidence: number
}

export interface LineStrokeRecognition {
	kind: 'line'
	/** Ends of the shaft, without any arrowhead drawn at the end of the same stroke. */
	start: Vec
	end: Vec
	/** Unit vectors pointing out of the stroke at each end. */
	startDirection: Vec
	endDirection: Vec
	/** The shaft's halfway point, set only when the stroke is clearly arced. */
	arcMidpoint: Vec | null
	/** The stroke doubles back at this end to draw an arrowhead. */
	arrowheadAtStart: boolean
	arrowheadAtEnd: boolean
	confidence: number
}

export interface ChevronStrokeRecognition {
	kind: 'chevron'
	apex: Vec
	/** Unit vector from the open side of the V towards its apex. */
	direction: Vec
	/** Length of the longer arm. */
	size: number
	confidence: number
}

export interface UnrecognizedStroke {
	kind: 'unknown'
	confidence: 0
}

export type StrokeRecognition =
	| GeoStrokeRecognition
	| LineStrokeRecognition
	| ChevronStrokeRecognition
	| UnrecognizedStroke

const RESAMPLE_COUNT = 128
const LOOP_RESAMPLE_COUNT = 64
const SNAP_ANGLE = (10 * Math.PI) / 180

/** A stroke is closed when its end comes back within this share of its bounding-box diagonal. */
const CLOSE_GAP_RATIO = 0.2
/** Up to this share of the stroke may overshoot the start, or lead in before the loop begins. */
const MAX_OVERSHOOT_RATIO = 0.25
/** A loop's own area must be at least this share of its hull's. Rules out figure eights and back-and-forth scribbles. */
const MIN_LOOP_FILL = 0.6
/** Loops thinner than this are slivers, not shapes. */
const MIN_LOOP_ASPECT = 0.05

// The convex hull's area as a share of the smallest rectangle around the stroke: about 1 for a
// rectangle, 0.79 for an ellipse and 0.5 for a triangle. These gates decide which candidates get
// fitted at all. Diamonds range from 0.5 to 1 depending on their proportions, so they're always
// fitted.
const RECTANGLE_MIN_FILL = 0.8
const ELLIPSE_MIN_FILL = 0.65
const ELLIPSE_MAX_FILL = 0.92
const TRIANGLE_MAX_FILL = 0.72

/** Mean distance between the stroke and the fitted outline, as a share of the shape's size. */
const MAX_GEO_FIT_ERROR = 0.06
/** Ellipses rounder than this are treated as circles, whose fitted rotation is just noise. */
const CIRCLE_ASPECT = 0.9
/**
 * A square fits a rectangle and a diamond equally well. Errors within this ratio, or this margin
 * for strokes so clean that both errors are close to zero, count as a tie.
 */
const SQUARE_TIE_RATIO = 1.35
const SQUARE_TIE_MARGIN = 0.01
/** How much an equilateral-ish triangle prefers an axis-aligned reading over a tilted one. */
const TRIANGLE_TILT_WEIGHT = 0.015

/** Simplification tolerance for open strokes, as a share of their length. Small enough to keep an arrowhead's barbs. */
const SIMPLIFY_RATIO = 0.02
/** An arrowhead drawn at the end of a stroke reaches this far back from the tip, relative to the shaft. */
const MIN_BARB_RATIO = 0.06
const MAX_BARB_RATIO = 0.45
/** The stroke must double back by at least this much at the tip to count as an arrowhead. */
const MIN_BARB_TURN = (100 * Math.PI) / 180

/** Straight lines stray at most this share of their length from the line between their ends. */
const MAX_LINE_DEVIATION = 0.07
/** Arcs stay within this share of their chord from the circle through their ends and middle. */
const MAX_ARC_ERROR = 0.035
/** A semicircle is about 1.57 times its chord. Anything longer is a loop, not a connector. */
const MAX_ARC_LENGTH_RATIO = 1.8
/** Any sharper turn is a corner, and a stroke with a corner isn't an arc. */
const MAX_ARC_TURN = (50 * Math.PI) / 180

const CHEVRON_SIMPLIFY_RATIO = 0.06
const CHEVRON_MIN_ARM_RATIO = 0.4
const CHEVRON_MIN_ANGLE = (15 * Math.PI) / 180
const CHEVRON_MAX_ANGLE = (110 * Math.PI) / 180
const CHEVRON_MAX_ARM_DEVIATION = 0.12

const UNRECOGNIZED: UnrecognizedStroke = { kind: 'unknown', confidence: 0 }

export function recognizeStroke(points: VecLike[]): StrokeRecognition {
	const path = removeDuplicatePoints(points)
	if (path.length < 2 || getPathLength(path) === 0) return UNRECOGNIZED

	const resampled = resample(path, RESAMPLE_COUNT)
	const loop = getClosedLoop(resampled)
	const closed = loop ? recognizeClosedStroke(loop) : null
	return closed ?? recognizeLine(resampled) ?? recognizeChevron(resampled) ?? UNRECOGNIZED
}

/**
 * The `bend` an arc arrow from `start` to `end` needs so that it passes through `through`. tldraw
 * places the arc's middle at the chord's midpoint plus `bend` along the chord normal (-y, x).
 */
export function getBendThroughPoint(start: VecLike, end: VecLike, through: VecLike): number {
	const length = Vec.Dist(start, end)
	if (length === 0) return 0
	const u = Vec.Div(Vec.Sub(end, start), length)
	const n = new Vec(-u.y, u.x)
	const offset = Vec.Sub(through, Vec.Med(start, end))
	const along = Vec.Dpr(offset, u)
	const across = Vec.Dpr(offset, n)
	if (Math.abs(across) < 1e-9 * length) return 0
	const half = length / 2
	// The circle through all three points is centred `centre` along the normal from the chord's midpoint.
	const centre = (along * along + across * across - half * half) / (2 * across)
	return centre + Math.sign(across) * Math.hypot(half, centre)
}

interface GeoFit {
	kind: GeoStrokeKind
	center: Vec
	width: number
	height: number
	/** The fitted orientation, before snapping. For triangles, the turn from pointing up. */
	rotation: number
	/** The ideal outline the stroke is scored against. */
	outline: Vec[]
}

function recognizeClosedStroke(loop: Vec[]): GeoStrokeRecognition | null {
	const points = resampleLoop(loop, LOOP_RESAMPLE_COUNT)
	const hull = getConvexHull(points)
	const hullArea = getPolygonArea(hull)
	if (hullArea === 0 || getPolygonArea(points) < MIN_LOOP_FILL * hullArea) return null

	const minRect = getMinAreaRect(hull)
	if (
		Math.min(minRect.width, minRect.height) <
		MIN_LOOP_ASPECT * Math.max(minRect.width, minRect.height)
	) {
		return null
	}
	const fill = hullArea / (minRect.width * minRect.height)

	const size = Math.sqrt(minRect.width * minRect.height)
	const fits: GeoFit[] = []
	if (fill >= RECTANGLE_MIN_FILL) fits.push(fitRectangle(points, minRect.rotation))
	if (fill >= ELLIPSE_MIN_FILL && fill <= ELLIPSE_MAX_FILL) fits.push(fitEllipse(points))
	if (fill <= TRIANGLE_MAX_FILL) fits.push(fitTriangle(points, hull, size))
	fits.push(fitDiamond(points))

	const scored = fits.map((fit) => ({ fit, error: getFitError(points, fit.outline) / size }))
	scored.sort((a, b) => a.error - b.error)
	let best = scored[0]

	// A square fits both a rectangle and a diamond. It's a diamond only when its corners sit near the
	// midpoints of its upright bounding box's edges, which is exactly when the diamond's diagonals
	// snap to the axes.
	if (best.fit.kind === 'rectangle' || best.fit.kind === 'diamond') {
		const otherKind = best.fit.kind === 'rectangle' ? 'diamond' : 'rectangle'
		const other = scored.find((s) => s.fit.kind === otherKind)
		if (
			other &&
			other.error <= Math.max(best.error * SQUARE_TIE_RATIO, best.error + SQUARE_TIE_MARGIN)
		) {
			const diamond = best.fit.kind === 'diamond' ? best : other
			const rectangle = best.fit.kind === 'rectangle' ? best : other
			best = snapToQuarterTurn(diamond.fit.rotation) === 0 ? diamond : rectangle
		}
	}
	if (best.error > MAX_GEO_FIT_ERROR) return null

	// Snapping only turns the shape: it keeps the size and center it was fitted with, so a slightly
	// tilted rectangle doesn't grow to cover its upright bounding box.
	const { kind, center, width, height } = best.fit
	let rotation = snapToQuarterTurn(best.fit.rotation)
	// Downward triangles get a flip rather than a half turn, so their label stays upright.
	const flipY = kind === 'triangle' && Math.abs(rotation) > Math.PI / 2 + 1e-9
	if (flipY) rotation = snapToQuarterTurn(normalizeHalfTurn(rotation - Math.PI))

	return {
		kind,
		center,
		width,
		height,
		rotation,
		flipY,
		confidence: 1 - best.error / MAX_GEO_FIT_ERROR,
	}
}

function fitRectangle(points: Vec[], minRectRotation: number): GeoFit {
	const rotation = normalizeQuarterTurn(minRectRotation)
	const box = getExtentsInFrame(points, rotation)
	return { kind: 'rectangle', ...box, rotation, outline: getBoxCorners(box, rotation) }
}

function fitEllipse(points: Vec[]): GeoFit {
	// An ellipse's minimum-area rectangle barely changes as it turns, so its angle is noisy. The
	// principal axes of the points are stable.
	const { rotation: axis, aspect } = getPrincipalAxes(points)
	const rotation = aspect > CIRCLE_ASPECT ? 0 : normalizeQuarterTurn(axis)
	const box = getExtentsInFrame(points, rotation)
	const { u, v } = getFrame(rotation)
	const outline: Vec[] = []
	for (let i = 0; i < LOOP_RESAMPLE_COUNT; i++) {
		const t = (i / LOOP_RESAMPLE_COUNT) * Math.PI * 2
		outline.push(
			Vec.Add(
				box.center,
				Vec.Add(
					Vec.Mul(u, (Math.cos(t) * box.width) / 2),
					Vec.Mul(v, (Math.sin(t) * box.height) / 2)
				)
			)
		)
	}
	return { kind: 'ellipse', ...box, rotation, outline }
}

function fitTriangle(points: Vec[], hull: Vec[], size: number): GeoFit {
	const corners = getLargestTriangle(hull)

	// tldraw's triangle is isosceles, with its apex centred over a base along the bottom of its box.
	// Try each side as the base and keep the reading that matches the stroke best. An equilateral
	// triangle reads equally well three ways, so lean towards readings close to axis-aligned.
	let best: GeoFit | null = null
	let bestScore = Infinity
	for (let i = 0; i < 3; i++) {
		const a = corners[i]
		const b = corners[(i + 1) % 3]
		const normal = Vec.Per(Vec.Sub(b, a)).uni()
		const direction = Vec.Dpr(normal, Vec.Sub(corners[(i + 2) % 3], a)) < 0 ? normal.neg() : normal
		// The rotation that turns the triangle's "up" into the direction it points.
		const rotation = Math.atan2(direction.x, -direction.y)
		const box = getExtentsInFrame(points, rotation)
		const outline = getTriangleCorners(box, rotation)
		const quarter = Math.PI / 2
		const tilt = Math.abs(rotation - Math.round(rotation / quarter) * quarter) / (quarter / 2)
		const score =
			average(points, (p) => getDistanceToPolygon(p, outline)) / size + TRIANGLE_TILT_WEIGHT * tilt
		if (score < bestScore) {
			bestScore = score
			best = { kind: 'triangle', ...box, rotation, outline }
		}
	}
	return best!
}

function fitDiamond(points: Vec[]): GeoFit {
	// A diamond's diagonals are its axes. Try every orientation and keep the closest.
	let bestRotation = 0
	let bestError = Infinity
	for (let degrees = 0; degrees < 90; degrees += 2) {
		const rotation = (degrees * Math.PI) / 180
		const outline = getDiamondCorners(getExtentsInFrame(points, rotation), rotation)
		const error = average(points, (p) => getDistanceToPolygon(p, outline))
		if (error < bestError) {
			bestError = error
			bestRotation = rotation
		}
	}
	const rotation = normalizeQuarterTurn(bestRotation)
	const box = getExtentsInFrame(points, rotation)
	return { kind: 'diamond', ...box, rotation, outline: getDiamondCorners(box, rotation) }
}

function recognizeLine(points: Vec[]): LineStrokeRecognition | null {
	const last = points.length - 1
	const vertices = simplify(points, SIMPLIFY_RATIO * getPathLength(points))
	const endTip = findArrowheadTip(points, vertices)
	const reversedTip = findArrowheadTip(
		[...points].reverse(),
		vertices.map((i) => last - i).reverse()
	)
	const startTip = last - reversedTip
	if (endTip - startTip < 2) return null

	const shaft = points.slice(startTip, endTip + 1)
	const fit = fitStraightLine(shaft) ?? fitArc(shaft)
	if (!fit) return null
	return {
		kind: 'line',
		start: shaft[0],
		end: shaft[shaft.length - 1],
		...fit,
		arrowheadAtStart: startTip > 0,
		arrowheadAtEnd: endTip < last,
	}
}

/**
 * Walks the simplified stroke looking for a tip after which everything stays close and the stroke
 * doubles back: that tail is an arrowhead drawn without lifting the pen. Returns the index where
 * the shaft ends, which is the last point when there's no arrowhead.
 */
function findArrowheadTip(points: Vec[], vertices: number[]): number {
	const last = points.length - 1
	for (let i = 1; i < vertices.length - 1; i++) {
		const tipIndex = vertices[i]
		const tip = points[tipIndex]
		const shaftLength = Vec.Dist(points[0], tip)
		let reach = 0
		for (let j = tipIndex + 1; j <= last; j++) {
			reach = Math.max(reach, Vec.Dist(points[j], tip))
		}
		if (reach > MAX_BARB_RATIO * shaftLength) continue
		// Later tips only have shorter tails, so a flick this small means there's no arrowhead.
		if (reach < MIN_BARB_RATIO * shaftLength) return last
		const incoming = Vec.Sub(tip, points[vertices[i - 1]])
		const outgoing = Vec.Sub(points[vertices[i + 1]], tip)
		if (Math.abs(Vec.AngleBetween(incoming, outgoing)) >= MIN_BARB_TURN) return tipIndex
	}
	return last
}

type ShaftFit = Pick<
	LineStrokeRecognition,
	'startDirection' | 'endDirection' | 'arcMidpoint' | 'confidence'
>

function fitStraightLine(shaft: Vec[]): ShaftFit | null {
	const start = shaft[0]
	const end = shaft[shaft.length - 1]
	const length = Vec.Dist(start, end)
	if (length === 0) return null
	const direction = Vec.Div(Vec.Sub(end, start), length)
	let maxDeviation = 0
	for (const point of shaft) {
		maxDeviation = Math.max(maxDeviation, Math.abs(Vec.Cpr(direction, Vec.Sub(point, start))))
	}
	const deviation = maxDeviation / length
	if (deviation > MAX_LINE_DEVIATION) return null
	return {
		startDirection: direction.clone().neg(),
		endDirection: direction,
		arcMidpoint: null,
		confidence: 1 - deviation / MAX_LINE_DEVIATION,
	}
}

function fitArc(shaft: Vec[]): ShaftFit | null {
	const start = shaft[0]
	const end = shaft[shaft.length - 1]
	const middle = shaft[Math.round((shaft.length - 1) / 2)]
	const chord = Vec.Dist(start, end)
	if (chord === 0 || getPathLength(shaft) > MAX_ARC_LENGTH_RATIO * chord) return null

	const center = centerOfCircleFromThreePoints(start, middle, end)
	if (!center) return null
	const radius = (Vec.Dist(center, start) + Vec.Dist(center, middle) + Vec.Dist(center, end)) / 3
	const error = average(shaft, (p) => Math.abs(Vec.Dist(p, center) - radius)) / chord
	if (error > MAX_ARC_ERROR) return null

	const vertices = simplify(shaft, SIMPLIFY_RATIO * getPathLength(shaft))
	for (let i = 1; i < vertices.length - 1; i++) {
		const incoming = Vec.Sub(shaft[vertices[i]], shaft[vertices[i - 1]])
		const outgoing = Vec.Sub(shaft[vertices[i + 1]], shaft[vertices[i]])
		if (Math.abs(Vec.AngleBetween(incoming, outgoing)) > MAX_ARC_TURN) return null
	}

	return {
		startDirection: getTangentAway(center, start, middle),
		endDirection: getTangentAway(center, end, middle),
		arcMidpoint: middle,
		confidence: 1 - error / MAX_ARC_ERROR,
	}
}

/** The tangent to the circle at `point`, facing away from `inner`. */
function getTangentAway(center: Vec, point: Vec, inner: Vec) {
	const tangent = Vec.Per(Vec.Sub(point, center)).uni()
	return Vec.Dpr(tangent, Vec.Sub(point, inner)) < 0 ? tangent.neg() : tangent
}

function recognizeChevron(points: Vec[]): ChevronStrokeRecognition | null {
	const vertices = simplify(points, CHEVRON_SIMPLIFY_RATIO * getPathLength(points))
	if (vertices.length !== 3) return null
	const [first, apex, last] = vertices.map((i) => points[i])
	const armA = Vec.Dist(apex, first)
	const armB = Vec.Dist(apex, last)
	const size = Math.max(armA, armB)
	if (Math.min(armA, armB) < CHEVRON_MIN_ARM_RATIO * size) return null

	const angle = Math.abs(Vec.AngleBetween(Vec.Sub(first, apex), Vec.Sub(last, apex)))
	if (angle < CHEVRON_MIN_ANGLE || angle > CHEVRON_MAX_ANGLE) return null

	let maxDeviation = 0
	points.forEach((point, i) => {
		const distance =
			i <= vertices[1]
				? Vec.DistanceToLineSegment(first, apex, point)
				: Vec.DistanceToLineSegment(apex, last, point)
		maxDeviation = Math.max(maxDeviation, distance)
	})
	const deviation = maxDeviation / size
	if (deviation > CHEVRON_MAX_ARM_DEVIATION) return null

	return {
		kind: 'chevron',
		apex,
		direction: Vec.Add(Vec.Sub(apex, first).uni(), Vec.Sub(apex, last).uni()).uni(),
		size,
		confidence: 1 - deviation / CHEVRON_MAX_ARM_DEVIATION,
	}
}

/**
 * Trims the stroke to the loop it closes, allowing for an end that overshoots the start or a start
 * that leads in before the loop. Returns null when the stroke doesn't come back to where it began.
 */
function getClosedLoop(points: Vec[]): Vec[] | null {
	const last = points.length - 1
	const reach = Math.floor(last * MAX_OVERSHOOT_RATIO)
	let best = { gap: Vec.Dist(points[0], points[last]), from: 0, to: last }
	for (let i = last - reach; i < last; i++) {
		const gap = Vec.Dist(points[i], points[0])
		if (gap < best.gap) best = { gap, from: 0, to: i }
	}
	for (let i = 1; i <= reach; i++) {
		const gap = Vec.Dist(points[i], points[last])
		if (gap < best.gap) best = { gap, from: i, to: last }
	}
	if (best.gap > CLOSE_GAP_RATIO * getBoundsDiagonal(points)) return null
	return points.slice(best.from, best.to + 1)
}

function getFitError(points: Vec[], outline: Vec[]) {
	// Measure both ways, so an outline that only covers part of the stroke scores badly too.
	const toOutline = average(points, (p) => getDistanceToPolygon(p, outline))
	const toStroke = average(resampleLoop(outline, LOOP_RESAMPLE_COUNT), (p) =>
		getDistanceToPolygon(p, points)
	)
	return (toOutline + toStroke) / 2
}

interface FrameExtents {
	center: Vec
	width: number
	height: number
}

function getFrame(rotation: number) {
	return {
		u: new Vec(Math.cos(rotation), Math.sin(rotation)),
		v: new Vec(-Math.sin(rotation), Math.cos(rotation)),
	}
}

/** The box around the points, aligned to axes rotated clockwise by `rotation`. */
function getExtentsInFrame(points: Vec[], rotation: number): FrameExtents {
	const { u, v } = getFrame(rotation)
	let minU = Infinity
	let maxU = -Infinity
	let minV = Infinity
	let maxV = -Infinity
	for (const point of points) {
		const pu = Vec.Dpr(point, u)
		const pv = Vec.Dpr(point, v)
		minU = Math.min(minU, pu)
		maxU = Math.max(maxU, pu)
		minV = Math.min(minV, pv)
		maxV = Math.max(maxV, pv)
	}
	return {
		center: Vec.Add(Vec.Mul(u, (minU + maxU) / 2), Vec.Mul(v, (minV + maxV) / 2)),
		width: maxU - minU,
		height: maxV - minV,
	}
}

function getBoxCorners({ center, width, height }: FrameExtents, rotation: number) {
	const { u, v } = getFrame(rotation)
	const halfU = Vec.Mul(u, width / 2)
	const halfV = Vec.Mul(v, height / 2)
	return [
		Vec.Sub(Vec.Sub(center, halfU), halfV),
		Vec.Sub(Vec.Add(center, halfU), halfV),
		Vec.Add(Vec.Add(center, halfU), halfV),
		Vec.Add(Vec.Sub(center, halfU), halfV),
	]
}

function getDiamondCorners({ center, width, height }: FrameExtents, rotation: number) {
	const { u, v } = getFrame(rotation)
	return [
		Vec.Sub(center, Vec.Mul(v, height / 2)),
		Vec.Add(center, Vec.Mul(u, width / 2)),
		Vec.Add(center, Vec.Mul(v, height / 2)),
		Vec.Sub(center, Vec.Mul(u, width / 2)),
	]
}

/** tldraw's triangle: apex at the top centre of its box, base along the bottom. */
function getTriangleCorners({ center, width, height }: FrameExtents, rotation: number) {
	const { u, v } = getFrame(rotation)
	const halfU = Vec.Mul(u, width / 2)
	const halfV = Vec.Mul(v, height / 2)
	return [
		Vec.Sub(center, halfV),
		Vec.Add(Vec.Add(center, halfU), halfV),
		Vec.Add(Vec.Sub(center, halfU), halfV),
	]
}

/** The orientation of the points' principal axis, and how elongated they are along it. */
function getPrincipalAxes(points: Vec[]) {
	const mean = Vec.Average(points)
	let xx = 0
	let xy = 0
	let yy = 0
	for (const point of points) {
		const dx = point.x - mean.x
		const dy = point.y - mean.y
		xx += dx * dx
		xy += dx * dy
		yy += dy * dy
	}
	const spread = Math.hypot((xx - yy) / 2, xy)
	const major = (xx + yy) / 2 + spread
	const minor = (xx + yy) / 2 - spread
	return {
		rotation: Math.atan2(2 * xy, xx - yy) / 2,
		aspect: major === 0 ? 1 : Math.sqrt(Math.max(minor, 0) / major),
	}
}

/** The smallest-area rectangle around a convex hull is flush with one of its edges. */
function getMinAreaRect(hull: Vec[]) {
	let best = { ...getExtentsInFrame(hull, 0), rotation: 0 }
	for (let i = 0; i < hull.length; i++) {
		const edge = Vec.Sub(hull[(i + 1) % hull.length], hull[i])
		if (Vec.Len(edge) === 0) continue
		const rotation = Math.atan2(edge.y, edge.x)
		const box = getExtentsInFrame(hull, rotation)
		if (box.width * box.height < best.width * best.height) best = { ...box, rotation }
	}
	return best
}

function getLargestTriangle(hull: Vec[]): Vec[] {
	let best = [hull[0], hull[1], hull[2]]
	let bestArea = -1
	for (let i = 0; i < hull.length; i++) {
		for (let j = i + 1; j < hull.length; j++) {
			for (let k = j + 1; k < hull.length; k++) {
				const area = Math.abs(Vec.Cpr(Vec.Sub(hull[j], hull[i]), Vec.Sub(hull[k], hull[i])))
				if (area > bestArea) {
					bestArea = area
					best = [hull[i], hull[j], hull[k]]
				}
			}
		}
	}
	return best
}

/** Andrew's monotone chain. */
function getConvexHull(points: Vec[]): Vec[] {
	const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
	const turn = (o: Vec, a: Vec, b: Vec) => Vec.Cpr(Vec.Sub(a, o), Vec.Sub(b, o))
	const lower: Vec[] = []
	for (const point of sorted) {
		while (
			lower.length >= 2 &&
			turn(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
		) {
			lower.pop()
		}
		lower.push(point)
	}
	const upper: Vec[] = []
	for (const point of sorted.reverse()) {
		while (
			upper.length >= 2 &&
			turn(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
		) {
			upper.pop()
		}
		upper.push(point)
	}
	lower.pop()
	upper.pop()
	return lower.concat(upper)
}

function getPolygonArea(polygon: Vec[]) {
	let area = 0
	for (let i = 0; i < polygon.length; i++) {
		area += Vec.Cpr(polygon[i], polygon[(i + 1) % polygon.length])
	}
	return Math.abs(area) / 2
}

function getDistanceToPolygon(point: Vec, polygon: Vec[]) {
	let min = Infinity
	for (let i = 0; i < polygon.length; i++) {
		min = Math.min(
			min,
			Vec.DistanceToLineSegment(polygon[i], polygon[(i + 1) % polygon.length], point)
		)
	}
	return min
}

/** Ramer–Douglas–Peucker. Returns the indices of the points that survive. */
function simplify(points: Vec[], tolerance: number): number[] {
	const keep = points.map((_, i) => i === 0 || i === points.length - 1)
	const stack: [number, number][] = [[0, points.length - 1]]
	while (stack.length) {
		const [from, to] = stack.pop()!
		let maxDistance = 0
		let index = -1
		for (let i = from + 1; i < to; i++) {
			const distance = Vec.DistanceToLineSegment(points[from], points[to], points[i])
			if (distance > maxDistance) {
				maxDistance = distance
				index = i
			}
		}
		if (index !== -1 && maxDistance > tolerance) {
			keep[index] = true
			stack.push([from, index], [index, to])
		}
	}
	return keep.flatMap((kept, i) => (kept ? [i] : []))
}

/** Evenly spaced points along the path, so fast and slow parts of a stroke count equally. */
function resample(path: Vec[], count: number): Vec[] {
	const step = getPathLength(path) / (count - 1)
	const result = [path[0].clone()]
	let travelled = 0
	for (let i = 1; i < path.length; i++) {
		let from = path[i - 1]
		const to = path[i]
		let segment = Vec.Dist(from, to)
		while (travelled + segment >= step && result.length < count - 1) {
			const point = Vec.Lrp(from, to, (step - travelled) / segment)
			result.push(point)
			from = point
			segment = Vec.Dist(from, to)
			travelled = 0
		}
		travelled += segment
	}
	while (result.length < count) result.push(path[path.length - 1].clone())
	return result
}

function resampleLoop(loop: Vec[], count: number): Vec[] {
	return resample([...loop, loop[0]], count + 1).slice(0, count)
}

function removeDuplicatePoints(points: VecLike[]): Vec[] {
	const result: Vec[] = []
	for (const { x, y } of points) {
		const previous = result[result.length - 1]
		if (!previous || previous.x !== x || previous.y !== y) result.push(new Vec(x, y))
	}
	return result
}

function getPathLength(path: Vec[]) {
	let length = 0
	for (let i = 1; i < path.length; i++) length += Vec.Dist(path[i - 1], path[i])
	return length
}

function getBoundsDiagonal(points: Vec[]) {
	const { width, height } = getExtentsInFrame(points, 0)
	return Math.hypot(width, height)
}

/** Wraps an angle into (-π/4, π/4]: boxes, ellipses and diamonds look the same a quarter turn on. */
function normalizeQuarterTurn(angle: number) {
	const quarter = Math.PI / 2
	let result = angle - Math.round(angle / quarter) * quarter
	if (result <= -quarter / 2) result += quarter
	return result
}

function normalizeHalfTurn(angle: number) {
	return Math.atan2(Math.sin(angle), Math.cos(angle))
}

function snapToQuarterTurn(angle: number) {
	const quarter = Math.PI / 2
	const snapped = Math.round(angle / quarter) * quarter
	// `+ 0` turns -0 into 0, so callers can compare with `=== 0` and tests with `toBe(0)`.
	return Math.abs(angle - snapped) <= SNAP_ANGLE ? normalizeHalfTurn(snapped) + 0 : angle
}

function average(points: Vec[], measure: (point: Vec) => number) {
	let total = 0
	for (const point of points) total += measure(point)
	return total / points.length
}
