import { Vec, VecLike } from 'tldraw'
// eslint-disable-next-line tldraw/no-undeclared-dependencies
import { describe, expect, it } from 'vitest'
import { SketchStroke, SketchText, segmentSketch } from './segmentSketch'

/** A hand-drawn-ish stroke through `corners`, sampled every few units with a seeded wobble. */
function stroke(id: string, corners: VecLike[], seed = 1): SketchStroke {
	const random = mulberry32(seed)
	const points: Vec[] = []
	for (let i = 1; i < corners.length; i++) {
		const a = Vec.From(corners[i - 1])
		const b = Vec.From(corners[i])
		const steps = Math.max(2, Math.ceil(Vec.Dist(a, b) / 4))
		for (let s = 0; s < steps; s++) {
			const p = Vec.Lrp(a, b, s / steps)
			points.push(new Vec(p.x + (random() - 0.5) * 2, p.y + (random() - 0.5) * 2))
		}
	}
	points.push(Vec.From(corners[corners.length - 1]))
	return { id, points }
}

function box(id: string, x: number, y: number, w = 160, h = 80) {
	return stroke(id, [
		{ x, y },
		{ x: x + w, y },
		{ x: x + w, y: y + h },
		{ x, y: y + h },
		{ x: x + 2, y: y + 3 },
	])
}

function circle(id: string, cx: number, cy: number, r: number, from = 0, to = Math.PI * 2) {
	const corners: VecLike[] = []
	for (let i = 0; i <= 48; i++) {
		const t = from + ((to - from) * i) / 48
		corners.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) })
	}
	return stroke(id, corners)
}

function line(id: string, x1: number, y1: number, x2: number, y2: number) {
	return stroke(id, [
		{ x: x1, y: y1 },
		{ x: x2, y: y2 },
	])
}

/** A small zigzag, like a handwritten word. */
function word(id: string, x: number, y: number, w = 40) {
	const corners: VecLike[] = []
	for (let i = 0; i <= 6; i++) corners.push({ x: x + (w * i) / 6, y: y + (i % 2 ? 12 : 0) })
	return stroke(id, corners)
}

function text(id: string, value: string, x: number, y: number): SketchText {
	return { id, text: value, bounds: { x, y, w: 60, h: 20 } }
}

