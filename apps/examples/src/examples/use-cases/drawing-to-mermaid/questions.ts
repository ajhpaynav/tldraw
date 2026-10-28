import { TypeSafeQuestion } from './typesafe'

// Every question the example asks TypeSafe, and the thresholds its answers are read with, live in
// this file so they can be audited and tuned in one place. Jev makes the judgments; the code in
// buildMermaid.ts decides what the diagram should be.

/** A Noul above this reads as yes. */
export const YES = 0.7
/** A Noul below this reads as no. Between NO and YES the question isn't settled. */
export const NO = 0.3

// Option names are sent to the model, so they describe the content. Each maps to one Mermaid
// flowchart node shape in buildMermaid.ts.
export const NODE_SHAPES = {
	rectangle: 'A box with four straight sides and sharp, square corners.',
	rounded_rectangle: 'A box with four straight sides and clearly rounded corners.',
	stadium: 'A pill shape: two long straight parallel sides joined by half circles at both ends.',
	diamond:
		'A square standing on one corner, with four straight sides meeting at top, bottom, left and right points.',
	circle: 'A round outline that is about as wide as it is tall.',
	cylinder:
		'A drum or database symbol: an oval on top, two straight vertical sides and a curved bottom.',
	parallelogram:
		'A slanted box: the top and bottom sides are horizontal and the left and right sides lean the same way.',
	hexagon: 'A six-sided outline with flat top and bottom and pointed left and right ends.',
} as const

export type NodeShape = keyof typeof NODE_SHAPES

/** State: `node` is the node's outline and anything drawn inside it, in black. */
export function nodeQuestions() {
	return {
		// The null case for `shape`, which always picks an option even for a scribble.
		is_outline: {
			type: 'noul',
			instructions:
				'Is `node` a closed outline drawn around an area, like a box, circle or diamond?',
			criteria: {
				true: 'One closed outline surrounds an area, possibly with words inside it.',
				false:
					'There are only words, a line, an arrow or a scribble, with no outline around an area.',
			},
		},
		shape: {
			type: 'choice',
			instructions: 'What shape is the outline drawn in `node`?',
			criteria: NODE_SHAPES,
		},
	} satisfies Record<string, TypeSafeQuestion>
}

export const ARROW_ENDS = {
	toward_blue:
		'There is an arrowhead only at the end of the black line that touches the blue shape.',
	toward_red: 'There is an arrowhead only at the end of the black line that touches the red shape.',
	both_ends: 'There are arrowheads at both ends of the black line.',
	no_arrowhead: 'The black line is plain, with no arrowhead at either end.',
} as const

export type ArrowEnds = keyof typeof ARROW_ENDS

/**
 * State: `sketch` shows one connector in black between two shapes, one drawn in red and one in
 * blue. Choice answers can lean toward the first option, so the same question is asked with the
 * options in both orders and buildMermaid.ts averages them.
 */
export function arrowQuestions() {
	const instructions = 'In `sketch`, which ends of the black line have an arrowhead?'
	const reversed = Object.fromEntries(Object.entries(ARROW_ENDS).reverse())
	return {
		ends: { type: 'choice', instructions, criteria: ARROW_ENDS },
		ends_reversed: { type: 'choice', instructions, criteria: reversed },
	} satisfies Record<string, TypeSafeQuestion>
}

/** Labels that are common in flowcharts, offered as candidates for every handwritten label. */
export const COMMON_LABELS = [
	'Start',
	'End',
	'Begin',
	'Stop',
	'Done',
	'Yes',
	'No',
	'OK',
	'Cancel',
	'Error',
	'Success',
	'Fail',
	'Retry',
	'Login',
	'Logout',
	'Sign up',
	'Submit',
	'Save',
	'Input',
	'Output',
	'Wait',
	'Next',
]

/**
 * State: `label` is handwriting on its own. Jev doesn't transcribe, but it is good at picking the
 * handwritten text from a list, so known labels are checked first. `in_list` is the null case for
 * `match`, which always picks one of the candidates.
 */
export function labelMatchQuestions(candidates: string[]) {
	return {
		match: {
			type: 'choice',
			instructions: 'Which of these is handwritten in `label`?',
			criteria: Object.fromEntries(candidates.map((c) => [c, null])),
		},
		in_list: {
			type: 'noul',
			instructions: `Is the text handwritten in \`label\` exactly one of these: ${candidates.join(', ')}?`,
			criteria: {
				true: 'The handwritten words are the same as one of the listed labels, ignoring capitals.',
				false:
					'The handwritten words say something that is not in the list, such as a different word or extra words.',
			},
		},
	} satisfies Record<string, TypeSafeQuestion>
}

// The characters a handwritten label is read with, one Choice per position. Option names are what
// the model sees, so punctuation gets a descriptive name rather than the bare symbol.
export const LABEL_CHARACTERS: Record<string, string | null> = {
	...Object.fromEntries('abcdefghijklmnopqrstuvwxyz'.split('').map((c) => [c, null])),
	// Keys like "0" would be listed before the letters whatever order they're added in, and a
	// Choice can lean toward its first options.
	...Object.fromEntries('0123456789'.split('').map((d) => [`digit_${d}`, null])),
	space: 'A gap between two words.',
	question_mark: 'The character ?',
	hyphen: 'The character -',
	end_of_text: 'Nothing: the text has already ended.',
}

export const LABEL_CHARACTER_TEXT: Record<string, string> = {
	...Object.fromEntries('0123456789'.split('').map((d) => [`digit_${d}`, d])),
	space: ' ',
	question_mark: '?',
	hyphen: '-',
}

/** State: `label`. Jev isn't trained to generate text, so code keeps several readings in a beam. */
export function nextCharacterQuestion(prefix: string): TypeSafeQuestion {
	return {
		type: 'choice',
		instructions: prefix
			? `The text handwritten in \`label\` begins with "${prefix}". Which character comes right after "${prefix}"?`
			: 'Which character does the text handwritten in `label` begin with?',
		criteria: LABEL_CHARACTERS,
	}
}

/** State: `label`. Pick between the beam's readings, and check each one on its own. */
export function pickReadingQuestions(readings: string[]) {
	const questions: Record<string, TypeSafeQuestion> = {
		pick: {
			type: 'choice',
			instructions: 'Which of these is the text handwritten in `label`?',
			criteria: Object.fromEntries(readings.map((r) => [r, null])),
		},
	}
	readings.forEach((reading, i) => {
		questions[`says_${i}`] = {
			type: 'noul',
			instructions: `Does \`label\` say "${reading}", ignoring capital letters?`,
		}
	})
	return questions
}
