/**
 * Image exports: the blueprint as a standalone SVG string, and that SVG rasterised to a PNG.
 * This module pulls in React's server renderer, so it is loaded on demand; the text exports
 * (the budget CSV) and the download helper live in `core/files`. It lives beside <Scene/> because it is the renderer run
 * off screen; nothing in `core` depends on it.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { Scene, THEMES, sceneBounds } from './Scene'
import { makeCam, makeProj } from '../core/iso'
import type { Doc } from '../core/types'

export interface RenderOpts {
  /** the plan view, straight down, in place of the isometric one */
  flat?: boolean
  /** explicit camera angle; overrides `flat` */
  cam?: { yaw: number; pitch: number }
  /** defaults to light, whatever the editor is showing */
  theme?: 'dark' | 'light'
  /** false leaves the image transparent */
  background?: boolean
  /** false hides component names; text labels placed on the canvas are always drawn */
  labels?: boolean
}

/** The whole blueprint as one self-contained SVG document, with its size in pixels (the diagram's bounds plus a 48 px margin). */
export function svgString(doc: Doc, o: RenderOpts = {}): { svg: string; w: number; h: number } {
  const proj = o.cam ? makeCam(o.cam.yaw, o.cam.pitch) : makeProj(o.flat ? 1 : 0)
  const theme = THEMES[o.theme ?? 'light']
  const b = sceneBounds(doc, proj, 48)
  // rendered inside an <svg> root so React resolves SVG element names correctly
  const svg = renderToStaticMarkup(
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} width={Math.round(b.w)} height={Math.round(b.h)}>
      {o.background !== false && <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={theme.bg} />}
      <Scene doc={doc} proj={proj} theme={theme} showLabels={o.labels ?? true} />
    </svg>,
  )
  // hit-testing attributes and pointer cursors only mean something inside the editor
  return { svg: svg.replace(/ data-(kind|id)="[^"]*"/g, '').replace(/ style="cursor:[^"]*"/g, ''), w: b.w, h: b.h }
}

/**
 * The blueprint as a PNG, drawn at `scale` times the SVG's size. Browser only: it needs an image decoder and a canvas.
 * Rejects if the SVG cannot be decoded or the canvas cannot produce a file.
 */
export async function pngBlob(doc: Doc, o: RenderOpts = {}, scale = 2): Promise<Blob> {
  const { svg, w, h } = svgString(doc, o)
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('Could not rasterise diagram'))
      img.src = url
    })
    // the scale is lowered until neither side exceeds 8192 px: browsers fail to draw canvases much larger than that
    const max = 8192
    const s = Math.min(scale, max / w, max / h)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * s)
    canvas.height = Math.round(h * s)
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((res, rej) => canvas.toBlob((bl) => (bl ? res(bl) : rej(new Error('Export failed'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}


export { budgetCsv, download, slug } from '../core/files'
