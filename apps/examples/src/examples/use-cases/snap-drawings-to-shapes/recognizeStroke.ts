import { Vec, VecLike, centerOfCircleFromThreePoints } from 'tldraw'

// Recognizes a freehand stroke from its points. It knows nothing about the editor, so every
// threshold below can be tuned against the fixtures in recognizeStroke.test.ts. Results are in the
// same space as the points, and "axis-aligned" means aligned with that space's axes.

export type GeoStrokeKind = 'rectangle' | 'ellipse' | 'triangle' | 'diamond'

export interface GeoStrokeRecognition {
	kind: GeoStrokeKind
	/** Center of the fitted box. */
	center: Vec
	/** Size of the fitted box along its own rotated axes. */
	width: number
	height: number
	/**
	 * Clockwise, in radians. Snapped to the nearest quarter turn within about 10° of it, which is
	 * zero for everything but triangles pointing sideways.
	 */
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
/**
 * Trimmed overshoot retraces the loop or flicks off it. A tail that heads further away than this
 * share of the loop's size is a separate line, like the stem of a 9.
 */
const MAX_TRIM_DISTANCE_RATIO = 0.13
/**
 * The closing gap, measured across the loop's narrow side, as a share of that side. A thin U or an
 * out-and-back stroke ends beside itself, a whole side short of closing.
 */
const MAX_CROSS_GAP_RATIO = 0.5
/** Loop area over hull area. Figure eights, stars and retraced stems fall short. */
const MIN_LOOP_FILL = 0.7
/** Loops thinner than this are slivers, not shapes. */
const MIN_LOOP_ASPECT = 0.05

// The convex hull's area as a share of the smallest rectangle around the stroke: about 1 for a
// rectangle, 0.79 for an ellipse and 0.5 for a triangle. These gates decide which candidates get
// fitted at all. Diamonds range from 0.5 to 1 depending on their proportions, so they're gated on
// shear instead.
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
/** Sides (or a diamond's diagonals) within this ratio of each other make a square. */
const SQUARE_ASPECT = 0.82
/** How much worse the reading chosen by orientation may fit before the better-fitting one wins. */
const SQUARE_REFIT_RATIO = 5
/**
 * A rectangle's corners sit within this share of the shape's size from the stroke. A trapezoid's
 * don't.
 */
const MAX_RECTANGLE_CORNER_GAP = 0.17
/**
 * How far the ends of a diamond's short diagonal slide apart along the long one, as a share of
 * the long one. A rhombus's diagonals cross at their midpoints; a parallelogram's don't.
 */
const MAX_DIAMOND_SHEAR = 0.12
/** Hand-drawn ellipses fit within this, while closed D shapes only just pass the general limit. */
const MAX_ELLIPSE_FIT_ERROR = 0.045
/** How far, on average, the outline dips inside its hull. Clouds dip; ellipses barely do. */
const MAX_ELLIPSE_CONCAVITY = 0.008
/** How much an equilateral-ish triangle prefers an axis-aligned reading over a tilted one. */
const TRIANGLE_TILT_WEIGHT = 0.015
/**
 * A tilted triangle reading gives way to an axis-aligned one whose outline is within this share
 * of its size.
 */
const TRIANGLE_SAME_OUTLINE = 0.06

/**
 * Simplification tolerance for open strokes, as a share of their length. Small enough to keep an
 * arrowhead's barbs.
 */
const SIMPLIFY_RATIO = 0.02
/**
 * An arrowhead drawn at the end of a stroke reaches this far back from the tip, relative to the
 * shaft.
 */
const MIN_BARB_RATIO = 0.06
const MAX_BARB_RATIO = 0.45
/** The stroke must double back by at least this much at the tip to count as an arrowhead. */
const MIN_BARB_TURN = (100 * Math.PI) / 180
/**
 * Arrowheads drawn first are rare and sharp, while check marks drawn short arm first look just
 * like a blunt one. So a head at the start must double back further.
 */
const MIN_START_BARB_TURN = (130 * Math.PI) / 180
/** A barb opens out to the side. A tail that runs straight back along the shaft is a retrace. */
const MIN_BARB_SPREAD = 0.13
/** Blunt barbs turning less than this must be short. A long one makes an L or a check mark. */
const BLUNT_BARB_TURN = (130 * Math.PI) / 180
const MAX_BLUNT_BARB_RATIO = 0.25
/** The least a barb that meets `minArrowheadLength` must reach, as a share of a very long shaft. */
const MIN_LONG_SHAFT_BARB_RATIO = 0.02

/** Straight lines stray at most this share of their length from the line between their ends. */
const MAX_LINE_DEVIATION = 0.07
/**
 * Hand wobble swings across a line a few times; a zigzag or wavy underline swings many. Swings
 * count when they're at least this share of the chord.
 */
const MIN_SWING = 0.02
const MAX_SWINGS = 5
/**
 * A line never backs up along itself by more than this share of its chord. A strike-through
 * does.
 */
const MAX_BACKTRACK = 0.15
/** Arcs stay within this share of their chord from the circle through their ends and middle. */
const MAX_ARC_ERROR = 0.06
/** An arc may stray this far, as a share of its chord, across to the other side of its chord. */
const MAX_ARC_CROSSING = 0.03
/** A semicircle is about 1.57 times its chord. Anything longer is a loop, not a connector. */
const MAX_ARC_LENGTH_RATIO = 1.8
/** Turning more than this within a short stretch of the stroke is a corner, and an arc has none. */
const MAX_ARC_TURN = (45 * Math.PI) / 180
/** The stretch the turn above is measured over, as a share of the stroke's points. */
const ARC_TURN_SPAN = 0.025
/**
 * A real arc fits its circle much better than two straight segments meeting at its far point.
 * A bent line, like a stick figure's leg, fits the two segments nearly as well as the circle.
 */
const MIN_ARC_OVER_CORNER = 0.8

const CHEVRON_SIMPLIFY_RATIO = 0.06
const CHEVRON_MIN_ARM_RATIO = 0.4
const CHEVRON_MIN_ANGLE = (15 * Math.PI) / 180
const CHEVRON_MAX_ANGLE = (110 * Math.PI) / 180
const CHEVRON_MAX_ARM_DEVIATION = 0.08

const UNRECOGNIZED: UnrecognizedStroke = { kind: 'unknown', confidence: 0 }

/**
 * The recognizer works on shapes alone, so it can't tell a dot from a circle or a flick from an
 * arrowhead without knowing how big things look on screen. Both are in the points' units.
 */
export interface RecognizeStrokeOptions {
	/** Strokes whose bounds are smaller than this are dots and taps. */
	minSize?: number
	/**
	 * People draw arrowheads at about the same size on screen however long the shaft is. A barb at
	 * least this long counts even when it's tiny next to a long shaft.
	 */
	minArrowheadLength?: number
}

export function recognizeStroke(
	points: VecLike[],
	{ minSize = 0, minArrowheadLength = Infinity }: RecognizeStrokeOptions = {}
): StrokeRecognition {
	const path = removeDuplicatePoints(points)
	if (path.length < 2 || getPathLength(path) === 0) return UNRECOGNIZED
	if (getBoundsDiagonal(path) < minSize) return UNRECOGNIZED

	const resampled = resample(path, RESAMPLE_COUNT)
	const loop = getClosedLoop(resampled)
	const closed = loop ? recognizeClosedStroke(loop) : null
	return (
		closed ??
		recognizeLine(resampled, minArrowheadLength) ??
		recognizeChevron(resampled) ??
		UNRECOGNIZED
	)
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
	// The circle through all three points is centred `centre` along the normal from the chord's
	// midpoint.
	const centre = (along * along + across * across - half * half) / (2 * across)
	return centre + Math.sign(across) * Math.hypot(half, centre)
}

interface ScoredFit {
	fit: GeoFit
	/** Mean distance between stroke and outline, as a share of the shape's size. */
	error: number
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
	const loopArea = getPolygonArea(points)
	if (hullArea === 0 || loopArea < MIN_LOOP_FILL * hullArea) return null

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
	if (fill >= RECTANGLE_MIN_FILL) {
		const rectangle = fitRectangle(points, minRect.rotation)
		const cornerGap = Math.max(...rectangle.outline.map((c) => getDistanceToPolygon(c, points)))
		if (cornerGap <= MAX_RECTANGLE_CORNER_GAP * size) fits.push(rectangle)
	}
	if (fill >= ELLIPSE_MIN_FILL && fill <= ELLIPSE_MAX_FILL) fits.push(fitEllipse(points))
	if (fill <= TRIANGLE_MAX_FILL) fits.push(fitTriangle(points, hull, size))
	const diamond = fitDiamond(points)
	if (getDiamondShear(points, diamond) <= MAX_DIAMOND_SHEAR) fits.push(diamond)
	if (fits.length === 0) return null

