import { Vec } from 'tldraw'
// eslint-disable-next-line tldraw/no-undeclared-dependencies
import { describe, expect, it } from 'vitest'
import {
	GeoStrokeKind,
	StrokeRecognition,
	getBendThroughPoint,
	recognizeStroke,
} from './recognizeStroke'

// Fixtures are generated rather than recorded: an ideal path, sampled unevenly like a real
// pointer, with seeded low-frequency wobble and noise standing in for a shaky hand.

const DEG = Math.PI / 180
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8]

type Path = (t: number) => Vec

interface DrawOptions {
	/** Wobble and noise amplitude, as a share of the path's size. 0 draws the ideal path. */
	jitter?: number
	seed?: number
	/** Number of points to sample. */
	count?: number
}

function draw(path: Path, { jitter = 0, seed = 1, count = 120 }: DrawOptions = {}): Vec[] {
	const random = mulberry32(seed)
	const ideal = Array.from({ length: count }, (_, i) => path(i / (count - 1)))
	const size = getSize(ideal)
	const phases = Array.from({ length: 6 }, () => random() * Math.PI * 2)
	const speed = 0.4 + random() * 0.4
	return Array.from({ length: count }, (_, i) => {
		// Uneven spacing, the way pointer events bunch up at corners and spread out on straights.
		const s = i / (count - 1)
		const t = s - (speed * Math.sin(2 * Math.PI * s)) / (2 * Math.PI) / 4
		const wobble = new Vec(
			Math.sin(t * 7 + phases[0]) * 0.6 + Math.sin(t * 17 + phases[1]) * 0.4,
			Math.sin(t * 5 + phases[2]) * 0.6 + Math.sin(t * 13 + phases[3]) * 0.4
		)
		const noise = new Vec(random() - 0.5, random() - 0.5).mul(0.6)
		return Vec.Add(path(t), Vec.Add(wobble, noise).mul(jitter * size))
	})
}

function polygon(corners: Vec[], { start = 0, sweep = 1 } = {}): Path {
	const closed = [...corners, corners[0]]
	const lengths = closed.slice(1).map((p, i) => Vec.Dist(closed[i], p))
	const perimeter = lengths.reduce((a, b) => a + b, 0)
	return (t) => {
		let distance = ((((start + t * sweep) % 1) + 1) % 1) * perimeter
		for (let i = 0; i < lengths.length; i++) {
			if (distance <= lengths[i]) return Vec.Lrp(closed[i], closed[i + 1], distance / lengths[i])
			distance -= lengths[i]
		}
		return closed[0].clone()
	}
}

function polyline(points: Vec[]): Path {
	const lengths = points.slice(1).map((p, i) => Vec.Dist(points[i], p))
	const total = lengths.reduce((a, b) => a + b, 0)
	return (t) => {
		let distance = t * total
		for (let i = 0; i < lengths.length; i++) {
			if (distance <= lengths[i]) return Vec.Lrp(points[i], points[i + 1], distance / lengths[i])
			distance -= lengths[i]
		}
		return points[points.length - 1].clone()
	}
}

function ellipse(
	center: Vec,
	width: number,
	height: number,
	{ rotation = 0, start = 0, sweep = 1 } = {}
): Path {
	return (t) => {
		const angle = (start + t * sweep) * Math.PI * 2
		const local = new Vec((Math.cos(angle) * width) / 2, (Math.sin(angle) * height) / 2)
		return Vec.Add(center, Vec.Rot(local, rotation))
	}
}

function arc(center: Vec, radius: number, from: number, to: number): Path {
	return (t) => Vec.Add(center, Vec.FromAngle(from + (to - from) * t, radius))
}

function rectangleCorners(center: Vec, width: number, height: number, rotation = 0) {
	return [
		[-1, -1],
		[1, -1],
		[1, 1],
		[-1, 1],
	].map(([x, y]) => Vec.Add(center, Vec.Rot(new Vec((x * width) / 2, (y * height) / 2), rotation)))
}

