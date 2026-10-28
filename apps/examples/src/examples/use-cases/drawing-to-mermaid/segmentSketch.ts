import { Box, BoxModel, Vec, VecLike, pointInPolygon } from 'tldraw'
import type { NodeShape } from './questions'

// Splits a hand-drawn flowchart into nodes, connectors and labels using only the strokes'
// geometry. It decides what goes with what; TypeSafe later judges what each piece looks like.
// Pure, so it can be tested without an editor. All points are in page space.

/** A node drawn at 100% zoom is about this many screen pixels across, corner to corner. */
const TYPICAL_NODE_SIZE = 170

// The distances below are in screen pixels at the zoom the sketch was drawn at.

/** How close a stroke's end has to come to another stroke to touch it. */
const TOUCH_DISTANCE = 16
/** Closed outlines smaller than this across are letters or dots, not nodes. */
const MIN_NODE_SIZE = 36
/** A stroke is closed when its end comes back to its start within this share of its size... */
const CLOSE_GAP_RATIO = 0.2
/** ...and it encloses some area: its hull covers at least this share of its size squared. */
const MIN_FILL = 0.05
/** Handwriting strokes this far apart belong to the same word or phrase. */
const WORD_GAP = 28
/** A phrase whose middle is this far from a connector labels that connector. */
const EDGE_LABEL_DISTANCE = 48
/** An arrowhead drawn as its own stroke is at most this share of its connector's length... */
const MAX_ARROWHEAD_RATIO = 0.6
/** ...and comes within this distance of the connector's end. */
const ARROWHEAD_REACH = 32
/** Strokes that extend an outline are at least this share of its size, so letters aren't. */
const MIN_EXTENSION_RATIO = 0.3
/**
 * A stroke that ends in a hooked arrowhead ends at the tip of the barb, short of the node it
 * points at. The barb is at most this long.
 */
const HOOK_LENGTH = 32

/** What a tldraw shape already says about itself, so nobody has to judge it from a picture. */
export type KnownShape =
	| { type: 'node'; shape: NodeShape; text?: string }
	| {
			type: 'connector'
			/** Whether the first and last of the stroke's points have an arrowhead. */
			arrowheads: { start: boolean; end: boolean }
			/** Ids of the strokes the connector's ends are bound to. */
			boundTo: { start?: string; end?: string }
			text?: string
	  }

export interface SketchStroke {
	id: string
	/** In page space. For a tldraw shape, its outline or path. */
	points: VecLike[]
	/** Set for tldraw shapes: geo shapes and notes are nodes, arrows and lines are connectors. */
	known?: KnownShape
}

export interface SketchText {
	id: string
	text: string
	/** In page space. */
	bounds: BoxModel
}

export interface SketchNode {
	id: string
	/** The outline, plus any strokes that extend it, like the sides of a cylinder. */
	outline: string[]
	/** Handwriting inside the outline. */
	label: string[]
	/** Typed text inside the outline, which wins over handwriting. */
	text?: string
	/** The node's shape, when it's a tldraw shape rather than a drawing. */
	shape?: NodeShape
	bounds: Box
}

export interface SketchEdge {
	id: string
	/** The node the connector stroke starts at. */
	from: string
	/** The node the connector stroke ends at. */
	to: string
	/** The connector and any arrowheads drawn as separate strokes. */
	strokes: string[]
	label: string[]
	text?: string
	/** Which ends have arrowheads, when the connector is a tldraw arrow or line. */
	arrowheads?: { from: boolean; to: boolean }
	bounds: Box
}

export interface SketchGraph {
	nodes: SketchNode[]
	edges: SketchEdge[]
	/** Ids of strokes and text that didn't end up as part of the diagram. */
	ignored: string[]
	/** Page units per screen pixel at the zoom the sketch was drawn at. */
	scale: number
}

interface StrokeGeometry {
	id: string
	points: Vec[]
	bounds: Box
	start: Vec
	end: Vec
	known?: KnownShape
}

interface NodeDraft {
	outline: StrokeGeometry[]
	hull: Vec[]
	bounds: Box
	label: StrokeGeometry[]
	texts: SketchText[]
}

