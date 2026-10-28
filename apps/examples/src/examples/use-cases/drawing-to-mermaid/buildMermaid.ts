import { Box, VecLike } from 'tldraw'
import { ArrowEnds, NO, NodeShape, YES } from './questions'
import { LabelReading } from './readLabel'
import { SketchGraph } from './segmentSketch'

// Turns the segmented sketch and TypeSafe's judgments into Mermaid flowchart source. Pure, so
// the decisions can be tested without the API.

export interface NodeJudgment {
	/** Probability that the node's strokes are a closed outline at all. */
	isOutline: number
	shape: NodeShape
}

export interface EdgeJudgment {
	/** Probability of each arrowhead arrangement, averaged over both option orders. */
	ends: Record<ArrowEnds, number>
}

export interface SketchJudgments {
	nodes: Map<string, NodeJudgment>
	edges: Map<string, EdgeJudgment>
	/** Readings of handwritten labels, by node or edge id. */
	labels: Map<string, LabelReading>
}

export interface MermaidResult {
	source: string
	/** Things the user should check, like labels TypeSafe wasn't sure it read correctly. */
	notes: string[]
	/** How many nodes are in the source, after leaving out marks that aren't shapes. */
	nodeCount: number
}

const NODE_BRACKETS: Record<NodeShape, [string, string]> = {
	rectangle: ['[', ']'],
	rounded_rectangle: ['(', ')'],
	stadium: ['([', '])'],
	diamond: ['{', '}'],
	circle: ['((', '))'],
	cylinder: ['[(', ')]'],
	parallelogram: ['[/', '/]'],
	hexagon: ['{{', '}}'],
}

const LINKS: Record<ArrowEnds, string> = {
	toward_blue: '-->',
	toward_red: '-->',
	both_ends: '<-->',
	no_arrowhead: '---',
}

export function buildMermaid(graph: SketchGraph, judgments: SketchJudgments): MermaidResult {
	const notes: string[] = []
	const label = (id: string, typed: string | undefined, handwritten: boolean) => {
		if (typed) return typed
		const reading = judgments.labels.get(id)
		if (reading?.text) {
			if (reading.probability < YES) {
				notes.push(
					`${id}: read the handwriting as "${reading.text}", but TypeSafe is only ${Math.round(reading.probability * 100)}% sure. Edit the source if it's wrong.`
				)
			}
			return reading.text
		}
		if (handwritten) notes.push(`${id}: couldn't read the handwriting, so the label is empty.`)
		return ''
	}

	// [1]
	const connected = new Set(graph.edges.flatMap((e) => [e.from, e.to]))
	const nodes = graph.nodes.filter((node) => {
		const judgment = judgments.nodes.get(node.id)
		if (judgment && judgment.isOutline < NO && !connected.has(node.id)) {
			notes.push(`${node.id}: left out, because TypeSafe doesn't think it's a shape.`)
			return false
		}
		return true
	})

	const lines = nodes.map((node) => {
		const shape = judgments.nodes.get(node.id)?.shape ?? 'rectangle'
		const [open, close] = NODE_BRACKETS[shape]
		return `${node.id}${open}${quote(label(node.id, node.text, node.label.length > 0))}${close}`
	})

	// [2]
	const centers = new Map(nodes.map((node) => [node.id, node.bounds.center]))
	const links: Link[] = []
	for (const edge of graph.edges) {
		if (!centers.has(edge.from) || !centers.has(edge.to)) continue
		const ends = getMostLikely(judgments.edges.get(edge.id)?.ends)
		const [from, to] = ends === 'toward_red' ? [edge.to, edge.from] : [edge.from, edge.to]
		links.push({
			from: centers.get(from)!,
			to: centers.get(to)!,
			directed: ends === 'toward_blue' || ends === 'toward_red',
		})
		const text = label(edge.id, edge.text, edge.label.length > 0)
		lines.push(`${from} ${LINKS[ends]}${text ? `|${quote(text)}|` : ''} ${to}`)
	}

	if (graph.ignored.length > 0) {
		notes.push(
			`${graph.ignored.length} stroke${graph.ignored.length === 1 ? '' : 's'} or text didn't belong to a shape or connector, so ${graph.ignored.length === 1 ? 'it was' : 'they were'} left out.`
		)
	}

	const direction = getDirection(links, Box.Common(nodes.map((n) => n.bounds)))
	const source = [`flowchart ${direction}`, ...lines.map((l) => `    ${l}`)].join('\n')
	return { source, notes, nodeCount: nodes.length }
}

function getMostLikely(ends: Record<ArrowEnds, number> | undefined): ArrowEnds {
	if (!ends) return 'no_arrowhead'
	return (Object.keys(ends) as ArrowEnds[]).reduce((a, b) => (ends[b] > ends[a] ? b : a))
}

interface Link {
	from: VecLike
	to: VecLike
	directed: boolean
}

/**
 * The chart's direction, from the sketch. The axis is the one most connectors run along, counting
 * connectors rather than their lengths, so one long sideways arrow doesn't outweigh a column of
 * short ones; ties go to top-down, Mermaid's usual. The way along it is where those connectors'
 * arrows point.
 */
function getDirection(links: Link[], bounds: Box) {
	if (links.length === 0) return bounds.width > bounds.height ? 'LR' : 'TD'
	const isVertical = (l: Link) => Math.abs(l.to.y - l.from.y) >= Math.abs(l.to.x - l.from.x)
	const vertical = links.filter(isVertical)
	if (vertical.length * 2 >= links.length) {
		const down = vertical.filter((l) => l.directed).reduce((sum, l) => sum + l.to.y - l.from.y, 0)
		return down >= 0 ? 'TD' : 'BT'
	}
	const across = links.filter((l) => l.directed && !isVertical(l))
	return across.reduce((sum, l) => sum + l.to.x - l.from.x, 0) >= 0 ? 'LR' : 'RL'
}

/**
 * Mermaid labels are always quoted, and characters that would end the quote or be read as markup
 * are written as named HTML entities, which @tldraw/mermaid decodes. `n1[""]` is a parse error,
 * so an empty label is a single space.
 */
export function quote(text: string) {
	const escaped = text
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/#/g, '&num;')
		.replace(/`/g, '&grave;')
		.replace(/%/g, '&percnt;')
		.replace(/\r?\n/g, '<br>')
	return `"${escaped || ' '}"`
}

/*
[1]
A node TypeSafe says isn't an outline is left out, unless a connector touches it: the connector is
better evidence that the user meant a node than the image of a messy outline is against it.

[2]
TypeSafe says which ends of a drawn connector have arrowheads, in a picture where the node at the
stroke's start is drawn red and the node at its end blue; a tldraw arrow says so in its props.
Mermaid's layout direction follows the connectors (see getDirection).
*/
