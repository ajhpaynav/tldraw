import { Box, VecLike } from 'tldraw'

const LONG_SIDE = 448
// TypeSafe rejects images with either side under 280 pixels.
const MIN_SIDE = 280
// A short word blown up to fill the image gets hard to read, so small crops stay small.
const MAX_UPSCALE = 4
const LINE_WIDTH = 5

export interface CropLayer {
	color: string
	strokes: VecLike[][]
}

/**
 * Draws strokes into a PNG for TypeSafe and returns it base64-encoded. The strokes are drawn as
 * plain polylines on white, whatever the canvas theme, so every image looks the same to the
 * model.
 */
export function renderCrop(layers: CropLayer[], bounds: Box, padding: number): string {
	const box = bounds.clone().expandBy(padding)
	const scale = Math.min(LONG_SIDE / Math.max(box.w, box.h, 1), MAX_UPSCALE)
	const width = Math.max(MIN_SIDE, Math.ceil(box.w * scale))
	const height = Math.max(MIN_SIDE, Math.ceil(box.h * scale))

	const canvas = document.createElement('canvas')
	canvas.width = width
	canvas.height = height
	const ctx = canvas.getContext('2d')!
	ctx.fillStyle = 'white'
	ctx.fillRect(0, 0, width, height)
	ctx.translate((width - box.w * scale) / 2, (height - box.h * scale) / 2)
	ctx.scale(scale, scale)
	ctx.translate(-box.x, -box.y)
	ctx.lineCap = 'round'
	ctx.lineJoin = 'round'
	ctx.lineWidth = LINE_WIDTH / scale

	for (const layer of layers) {
		ctx.strokeStyle = layer.color
		ctx.fillStyle = layer.color
		for (const points of layer.strokes) {
			if (points.length === 1) {
				ctx.beginPath()
				ctx.arc(points[0].x, points[0].y, LINE_WIDTH / scale / 2, 0, Math.PI * 2)
				ctx.fill()
				continue
			}
			ctx.beginPath()
			ctx.moveTo(points[0].x, points[0].y)
			for (const p of points.slice(1)) ctx.lineTo(p.x, p.y)
			ctx.stroke()
		}
	}
	return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length)
}