interface EdgeDraft {
	stroke: StrokeGeometry
	from: NodeDraft
	to: NodeDraft
	arrowheads: StrokeGeometry[]
	label: StrokeGeometry[]
	texts: SketchText[]
}

/**
 * @param options.scale - Page units per screen pixel at the zoom the sketch was drawn at. By
 * default it's estimated from the size of the sketch's outlines.
 */
export function segmentSketch(
	strokes: SketchStroke[],
	texts: SketchText[],
	options: { scale?: number } = {}
): SketchGraph {
	const geometry = strokes
		.filter((s) => s.points.length > 0)
		.map((s): StrokeGeometry => {
			const points = s.points.map((p) => new Vec(p.x, p.y))
			return {
				id: s.id,
				points,
				bounds: Box.FromPoints(points),
				start: points[0],
				end: points[points.length - 1],
				known: s.known,
			}
		})
	const scale = options.scale ?? estimateScale(geometry)
	const touch = TOUCH_DISTANCE * scale
	const reach = ARROWHEAD_REACH * scale

	// [1]
	const outlines = findOutlines(geometry, MIN_NODE_SIZE * scale, touch)
	const heads = getClosedArrowheads(outlines, touch, 2 * reach)
	const nodes = outlines.filter((n) => !heads.includes(n.outline[0]))
	const used = new Set(nodes.flatMap((n) => [...n.outline, ...n.label]))
	let loose = geometry.filter((g) => !used.has(g))

	// [2]
	const edges: EdgeDraft[] = []
	const findConnectors = () => {
		for (const stroke of loose) {
			if (heads.includes(stroke) || stroke.known?.type === 'node') continue
			const known = stroke.known
			const ends = [stroke.points, [...stroke.points].reverse()].map((points, i) => {
				// A tldraw arrow's binding says exactly which shape its end is attached to.
				const bound = known && (i === 0 ? known.boundTo.start : known.boundTo.end)
				const node = bound && nodes.find((n) => n.outline.some((s) => s.id === bound))
				if (node) return { node, head: undefined }
				return known
					? getConnectorEnd(nodes, [], points, touch, 0)
					: getConnectorEnd(nodes, heads, points, touch, HOOK_LENGTH * scale)
			})
			const [from, to] = ends
			if (!from || !to || from.node === to.node) continue
			const arrowheads = ends.flatMap((end) => (end?.head ? [end.head] : []))
			edges.push({ stroke, from: from.node, to: to.node, arrowheads, label: [], texts: [] })
		}
		const taken = new Set(edges.flatMap((e) => [e.stroke, ...e.arrowheads]))
		loose = loose.filter((g) => !taken.has(g))
	}

	// [3]
	const takeLabels = () => {
		for (const stroke of [...loose]) {
			if (stroke.known) continue
			const node = getEnclosingNode(nodes, stroke.bounds.center)
			if (!node) continue
			node.label.push(stroke)
			loose.splice(loose.indexOf(stroke), 1)
		}
	}

	findConnectors()
	loose = takeArrowheads(edges, loose, reach, touch)
	takeLabels()

	// [4]
	for (const node of nodes) {
		const extra = getOutlineExtensions(node, loose, touch)
		if (extra.length === 0) continue
		node.outline.push(...extra)
		node.bounds = Box.Common([node.bounds, ...extra.map((g) => g.bounds)])
		node.hull = getConvexHull(node.outline.flatMap((g) => g.points))
		loose = loose.filter((g) => !extra.includes(g))
	}
	findConnectors()
	loose = takeArrowheads(edges, loose, reach, touch)
	takeLabels()

	// [5]
	const keptNodes = nodes.filter(
		(node) =>
			getKnownNode(node) ||
			edges.some((e) => e.from === node || e.to === node) ||
			node.label.length > 0 ||
			nodes.length === 1 ||
			node.bounds.width + node.bounds.height >= getMedianSize(nodes) * 0.5
	)
	for (const node of nodes) {
		if (!keptNodes.includes(node)) loose.push(...node.outline, ...node.label)
	}

	// A tldraw arrow or line that doesn't join two nodes isn't handwriting either.
	const ignored = loose.filter((g) => g.known).map((g) => g.id)
	loose = loose.filter((g) => !g.known)
	for (const phrase of clusterByDistance(loose, WORD_GAP * scale)) {
		const edge = getNearestEdge(edges, Box.Common(phrase.map((g) => g.bounds)).center, keptNodes)
		if (edge && edge.distance <= EDGE_LABEL_DISTANCE * scale) edge.edge.label.push(...phrase)
		else ignored.push(...phrase.map((g) => g.id))
	}

	// [6]
	for (const text of texts) {
		const center = Box.From(text.bounds).center
		const node = getEnclosingNode(keptNodes, center)
		if (node) {
			node.texts.push(text)
			continue
		}
		const edge = getNearestEdge(edges, center, keptNodes)
		if (edge && edge.distance <= EDGE_LABEL_DISTANCE * scale) edge.edge.texts.push(text)
		else ignored.push(text.id)
	}

	// [7]
	const sortedNodes = [...keptNodes].sort(
		(a, b) => a.bounds.center.y - b.bounds.center.y || a.bounds.center.x - b.bounds.center.x
	)
	const nodeIds = new Map(sortedNodes.map((node, i) => [node, `n${i + 1}`]))
	const order = (node: NodeDraft) => sortedNodes.indexOf(node)
	edges.sort((a, b) => order(a.from) - order(b.from) || order(a.to) - order(b.to))
	return {
		nodes: sortedNodes.map((node) => {
			const known = getKnownNode(node)
			return {
				id: nodeIds.get(node)!,
				outline: node.outline.map((g) => g.id),
				label: node.label.map((g) => g.id),
				text: joinTexts(known?.text, node.texts),
				shape: known?.shape,
				bounds: node.bounds,
			}
		}),
		edges: edges.map((edge, i) => {
			const known = edge.stroke.known?.type === 'connector' ? edge.stroke.known : undefined
			return {
				id: `e${i + 1}`,
				from: nodeIds.get(edge.from)!,
				to: nodeIds.get(edge.to)!,
				strokes: [edge.stroke.id, ...edge.arrowheads.map((g) => g.id)],
				label: edge.label.map((g) => g.id),
				text: joinTexts(known?.text, edge.texts),
				arrowheads: known && { from: known.arrowheads.start, to: known.arrowheads.end },
				bounds: Box.Common([edge.stroke.bounds, ...edge.arrowheads.map((g) => g.bounds)]),
			}
		}),
		ignored,
		scale,
	}
}

