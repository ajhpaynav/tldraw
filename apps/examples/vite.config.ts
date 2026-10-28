import type { IncomingMessage } from 'http'
import path from 'path'
import react from '@vitejs/plugin-react'
import { Plugin, PluginOption, defineConfig, loadEnv } from 'vite'

/**
 * Plugin to enable SPA fallback for vite preview.
 * In dev mode, Vite handles SPA routing automatically.
 * In preview mode, we need to rewrite page-like URLs to /index.html
 * so the static file server (sirv) serves the SPA entry point.
 */
function spaFallbackPlugin(): Plugin {
	return {
		name: 'spa-fallback',
		configurePreviewServer(server) {
			server.middlewares.use((req, res, next) => {
				const url = req.url || '/'
				const pathname = url.split('?')[0]
				const ext = path.extname(pathname)

				// If this looks like a page request (no file extension),
				// rewrite to index.html so sirv serves the SPA
				if (!ext) {
					req.url = '/index.html' + (url.includes('?') ? url.substring(url.indexOf('?')) : '')
				}
				next()
			})
		},
	}
}

const TYPESAFE_MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * Why a request may not use the TypeSafe proxy, which spends the developer's key. The dev server
 * listens on the network (`vite --host`) and accepts any Host (`allowedHosts: true`), so checking
 * that the caller is this machine isn't enough on its own.
 */
function getTypesafeProxyRefusal(req: IncomingMessage): string | undefined {
	const remote = req.socket.remoteAddress ?? ''
	if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
		return 'The TypeSafe proxy only accepts requests from this machine.'
	}
	// A tunnel (ngrok, cloudflared, editor port forwarding) connects from this machine on behalf of
	// whoever has its URL.
	if (req.headers['forwarded'] || req.headers['x-forwarded-for']) {
		return 'The TypeSafe proxy does not accept forwarded requests.'
	}
	// A DNS-rebinding page reaches this machine under its own domain name.
	const host = req.headers.host ?? ''
	if (!['localhost', '127.0.0.1', '[::1]'].includes(host.replace(/:\d+$/, ''))) {
		return 'The TypeSafe proxy only accepts requests to localhost.'
	}
	// Any other site open in the browser can also POST here from this machine. Cross-site requests
	// carry their origin, and a JSON content type forces a CORS preflight that Vite refuses.
	const origin = req.headers.origin
	const site = req.headers['sec-fetch-site']
	if ((origin && origin !== `http://${host}`) || (site && site !== 'same-origin')) {
		return 'The TypeSafe proxy only accepts requests from this app.'
	}
	if (!req.headers['content-type']?.includes('application/json')) {
		return 'Send the request as application/json.'
	}
	return undefined
}

/**
 * Dev-server proxy for the drawing to Mermaid example. The TypeSafe API key is read from
 * TYPESAFE_API_KEY (e.g. in apps/examples/.env.local) and never reaches the browser.
 */
function typesafeProxyPlugin(apiKey: string | undefined): Plugin {
	return {
		name: 'typesafe-proxy',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use('/api/typesafe/systemone', async (req, res) => {
				const sendError = (status: number, error: string) => {
					res.statusCode = status
					res.setHeader('content-type', 'application/json')
					// The proxy's own errors won't go away on retry, unlike TypeSafe's 429s and 5xxs.
					res.setHeader('x-typesafe-proxy-error', '1')
					res.end(JSON.stringify({ error }))
				}
				if (req.method !== 'POST') return sendError(405, 'Use POST.')
				const refusal = getTypesafeProxyRefusal(req)
				if (refusal) return sendError(403, refusal)
				if (!apiKey) {
					return sendError(
						503,
						'TYPESAFE_API_KEY is not set. Add it to apps/examples/.env.local and restart the dev server.'
					)
				}
				try {
					const chunks: Buffer[] = []
					let size = 0
					for await (const chunk of req) {
						size += chunk.length
						if (size > TYPESAFE_MAX_BODY_BYTES) return sendError(413, 'Request body is too large.')
						chunks.push(chunk)
					}
					const upstream = await fetch('https://api.typesafe.ai/v1/systemone', {
						method: 'POST',
						headers: {
							authorization: `Bearer ${apiKey}`,
							'content-type': 'application/json',
							'TypeSafe-Danger-Zone-Images': 'true',
						},
						body: Buffer.concat(chunks),
					})
					res.statusCode = upstream.status
					res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json')
					const retryAfter = upstream.headers.get('retry-after')
					if (retryAfter) res.setHeader('retry-after', retryAfter)
					res.end(Buffer.from(await upstream.arrayBuffer()))
				} catch (e) {
					sendError(502, `Could not reach TypeSafe: ${e instanceof Error ? e.message : String(e)}`)
				}
			})
		},
	}
}

const PR_NUMBER = process.env.VERCEL_GIT_PULL_REQUEST_ID

function getEnv() {
	if (!process.env.VERCEL_ENV) {
		return 'development'
	}
	if (PR_NUMBER !== undefined && PR_NUMBER !== '') {
		return 'preview'
	}
	if (process.env.VERCEL_ENV === 'production') {
		return 'production'
	}
	return 'canary'
}

const env = getEnv()

// eslint-disable-next-line no-console
console.log('build env:', env)

function urlOrLocalFallback(mode: string, url: string | undefined, localFallbackPort: number) {
	if (url) {
		return JSON.stringify(url)
	}

	if (mode === 'development') {
		// in dev, vite lets us inline javascript expressions - so we return a template string that
		// will be evaluated on the client
		return '`http://${location.hostname}:' + localFallbackPort + '`'
	} else {
		// in production, we have to fall back to a hardcoded value
		return JSON.stringify(`http://localhost:${localFallbackPort}`)
	}
}