function diamondCorners(center: Vec, width: number, height: number, rotation = 0) {
	return [
		[0, -1],
		[1, 0],
		[0, 1],
		[-1, 0],
	].map(([x, y]) => Vec.Add(center, Vec.Rot(new Vec((x * width) / 2, (y * height) / 2), rotation)))
}

/** An isosceles triangle pointing up before rotation, like tldraw's. */
function triangleCorners(center: Vec, width: number, height: number, rotation = 0) {
	return [
		[0, -1],
		[1, 1],
		[-1, 1],
	].map(([x, y]) => Vec.Add(center, Vec.Rot(new Vec((x * width) / 2, (y * height) / 2), rotation)))
}

/** A shaft from `from` to `tip`, then barbs drawn without lifting the pen. */
function arrowWithHook(from: Vec, tip: Vec, barbLength: number, { double = false } = {}) {
	const back = Vec.Sub(from, tip).uni()
	const barbA = Vec.Add(tip, Vec.Rot(back, 30 * DEG).mul(barbLength))
	const barbB = Vec.Add(tip, Vec.Rot(back, -30 * DEG).mul(barbLength))
	return polyline(double ? [from, tip, barbA, tip, barbB] : [from, tip, barbA])
}

function chevron(apex: Vec, direction: Vec, armLength: number, angle = 60 * DEG) {
	const back = direction.clone().uni().neg()
	return polyline([
		Vec.Add(apex, Vec.Rot(back, angle / 2).mul(armLength)),
		apex,
		Vec.Add(apex, Vec.Rot(back, -angle / 2).mul(armLength)),
	])
}

const center = new Vec(400, 300)

function expectGeo(
	result: StrokeRecognition,
	expected: {
		kind: GeoStrokeKind
		rotation?: number
		flipY?: boolean
		width?: number
		height?: number
	},
	sizeTolerance = 0.12
) {
	expect(result.kind).toBe(expected.kind)
	if (result.kind === 'unknown' || result.kind === 'line' || result.kind === 'chevron') return
	if (expected.rotation !== undefined) {
		expect(angleDifference(result.rotation, expected.rotation)).toBeLessThan(4 * DEG)
	}
	expect(result.flipY).toBe(expected.flipY ?? false)
	if (expected.width !== undefined) {
		expect(Math.abs(result.width - expected.width) / expected.width).toBeLessThan(sizeTolerance)
	}
	if (expected.height !== undefined) {
		expect(Math.abs(result.height - expected.height) / expected.height).toBeLessThan(sizeTolerance)
	}
	expect(result.confidence).toBeGreaterThan(0)
}