describe('segmentSketch', () => {
	it('finds two boxes joined by a line, in drawing order', () => {
		const graph = segmentSketch([box('a', 0, 0), box('b', 0, 200), line('ab', 80, 85, 80, 195)], [])
		expect(graph.nodes.map((n) => n.outline)).toEqual([['a'], ['b']])
		expect(graph.edges).toMatchObject([{ from: 'n1', to: 'n2', strokes: ['ab'] }])
		expect(graph.ignored).toEqual([])
	})

	it('keeps the direction the connector was drawn in', () => {
		const graph = segmentSketch([box('a', 0, 0), box('b', 0, 200), line('ba', 80, 195, 80, 85)], [])
		expect(graph.edges).toMatchObject([{ from: 'n2', to: 'n1' }])
	})

	it('counts a connector that ends inside a node', () => {
		const graph = segmentSketch([box('a', 0, 0), box('b', 0, 200), line('ab', 80, 60, 80, 230)], [])
		expect(graph.edges).toMatchObject([{ from: 'n1', to: 'n2' }])
	})

	it('attaches an arrowhead drawn as a separate stroke to its connector', () => {
		const head = stroke('head', [
			{ x: 68, y: 182 },
			{ x: 80, y: 196 },
			{ x: 92, y: 182 },
		])
		const graph = segmentSketch(
			[box('a', 0, 0), box('b', 0, 200), line('ab', 80, 85, 80, 195), head],
			[]
		)
		expect(graph.edges).toMatchObject([{ strokes: ['ab', 'head'] }])
		expect(graph.ignored).toEqual([])
	})

	it('treats strokes inside an outline as its label, including closed letters', () => {
		const graph = segmentSketch(
			[box('a', 0, 0), word('w1', 20, 30), circle('o', 120, 36, 12), box('b', 300, 0)],
			[]
		)
		expect(graph.nodes).toHaveLength(2)
		expect(graph.nodes[0].outline).toEqual(['a'])
		expect([...graph.nodes[0].label].sort()).toEqual(['o', 'w1'])
	})

	it('joins an outline drawn one side at a time', () => {
		const sides = [
			line('top', 0, 0, 160, 0),
			line('right', 160, 0, 160, 80),
			line('bottom', 160, 80, 0, 80),
			line('left', 0, 80, 0, 0),
		]
		// The connector starts right at a corner, where it meets two sides' ends.
		const graph = segmentSketch([...sides, box('b', 0, 200), line('ab', 0, 80, 40, 210)], [])
		expect(graph.nodes.map((n) => [...n.outline].sort())).toEqual([
			['bottom', 'left', 'right', 'top'],
			['b'],
		])
		expect(graph.edges).toMatchObject([{ from: 'n1', to: 'n2', strokes: ['ab'] }])
	})

	it('joins the sides of a cylinder to its top, and connects to its bottom', () => {
		const graph = segmentSketch(
			[
				box('a', 0, 0),
				// Top oval, two sides, and the bottom curve.
				stroke(
					'top',
					circle('', 80, 220, 1).points.map((_, i, all) => ({
						x: 80 + 70 * Math.cos((i / (all.length - 1)) * Math.PI * 2),
						y: 220 + 18 * Math.sin((i / (all.length - 1)) * Math.PI * 2),
					}))
				),
				line('left', 10, 222, 10, 330),
				line('right', 150, 222, 150, 330),
				stroke(
					'bottom',
					Array.from({ length: 25 }, (_, i) => ({
						x: 10 + (140 * i) / 24,
						y: 330 + 18 * Math.sin((i / 24) * Math.PI),
					}))
				),
				line('ab', 80, 85, 80, 198),
				box('c', 0, 450),
				line('bc', 80, 352, 80, 445),
			],
			[]
		)
		expect(graph.nodes.map((n) => [...n.outline].sort())).toEqual([
			['a'],
			['bottom', 'left', 'right', 'top'],
			['c'],
		])
		expect(graph.edges).toMatchObject([
			{ from: 'n1', to: 'n2' },
			{ from: 'n2', to: 'n3' },
		])
	})

	it('labels a connector with handwriting next to its middle', () => {
		const graph = segmentSketch(
			[box('a', 0, 0), box('b', 0, 300), line('ab', 80, 85, 80, 295), word('yes', 92, 180, 30)],
			[]
		)
		expect(graph.edges).toMatchObject([{ label: ['yes'] }])
	})

	it('uses typed text for nodes and connectors', () => {
		const graph = segmentSketch(
			[box('a', 0, 0), box('b', 0, 300), line('ab', 80, 85, 80, 295)],
			[text('t1', 'Start', 50, 30), text('t2', 'Yes', 92, 180), text('far', 'Note', 900, 900)]
		)
		expect(graph.nodes[0].text).toBe('Start')
		expect(graph.edges[0].text).toBe('Yes')
		expect(graph.ignored).toEqual(['far'])
	})

	it('ignores lines that only touch one node, and stray marks', () => {
		const graph = segmentSketch(
			[box('a', 0, 0), box('b', 0, 300), line('dangling', 170, 40, 300, 40), word('x', 600, 600)],
			[]
		)
		expect(graph.edges).toEqual([])
		expect([...graph.ignored].sort()).toEqual(['dangling', 'x'])
	})

	it('does not mistake a small closed letter by a connector for a node', () => {
		const graph = segmentSketch(
			[
				box('a', 0, 0),
				box('b', 0, 300),
				line('ab', 80, 85, 80, 295),
				// The O and K of "OK", next to the connector.
				circle('O', 105, 190, 20),
				line('K', 130, 170, 130, 210),
			],
			[]
		)
		expect(graph.nodes.map((n) => n.outline)).toEqual([['a'], ['b']])
		expect([...graph.edges[0].label].sort()).toEqual(['K', 'O'])
	})

	it('connects a hooked arrow whose barb ends short of the node', () => {
		// The tip touches b at y = 196, then the barb flicks back up and away to 20 units short.
		const hooked = stroke('ab', [
			{ x: 80, y: 85 },
			{ x: 80, y: 196 },
			{ x: 66, y: 180 },
		])
		const graph = segmentSketch([box('a', 0, 0), box('b', 0, 200), hooked], [])
		expect(graph.edges).toMatchObject([{ from: 'n1', to: 'n2', strokes: ['ab'] }])
	})

	it('does not mistake a short hooked arrow for a closed outline', () => {
		// Recorded from a real stroke: the barb's end lands near the middle of a short shaft.
		const hooked = stroke('ab', [
			{ x: 80, y: 85 },
			{ x: 80, y: 155.5 },
			{ x: 70, y: 144 },
		])
		const graph = segmentSketch([box('a', 0, 0), box('b', 0, 160), hooked], [])
		expect(graph.edges).toMatchObject([{ from: 'n1', to: 'n2', strokes: ['ab'] }])
	})

	it('labels a cylinder with typed text in its body, below the top oval', () => {
		const graph = segmentSketch(
			[
				stroke(
					'top',
					Array.from({ length: 49 }, (_, i) => ({
						x: 80 + 70 * Math.cos((i / 48) * Math.PI * 2),
						y: 20 + 18 * Math.sin((i / 48) * Math.PI * 2),
					}))
				),
				line('left', 10, 22, 10, 130),
				line('right', 150, 22, 150, 130),
				stroke(
					'bottom',
					Array.from({ length: 25 }, (_, i) => ({
						x: 10 + (140 * i) / 24,
						y: 130 + 18 * Math.sin((i / 24) * Math.PI),
					}))
				),
			],
			[text('log', 'Log', 50, 70)]
		)
		expect(graph.nodes).toMatchObject([{ text: 'Log' }])
	})

	it('estimates the scale the sketch was drawn at from its outlines', () => {
		const strokes = [
			box('a', 0, 0),
			box('b', 0, 300),
			line('ab', 80, 85, 80, 295),
			word('w1', 30, 30),
			word('w2', 90, 30),
		]
		const at = (factor: number) =>
			segmentSketch(
				strokes.map((s) => ({ ...s, points: s.points.map((p) => Vec.Mul(p, factor)) })),
				[]
			)
		for (const factor of [0.5, 1, 3]) {
			const graph = at(factor)
			expect(graph.scale).toBeCloseTo(factor * 1.05, 1)
			expect(graph.edges).toHaveLength(1)
			expect([...graph.nodes[0].label].sort()).toEqual(['w1', 'w2'])
		}
	})

	it('keeps a label centred in a node when a connector leaves next to it', () => {
		const graph = segmentSketch(
			[box('a', 0, 0), word('label', 50, 30, 60), box('b', 0, 250), line('ab', 80, 82, 80, 248)],
			[]
		)
		expect(graph.nodes[0].label).toEqual(['label'])
		expect(graph.edges).toMatchObject([{ strokes: ['ab'] }])
	})

	it('keeps letters in a node when a connector overshoots into it', () => {
		const graph = segmentSketch(
			[
				box('a', 0, 0),
				box('b', 0, 250),
				line('ab', 80, 82, 80, 262),
				word('L1', 50, 280, 16),
				word('L2', 72, 280, 16),
				word('L3', 94, 280, 16),
			],
			[]
		)
		expect([...graph.nodes[1].label].sort()).toEqual(['L1', 'L2', 'L3'])
		expect(graph.edges).toMatchObject([{ strokes: ['ab'] }])
	})

	it('does not take the letters of a branch label next to the connector as an arrowhead', () => {
		const graph = segmentSketch(
			[
				stroke('d', [
					{ x: 80, y: 180 },
					{ x: 140, y: 220 },
					{ x: 80, y: 260 },
					{ x: 20, y: 220 },
					{ x: 83, y: 182 },
				]),
				box('b', 300, 180),
				line('db', 141, 220, 298, 220),
				stroke('Y', [
					{ x: 146, y: 200 },
					{ x: 153, y: 207 },
					{ x: 160, y: 200 },
				]),
				word('e', 164, 202, 12),
				word('s', 180, 202, 12),
			],
			[]
		)
		expect(graph.edges).toHaveLength(1)
		expect(graph.edges[0].strokes).toEqual(['db'])
		expect([...graph.edges[0].label].sort()).toEqual(['Y', 'e', 's'])
	})

	it('gives a separate arrowhead to the connector it caps, not the first one nearby', () => {
		const graph = segmentSketch(
			[
				box('A', 0, 0),
				box('C', 300, 0),
				box('B', 100, 250),
				line('ab', 80, 82, 172, 248),
				line('cb', 380, 82, 195, 248),
				stroke('vcb', [
					{ x: 190, y: 232 },
					{ x: 195, y: 248 },
					{ x: 208, y: 240 },
				]),
			],
			[]
		)
		const strokes = Object.fromEntries(graph.edges.map((e) => [e.strokes[0], e.strokes]))
		expect(strokes).toEqual({ ab: ['ab'], cb: ['cb', 'vcb'] })
	})

	it('treats a small closed triangle at a connector end as its arrowhead', () => {
		const triangle = stroke('tri', [
			{ x: 66, y: 170 },
			{ x: 94, y: 170 },
			{ x: 80, y: 198 },
			{ x: 66, y: 171 },
		])
		const graph = segmentSketch(
			[box('a', 0, 0), box('b', 0, 200), line('ab', 80, 82, 80, 170), triangle],
			[]
		)
		expect(graph.nodes.map((n) => n.outline)).toEqual([['a'], ['b']])
		expect(graph.edges).toMatchObject([{ from: 'n1', to: 'n2', strokes: ['ab', 'tri'] }])
	})

	it('finds a circle closed by carrying on past its start', () => {
		const graph = segmentSketch(
			[
				circle('c', 80, 40, 40, 0, Math.PI * 2 + Math.PI / 4),
				box('b', 0, 200),
				line('cb', 80, 82, 80, 198),
			],
			[]
		)
		expect(graph.nodes.map((n) => n.outline)).toEqual([['c'], ['b']])
		expect(graph.edges).toHaveLength(1)
	})

	it('finds a box drawn one side at a time with crossing corners', () => {
		const graph = segmentSketch(
			[
				line('top', -15, 0, 175, 0),
				line('right', 160, -15, 160, 95),
				line('bottom', 175, 80, -15, 80),
				line('left', 0, 95, 0, -15),
				box('b', 0, 250),
				line('ab', 80, 97, 80, 248),
			],
			[]
		)
		expect(graph.nodes.map((n) => [...n.outline].sort())).toEqual([
			['bottom', 'left', 'right', 'top'],
			['b'],
		])
		expect(graph.edges).toHaveLength(1)
	})

	it('keeps two outlines drawn in several strokes apart when a connector joins their ends', () => {
		const half = (id: string, cx: number, sign: number) =>
			stroke(id, [
				{ x: cx - 60 * sign, y: 0 },
				{ x: cx, y: -40 * sign },
				{ x: cx + 60 * sign, y: 0 },
			])
		const graph = segmentSketch(
			[
				half('d1top', 80, 1),
				half('d1bot', 80, -1),
				half('d2top', 320, 1),
				half('d2bot', 320, -1),
				line('d1d2', 140, 0, 260, 0),
			],
			[]
		)
		expect(graph.nodes.map((n) => [...n.outline].sort())).toEqual([
			['d1bot', 'd1top'],
			['d2bot', 'd2top'],
		])
		expect(graph.edges).toMatchObject([{ strokes: ['d1d2'] }])

		const sides = (p: string, x: number) => [
			line(`${p}-top`, x, 0, x + 160, 0),
			line(`${p}-right`, x + 160, 0, x + 160, 80),
			line(`${p}-bottom`, x + 160, 80, x, 80),
			line(`${p}-left`, x, 80, x, 0),
		]
		const boxes = segmentSketch(
			[...sides('a', 0), ...sides('c', 300), line('ac', 160, 80, 300, 0)],
			[]
		)
		expect(boxes.nodes).toHaveLength(2)
		expect(boxes.edges).toMatchObject([{ strokes: ['ac'] }])
	})

	it('estimates the scale from node outlines, not letters or small Start and End circles', () => {
		const sides = (p: string, y: number) => [
			line(`${p}-top`, 0, y, 160, y),
			line(`${p}-right`, 160, y, 160, y + 80),
			line(`${p}-bottom`, 160, y + 80, 0, y + 80),
			line(`${p}-left`, 0, y + 80, 0, y),
		]
		// Both boxes drawn one side at a time, with a closed letter inside one of them.
		const lettered = segmentSketch(
			[
				...sides('a', 0),
				...sides('b', 250),
				circle('o', 40, 40, 7),
				line('ab', 80, 88, 80, 242),
				word('yes', 92, 160, 30),
			],
			[]
		)
		expect(lettered.scale).toBeGreaterThan(0.8)
		expect(lettered.edges).toMatchObject([{ strokes: ['ab'], label: ['yes'] }])

		// A connector stopping 12 short of each box survives small circles elsewhere.
		const circled = segmentSketch(
			[
				circle('start', 80, 30, 28),
				box('a', 0, 100),
				box('b', 0, 400),
				circle('end', 80, 560, 28),
				line('sa', 80, 60, 80, 98),
				line('ab', 80, 192, 80, 388),
				line('be', 80, 482, 80, 530),
			],
			[]
		)
		expect(circled.scale).toBeGreaterThan(0.8)
		expect(circled.edges.map((e) => e.strokes[0])).toEqual(['sa', 'ab', 'be'])
	})

	it('labels a cylinder with handwriting in its body', () => {
		const graph = segmentSketch(
			[
				stroke(
					'top',
					Array.from({ length: 49 }, (_, i) => ({
						x: 80 + 70 * Math.cos((i / 48) * Math.PI * 2),
						y: 20 + 18 * Math.sin((i / 48) * Math.PI * 2),
					}))
				),
				line('left', 10, 22, 10, 130),
				line('right', 150, 22, 150, 130),
				stroke(
					'bottom',
					Array.from({ length: 25 }, (_, i) => ({
						x: 10 + (140 * i) / 24,
						y: 130 + 18 * Math.sin((i / 24) * Math.PI),
					}))
				),
				word('users', 55, 70, 50),
			],
			[]
		)
		expect(graph.nodes).toMatchObject([{ label: ['users'] }])
		expect(graph.ignored).toEqual([])
	})

	it('keeps connectors with separate arrowheads out of an outline drawn one side at a time', () => {
		const v = (id: string, x: number, y: number, dx: number, dy: number) =>
			stroke(id, [
				{ x: x - 12 * dx - 7 * dy, y: y - 12 * dy - 7 * dx },
				{ x, y },
				{ x: x - 12 * dx + 7 * dy, y: y - 12 * dy + 7 * dx },
			])
		const graph = segmentSketch(
			[
				box('a', 0, 0),
				line('rt', 0, 250, 160, 250),
				line('rr', 160, 250, 160, 330),
				line('rb', 160, 330, 0, 330),
				line('rl', 0, 330, 0, 250),
				line('ar', 80, 82, 80, 246),
				v('v1', 80, 248, 0, 1),
				// A loop-back edge from the side of r up to the side of a, with its own arrowhead.
				stroke('ra', [
					{ x: -2, y: 290 },
					{ x: -60, y: 290 },
					{ x: -60, y: 40 },
					{ x: -6, y: 40 },
				]),
				v('v2', -4, 40, 1, 0),
			],
			[]
		)
		expect(graph.nodes.map((n) => [...n.outline].sort())).toEqual([['a'], ['rb', 'rl', 'rr', 'rt']])
		const strokes = Object.fromEntries(graph.edges.map((e) => [e.strokes[0], e.strokes]))
		expect(strokes).toEqual({ ar: ['ar', 'v1'], ra: ['ra', 'v2'] })
	})

	describe('tldraw shapes', () => {
		const geo = (id: string, x: number, y: number, text?: string, w = 140, h = 140) => ({
			id,
			points: [
				{ x, y },
				{ x: x + w, y },
				{ x: x + w, y: y + h },
				{ x, y: y + h },
				{ x, y },
			],
			known: { type: 'node' as const, shape: 'rectangle' as const, text },
		})
		const arrow = (
			id: string,
			points: VecLike[],
			{
				start,
				end,
				heads = [false, true],
				text,
			}: { start?: string; end?: string; heads?: boolean[]; text?: string } = {}
		) => ({
			id,
			points,
			known: {
				type: 'connector' as const,
				arrowheads: { start: heads[0], end: heads[1] },
				boundTo: { start, end },
				text,
			},
		})

		it('mixes tldraw shapes and arrows with drawn ones, like a real sketch', () => {
			const graph = segmentSketch(
				[
					geo('terminal', 0, 0, 'Terminal'),
					circle('host', 450, 75, 80),
					// Drawn arrow from Terminal into Host, with the barbs drawn as two strokes.
					line('th', 142, 70, 368, 72),
					line('barb1', 340, 52, 368, 72),
					line('barb2', 340, 92, 368, 72),
					geo('gateway', 350, 230, 'Gateway', 280, 160),
					// Drawn line from Host's bottom into Gateway, no arrowhead.
					line('hg', 440, 152, 430, 260),
					geo('core', 100, 680, 'Core', 220, 140),
					geo('vault', 440, 750, 'NPT Vault', 220, 140),
					arrow(
						'gc',
						[
							{ x: 430, y: 390 },
							{ x: 230, y: 680 },
						],
						{ start: 'gateway', end: 'core' }
					),
					arrow(
						'gv',
						[
							{ x: 500, y: 300 },
							{ x: 520, y: 750 },
						],
						{ start: 'gateway', end: 'vault' }
					),
					// Unbound, but its ends touch the shapes.
					arrow('vc', [
						{ x: 438, y: 820 },
						{ x: 322, y: 790 },
					]),
				],
				[text('hostLabel', 'Host', 425, 65)]
			)
			expect(graph.nodes.map((n) => [n.outline[0], n.text, n.shape])).toEqual([
				['terminal', 'Terminal', 'rectangle'],
				['host', 'Host', undefined],
				['gateway', 'Gateway', 'rectangle'],
				['core', 'Core', 'rectangle'],
				['vault', 'NPT Vault', 'rectangle'],
			])
			const edges = Object.fromEntries(
				graph.edges.map((e) => [e.strokes[0], [e.from, e.to, e.strokes.slice(1), e.arrowheads]])
			)
			expect(edges).toEqual({
				th: ['n1', 'n2', ['barb1', 'barb2'], undefined],
				hg: ['n2', 'n3', [], undefined],
				gc: ['n3', 'n4', [], { from: false, to: true }],
				gv: ['n3', 'n5', [], { from: false, to: true }],
				vc: ['n5', 'n4', [], { from: false, to: true }],
			})
			expect(graph.ignored).toEqual([])
		})

		it('uses an arrow binding even when the end is far from the shape', () => {
			const graph = segmentSketch(
				[
					geo('a', 0, 0),
					geo('b', 0, 400),
					arrow(
						'ab',
						[
							{ x: 70, y: 170 },
							{ x: 70, y: 360 },
						],
						{ start: 'a', end: 'b', text: 'Yes' }
					),
				],
				[]
			)
			expect(graph.edges).toMatchObject([{ from: 'n1', to: 'n2', text: 'Yes' }])
		})

		it('keeps a tldraw shape inside another as a node, and reads handwriting inside one', () => {
			const graph = segmentSketch(
				[geo('outer', 0, 0, 'Group', 400, 300), geo('inner', 100, 100), word('w', 20, 250)],
				[]
			)
			expect(graph.nodes.map((n) => n.outline[0])).toEqual(['outer', 'inner'])
			expect(graph.nodes[0].label).toEqual(['w'])
		})

		it('ignores a tldraw arrow that only touches one shape rather than reading it as a label', () => {
			const graph = segmentSketch(
				[
					geo('a', 0, 0),
					geo('b', 0, 300),
					line('ab', 70, 142, 70, 298),
					arrow('stray', [
						{ x: 142, y: 200 },
						{ x: 300, y: 200 },
					]),
				],
				[]
			)
			expect(graph.edges).toHaveLength(1)
			expect(graph.edges[0].label).toEqual([])
			expect(graph.ignored).toEqual(['stray'])
		})
	})

	it('numbers nodes in reading order', () => {
		const graph = segmentSketch([box('low', 0, 300), box('right', 400, 0), box('left', 0, 0)], [])
		expect(graph.nodes.map((n) => [n.id, n.outline[0]])).toEqual([
			['n1', 'left'],
			['n2', 'right'],
			['n3', 'low'],
		])
	})

	it('scales its tolerances with the zoom level', () => {
		const strokes = [box('a', 0, 0), box('b', 0, 200), line('ab', 80, 85, 80, 195)]
		const big = strokes.map((s) => ({ ...s, points: s.points.map((p) => Vec.Mul(p, 3)) }))
		expect(segmentSketch(big, [], { scale: 3 }).edges).toHaveLength(1)
	})
})

function mulberry32(seed: number) {
	return () => {
		seed |= 0
		seed = (seed + 0x6d2b79f5) | 0
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}