/**
 * Page units per screen pixel at the zoom the sketch was drawn at. The camera's zoom says nothing
 * about that: the user may have zoomed out since, and this example zooms out itself to show the
 * diagram. People draw nodes at a fairly constant size on screen, so the size of the sketch's
 * larger outlines gives the scale. Letters are smaller, and small nodes like Start and End circles
 * shouldn't drag it down either, so it's the upper median of the outlines at least half the size
 * of the largest.
 */
function estimateScale(strokes: StrokeGeometry[]) {
	const sizes = findOutlines(strokes, 0, TOUCH_DISTANCE)
		.map((n) => getDiagonal(n.bounds))
		.sort((a, b) => b - a)
	if (sizes.length === 0) return 1
	const large = sizes.filter((size) => size >= 0.5 * sizes[0])
	const size = large[Math.floor((large.length - 1) / 2)]
	return Math.min(Math.max(size / TYPICAL_NODE_SIZE, 0.25), 8)
}

function findOutlines(strokes: StrokeGeometry[], minSize: number, touch: number): NodeDraft[] {
	const candidates: StrokeGeometry[][] = []
	for (const stroke of strokes) {
		if (stroke.known) {
			if (stroke.known.type === 'node') candidates.push([stroke])
		} else if (getDiagonal(stroke.bounds) >= minSize && isClosed(stroke, touch)) {
			candidates.push([stroke])
		}
	}
	const closed = new Set(candidates.flat())
	for (const loop of findStrokeLoops(
		strokes.filter((s) => !closed.has(s) && !s.known),
		touch
	)) {
		if (getDiagonal(Box.Common(loop.map((s) => s.bounds))) >= minSize) candidates.push(loop)
	}

	// An outline drawn inside a bigger one is a letter like O or D, not a node. A tldraw shape
	// inside another is still a node.
	const drafts = candidates
		.map((outline): NodeDraft => {
			const points = outline.flatMap((s) => s.points)
			return {
				outline,
				hull: getConvexHull(points),
				bounds: Box.FromPoints(points),
				label: [],
				texts: [],
			}
		})
		.sort((a, b) => getArea(b.bounds) - getArea(a.bounds))
	const nodes: NodeDraft[] = []
	for (const draft of drafts) {
		const parent = nodes.find((n) => pointInPolygon(draft.bounds.center, n.hull))
		if (parent && !getKnownNode(draft)) parent.label.push(...draft.outline)
		else nodes.push(draft)
	}
	return nodes
}

