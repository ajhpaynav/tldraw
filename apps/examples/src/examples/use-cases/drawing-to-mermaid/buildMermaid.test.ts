import { Box } from 'tldraw'
// eslint-disable-next-line tldraw/no-undeclared-dependencies
import { describe, expect, it } from 'vitest'
import { EdgeJudgment, NodeJudgment, SketchJudgments, buildMermaid, quote } from './buildMermaid'
import { ArrowEnds } from './questions'
import { LabelReading } from './readLabel'
import { SketchEdge, SketchGraph, SketchNode } from './segmentSketch'

function node(id: string, x: number, y: number, extra: Partial<SketchNode> = {}): SketchNode {
	return { id, outline: [`${id}-outline`], label: [], bounds: new Box(x, y, 100, 50), ...extra }
}

function edge(id: string, from: string, to: string, extra: Partial<SketchEdge> = {}): SketchEdge {
	return {
		id,
		from,
		to,
		strokes: [`${id}-stroke`],
		label: [],
		bounds: new Box(0, 0, 1, 1),
		...extra,
	}
}

function ends(most: ArrowEnds): EdgeJudgment {
	const result = { toward_blue: 0.05, toward_red: 0.05, both_ends: 0.05, no_arrowhead: 0.05 }
	result[most] = 0.85
	return { ends: result }
}

function judge({
	nodes = {},
	edges = {},
	labels = {},
}: {
	nodes?: Record<string, Partial<NodeJudgment>>
	edges?: Record<string, EdgeJudgment>
	labels?: Record<string, LabelReading>
}): SketchJudgments {
	return {
		nodes: new Map(
			Object.entries(nodes).map(([id, j]) => [id, { isOutline: 0.95, shape: 'rectangle', ...j }])
		),
		edges: new Map(Object.entries(edges)),
		labels: new Map(Object.entries(labels)),
	}
}

function graph(nodes: SketchNode[], edges: SketchEdge[] = [], ignored: string[] = []): SketchGraph {
	return { nodes, edges, ignored, scale: 1 }
}

