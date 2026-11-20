import { defOf, docCost, nodeName } from './catalog'
import { RATE_CARD } from './pricing'
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

const BASIS_WORD = { fixed: 'Published rate, provisioned capacity', usage: 'Published rate, usage you entered', estimate: 'Estimate' } as const

export function budgetCsv(doc: Doc, pricing: PricingModel): string {
  const rows: (string | number)[][] = [['Component', 'Service', 'Category', 'Line item', 'Monthly (USD)', 'Yearly (USD)', 'Basis', 'Note']]
  const cost = docCost(doc, pricing)
  for (const n of doc.nodes) {
    const d = defOf(n.type)
    for (const l of cost.perNode.get(n.id)!.lines) rows.push([nodeName(n), d.svc, d.category, l.label, l.monthly.toFixed(2), (l.monthly * 12).toFixed(2), BASIS_WORD[l.basis ?? 'estimate'], l.note ?? ''])
  }
  // free allowances belong to the account, so they are listed once, not against any one component
  for (const c of cost.credits) rows.push(['Free allowance', c.name, '', c.detail, (-c.monthly).toFixed(2), (-c.monthly * 12).toFixed(2), 'Published allowance', 'Applied once for the whole account'])
  rows.push(['Total', '', '', `${doc.region} · ${pricing}`, cost.total.toFixed(2), (cost.total * 12).toFixed(2), '', `AWS prices: ${RATE_CARD.source}, read ${RATE_CARD.generated}. Excludes tax, support plans and data transfer between services.`])
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'blueprint'