/**
 * A stroke that encloses an area and comes back to where it started. People often close a
 * circle by carrying on past the start, so an end that lands on the first quarter of the stroke
 * counts too. Not the first half: the barb of a hooked arrow on a short connector lands on that.
 */
function isClosed(stroke: StrokeGeometry, touch: number) {
	const size = getDiagonal(stroke.bounds)
	if (size === 0) return false
	// A straight or hooked line comes back near itself but encloses almost nothing.
	if (getPolygonArea(getConvexHull(stroke.points)) < MIN_FILL * size * size) return false
	const gap = Math.max(CLOSE_GAP_RATIO * size, touch)
	if (Vec.Dist(stroke.start, stroke.end) <= gap) return true
	const quarter = getPathLength(stroke.points) / 4
	return (
		getDistanceToPolyline(stroke.end, getPathPrefix(stroke.points, quarter)) <= gap ||
		getDistanceToPolyline(stroke.start, getPathPrefix([...stroke.points].reverse(), quarter)) <= gap
	)
}

/**
 * Finds outlines drawn in several strokes, like a box drawn one side at a time: groups of strokes
 * whose ends all land on another stroke in the group. Strokes with a loose end, like a connector
 * that starts at a corner, are peeled off. A stroke that holds two loops together, like a
 * connector from one such box's corner to another's, is split off too.
 */
function findStrokeLoops(strokes: StrokeGeometry[], touch: number): StrokeGeometry[][] {
	const lands = (p: Vec, on: StrokeGeometry) => getDistanceToPolyline(p, on.points) <= touch
	const meets = (a: StrokeGeometry, b: StrokeGeometry) =>
		[a.start, a.end].some((p) => lands(p, b)) || [b.start, b.end].some((p) => lands(p, a))
	const peel = (group: StrokeGeometry[]) => {
		for (;;) {
			const kept = group.filter((s) => {
				const others = group.filter((o) => o !== s)
				const landsOn = [s.start, s.end].map((p) => others.filter((o) => lands(p, o)))
				if (landsOn.some((on) => on.length === 0)) return false
				// In a loop of three or more strokes, each stroke joins two others. A V arrowhead,
				// whose ends both land on its connector, doesn't.
				return group.length <= 2 || new Set(landsOn.flat()).size >= 2
			})
			if (kept.length === group.length) return group
			group = kept
		}
	}
	// The loops left when `without` is taken out of `group`.
	const getLoops = (group: StrokeGeometry[], without?: StrokeGeometry) =>
		groupBy(
			group.filter((s) => s !== without),
			meets
		)
			.map(peel)
			.filter((g) => g.length >= 2)

	const loops: StrokeGeometry[][] = []
	const groups = getLoops(strokes)
	while (groups.length > 0) {
		const group = groups.pop()!
		// Only a stroke that leaves a loop on both sides is a bridge. Taking out a box's side would
		// also split off a connector hanging from it, but the box wouldn't be a loop any more.
		const split = group.map((s) => getLoops(group, s)).find((parts) => parts.length > 1)
		if (split) groups.push(...split)
		else loops.push(group)
	}
	return loops
}

/**
 * Small closed outlines pressed against a much bigger one, like a closed triangle at the end of
 * a connector, are arrowheads rather than nodes.
 */
