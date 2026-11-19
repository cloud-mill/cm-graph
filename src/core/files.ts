import { costOf, defOf, nodeName } from './catalog'
import type { Doc, PricingModel } from './types'

/**
 * Text exports and the download helper. Kept apart from the image exporters,
 * which pull in React's server renderer and are only loaded when an image is
 * actually exported.
 */
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
