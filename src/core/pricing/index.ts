import type { CostLine, PricingModel } from '../types'
import card from './aws-rates.json'

/**
 * Pricing.
 *
 * Every AWS rate here is read from `aws-rates.json`, which `scripts/build-rate-card.mjs`
 * generates from the AWS Price List Bulk API: nothing is typed in by hand, and
 * the publication date of each price file travels with the data.
 *
 * A cost line always says how far it can be trusted:
 *
 *  - `fixed`     a published rate times capacity that is provisioned whether or
 *                not it is used: instance hours, allocated storage, a gateway.
 *  - `usage`     a published rate times a volume the user entered: requests,
 *                gigabytes moved, invocations. Exactly as right as that number.
 *  - `estimate`  the rate itself is not verified for this place or shape: a
 *                service whose price list is not loaded, a region priced at
 *                another region's rate, a size the provider does not sell.
 *
 * Nothing is ever silently substituted. When a price is missing the line is
 * marked `estimate` and carries a note saying what was used instead.
 */

export const HOURS = 730 // hours in an average month, the convention every cloud's own calculator uses

type Row = (number | null | undefined)[]
type Table = Record<string, Row>
interface Region { ec2: Table; rds: Record<string, Table>; cache: Table; redshift: Table; search: Table; flat: Record<string, number> }
const REGIONS = card.regions as unknown as Record<string, Region>
const GLOBAL = card.global as Record<string, number>
const HOME = 'us-east-1'

export const RATE_CARD = {
  /** the day the card was generated */
  generated: card.generated,
  source: card.source,
  url: 'https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api.html',
  /** publication date of each AWS price file the card was read from */
  published: card.published as Record<string, string>,
  regions: Object.keys(REGIONS),
}

export interface Quote { region: string; model: PricingModel }
export interface Rate {
  usd: number
  /** read from this region's own price list (or a global one) */
  local: boolean
  /** a reserved rate was used */
  reserved?: boolean
  note?: string
}

const US_NOTE = 'Priced at the N. Virginia rate: this region has no published price for it.'

/** A single published rate, such as a request or a gigabyte-month. `undefined` when AWS publishes none at all. */
export function flat(q: Quote, key: string): Rate | undefined {
  if (key in GLOBAL) return { usd: GLOBAL[key], local: true }
  const here = REGIONS[q.region]?.flat[key]
  if (here !== undefined) return { usd: here, local: true }
  const home = REGIONS[HOME].flat[key]
  return home === undefined ? undefined : { usd: home, local: false, note: US_NOTE }
}

const RESERVED_NOTE: Record<Exclude<PricingModel, 'ondemand'>, string> = {
  commit1: 'Reserved for 1 year, no upfront payment.',
  commit3: 'Reserved for 3 years (no upfront where sold, otherwise partial upfront spread over the term).',
}

/**
 * The hourly rate for an instance-shaped thing, honouring the pricing model.
 * `col` is where the on-demand price sits in the row; the two reserved rates always follow it.
 */
function instance(row: Row | undefined, q: Quote, local: boolean, od = 0, r1 = od + 1): Rate | undefined {
  const base = row?.[od]
  if (base === undefined || base === null) return undefined
  const rate: Rate = { usd: base, local, note: local ? undefined : US_NOTE }
  if (q.model !== 'ondemand') {
    const r = row![q.model === 'commit1' ? r1 : r1 + 1]
    // a few published reserved rates are no cheaper than on-demand (some licensed database engines): nobody would buy those
    if (typeof r === 'number' && r < base) { rate.usd = r; rate.reserved = true; rate.note = [RESERVED_NOTE[q.model], rate.note].filter(Boolean).join(' ') }
    else rate.note = ['No reserved price is published for this, so it stays on-demand.', rate.note].filter(Boolean).join(' ')
  }
  return rate
}
const pick = <T,>(q: Quote, get: (r: Region) => T | undefined): [T | undefined, boolean] => {
  const here = REGIONS[q.region] ? get(REGIONS[q.region]) : undefined
  return here !== undefined ? [here, true] : [get(REGIONS[HOME]), false]
}