function getClosedArrowheads(outlines: NodeDraft[], touch: number, maxSize: number) {
	return outlines.flatMap((small) => {
		const size = getDiagonal(small.bounds)
		if (small.outline.length !== 1 || getKnownNode(small) || size > maxSize) return []
		const stroke = small.outline[0]
		const isHead = outlines.some(
			(big) =>
				big !== small &&
				getDiagonal(big.bounds) >= 2 * size &&
				getGap(stroke.points, big.outline) <= touch
		)
		return isHead ? [stroke] : []
	})
}

function getTouchedNode(nodes: NodeDraft[], point: Vec, touch: number): NodeDraft | undefined {
	let best: NodeDraft | undefined
	let bestDistance = Infinity
	for (const node of nodes) {
		const distance = pointInPolygon(point, node.hull)
			? 0
			: Math.min(...node.outline.map((s) => getDistanceToPolyline(point, s.points)))
		// Inside two outlines at once means one is drawn inside the other: take the smaller.
		const tieBreak = distance === 0 ? getArea(node.bounds) / 1e12 : 0
		if (distance <= touch && distance + tieBreak < bestDistance) {
			best = node
			bestDistance = distance + tieBreak
		}
	}
	return best
}

/**
 * The node at one end of a possible connector, given its points starting from that end, and the
 * closed arrowhead there if there is one. A connector can end on a closed arrowhead whose tip
 * touches the node.
 */
function getConnectorEnd(
	nodes: NodeDraft[],
	heads: StrokeGeometry[],
	points: Vec[],
	touch: number,
	hookLength: number
): { node: NodeDraft; head?: StrokeGeometry } | undefined {
	const head = heads.find((h) => getDistanceToPolyline(points[0], h.points) <= touch)
	const node =
		getEndNode(nodes, points, touch, hookLength) ??
		(head && nodes.find((n) => getGap(head.points, n.outline) <= touch))
	return node ? { node, head } : undefined
}

/**
 * The node touched by the end of a stroke whose points start at that end. Walks in from the end
 * for up to `reach`, or a third of the stroke, so a hook's barb doesn't hide the arrow's tip.
 */
function getEndNode(
	nodes: NodeDraft[],
	points: Vec[],
	touch: number,
	reach: number
): NodeDraft | undefined {
	const limit = Math.min(reach, getPathLength(points) / 3)
	let travelled = 0
	for (let i = 0; i < points.length; i++) {
		if (i > 0) travelled += Vec.Dist(points[i - 1], points[i])
		if (i > 0 && travelled > limit) break
		const node = getTouchedNode(nodes, points[i], touch)
		if (node) return node
	}
	return undefined
}

function getEnclosingNode(nodes: NodeDraft[], point: Vec): NodeDraft | undefined {
	return nodes
		.filter((n) => pointInPolygon(point, n.hull))
		.sort((a, b) => getArea(a.bounds) - getArea(b.bounds))[0]
}

/**
 * Long strokes near a node whose ends all land on the node's outline or on each other extend the
 * outline, like the sides and bottom of a cylinder drawn as an oval plus three strokes. A stroke
 * with a loose end, like a connector that stops short of its target, is peeled off.
 */
function getOutlineExtensions(node: NodeDraft, loose: StrokeGeometry[], touch: number) {
	const near = node.bounds.clone().expandBy(Math.max(node.bounds.width, node.bounds.height))
	const minSize = MIN_EXTENSION_RATIO * getDiagonal(node.bounds)
	let extra = loose.filter(
		(g) => !g.known && near.contains(g.bounds) && getDiagonal(g.bounds) >= minSize
	)
	for (;;) {
		const kept = extra.filter((g) => {
			const others = [...node.outline, ...extra.filter((o) => o !== g)]
			return [g.start, g.end].every((p) =>
				others.some((o) => getDistanceToPolyline(p, o.points) <= touch)
			)
		})
		if (kept.length === extra.length) return extra
		extra = kept
	}
}

/**
 * Gives each stroke that looks like an arrowhead drawn on its own to the connector end it sits
 * at, and returns the rest. See isArrowheadAt.
 */