	const scored: ScoredFit[] = fits.map((fit) => ({
		fit,
		error: getFitError(points, fit.outline) / size,
	}))
	scored.sort((a, b) => a.error - b.error)
	let best = scored[0]

	if (best.fit.kind === 'rectangle' || best.fit.kind === 'diamond') {
		best = pickSquareReading(points, best, scored, size)
	}
	if (best.error > MAX_GEO_FIT_ERROR) return null
	if (best.fit.kind === 'ellipse') {
		// An ellipse passes through the middle of a cloud's bumps, so the mean error can't tell them
		// apart. How much the outline dips inside its hull can.
		const concavity = (hullArea - Math.min(hullArea, loopArea)) / getPerimeter(hull) / size
		if (best.error > MAX_ELLIPSE_FIT_ERROR || concavity > MAX_ELLIPSE_CONCAVITY) return null
	}

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
	const readings: GeoFit[] = []
	let best: GeoFit | null = null
	let bestScore = Infinity
	for (let i = 0; i < 3; i++) {
		const a = corners[i]
		const b = corners[(i + 1) % 3]
		const apex = corners[(i + 2) % 3]
		const normal = Vec.Per(Vec.Sub(b, a)).uni()
		let direction = Vec.Dpr(normal, Vec.Sub(apex, a)) < 0 ? normal.neg() : normal
		// A few pixels of wobble tilt a short base's normal a long way, but barely move the median.
		const height = Math.abs(Vec.Cpr(Vec.Sub(b, a).uni(), Vec.Sub(apex, a)))
		if (Vec.Dist(a, b) < 0.5 * height) direction = Vec.Sub(apex, Vec.Med(a, b)).uni()
		// The rotation that turns the triangle's "up" into the direction it points.
		const rotation = Math.atan2(direction.x, -direction.y)
		const box = getExtentsInFrame(points, rotation)
		const reading: GeoFit = {
			kind: 'triangle',
			...box,
			rotation,
			outline: getTriangleCorners(box, rotation),
		}
		readings.push(reading)
		const quarter = Math.PI / 2
		const tilt = Math.abs(rotation - Math.round(rotation / quarter) * quarter) / (quarter / 2)
		const score =
			average(points, (p) => getDistanceToPolygon(p, reading.outline)) / size +
			TRIANGLE_TILT_WEIGHT * tilt
		if (score < bestScore) {
			bestScore = score
			best = reading
		}
	}