describe('buildMermaid', () => {
	it('writes each shape with its Mermaid brackets', () => {
		const shapes = [
			'rectangle',
			'rounded_rectangle',
			'stadium',
			'diamond',
			'circle',
			'cylinder',
			'parallelogram',
			'hexagon',
		] as const
		const nodes = shapes.map((_, i) => node(`n${i + 1}`, 0, i * 100, { text: 'x' }))
		const { source } = buildMermaid(
			graph(nodes),
			judge({ nodes: Object.fromEntries(shapes.map((shape, i) => [`n${i + 1}`, { shape }])) })
		)
		expect(source).toBe(
			[
				'flowchart TD',
				'    n1["x"]',
				'    n2("x")',
				'    n3(["x"])',
				'    n4{"x"}',
				'    n5(("x"))',
				'    n6[("x")]',
				'    n7[/"x"/]',
				'    n8{{"x"}}',
			].join('\n')
		)
	})

	it('points arrows the way TypeSafe saw them', () => {
		const nodes = [node('n1', 0, 0, { text: 'A' }), node('n2', 0, 200, { text: 'B' })]
		const lines = (most: ArrowEnds) =>
			buildMermaid(
				graph(nodes, [edge('e1', 'n1', 'n2')]),
				judge({ edges: { e1: ends(most) } })
			).source.split('\n')[3]
		expect(lines('toward_blue')).toBe('    n1 --> n2')
		expect(lines('toward_red')).toBe('    n2 --> n1')
		expect(lines('both_ends')).toBe('    n1 <--> n2')
		expect(lines('no_arrowhead')).toBe('    n1 --- n2')
	})

	it('lays the chart out the way the arrows point', () => {
		const direction = (to: [number, number], most: ArrowEnds = 'toward_blue') =>
			buildMermaid(
				graph([node('n1', 0, 0), node('n2', ...to)], [edge('e1', 'n1', 'n2')]),
				judge({ edges: { e1: ends(most) } })
			).source.split('\n')[0]
		expect(direction([0, 300])).toBe('flowchart TD')
		expect(direction([0, -300])).toBe('flowchart BT')
		expect(direction([300, 20])).toBe('flowchart LR')
		expect(direction([300, 20], 'toward_red')).toBe('flowchart RL')
	})

	it('picks the axis most connectors run along, not the one with the longest arrows', () => {
		// Two long sideways arrows and three short downward connectors, one with no arrowhead.
		const nodes = [
			node('n1', 400, 0),
			node('n2', 0, 0),
			node('n3', 400, 200),
			node('n4', 100, 575),
			node('n5', 450, 450),
		]
		const { source } = buildMermaid(
			graph(nodes, [
				edge('e1', 'n1', 'n3'),
				edge('e2', 'n2', 'n1'),
				edge('e3', 'n3', 'n4'),
				edge('e4', 'n3', 'n5'),
				edge('e5', 'n5', 'n4'),
			]),
			judge({
				edges: {
					e1: ends('no_arrowhead'),
					e2: ends('toward_blue'),
					e3: ends('toward_blue'),
					e4: ends('toward_blue'),
					e5: ends('toward_blue'),
				},
			})
		)
		expect(source).toMatch(/^flowchart TD/)
	})

	it('falls back to the sketch shape for the layout when no arrows have a direction', () => {
		const wide = graph([node('n1', 0, 0), node('n2', 400, 0)], [edge('e1', 'n1', 'n2')])
		expect(buildMermaid(wide, judge({ edges: { e1: ends('no_arrowhead') } })).source).toMatch(
			/^flowchart LR/
		)
	})

	it('prefers typed text, then handwriting, and flags readings TypeSafe is unsure of', () => {
		const { source, notes } = buildMermaid(
			graph(
				[
					node('n1', 0, 0, { text: 'Typed', label: ['ink'] }),
					node('n2', 0, 100, { label: ['ink'] }),
					node('n3', 0, 200, { label: ['ink'] }),
					node('n4', 0, 300, { label: ['ink'] }),
				],
				[edge('e1', 'n1', 'n2', { label: ['ink'] })]
			),
			judge({
				edges: { e1: ends('toward_blue') },
				labels: {
					n1: { text: 'Ignored', probability: 1, method: 'list' },
					n2: { text: 'Check stock', probability: 0.98, method: 'read' },
					n3: { text: 'Chek stok', probability: 0.14, method: 'read' },
					n4: { text: '', probability: 0, method: 'read' },
					e1: { text: 'Yes', probability: 0.99, method: 'list' },
				},
			})
		)
		expect(source.split('\n').slice(1)).toEqual([
			'    n1["Typed"]',
			'    n2["Check stock"]',
			'    n3["Chek stok"]',
			'    n4[" "]',
			'    n1 -->|"Yes"| n2',
		])
		expect(notes).toEqual([
			`n3: read the handwriting as "Chek stok", but TypeSafe is only 14% sure. Edit the source if it's wrong.`,
			"n4: couldn't read the handwriting, so the label is empty.",
		])
	})

	it('leaves out unconnected marks TypeSafe says are not outlines', () => {
		const { source, notes, nodeCount } = buildMermaid(
			graph([node('n1', 0, 0), node('n2', 0, 200), node('n3', 300, 0)], [edge('e1', 'n1', 'n2')]),
			judge({
				nodes: { n2: { isOutline: 0.1 }, n3: { isOutline: 0.1 } },
				edges: { e1: ends('toward_blue') },
			})
		)
		expect(source).toContain('n2[')
		expect(source).not.toContain('n3')
		expect(notes).toEqual(["n3: left out, because TypeSafe doesn't think it's a shape."])
		expect(nodeCount).toBe(2)
	})

	it('mentions strokes that were left out', () => {
		const { notes } = buildMermaid(graph([node('n1', 0, 0)], [], ['a', 'b']), judge({}))
		expect(notes).toEqual([
			"2 strokes or text didn't belong to a shape or connector, so they were left out.",
		])
	})
})

describe('quote', () => {
	it('escapes characters that would break or be read as markup', () => {
		expect(quote('Say "hi" <b> & #1;\nnext')).toBe(
			'"Say &quot;hi&quot; &lt;b&gt; &amp; &num;1;<br>next"'
		)
		expect(quote('`code` at 100%%{')).toBe('"&grave;code&grave; at 100&percnt;&percnt;{"')
	})

	it('writes an empty label as a space, since "" is a parse error', () => {
		expect(quote('')).toBe('" "')
	})
})