function takeArrowheads(edges: EdgeDraft[], loose: StrokeGeometry[], reach: number, touch: number) {
	const ends = edges
		.filter((edge) => !edge.stroke.known)
		.flatMap((edge) =>
			[edge.stroke.points, [...edge.stroke.points].reverse()].map((points) => ({
				edge,
				tip: points[0],
				outward: getEndDirection(points, reach),
				length: getPathLength(points),
			}))
		)
	return loose.filter((stroke) => {
		if (stroke.known) return true
		let best: (typeof ends)[number] | undefined
		let bestDistance = Infinity
		for (const end of ends) {
			const distance = getDistanceToPolyline(end.tip, stroke.points)
			if (distance > reach || distance >= bestDistance) continue
			if (!isArrowheadAt(stroke, end, touch)) continue
			best = end
			bestDistance = distance
		}
		best?.edge.arrowheads.push(stroke)
		return !best
	})
}

/**
 * An arrowhead is small next to its connector and lies behind the connector's tip, never past
 * it. Either it's a V or a closed triangle that sits across the connector's line, with its ends
 * on opposite sides, or it's one barb drawn from the tip. That rules out letters of a label
 * written beside the connector, which sit on one side, and of a label inside the node the
 * connector points into, which lie past the tip.
 */
function isArrowheadAt(
	stroke: StrokeGeometry,
	end: { tip: Vec; outward: Vec; length: number },
	touch: number
) {
	if (getDiagonal(stroke.bounds) > MAX_ARROWHEAD_RATIO * end.length) return false
	const along = (p: Vec) => Vec.Dpr(Vec.Sub(p, end.tip), end.outward)
	if (stroke.points.some((p) => along(p) > touch)) return false
	const side = (p: Vec) => Vec.Cpr(end.outward, Vec.Sub(p, end.tip))
	if (side(stroke.start) * side(stroke.end) < 0) return true
	if (isClosed(stroke, touch)) {
		const sides = stroke.points.map(side)
		return Math.min(...sides) < 0 && Math.max(...sides) > 0
	}
	return Math.min(Vec.Dist(stroke.start, end.tip), Vec.Dist(stroke.end, end.tip)) <= touch / 2
}

/** The direction a stroke points at one end, given its points starting from that end. */
function getEndDirection(points: Vec[], length: number) {
	const inner = getPathPrefix(points, Math.min(length, getPathLength(points) / 2))
	const back = inner[inner.length - 1]
	const direction = Vec.Sub(points[0], back)
	return Vec.Len(direction) > 0 ? Vec.Uni(direction) : new Vec(1, 0)
}

function getNearestEdge(edges: EdgeDraft[], point: Vec, nodes: NodeDraft[]) {
	let best: { edge: EdgeDraft; distance: number } | undefined
	for (const edge of edges) {
		const distance = getDistanceToPolyline(point, edge.stroke.points)
		if (!best || distance < best.distance) best = { edge, distance }
	}
	// Text closer to a node's outline than to any connector is more likely a stray note.
	if (
		best &&
		nodes.some((n) =>
			n.outline.some((s) => getDistanceToPolyline(point, s.points) < best!.distance)
		)
	) {
		return undefined
	}
	return best
}

function clusterByDistance(strokes: StrokeGeometry[], gap: number): StrokeGeometry[][] {
	return groupBy(strokes, (a, b) =>
		a.bounds
			.clone()
			.expandBy(gap / 2)
			.collides(b.bounds.clone().expandBy(gap / 2))
	)
}

function groupBy<T>(items: T[], related: (a: T, b: T) => boolean): T[][] {
	const groups: T[][] = []
	const seen = new Set<T>()
	for (const item of items) {
		if (seen.has(item)) continue
		const group = [item]
		seen.add(item)
		for (let i = 0; i < group.length; i++) {
			for (const other of items) {
				if (!seen.has(other) && related(group[i], other)) {
					seen.add(other)
					group.push(other)
				}
			}
		}
		groups.push(group)
	}
	return groups
}