	// Noise or a looped corner can tip a nearly equilateral triangle to a reading 120° away. If an
	// axis-aligned reading draws much the same outline, use it, so the label and handles stay level.
	if (snapToQuarterTurn(best!.rotation) === best!.rotation) {
		const level = readings.find(
			(reading) =>
				snapToQuarterTurn(reading.rotation) !== reading.rotation &&
				getFitError(resampleLoop(reading.outline, LOOP_RESAMPLE_COUNT), best!.outline) / size <=
					TRIANGLE_SAME_OUTLINE
		)
		if (level) return level
	}
	return best!
}

function fitDiamond(points: Vec[]): GeoFit {
	// A diamond's diagonals are its axes. Try every orientation and keep the closest.
	let best = getDiamondAt(points, 0)
	let bestError = Infinity
	for (let degrees = 0; degrees < 90; degrees += 2) {
		const fit = getDiamondAt(points, normalizeQuarterTurn((degrees * Math.PI) / 180))
		const error = average(points, (p) => getDistanceToPolygon(p, fit.outline))
		if (error < bestError) {
			bestError = error
			best = fit
		}
	}
	return best
}

function getDiamondAt(points: Vec[], rotation: number): GeoFit {
	const box = getExtentsInFrame(points, rotation)
	return { kind: 'diamond', ...box, rotation, outline: getDiamondCorners(box, rotation) }
}

/** How far apart the short diagonal's ends sit along the long one, as a share of the long one. */
function getDiamondShear(points: Vec[], { rotation, width, height }: GeoFit) {
	const { u, v } = getFrame(rotation)
	const [long, short, longExtent, shortExtent] =
		width >= height ? [u, v, width, height] : [v, u, height, width]
	const tip = (sign: number) => {
		const values = points.map((p) => sign * Vec.Dpr(p, short))
		const max = Math.max(...values)
		return Vec.Average(points.filter((_, i) => values[i] >= max - 0.04 * shortExtent))
	}
	return Math.abs(Vec.Dpr(Vec.Sub(tip(1), tip(-1)), long)) / longExtent
}

/**
 * A square reads as both a rectangle and a diamond, and the two fits lean opposite ways: a diamond
 * soaks up a slight shear, and a rectangle shrugs off rounded tips. So a near-square that lines up
 * with the axes is decided by its orientation, as the spec does: corners on the midpoints of its
 * upright bounding box make a diamond, sides along it make a rectangle.
 */
function pickSquareReading(points: Vec[], best: ScoredFit, scored: ScoredFit[], size: number) {
	const { kind, width, height, rotation } = best.fit
	const diamondRotation =
		kind === 'diamond' ? rotation : normalizeQuarterTurn(rotation + Math.PI / 4)
	const onCorner = snapToQuarterTurn(diamondRotation) === 0
	const upright = snapToQuarterTurn(normalizeQuarterTurn(diamondRotation + Math.PI / 4)) === 0
	if (Math.min(width, height) >= SQUARE_ASPECT * Math.max(width, height) && (onCorner || upright)) {
		if (onCorner === (kind === 'diamond')) return best
		const fit = onCorner
			? getDiamondAt(points, diamondRotation)
			: fitRectangle(points, diamondRotation + Math.PI / 4)
		const error = getFitError(points, fit.outline) / size
		const limit = Math.max(best.error * SQUARE_REFIT_RATIO, best.error + SQUARE_TIE_MARGIN)
		return error <= limit ? { fit, error } : best
	}

	// Away from the axes, a tie between the two is a tilted square, which reads as a rectangle
	// unless its corners still sit on the bounding box's midpoints.
	const other = scored.find((s) => s.fit.kind === (kind === 'rectangle' ? 'diamond' : 'rectangle'))
	if (
		other &&
		other.error <= Math.max(best.error * SQUARE_TIE_RATIO, best.error + SQUARE_TIE_MARGIN)
	) {
		const diamond = kind === 'diamond' ? best : other
		const rectangle = kind === 'rectangle' ? best : other
		return snapToQuarterTurn(diamond.fit.rotation) === 0 ? diamond : rectangle
	}
	return best
}

function recognizeLine(points: Vec[], minArrowheadLength: number): LineStrokeRecognition | null {
	const last = points.length - 1
	const vertices = simplify(points, SIMPLIFY_RATIO * getPathLength(points))
	const endTip = findArrowheadTip(points, vertices, MIN_BARB_TURN, minArrowheadLength)
	const reversedTip = findArrowheadTip(
		[...points].reverse(),
		vertices.map((i) => last - i).reverse(),
		MIN_START_BARB_TURN,
		minArrowheadLength
	)
	const startTip = last - reversedTip
	if (endTip - startTip < 2) return null

	const shaft = points.slice(startTip, endTip + 1)
	if (isScribbledOut(shaft)) return null
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
function findArrowheadTip(
	points: Vec[],
	vertices: number[],
	minTurn: number,
	minArrowheadLength: number
): number {
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
		const minReach = Math.min(
			MIN_BARB_RATIO * shaftLength,
			Math.max(minArrowheadLength, MIN_LONG_SHAFT_BARB_RATIO * shaftLength)
		)
		// Later tips only have shorter tails, so a flick this small means there's no arrowhead.
		if (reach < minReach) return last

		const incoming = Vec.Sub(tip, points[vertices[i - 1]])
		const outgoing = Vec.Sub(points[vertices[i + 1]], tip)
		const turn = Math.abs(Vec.AngleBetween(incoming, outgoing))
		if (turn < minTurn) continue
		if (turn < BLUNT_BARB_TURN && reach > MAX_BLUNT_BARB_RATIO * shaftLength) continue
		const along = incoming.uni()
		let spread = 0
		for (let j = tipIndex + 1; j <= last; j++) {
			spread = Math.max(spread, Math.abs(Vec.Cpr(along, Vec.Sub(points[j], tip))))
		}
		if (spread < MIN_BARB_SPREAD * reach) continue
		return tipIndex
	}
	return last
}

/** Zigzags, wavy underlines and strike-throughs stay close to a straight line but aren't one. */
function isScribbledOut(shaft: Vec[]) {
	const start = shaft[0]
	const chord = Vec.Dist(start, shaft[shaft.length - 1])
	if (chord === 0) return false
	const direction = Vec.Div(Vec.Sub(shaft[shaft.length - 1], start), chord)

	let furthest = -Infinity
	for (const point of shaft) {
		const along = Vec.Dpr(Vec.Sub(point, start), direction)
		furthest = Math.max(furthest, along)
		if (along < furthest - MAX_BACKTRACK * chord) return true
	}

	// Count swings across the chord, smoothed over three points so hand jitter doesn't count.
	const offsets = shaft.map((point) => Vec.Cpr(direction, Vec.Sub(point, start)) / chord)
	const smoothed = offsets.map(
		(_, i) =>
			(offsets[Math.max(0, i - 1)] + offsets[i] + offsets[Math.min(offsets.length - 1, i + 1)]) / 3
	)
	let heading = 0
	let high = smoothed[0]
	let low = smoothed[0]
	let swings = 0
	for (const offset of smoothed) {
		if (heading === 0) {
			high = Math.max(high, offset)
			low = Math.min(low, offset)
			if (offset >= low + MIN_SWING) [heading, high] = [1, offset]
			else if (offset <= high - MIN_SWING) [heading, low] = [-1, offset]
		} else if (heading === 1) {
			if (offset > high) high = offset
			else if (offset <= high - MIN_SWING) [swings, heading, low] = [swings + 1, -1, offset]
		} else {
			if (offset < low) low = offset
			else if (offset >= low + MIN_SWING) [swings, heading, high] = [swings + 1, 1, offset]
		}
	}
	return swings > MAX_SWINGS
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

	// An arc bows out to one side of its chord. Waves and S-curves cross it.
	const direction = Vec.Div(Vec.Sub(end, start), chord)
	const side = Math.sign(Vec.Cpr(direction, Vec.Sub(middle, start)))
	for (const point of shaft) {
		if (side * Vec.Cpr(direction, Vec.Sub(point, start)) < -MAX_ARC_CROSSING * chord) return null
	}

	const center = centerOfCircleFromThreePoints(start, middle, end)
	if (!center) return null
	const radius = (Vec.Dist(center, start) + Vec.Dist(center, middle) + Vec.Dist(center, end)) / 3
	const error = average(shaft, (p) => Math.abs(Vec.Dist(p, center) - radius)) / chord
	if (error > MAX_ARC_ERROR) return null

	let far = middle
	for (const point of shaft) {
		if (Vec.DistanceToLineSegment(start, end, point) > Vec.DistanceToLineSegment(start, end, far)) {
			far = point
		}
	}
	const cornerError =
		average(shaft, (p) =>
			Math.min(Vec.DistanceToLineSegment(start, far, p), Vec.DistanceToLineSegment(far, end, p))
		) / chord
	if (cornerError < MIN_ARC_OVER_CORNER * error) return null

	// A corner turns sharply in one place, while a curve spreads its turn out, however tight it is.
	const span = Math.max(2, Math.round(shaft.length * ARC_TURN_SPAN))
	for (let i = span; i < shaft.length - span; i++) {
		const incoming = Vec.Sub(shaft[i], shaft[i - span])
		const outgoing = Vec.Sub(shaft[i + span], shaft[i])
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

	const loop = points.slice(best.from, best.to + 1)
	const narrow = getMinAreaRect(getConvexHull(loop))
	const { u, v } = getFrame(narrow.rotation)
	const across = narrow.width < narrow.height ? u : v
	const gap = Vec.Sub(points[best.to], points[best.from])
	if (
		Math.abs(Vec.Dpr(gap, across)) >
		MAX_CROSS_GAP_RATIO * Math.min(narrow.width, narrow.height)
	) {
		return null
	}

	const limit = MAX_TRIM_DISTANCE_RATIO * getBoundsDiagonal(loop)
	const trimmed = [...points.slice(0, best.from), ...points.slice(best.to + 1)]
	if (trimmed.some((point) => getDistanceToPolygon(point, loop) > limit)) return null
	return loop
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

function getPerimeter(polygon: Vec[]) {
	return getPathLength([...polygon, polygon[0]])
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

/** Wraps an angle into (-π/4, π/4]: boxes, ellipses and diamonds repeat every quarter turn. */
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