describe('closed strokes', () => {
	it('recognizes a clean rectangle', () => {
		const result = recognizeStroke(draw(polygon(rectangleCorners(center, 240, 140))))
		expectGeo(result, { kind: 'rectangle', rotation: 0, width: 240, height: 140 }, 0.02)
		expect(result.kind === 'rectangle' && Vec.Dist(result.center, center)).toBeLessThan(2)
		expect(result.kind === 'rectangle' && result.rotation).toBe(0)
	})

	it('recognizes a clean ellipse and circle', () => {
		expectGeo(recognizeStroke(draw(ellipse(center, 260, 140))), {
			kind: 'ellipse',
			rotation: 0,
			width: 260,
			height: 140,
		})
		expectGeo(recognizeStroke(draw(ellipse(center, 180, 180))), {
			kind: 'ellipse',
			rotation: 0,
			width: 180,
			height: 180,
		})
	})

	it('recognizes triangles and the way they point', () => {
		const up = recognizeStroke(draw(polygon(triangleCorners(center, 200, 160))))
		expectGeo(up, { kind: 'triangle', rotation: 0, width: 200, height: 160 })

		const down = recognizeStroke(draw(polygon(triangleCorners(center, 200, 160, 180 * DEG))))
		expectGeo(down, { kind: 'triangle', rotation: 0, flipY: true, width: 200, height: 160 })

		const right = recognizeStroke(draw(polygon(triangleCorners(center, 200, 160, 90 * DEG))))
		expectGeo(right, { kind: 'triangle', rotation: 90 * DEG, width: 200, height: 160 })

		const left = recognizeStroke(draw(polygon(triangleCorners(center, 200, 160, -90 * DEG))))
		expectGeo(left, { kind: 'triangle', rotation: -90 * DEG, width: 200, height: 160 })

		const tilted = recognizeStroke(draw(polygon(triangleCorners(center, 200, 160, 30 * DEG))))
		expectGeo(tilted, { kind: 'triangle', rotation: 30 * DEG, width: 200, height: 160 })
	})

	it('fits right triangles with the closest isosceles triangle', () => {
		// Two equal legs make an isosceles triangle on the hypotenuse, pointing at the right angle.
		const isosceles = [new Vec(300, 200), new Vec(300, 400), new Vec(500, 400)]
		expectGeo(recognizeStroke(draw(polygon(isosceles))), {
			kind: 'triangle',
			rotation: 45 * DEG,
			flipY: true,
		})
		const scalene = [new Vec(300, 250), new Vec(300, 400), new Vec(520, 400)]
		expect(recognizeStroke(draw(polygon(scalene), { jitter: 0.01 })).kind).toBe('triangle')
	})

	it('recognizes diamonds', () => {
		expectGeo(recognizeStroke(draw(polygon(diamondCorners(center, 220, 140)))), {
			kind: 'diamond',
			rotation: 0,
			width: 220,
			height: 140,
		})
		expectGeo(recognizeStroke(draw(polygon(diamondCorners(center, 220, 140, 25 * DEG)))), {
			kind: 'diamond',
			rotation: 25 * DEG,
			width: 220,
			height: 140,
		})
	})

	it('snaps nearly axis-aligned shapes to zero rotation', () => {
		for (const degrees of [-9, -5, 3, 8]) {
			expectGeo(recognizeStroke(draw(polygon(rectangleCorners(center, 240, 140, degrees * DEG)))), {
				kind: 'rectangle',
				rotation: 0,
			})
			expectGeo(recognizeStroke(draw(ellipse(center, 260, 130, { rotation: degrees * DEG }))), {
				kind: 'ellipse',
				rotation: 0,
			})
		}
	})

	it('keeps the rotation of clearly rotated rectangles and ellipses', () => {
		for (const degrees of [-35, -20, 15, 30, 40]) {
			expectGeo(recognizeStroke(draw(polygon(rectangleCorners(center, 240, 120, degrees * DEG)))), {
				kind: 'rectangle',
				rotation: degrees * DEG,
				width: 240,
				height: 120,
			})
			expectGeo(recognizeStroke(draw(ellipse(center, 260, 120, { rotation: degrees * DEG }))), {
				kind: 'ellipse',
				rotation: degrees * DEG,
				width: 260,
				height: 120,
			})
		}
	})

	it('tells a diamond from a rotated square by where its corners sit', () => {
		// Corners on the midpoints of the upright bounding box: a diamond.
		expectGeo(recognizeStroke(draw(polygon(rectangleCorners(center, 160, 160, 45 * DEG)))), {
			kind: 'diamond',
			rotation: 0,
		})
		expectGeo(recognizeStroke(draw(polygon(rectangleCorners(center, 160, 160, 40 * DEG)))), {
			kind: 'diamond',
			rotation: 0,
		})
		// Corners well away from them: a rotated square.
		expectGeo(recognizeStroke(draw(polygon(rectangleCorners(center, 160, 160, 25 * DEG)))), {
			kind: 'rectangle',
			rotation: 25 * DEG,
		})
	})

	it('copes with a shaky hand', () => {
		for (const seed of SEEDS) {
			const options = { jitter: 0.012, seed }
			expectGeo(recognizeStroke(draw(polygon(rectangleCorners(center, 240, 150)), options)), {
				kind: 'rectangle',
				rotation: 0,
				width: 240,
				height: 150,
			})
			expectGeo(
				recognizeStroke(draw(polygon(rectangleCorners(center, 240, 130, 30 * DEG)), options)),
				{ kind: 'rectangle', rotation: 30 * DEG }
			)
			expectGeo(recognizeStroke(draw(ellipse(center, 240, 150), options)), {
				kind: 'ellipse',
				rotation: 0,
				width: 240,
				height: 150,
			})
			expectGeo(recognizeStroke(draw(ellipse(center, 200, 200), options)), {
				kind: 'ellipse',
				rotation: 0,
			})
			expectGeo(recognizeStroke(draw(polygon(triangleCorners(center, 220, 180)), options)), {
				kind: 'triangle',
				rotation: 0,
				width: 220,
				height: 180,
			})
			expectGeo(
				recognizeStroke(draw(polygon(triangleCorners(center, 220, 180, 180 * DEG)), options)),
				{ kind: 'triangle', rotation: 0, flipY: true }
			)
			expectGeo(recognizeStroke(draw(polygon(diamondCorners(center, 220, 150)), options)), {
				kind: 'diamond',
				rotation: 0,
				width: 220,
				height: 150,
			})
		}
	})

	it('treats a stroke that ends near its start as closed', () => {
		for (const seed of SEEDS) {
			const options = { jitter: 0.01, seed }
			// Stops short of the start.
			expectGeo(
				recognizeStroke(
					draw(polygon(rectangleCorners(center, 240, 150), { start: 0.1, sweep: 0.95 }), options)
				),
				{ kind: 'rectangle', rotation: 0 }
			)
			expectGeo(recognizeStroke(draw(ellipse(center, 240, 150, { sweep: 0.94 }), options)), {
				kind: 'ellipse',
			})
			// Runs past the start.
			expectGeo(
				recognizeStroke(
					draw(polygon(rectangleCorners(center, 240, 150), { start: 0.3, sweep: 1.12 }), options)
				),
				{ kind: 'rectangle', rotation: 0, width: 240, height: 150 }
			)
			expectGeo(
				recognizeStroke(draw(ellipse(center, 240, 150, { start: 0.6, sweep: 1.15 }), options)),
				{ kind: 'ellipse', width: 240, height: 150 }
			)
		}
	})

	it("doesn't depend on where the stroke starts", () => {
		for (const start of [0, 0.13, 0.4, 0.62, 0.9]) {
			expectGeo(recognizeStroke(draw(polygon(rectangleCorners(center, 240, 150), { start }))), {
				kind: 'rectangle',
			})
			expectGeo(recognizeStroke(draw(polygon(triangleCorners(center, 220, 180), { start }))), {
				kind: 'triangle',
			})
			expectGeo(recognizeStroke(draw(polygon(diamondCorners(center, 220, 150), { start }))), {
				kind: 'diamond',
			})
		}
	})

	it('works at any scale', () => {
		for (const scale of [0.05, 1, 40]) {
			const result = recognizeStroke(
				draw(polygon(rectangleCorners(Vec.Mul(center, scale), 240 * scale, 150 * scale)), {
					jitter: 0.01,
				})
			)
			expectGeo(result, { kind: 'rectangle', width: 240 * scale, height: 150 * scale })
		}
	})
})