/** A tldraw shape's own label, then any text boxes on it in reading order. */
function joinTexts(own: string | undefined, texts: SketchText[]): string | undefined {
	const sorted = [...texts].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)
	const joined = [own, ...sorted.map((t) => t.text)]
		.map((t) => t?.trim())
		.filter(Boolean)
		.join(' ')
	return joined || undefined
}

function getKnownNode(node: NodeDraft) {
	for (const stroke of node.outline) {
		if (stroke.known?.type === 'node') return stroke.known
	}
	return undefined
}

function getMedianSize(nodes: NodeDraft[]) {
	const sizes = nodes.map((n) => n.bounds.width + n.bounds.height).sort((a, b) => a - b)
	return sizes[Math.floor(sizes.length / 2)] ?? 0
}

function getDiagonal(box: Box) {
	return Math.hypot(box.width, box.height)
}

function getArea(box: Box) {
	return box.width * box.height
}

function getPathLength(points: Vec[]) {
	let length = 0
	for (let i = 1; i < points.length; i++) length += Vec.Dist(points[i - 1], points[i])
	return length
}

/** The points of a path up to `length` along it. */
function getPathPrefix(points: Vec[], length: number) {
	let travelled = 0
	for (let i = 1; i < points.length; i++) {
		travelled += Vec.Dist(points[i - 1], points[i])
		if (travelled >= length) return points.slice(0, i + 1)
	}
	return points
}

function getDistanceToPolyline(point: VecLike, points: Vec[]) {
	if (points.length === 1) return Vec.Dist(point, points[0])
	let min = Infinity
	for (let i = 1; i < points.length; i++) {
		min = Math.min(min, Vec.DistanceToLineSegment(points[i - 1], points[i], point))
	}
	return min
}

/** The closest any point of `points` comes to any of `strokes`. */
function getGap(points: Vec[], strokes: StrokeGeometry[]) {
	let min = Infinity
	for (const p of points) {
		for (const s of strokes) min = Math.min(min, getDistanceToPolyline(p, s.points))
	}
	return min
}

function getPolygonArea(points: Vec[]) {
	let area = 0
	for (let i = 0; i < points.length; i++) {
		const a = points[i]
		const b = points[(i + 1) % points.length]
		area += a.x * b.y - b.x * a.y
	}
	return Math.abs(area) / 2
}

/** Andrew's monotone chain. Used for "is this point inside the node", which forgives gaps. */
function getConvexHull(points: Vec[]): Vec[] {
	const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
	if (sorted.length < 3) return sorted
	const cross = (o: Vec, a: Vec, b: Vec) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
	const half = (pts: Vec[]) => {
		const out: Vec[] = []
		for (const p of pts) {
			while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop()
			out.push(p)
		}
		out.pop()
		return out
	}
	return [...half(sorted), ...half([...sorted].reverse())]
}

/*
[1]
A node is a closed outline: one stroke that comes back to its start, or several strokes whose
ends all land on each other. Outlines inside bigger outlines are letters, so they become
handwriting instead. Small closed outlines pressed against a bigger one are closed arrowheads.

[2]
A connector is any other stroke whose two ends touch two different nodes, either by landing
inside the node or within TOUCH_DISTANCE of its outline. The ends are kept in drawing order;
TypeSafe decides which end, if any, has the arrowhead.

[3]
Separate arrowheads are taken before labels, because an arrowhead can poke into the node it
points at. The test in isArrowheadAt is strict enough that the letters of a label near a
connector's end aren't taken. Whatever is left inside a node's outline is then that node's
handwritten label.

[4]
Some outlines are drawn as a closed stroke plus extra strokes, like a cylinder's sides and bottom.
Connectors, arrowheads and labels are found again afterwards, because a connector may end on
those extra strokes and a label may be written between them.

[5]
A small closed loop that nothing connects to and that has nothing inside it is more likely a
letter of a label next to a connector, like the O in "OK", than a node.

[6]
Typed text (from the text tool) labels the node it sits in, or the nearest connector. Typed text
is exact, so it's used as is and TypeSafe doesn't need to read it.

[7]
Nodes are numbered in reading order, and connectors sorted by the nodes they join, so the
Mermaid source is stable from run to run.
*/