export function ec2Rate(q: Quote, type: string, windows = false): Rate | undefined {
  const [row, local] = pick(q, (r) => r.ec2[type])
  if (!row) return undefined
  if (!windows) return instance(row, q, local, 0, 2)
  // Windows is billed on demand here: its reserved rates are a separate list that is not loaded
  const w = row[1]
  if (typeof w !== 'number') return undefined
  return { usd: w, local, note: [q.model !== 'ondemand' ? 'Windows is shown on-demand; its reserved rates are not loaded.' : '', local ? '' : US_NOTE].filter(Boolean).join(' ') || undefined }
}
export const rdsRate = (q: Quote, engine: string, cls: string) => { const [row, local] = pick(q, (r) => r.rds[engine]?.[cls]); return instance(row, q, local) }
export const nodeRate = (q: Quote, table: 'cache' | 'redshift' | 'search', id: string) => { const [row, local] = pick(q, (r) => r[table][id]); return instance(row, q, local) }

/** Every instance type the card has a price for, somewhere. */
export const EC2_TYPES = new Set(Object.values(REGIONS).flatMap((r) => Object.keys(r.ec2)))
export const rdsOffered = (engine: string, cls: string) => Object.values(REGIONS).some((r) => r.rds[engine]?.[cls])

// ---- lines ---------------------------------------------------------------------------

const join = (...notes: (string | undefined | false)[]) => notes.filter(Boolean).join(' ') || undefined

/** capacity that is paid for whether or not it is used */
export function fixed(label: string, qty: number, rate: Rate | undefined, per = 1, note?: string): CostLine {
  if (!rate) return { label, monthly: 0, basis: 'estimate', note: join('No published price was found for this.', note) }
  return { label, monthly: qty * rate.usd * per, basis: rate.local ? 'fixed' : 'estimate', note: join(rate.note, note) }
}
/** a rate times a volume the user entered; `meter` lets account-wide free allowances be worked out once per blueprint */
export function usage(label: string, qty: number, rate: Rate | undefined, meter?: string, note?: string): CostLine {
  if (!rate) return { label, monthly: 0, basis: 'estimate', note: join('No published price was found for this.', note) }
  return { label, monthly: qty * rate.usd, basis: rate.local ? 'usage' : 'estimate', note: join(rate.note, note), ...(meter ? { meter: { key: meter, qty, rate: rate.usd } } : {}) }
}
/** a figure whose rate is not verified here */
export const rough = (label: string, monthly: number, note: string, meter?: CostLine['meter']): CostLine => ({ label, monthly, basis: 'estimate', note, ...(meter ? { meter } : {}) })

// ---- allowances -----------------------------------------------------------------------

export interface Allowance { key: string; name: string; qty: number; unit: string; source: string }

/**
 * Usage every account gets free each month, indefinitely (not the 12-month trial offers).
 * These are per account, not per resource, so they are applied once to the whole
 * blueprint's usage rather than to each component.
 */