describe('open strokes', () => {
	it('recognizes straight lines', () => {
		for (const seed of SEEDS) {
			const from = new Vec(100, 100)
			const to = new Vec(420, 260)
			const result = recognizeStroke(draw(polyline([from, to]), { jitter: 0.012, seed }))
			expect(result.kind).toBe('line')
			if (result.kind !== 'line') continue
			expect(Vec.Dist(result.start, from)).toBeLessThan(15)
			expect(Vec.Dist(result.end, to)).toBeLessThan(15)
			expect(result.arcMidpoint).toBeNull()
			expect(result.arrowheadAtStart).toBe(false)
			expect(result.arrowheadAtEnd).toBe(false)
			expect(Vec.Dpr(result.endDirection, Vec.Sub(to, from).uni())).toBeGreaterThan(0.95)
			expect(Vec.Dpr(result.startDirection, Vec.Sub(from, to).uni())).toBeGreaterThan(0.95)
		}
	})

	it('recognizes arcs and reports their midpoint', () => {
		for (const seed of SEEDS) {
			const result = recognizeStroke(
				draw(arc(center, 200, 200 * DEG, 320 * DEG), { jitter: 0.008, seed })
			)
			expect(result.kind).toBe('line')
			if (result.kind !== 'line') continue
			expect(result.arcMidpoint).not.toBeNull()
			expect(
				Vec.Dist(result.arcMidpoint!, Vec.Add(center, Vec.FromAngle(260 * DEG, 200)))
			).toBeLessThan(20)
		}
	})

	it('finds an arrowhead drawn at the end of the same stroke', () => {
		for (const seed of SEEDS) {
			const from = new Vec(100, 300)
			const tip = new Vec(450, 220)
			for (const double of [false, true]) {
				const result = recognizeStroke(
					draw(arrowWithHook(from, tip, 50, { double }), { jitter: 0.006, seed, count: 160 })
				)
				expect(result.kind).toBe('line')
				if (result.kind !== 'line') continue
				expect(result.arrowheadAtEnd).toBe(true)
				expect(result.arrowheadAtStart).toBe(false)
				expect(Vec.Dist(result.end, tip)).toBeLessThan(15)
				expect(result.arcMidpoint).toBeNull()
			}
		}
	})

	it('finds an arrowhead drawn at the start of the stroke', () => {
		const tip = new Vec(100, 300)
		const to = new Vec(450, 220)
		const back = Vec.Sub(to, tip).uni()
		const barb = Vec.Add(tip, Vec.Rot(back, 30 * DEG).mul(50))
		const result = recognizeStroke(draw(polyline([barb, tip, to]), { jitter: 0.006, count: 160 }))
		expect(result.kind).toBe('line')
		if (result.kind !== 'line') return
		expect(result.arrowheadAtStart).toBe(true)
		expect(result.arrowheadAtEnd).toBe(false)
		expect(Vec.Dist(result.start, tip)).toBeLessThan(15)
	})

	it('ignores a small flick at the end of a line', () => {
		const from = new Vec(100, 300)
		const tip = new Vec(450, 300)
		const flick = Vec.Add(tip, new Vec(-8, 6))
		const result = recognizeStroke(draw(polyline([from, tip, flick]), { count: 160 }))
		expect(result.kind).toBe('line')
		if (result.kind !== 'line') return
		expect(result.arrowheadAtEnd).toBe(false)
	})

	it('recognizes V-shaped arrowheads', () => {
		for (const seed of SEEDS) {
			for (const angle of [40, 60, 90]) {
				const direction = Vec.FromAngle(20 * DEG)
				const apex = new Vec(300, 300)
				const result = recognizeStroke(
					draw(chevron(apex, direction, 40, angle * DEG), { jitter: 0.01, seed, count: 40 })
				)
				expect(result.kind).toBe('chevron')
				if (result.kind !== 'chevron') continue
				expect(Vec.Dist(result.apex, apex)).toBeLessThan(6)
				expect(Vec.Dpr(result.direction, direction)).toBeGreaterThan(0.95)
			}
		}
	})
})

