/**
 * Reading screenshots: enough of a PNG decoder to get at the pixels of what Playwright hands back, and two measures of
 * a pair of pictures. Used where a test has to say something about what is on the screen and not about the page's own
 * account of itself: that a frame taken while a zoom is under way is the same picture as the frame it comes to rest on.
 *
 * No dependency is taken for this: the PNGs are Chrome's own (8 bits a channel, RGB or RGBA, not interlaced), which is
 * one page of code to read, and the comparison a test needs here is a count, not a perceptual metric.
 */
import { inflateSync } from 'node:zlib'

export interface Picture { w: number; h: number; channels: number; px: Buffer }

/** The pixels of a PNG as a browser's screenshot writes one: 8 bits a channel, RGB or RGBA, not interlaced. */
export function decode(png: Buffer): Picture {
  let p = 8, w = 0, h = 0, type = 0
  const parts: Buffer[] = []
  while (p < png.length) {
    const len = png.readUInt32BE(p), kind = png.toString('latin1', p + 4, p + 8), data = png.subarray(p + 8, p + 8 + len)
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]
      if (data[8] !== 8 || (type !== 2 && type !== 6) || data[12] !== 0) throw new Error(`a kind of PNG this does not read: depth ${data[8]}, colour type ${type}, interlace ${data[12]}`)
    } else if (kind === 'IDAT') parts.push(data)
    p += 12 + len
  }
  const channels = type === 6 ? 4 : 3, stride = w * channels, raw = inflateSync(Buffer.concat(parts)), px = Buffer.alloc(h * stride)
  // each row is stored as its difference from what one of five rules predicts from the pixels to the left and above
  for (let y = 0; y < h; y++) {
    const rule = raw[y * (stride + 1)], row = y * (stride + 1) + 1, out = y * stride
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? px[out + x - channels] : 0, up = y ? px[out + x - stride] : 0, corner = x >= channels && y ? px[out + x - stride - channels] : 0
      let guess = 0
      if (rule === 1) guess = left
      else if (rule === 2) guess = up
      else if (rule === 3) guess = (left + up) >> 1
      else if (rule === 4) { const a = Math.abs(up - corner), b = Math.abs(left - corner), c = Math.abs(left + up - 2 * corner); guess = a <= b && a <= c ? left : b <= c ? up : corner }
      px[out + x] = (raw[row + x] + guess) & 255
    }
  }
  return { w, h, channels, px }
}

export interface Difference {
  /** how many pixels the two pictures have */
  pixels: number
  /** pixels that differ at all, by more than 8 in 255 on some channel, and by more than 32 */
  any: number; over8: number; over32: number
  /** the largest difference on any channel of any pixel, of 255 */
  worst: number
}

/** How far apart two pictures of the same size are, pixel by pixel: the largest difference on any colour channel is what counts. */
export function difference(a: Picture, b: Picture): Difference {
  if (a.w !== b.w || a.h !== b.h) throw new Error(`pictures of different sizes: ${a.w} x ${a.h} and ${b.w} x ${b.h}`)
  const out: Difference = { pixels: a.w * a.h, any: 0, over8: 0, over32: 0, worst: 0 }
  for (let i = 0; i < out.pixels; i++) {
    const p = i * a.channels, q = i * b.channels
    const d = Math.max(Math.abs(a.px[p] - b.px[q]), Math.abs(a.px[p + 1] - b.px[q + 1]), Math.abs(a.px[p + 2] - b.px[q + 2]))
    if (d > 0) out.any++
    if (d > 8) out.over8++
    if (d > 32) out.over32++
    if (d > out.worst) out.worst = d
  }
  return out
}

/**
 * How much fine detail a picture has: the average strength of its edges (each pixel's brightness against its four
 * neighbours'). A picture that has been stretched, or drawn small and enlarged, has less of it than the same scene drawn
 * at its own size, so the ratio between two pictures of the same view says whether one of them is soft.
 */
export function sharpness(pic: Picture): number {
  const { w, h, channels, px } = pic
  const light = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) light[i] = 0.299 * px[i * channels] + 0.587 * px[i * channels + 1] + 0.114 * px[i * channels + 2]
  let sum = 0
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x
    sum += Math.abs(4 * light[i] - light[i - 1] - light[i + 1] - light[i - w] - light[i + w])
  }
  return sum / ((w - 2) * (h - 2))
}
