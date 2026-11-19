import { renderToStaticMarkup } from 'react-dom/server'
import { Scene, THEMES, sceneBounds } from '../canvas/Scene'
import { costOf, defOf, nodeName } from './catalog'
import { makeCam, makeProj } from './iso'
import type { Doc, PricingModel } from './types'

export interface RenderOpts {
  flat?: boolean
  /** explicit camera angle; overrides `flat` */
  cam?: { yaw: number; pitch: number }
  theme?: 'dark' | 'light'
  background?: boolean
  labels?: boolean
}

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
  return { svg: svg.replace(/ data-(kind|id)="[^"]*"/g, '').replace(/ style="cursor:[^"]*"/g, ''), w: b.w, h: b.h }
}

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

export function download(filename: string, data: Blob | string, mime = 'text/plain') {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

const csvCell = (v: string | number) => {
  // text that opens with a formula character gets a leading apostrophe, so a spreadsheet shows it instead of running it
  const s = typeof v === 'string' && /^[=+\-@\t\r]/.test(v) && isNaN(Number(v)) ? "'" + v : String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export function budgetCsv(doc: Doc, pricing: PricingModel): string {
  const rows: (string | number)[][] = [['Component', 'Service', 'Category', 'Line item', 'Monthly (USD)', 'Yearly (USD)']]
  let total = 0
  for (const n of doc.nodes) {
    const c = costOf(n, doc.region, pricing)
    const d = defOf(n.type)
    for (const l of c.lines) rows.push([nodeName(n), d.svc, d.category, l.label, l.monthly.toFixed(2), (l.monthly * 12).toFixed(2)])
    total += c.monthly
  }
  rows.push(['Total', '', '', `${doc.region} · ${pricing}`, total.toFixed(2), (total * 12).toFixed(2)])
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'blueprint'