describe('strokes that should stay as ink', () => {
	it('rejects scribbles', () => {
		for (const seed of SEEDS) {
			const random = mulberry32(seed)
			const walk = [new Vec(300, 300)]
			for (let i = 0; i < 12; i++) {
				walk.push(Vec.Add(walk[i], new Vec(random() - 0.5, random() - 0.5).mul(160)))
			}
			expect(recognizeStroke(draw(polyline(walk), { jitter: 0.005, seed })).kind).toBe('unknown')
		}
	})

	it('rejects zigzags, waves, spirals, figure eights and S-curves', () => {
		const zigzag = polyline(
			Array.from({ length: 9 }, (_, i) => new Vec(100 + i * 40, i % 2 ? 260 : 300))
		)
		const wave: Path = (t) => new Vec(100 + t * 400, 300 + Math.sin(t * Math.PI * 4) * 40)
		const spiral: Path = (t) => Vec.Add(center, Vec.FromAngle(t * Math.PI * 5, 20 + t * 140))
		const figureEight: Path = (t) =>
			Vec.Add(center, new Vec(Math.sin(t * Math.PI * 2) * 150, Math.sin(t * Math.PI * 4) * 60))
		const sCurve: Path = (t) => new Vec(100 + t * 400, 300 + Math.sin(t * Math.PI * 2) * 60)
		for (const path of [zigzag, wave, spiral, figureEight, sCurve]) {
			for (const seed of SEEDS.slice(0, 3)) {
				expect(recognizeStroke(draw(path, { jitter: 0.005, seed })).kind).toBe('unknown')
			}
		}
	})

	it('rejects open shapes that leave a large gap', () => {
		// A rectangle missing a side, and a C.
		expect(
			recognizeStroke(draw(polygon(rectangleCorners(center, 240, 150), { sweep: 0.7 }))).kind
		).toBe('unknown')
		expect(recognizeStroke(draw(ellipse(center, 200, 200, { sweep: 0.75 }))).kind).toBe('unknown')
	})

	it('rejects an L shape and a back-and-forth stroke', () => {
		// An L with equal arms reads as a V, which only converts when it caps a line.
		const lShape = polyline([new Vec(100, 100), new Vec(100, 400), new Vec(180, 400)])
		const backAndForth = polyline([new Vec(100, 100), new Vec(400, 120), new Vec(110, 105)])
		expect(recognizeStroke(draw(lShape)).kind).toBe('unknown')
		expect(recognizeStroke(draw(backAndForth, { jitter: 0.005 })).kind).toBe('unknown')
	})

	it('rejects dots and empty strokes', () => {
		expect(recognizeStroke([]).kind).toBe('unknown')
		expect(recognizeStroke([{ x: 5, y: 5 }]).kind).toBe('unknown')
		expect(
			recognizeStroke([
				{ x: 5, y: 5 },
				{ x: 5, y: 5 },
			]).kind
		).toBe('unknown')
	})
})