export const ALLOWANCES: Allowance[] = [
  { key: 'aws.lambda.req', name: 'Lambda requests', qty: 1e6, unit: 'requests', source: 'https://aws.amazon.com/lambda/pricing/' },
  { key: 'aws.lambda.gbs', name: 'Lambda compute', qty: 400_000, unit: 'GB-seconds', source: 'https://aws.amazon.com/lambda/pricing/' },
  { key: 'aws.cloudfront.gb', name: 'CloudFront data transfer', qty: 1024, unit: 'GB', source: 'https://aws.amazon.com/cloudfront/pricing/' },
  { key: 'aws.cloudfront.req', name: 'CloudFront requests', qty: 10e6, unit: 'requests', source: 'https://aws.amazon.com/cloudfront/pricing/' },
  { key: 'aws.egress', name: 'Data transfer out to the internet', qty: 100, unit: 'GB', source: 'https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer' },
  { key: 'aws.ddb.storage', name: 'DynamoDB storage', qty: 25, unit: 'GB', source: 'https://aws.amazon.com/dynamodb/pricing/on-demand/' },
  { key: 'aws.sqs', name: 'SQS requests', qty: 1e6, unit: 'requests', source: 'https://aws.amazon.com/sqs/pricing/' },
  { key: 'aws.sns', name: 'SNS publishes', qty: 1e6, unit: 'requests', source: 'https://aws.amazon.com/sns/pricing/' },
  { key: 'aws.cognito', name: 'Cognito monthly active users', qty: 10_000, unit: 'users', source: 'https://aws.amazon.com/cognito/pricing/' },
  { key: 'gcp.run.req', name: 'Cloud Run function requests', qty: 2e6, unit: 'requests', source: 'https://cloud.google.com/run/pricing' },
  { key: 'gcp.run.gbs', name: 'Cloud Run function compute', qty: 400_000, unit: 'GB-seconds', source: 'https://cloud.google.com/run/pricing' },
  { key: 'gcp.identity', name: 'Identity Platform monthly active users', qty: 50_000, unit: 'users', source: 'https://cloud.google.com/identity-platform/pricing' },
  { key: 'gcp.firestore.read', name: 'Firestore reads (50,000 a day)', qty: 1.5e6, unit: 'reads', source: 'https://cloud.google.com/firestore/pricing' },
  { key: 'gcp.firestore.write', name: 'Firestore writes (20,000 a day)', qty: 0.6e6, unit: 'writes', source: 'https://cloud.google.com/firestore/pricing' },
  { key: 'gcp.firestore.storage', name: 'Firestore storage', qty: 1, unit: 'GiB', source: 'https://cloud.google.com/firestore/pricing' },
  { key: 'gcp.pubsub', name: 'Pub/Sub throughput', qty: 10, unit: 'GiB', source: 'https://cloud.google.com/pubsub/pricing' },
  { key: 'gcp.tasks', name: 'Cloud Tasks operations', qty: 1e6, unit: 'operations', source: 'https://cloud.google.com/tasks/pricing' },
  { key: 'gcp.apigw', name: 'API Gateway calls', qty: 2e6, unit: 'calls', source: 'https://cloud.google.com/api-gateway/pricing' },
  { key: 'azure.fn.req', name: 'Azure Functions executions', qty: 1e6, unit: 'executions', source: 'https://azure.microsoft.com/pricing/details/functions/' },
  { key: 'azure.fn.gbs', name: 'Azure Functions compute', qty: 400_000, unit: 'GB-seconds', source: 'https://azure.microsoft.com/pricing/details/functions/' },
]

export interface Credit { key: string; name: string; monthly: number; detail: string }

/** What the account-wide free allowances are worth against a set of cost lines. */
export function credits(lines: CostLine[]): Credit[] {
  const used = new Map<string, { qty: number; value: number }>()
  for (const l of lines) {
    if (!l.meter) continue
    const u = used.get(l.meter.key) ?? { qty: 0, value: 0 }
    u.qty += l.meter.qty; u.value += l.monthly
    used.set(l.meter.key, u)
  }
  const out: Credit[] = []
  for (const a of ALLOWANCES) {
    const u = used.get(a.key)
    if (!u || u.qty <= 0 || u.value <= 0) continue
    // priced at the blueprint's own average rate for that meter, so mixed rates (x86 and Arm functions, say) come out right
    const free = Math.min(u.qty, a.qty)
    out.push({ key: a.key, name: a.name, monthly: (u.value * free) / u.qty, detail: `first ${a.qty.toLocaleString('en-US')} ${a.unit} each month are free` })
  }
  return out
}