const TLDRAW_BEMO_URL_STRING =
	env === 'production'
		? 'https://demo.tldraw.xyz'
		: env === 'canary'
			? 'https://canary-demo.tldraw.xyz'
			: PR_NUMBER
				? `https://pr-${PR_NUMBER}-demo.tldraw.xyz`
				: undefined

export default defineConfig(({ mode }) => ({
	plugins: [
		spaFallbackPlugin(),
		react(),
		exampleReadmePlugin(),
		typesafeProxyPlugin(loadEnv(mode, __dirname, 'TYPESAFE_').TYPESAFE_API_KEY),
	],
	root: path.join(__dirname, 'src'),
	publicDir: path.join(__dirname, 'public'),
	build: {
		outDir: path.join(__dirname, 'dist'),
		assetsInlineLimit: 0,
		target: 'es2022',
		minify: false,
	},
	oxc: {
		target: 'es2022',
	},
	server: {
		port: 5420,
		allowedHosts: true,
	},
	preview: {
		port: 5420,
	},
	clearScreen: false,
	optimizeDeps: {
		exclude: ['@tldraw/assets'],
	},
	define: {
		'process.env.TLDRAW_ENV': JSON.stringify(process.env.VERCEL_ENV ?? 'development'),
		'process.env.TLDRAW_DEPLOY_ID': JSON.stringify(
			process.env.VERCEL_GIT_COMMIT_SHA ?? `local-${Date.now()}`
		),
		'process.env.TLDRAW_BEMO_URL': urlOrLocalFallback(mode, TLDRAW_BEMO_URL_STRING, 8989),
		'process.env.TLDRAW_IMAGE_URL': urlOrLocalFallback(
			mode,
			env === 'development' ? undefined : 'https://images.tldraw.xyz',
			8786
		),
	},
}))

function exampleReadmePlugin(): PluginOption {
	return {
		name: 'example-readme',
		async transform(src, id) {
			const [filePath, query] = id.split('?')
			const isContentQuery = query?.split('&').includes('content')
			const match = filePath.match(/examples\/src\/examples\/(.+)\/README.md$/)
			if (!match) return

			const separator = '\n<hr>\n'
			const relativePath = match[1]
			const segments = relativePath.split('/')
			const slug = segments[segments.length - 1]
			const category = segments.slice(0, -1).join('/')
			if (!category) {
				throw new Error(`Example category folder missing for ${filePath}`)
			}
			const path = `/${slug}`
			const codeUrl = `https://github.com/tldraw/tldraw/tree/main/apps/examples/src/examples/${relativePath}`

			if (isContentQuery) {
				const remark = (await import('remark')).remark
				const remarkFrontmatter = (await import('remark-frontmatter')).default
				const remarkHtml = (await import('remark-html')).default
				const matter = (await import('vfile-matter')).matter

				const file = await remark()
					.use(remarkFrontmatter)
					.use(remarkHtml)
					.use(() => (_, file) => matter(file))
					.process(src)

				const parts = String(file).split(separator)
				const description = parts[0]
				const details = parts.slice(1).join(separator)

				const result = [
					`export const description = ${JSON.stringify(description)};`,
					`export const details = ${JSON.stringify(details)};`,
				]

				return result.join('\n')
			}

			const remark = (await import('remark')).remark
			const remarkFrontmatter = (await import('remark-frontmatter')).default
			const matter = (await import('vfile-matter')).matter

			const file = await remark()
				.use(remarkFrontmatter)
				.use(() => (_, file) => matter(file))
				.process(src)

			const frontmatter = parseFrontMatter(file.data.matter, filePath)

			const meta = {
				title: frontmatter.title,
				priority: frontmatter.priority,
				category,
				multiplayer: frontmatter.multiplayer,
				keywords: frontmatter.keywords,
				codeUrl,
				path,
			}

			const result = [
				`export const meta = ${JSON.stringify(meta)};`,
				`export const loadComponent = async () => {`,
				`    return (await import(${JSON.stringify(frontmatter.component)})).default;`,
				`};`,
				`export const loadContent = async () => {`,
				`    return await import(${JSON.stringify(filePath + '?content')});`,
				`};`,
			]

			return result.join('\n')
		},
	}
}

function parseFrontMatter(data: unknown, fileName: string) {
	if (!data || typeof data !== 'object') {
		throw new Error(`Frontmatter missing in ${fileName}`)
	}

	if (!('title' in data && typeof data.title === 'string')) {
		throw new Error(`Frontmatter key 'title' must be string in ${fileName}`)
	}

	if (!('component' in data && typeof data.component === 'string')) {
		throw new Error(`Frontmatter key 'component' must be string in ${fileName}`)
	}

	const priority = 'priority' in data ? data.priority : 999999
	if (typeof priority !== 'number') {
		throw new Error(`Frontmatter key 'priority' must be number in ${fileName}`)
	}

	const keywords = 'keywords' in data ? data.keywords : []
	if (!Array.isArray(keywords)) {
		throw new Error(`Frontmatter key 'keywords' must be array in ${fileName}`)
	}

	const multiplayer = 'multiplayer' in data ? data.multiplayer : false
	if (typeof multiplayer !== 'boolean') {
		throw new Error(`Frontmatter key 'multiplayer' must be boolean in ${fileName}`)
	}

	return {
		title: data.title,
		component: data.component,
		priority,
		keywords,
		multiplayer,
	}
}