describe('getBendThroughPoint', () => {
	it('matches the sagitta when the point is on the perpendicular bisector', () => {
		expect(getBendThroughPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 20 })).toBeCloseTo(20)
		expect(getBendThroughPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: -20 })).toBeCloseTo(
			-20
		)
		expect(getBendThroughPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 0 })).toBe(0)
	})

	it('puts the arc through points away from the bisector', () => {
		const start = new Vec(0, 0)
		const end = new Vec(200, 40)
		for (const through of [new Vec(40, 60), new Vec(150, -30), new Vec(260, 120)]) {
			const bend = getBendThroughPoint(start, end, through)
			// tldraw's arc middle for this bend, which must lie on the circle through all three points.
			const u = Vec.Sub(end, start).uni()
			const middle = Vec.Add(Vec.Med(start, end), new Vec(-u.y, u.x).mul(bend))
			const radius = (p: Vec) => Vec.Dist(p, circleCenter(start, end, through))
			expect(radius(middle)).toBeCloseTo(radius(start), 6)
		}
	})
})

function circleCenter(a: Vec, b: Vec, c: Vec) {
	const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
	const a2 = Vec.Len2(a)
	const b2 = Vec.Len2(b)
	const c2 = Vec.Len2(c)
	return new Vec(
		(a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
		(a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
	)
}

function angleDifference(a: number, b: number) {
	const difference = Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))
	return difference
}

function getSize(points: Vec[]) {
	const xs = points.map((p) => p.x)
	const ys = points.map((p) => p.y)
	return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
}

function mulberry32(seed: number) {
	let state = seed
	return () => {
		state = (state + 0x6d2b79f5) | 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}
