import {
	LABEL_CHARACTER_TEXT,
	YES,
	labelMatchQuestions,
	nextCharacterQuestion,
	pickReadingQuestions,
} from './questions'
import { TypeSafeLogEntry, askAboutImage, getChoice, getNoul } from './typesafe'

const BEAM_WIDTH = 4
const MAX_LABEL_LENGTH = 32
/** Characters less likely than this aren't worth following. */
const MIN_CHARACTER_PROBABILITY = 0.02

export interface LabelReading {
	text: string
	/** TypeSafe's probability that the handwriting says `text`. */
	probability: number
	/** `list` when the label matched a known label, `read` when it was read letter by letter. */
	method: 'list' | 'read'
}

interface Beam {
	text: string
	logProbability: number
}

/**
 * Reads a handwritten label. TypeSafe answers questions rather than writing text, so this asks it
 * to pick the label from a list first, which is fast and reliable. Only labels that aren't in the
 * list are read one character at a time; that's slower and less reliable, so the result carries
 * TypeSafe's own check of the reading.
 */
export async function readHandwriting(
	png: string,
	candidates: string[],
	log: TypeSafeLogEntry[]
): Promise<LabelReading> {
	const match = await askAboutImage('label', png, labelMatchQuestions(candidates), log)
	const inList = getNoul(match.in_list)
	if (inList >= YES) {
		return { text: getChoice(match.match).choice, probability: inList, method: 'list' }
	}

	const readings = await readByCharacter(png, log)
	if (readings.length === 0) return { text: '', probability: 0, method: 'read' }
	const picked = await askAboutImage('label', png, pickReadingQuestions(readings), log)
	const text = getChoice(picked.pick).choice
	return {
		text: toSentenceCase(text),
		probability: getNoul(picked[`says_${readings.indexOf(text)}`]),
		method: 'read',
	}
}

/**
 * A beam search over Choice answers: each step asks for the next character of the few most
 * likely readings so far, all in one request since they share the image.
 */
async function readByCharacter(png: string, log: TypeSafeLogEntry[]): Promise<string[]> {
	let beams: Beam[] = [{ text: '', logProbability: 0 }]
	const finished: Beam[] = []
	for (let step = 0; step < MAX_LABEL_LENGTH && beams.length > 0; step++) {
		const questions = Object.fromEntries(
			beams.map((beam, i) => [`beam_${i}`, nextCharacterQuestion(beam.text)])
		)
		const answers = await askAboutImage('label', png, questions, log)
		const next: Beam[] = []
		beams.forEach((beam, i) => {
			const { probabilities } = getChoice(answers[`beam_${i}`])
			for (const [option, probability] of Object.entries(probabilities)) {
				if (probability < MIN_CHARACTER_PROBABILITY) continue
				const logProbability = beam.logProbability + Math.log(probability)
				if (option === 'end_of_text') {
					if (beam.text.trim()) finished.push({ text: beam.text, logProbability })
					continue
				}
				const text = beam.text + (LABEL_CHARACTER_TEXT[option] ?? option)
				if (text.startsWith(' ') || text.includes('  ')) continue
				next.push({ text, logProbability })
			}
		})
		beams = next.sort((a, b) => b.logProbability - a.logProbability).slice(0, BEAM_WIDTH)
		const bestFinished = Math.max(...finished.map((beam) => beam.logProbability))
		if (beams.length === 0 || bestFinished > beams[0].logProbability) break
	}
	const best = [...finished, ...beams]
		.sort((a, b) => b.logProbability - a.logProbability)
		.map((beam) => beam.text.trim())
		.filter(Boolean)
	return [...new Set(best)].slice(0, BEAM_WIDTH)
}

function toSentenceCase(text: string) {
	return text.charAt(0).toUpperCase() + text.slice(1)
}
