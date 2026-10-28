// Minimal client for TypeSafe's System One API. Requests go through the dev server's
// /api/typesafe proxy (see apps/examples/vite.config.ts), which adds the API key, so the key never
// reaches the browser. https://docs.typesafe.ai/api/system-one

const ENDPOINT = '/api/typesafe/systemone'

// Pinned rather than `jev-latest`: the thresholds in questions.ts were checked against this
// version, and an alias can move under them.
export const TYPESAFE_MODEL = 'jev-1.14.0'

const MAX_CONCURRENT_REQUESTS = 6
const MAX_RETRIES = 3
const PROXY_MISSING =
	"The TypeSafe proxy isn't available here. Run the examples app locally with `pnpm dev`, with TYPESAFE_API_KEY in apps/examples/.env.local."

export type TypeSafeQuestion =
	| { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
	| { type: 'choice'; instructions: string; criteria: Record<string, string | null> }

export interface TypeSafeRequest {
	model: string
	state: Record<string, string>
	assets: Record<string, { type: 'image'; format: 'png'; data_base64: string }>
	questions: Record<string, TypeSafeQuestion>
}

export interface NoulAnswer {
	type: 'noul'
	noul: number
}

export interface ChoiceAnswer {
	type: 'choice'
	choice: string
	confidence: number
	probabilities: Record<string, number>
}

export type TypeSafeAnswer = NoulAnswer | ChoiceAnswer

export interface TypeSafeResponse {
	model: string
	answers: Record<string, TypeSafeAnswer>
	usage: { input_tokens: number; output_tokens: number }
}

/** Every request and its response, so a surprising answer can be inspected and replayed. */
export interface TypeSafeLogEntry {
	request: TypeSafeRequest
	response: TypeSafeResponse
}

export class TypeSafeError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message)
	}
}

let active = 0
const waiting: (() => void)[] = []

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (active >= MAX_CONCURRENT_REQUESTS) {
		await new Promise<void>((resolve) => waiting.push(resolve))
	}
	active++
	try {
		return await fn()
	} finally {
		active--
		waiting.shift()?.()
	}
}

async function post(request: TypeSafeRequest): Promise<TypeSafeResponse> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(ENDPOINT, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(request),
		})
		if (res.ok) {
			// A static host (like the deployed examples site) answers with the app's HTML instead.
			if (!res.headers.get('content-type')?.includes('application/json')) {
				throw new TypeSafeError(res.status, PROXY_MISSING)
			}
			return res.json()
		}

		const retryAfter = Number(res.headers.get('retry-after'))
		const fromProxy = res.headers.has('x-typesafe-proxy-error')
		if ((res.status === 429 || res.status >= 500) && !fromProxy && attempt < MAX_RETRIES) {
			const seconds = retryAfter > 0 ? retryAfter : 0.5 * 2 ** attempt
			await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
			continue
		}
		const body = await res.text()
		let message = body
		try {
			const json = JSON.parse(body)
			message = json.error ?? json.detail ?? body
			if (typeof message !== 'string') message = JSON.stringify(message)
		} catch {
			// not JSON; keep the raw text
		}
		throw new TypeSafeError(res.status, `TypeSafe request failed (${res.status}): ${message}`)
	}
}

/**
 * Ask questions about one image. The image goes in the state under `name`, so questions refer to
 * it as `name` in backticks and it is read once however many questions there are.
 */
export async function askAboutImage(
	name: string,
	pngBase64: string,
	questions: Record<string, TypeSafeQuestion>,
	log: TypeSafeLogEntry[]
): Promise<Record<string, TypeSafeAnswer>> {
	// References are matched as plain text anywhere in the request, so they must not occur in
	// question wording by accident.
	const ref = `img-${crypto.randomUUID()}`
	const request: TypeSafeRequest = {
		model: TYPESAFE_MODEL,
		state: { [name]: ref },
		assets: { [ref]: { type: 'image', format: 'png', data_base64: pngBase64 } },
		questions,
	}
	const response = await withSlot(() => post(request))
	log.push({ request, response })
	return response.answers
}

// A missing or mistyped answer is an error, never a silent "no".
export function getNoul(answer: TypeSafeAnswer | undefined): number {
	if (answer?.type !== 'noul') throw new TypeSafeError(0, 'TypeSafe returned no noul answer')
	return answer.noul
}

export function getChoice(answer: TypeSafeAnswer | undefined): ChoiceAnswer {
	if (answer?.type !== 'choice') throw new TypeSafeError(0, 'TypeSafe returned no choice answer')
	return answer
}
