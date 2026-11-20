#!/usr/bin/env node
/**
 * Builds src/core/pricing/aws-rates.json from the AWS Price List Bulk API.
 *
 *   node scripts/build-rate-card.mjs
 *
 * Source: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/<region>/index.{json,csv}
 * (public, no account needed; documented at
 * https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api.html)
 *
 * Nothing in the output is typed by hand: every number is read from an offer
 * file, and the file's own publication date is recorded beside it. A price the
 * offer file does not contain is simply absent from the card, and the app then
 * says so instead of inventing one.
 *
 * What is kept, per region:
 *   ec2[type]            [linux, windows, reserved 1-yr, reserved 3-yr]   USD per hour
 *   rds[engine][class]   [on-demand, reserved 1-yr, reserved 3-yr]        USD per hour, Single-AZ
 *   cache | redshift | search [node]  [on-demand, reserved 1-yr, reserved 3-yr]
 *   flat[key]            a single rate (first paid tier where the service has tiers)
 *
 * Reserved rates are standard-class, effective hourly: 1-year "No Upfront";
 * 3-year "No Upfront" where it is sold, otherwise "Partial Upfront" with the
 * upfront fee spread across the term's hours.
 */
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'

const REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-south-1', 'ap-southeast-1', 'ap-northeast-1', 'sa-east-1']
const EC2_FAMILIES = ['t3', 't4g', 't2', 'm4', 'm5', 'm6i', 'm7g', 'c5', 'c7g', 'r5', 'r7g', 'g5']
const SIZES = ['nano', 'micro', 'small', 'medium', 'large', 'xlarge', '2xlarge', '4xlarge', '8xlarge']
const RDS_CLASSES = ['t3', 't4g', 'm5', 'm7g', 'r5', 'r7g']
const RDS_ENGINES = {
  postgres: (a) => a.databaseEngine === 'PostgreSQL',
  mysql: (a) => a.databaseEngine === 'MySQL',
  mariadb: (a) => a.databaseEngine === 'MariaDB',
  // Aurora Standard (pay per I/O); the PostgreSQL- and MySQL-compatible editions are priced the same
  aurora: (a) => a.databaseEngine === 'Aurora PostgreSQL' && a.storage !== 'Aurora IO Optimization Mode',
  sqlserver: (a) => a.databaseEngine === 'SQL Server' && a.databaseEdition === 'Standard' && a.licenseModel === 'License included',
}
const CACHE_NODES = ['cache.t4g.micro', 'cache.t4g.small', 'cache.m7g.large', 'cache.r7g.large', 'cache.r7g.xlarge']
const REDSHIFT_NODES = ['dc2.large', 'ra3.xlplus', 'ra3.4xlarge']
const SEARCH_NODES = ['t3.small.search', 'm6g.large.search', 'r6g.large.search', 'r6g.xlarge.search']

const BASE = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws'
const HOURS_PER_YEAR = 8760
const round = (n) => Number(Number(n).toPrecision(8))

async function offer(service, region) {
  const url = region ? `${BASE}/${service}/current/${region}/index.json` : `${BASE}/${service}/current/index.json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${service} ${region ?? 'global'}: HTTP ${res.status}`)
  return res.json()
}

/** every on-demand price dimension of an offer, with its product's attributes */
function* onDemand(o) {
  for (const [sku, p] of Object.entries(o.products)) {
    for (const term of Object.values(o.terms.OnDemand?.[sku] ?? {})) {
      for (const d of Object.values(term.priceDimensions)) yield { a: p.attributes ?? {}, family: p.productFamily, sku, usd: Number(d.pricePerUnit.USD), begin: Number(d.beginRange ?? 0), desc: d.description }
    }
  }
}
/** effective hourly reserved rates for a product: [1-yr, 3-yr], or undefined where not sold */
function reserved(o, sku) {
  const pick = (years, option) => {
    for (const t of Object.values(o.terms.Reserved?.[sku] ?? {})) {
      const ta = t.termAttributes
      if (ta.LeaseContractLength !== years + 'yr' || ta.PurchaseOption !== option || (ta.OfferingClass && ta.OfferingClass !== 'standard')) continue
      let hourly = 0, upfront = 0
      for (const d of Object.values(t.priceDimensions)) { if (d.unit === 'Quantity') upfront = Number(d.pricePerUnit.USD); else hourly = Number(d.pricePerUnit.USD) }
      return round(hourly + upfront / (years * HOURS_PER_YEAR))
    }
  }
  return [pick(1, 'No Upfront'), pick(3, 'No Upfront') ?? pick(3, 'Partial Upfront')]
}
/** usage types carry a region prefix everywhere but (sometimes) N. Virginia: match on what follows it */
// the prefix is a region code only (USE1-, EU-, APS3-, us-east-1-): anything looser also catches other products,
// such as S3 Tables or S3 Files, whose usage types merely end the same way
const ut = (suffix) => new RegExp(`^(?:(?:[A-Z]{2,4}[0-9]?|[a-z]{2}-[a-z]+-[0-9])-)?${suffix}$`)
/** the first paid tier of a rate that matches */
function flat(o, test) {
  let best
  for (const r of onDemand(o)) if (r.usd > 0 && test(r) && (!best || r.begin < best.begin)) best = r
  return best ? round(best.usd) : undefined
}

async function ec2(region) {
  // the EC2 offer is ~480 MB of JSON per region, so it is read as CSV, a line at a time
  const res = await fetch(`${BASE}/AmazonEC2/current/${region}/index.csv`)
  if (!res.ok) throw new Error(`AmazonEC2 ${region}: HTTP ${res.status}`)
  const types = new Set(EC2_FAMILIES.flatMap((f) => SIZES.map((s) => `${f}.${s}`)))
  const out = {}, flatOut = {}
  let col, published
  const cells = (line) => { const c = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q } else if (ch === ',' && !q) { c.push(cur); cur = '' } else cur += ch } c.push(cur); return c }
  for await (const line of createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity })) {
    if (!col) {
      if (line.startsWith('"Publication Date"')) published = cells(line)[1]
      if (line.startsWith('"SKU"')) { const h = cells(line); col = Object.fromEntries(h.map((n, i) => [n, i])) }
      continue
    }
    // cheap pre-filter before the proper parse
    if (!/NatGateway|EBS:VolumeUsage|"(?:t3|t4g|t2|m4|m5|m6i|m7g|c5|c7g|r5|r7g|g5)\.[a-z0-9]+"/.test(line)) continue
    const c = cells(line), g = (n) => c[col[n]]
    const usage = g('usageType'), price = Number(g('PricePerUnit'))
    if (g('TermType') === 'OnDemand') {
      const vol = usage.match(/EBS:VolumeUsage\.(gp3|io2|st1|sc1)$/)
      if (vol && g('Product Family') === 'Storage' && price > 0) flatOut['ebs.' + vol[1]] = round(price)
      if (/NatGateway-Hours$/.test(usage) && price > 0 && !/Regional|Prov/.test(usage)) flatOut['nat.hour'] = round(price)
      if (/NatGateway-Bytes$/.test(usage) && price > 0 && !/Regional|Prov/.test(usage)) flatOut['nat.gb'] = round(price)
    }
    const type = g('Instance Type')
    if (!types.has(type) || g('Tenancy') !== 'Shared' || g('Pre Installed S/W') !== 'NA' || g('Unit') !== 'Hrs') continue
    const os = g('Operating System'), row = (out[type] ??= [])
    if (g('TermType') === 'OnDemand' && g('CapacityStatus') === 'Used') {
      if (os === 'Linux' && g('License Model') === 'No License required') row[0] = round(price)
      if (os === 'Windows' && g('License Model') === 'No License required') row[1] = round(price)
    } else if (g('TermType') === 'Reserved' && os === 'Linux' && g('PurchaseOption') === 'No Upfront' && g('OfferingClass') === 'standard') {
      if (g('LeaseContractLength') === '1yr') row[2] = round(price)
      if (g('LeaseContractLength') === '3yr') row[3] = round(price)
    }
  }
  for (const [t, r] of Object.entries(out)) if (r[0] === undefined) delete out[t]
  return { ec2: out, flat: flatOut, published }
}

async function rds(region) {
  const o = await offer('AmazonRDS', region)
  const out = {}
  for (const [sku, p] of Object.entries(o.products)) {
    const a = p.attributes ?? {}
    if (p.productFamily !== 'Database Instance' || a.deploymentOption !== 'Single-AZ') continue
    const m = /^db\.([a-z0-9]+)\.([a-z0-9]+)$/.exec(a.instanceType ?? '')
    if (!m || !RDS_CLASSES.includes(m[1]) || !SIZES.includes(m[2])) continue
    const engine = Object.keys(RDS_ENGINES).find((e) => RDS_ENGINES[e](a))
    if (!engine) continue
    const od = Object.values(o.terms.OnDemand?.[sku] ?? {}).flatMap((t) => Object.values(t.priceDimensions)).map((d) => Number(d.pricePerUnit.USD)).find((v) => v > 0)
    if (!od) continue
    const key = `${m[1]}.${m[2]}`, was = (out[engine] ??= {})[key]
    const [r1, r3] = reserved(o, sku)
    // the same class appears once per storage option at the same price; keep whichever carries reserved terms
    if (!was || (was[1] === undefined && r1 !== undefined)) out[engine][key] = [round(od), r1, r3]
  }
  const f = {
    'rds.gp3': flat(o, (r) => r.family === 'Database Storage' && ut('RDS:GP3-Storage').test(r.a.usagetype)),
    'aurora.storage': flat(o, (r) => ut('Aurora:StorageUsage').test(r.a.usagetype)),
    'aurora.io': flat(o, (r) => ut('Aurora:StorageIOUsage').test(r.a.usagetype)),
  }
  return { rds: out, flat: f, published: o.publicationDate }
}

async function nodes(service, region, list, usage, where = () => true) {
  const o = await offer(service, region)
  const out = {}
  for (const [sku, p] of Object.entries(o.products)) {
    const a = p.attributes ?? {}
    if (!list.includes(a.instanceType) || !ut(usage(a.instanceType)).test(a.usagetype ?? '') || !where(a)) continue
    const od = Object.values(o.terms.OnDemand?.[sku] ?? {}).flatMap((t) => Object.values(t.priceDimensions)).map((d) => Number(d.pricePerUnit.USD)).find((v) => v > 0)
    if (od) out[a.instanceType] = [round(od), ...reserved(o, sku)]
  }
  return { out, o }
}

/** [service, key, test] for everything charged at a single rate */
const FLAT = [
  ['AWSLambda', 'lambda.req', (r) => ut('Request').test(r.a.usagetype)],
  ['AWSLambda', 'lambda.gbs', (r) => ut('Lambda-GB-Second').test(r.a.usagetype)],
  ['AWSLambda', 'lambda.gbs.arm', (r) => ut('Lambda-GB-Second-ARM').test(r.a.usagetype)],
  ['AmazonECS', 'fargate.vcpu', (r) => ut('Fargate-vCPU-Hours:perCPU').test(r.a.usagetype)],
  ['AmazonECS', 'fargate.gb', (r) => ut('Fargate-GB-Hours').test(r.a.usagetype)],
  ['AmazonEKS', 'eks.cluster', (r) => ut('AmazonEKS-Hours:perCluster').test(r.a.usagetype)],
  ['AWSELB', 'alb.hour', (r) => ut('LoadBalancerUsage').test(r.a.usagetype) && /Application LoadBalancer-hour/i.test(r.desc)],
  ['AWSELB', 'alb.lcu', (r) => ut('LCUUsage').test(r.a.usagetype) && /Application load balancer capacity/i.test(r.desc)],
  ['AWSELB', 'nlb.hour', (r) => ut('LoadBalancerUsage').test(r.a.usagetype) && /Network LoadBalancer-hour/i.test(r.desc)],
  ['AWSELB', 'nlb.lcu', (r) => ut('LCUUsage').test(r.a.usagetype) && /Network load balancer capacity/i.test(r.desc)],
  ['AmazonDynamoDB', 'ddb.read', (r) => ut('ReadRequestUnits').test(r.a.usagetype) && !/IA-/.test(r.a.usagetype)],
  ['AmazonDynamoDB', 'ddb.write', (r) => ut('WriteRequestUnits').test(r.a.usagetype) && !/IA-|Repl/.test(r.a.usagetype)],
  ['AmazonDynamoDB', 'ddb.storage', (r) => ut('TimedStorage-ByteHrs').test(r.a.usagetype) && !/IA-/.test(r.a.usagetype)],
  ['AmazonS3', 's3.standard', (r) => ut('TimedStorage-ByteHrs').test(r.a.usagetype)],
  ['AmazonS3', 's3.ia', (r) => ut('TimedStorage-SIA-ByteHrs').test(r.a.usagetype)],
  ['AmazonS3', 's3.gir', (r) => ut('TimedStorage-GIR-ByteHrs').test(r.a.usagetype)],
  ['AmazonS3', 's3.gda', (r) => ut('TimedStorage-GDA-ByteHrs').test(r.a.usagetype)],
  ['AmazonS3', 's3.get', (r) => ut('Requests-Tier2').test(r.a.usagetype)],
  ['AmazonKinesis', 'kinesis.shard', (r) => ut('Storage-ShardHour').test(r.a.usagetype)],
  ['AmazonKinesis', 'kinesis.put', (r) => ut('PutRequestPayloadUnits').test(r.a.usagetype)],
  ['AmazonEFS', 'efs.standard', (r) => ut('TimedStorage-ByteHrs').test(r.a.usagetype) && !/IA|Archive/.test(r.a.usagetype)],
  ['AWSDataTransfer', 'egress', (r) => ut('DataTransfer-Out-Bytes').test(r.a.usagetype) && r.a.transferType === 'AWS Outbound'],
  ['AmazonCloudWatch', 'cw.metric', (r) => ut('CW:MetricMonitorUsage').test(r.a.usagetype)],
  ['AmazonCloudWatch', 'cw.logs', (r) => ut('DataProcessing-Bytes').test(r.a.usagetype) && /custom log data ingested in Standard/i.test(r.desc)],
  ['AmazonRoute53', 'route53.queries', (r) => ut('DNS-Queries').test(r.a.usagetype)],
  ['AmazonApiGateway', 'apigw.http', (r) => ut('ApiGatewayHttpRequest').test(r.a.usagetype)],
  ['AmazonApiGateway', 'apigw.rest', (r) => ut('ApiGatewayRequest').test(r.a.usagetype)],
  ['awswaf', 'waf.acl', (r) => ut('WebACLV2').test(r.a.usagetype)],
  ['awswaf', 'waf.rule', (r) => ut('RuleV2').test(r.a.usagetype)],
  ['awswaf', 'waf.req', (r) => ut('RequestV2-Tier1').test(r.a.usagetype)],
  ['AmazonCognito', 'cognito.lite', (r) => ut('CognitoLiteMAU').test(r.a.usagetype)],
  ['AmazonCognito', 'cognito.essentials', (r) => ut('CognitoEssentialsMAU').test(r.a.usagetype)],
  ['AWSSecretsManager', 'secrets.secret', (r) => ut('AWSSecretsManager-Secrets').test(r.a.usagetype)],
  ['awskms', 'kms.key', (r) => ut('KMS-Keys').test(r.a.usagetype)],
  ['AmazonSNS', 'sns.publish', (r) => ut('Requests-Tier1').test(r.a.usagetype)],
  ['AWSQueueService', 'sqs.standard', (r) => ut('Requests-(?:RBP|Tier1)').test(r.a.usagetype)],
  ['AWSQueueService', 'sqs.fifo', (r) => ut('Requests-FIFO-(?:RBP|Tier1)').test(r.a.usagetype)],
  ['AWSEvents', 'events.custom', (r) => ut('Event-64K-Chunks').test(r.a.usagetype) && /custom events/i.test(r.desc)],
]

async function region(id) {
  const card = { ec2: {}, rds: {}, cache: {}, redshift: {}, search: {}, flat: {} }
  const published = {}
  const [e, r, c, w, s] = await Promise.all([
    ec2(id), rds(id),
    nodes('AmazonElastiCache', id, CACHE_NODES, (t) => `NodeUsage:${t}`, (a) => a.cacheEngine === 'Redis' && !/ExtendedSupport|SyncDurability/.test(a.usagetype)),
    nodes('AmazonRedshift', id, REDSHIFT_NODES, (t) => `Node:${t}`),
    nodes('AmazonES', id, SEARCH_NODES, (t) => `ESInstance:${t.replace('.search', '')}`),
  ])
  Object.assign(card, { ec2: e.ec2, rds: r.rds, cache: c.out, redshift: w.out, search: s.out })
  Object.assign(card.flat, e.flat, r.flat, { 'search.gp3': flat(s.o, (x) => ut('ES:GP3-Storage').test(x.a.usagetype)), 'redshift.storage': flat(w.o, (x) => /RMS/.test(x.a.usagetype ?? '')) })
  Object.assign(published, { AmazonEC2: e.published, AmazonRDS: r.published, AmazonElastiCache: c.o.publicationDate, AmazonRedshift: w.o.publicationDate, AmazonES: s.o.publicationDate })
  const offers = new Map()
  for (const [service, key, test] of FLAT) {
    if (!offers.has(service)) offers.set(service, await offer(service, id).catch(() => null))
    const o = offers.get(service)
    if (!o) continue
    published[service] = o.publicationDate
    const v = flat(o, test)
    if (v !== undefined) card.flat[key] = v
  }
  for (const k of Object.keys(card.flat)) if (card.flat[k] === undefined) delete card.flat[k]
  return { card, published }
}

const out = { generated: new Date().toISOString().slice(0, 10), source: 'AWS Price List Bulk API', url: BASE, currency: 'USD', published: {}, global: {}, regions: {} }
for (const id of REGIONS) {
  process.stderr.write(`${id} … `)
  const { card, published } = await region(id)
  out.regions[id] = card
  if (id === 'us-east-1') out.published = Object.fromEntries(Object.entries(published).map(([k, v]) => [k, String(v).slice(0, 10)]))
  process.stderr.write(`${Object.keys(card.ec2).length} instance types, ${Object.keys(card.flat).length} rates\n`)
}
// CloudFront and Route 53 hosted zones are priced globally, not per region
{
  const cf = await offer('AmazonCloudFront')
  out.global['cloudfront.gb'] = flat(cf, (r) => r.a.usagetype === 'US-DataTransfer-Out-Bytes')
  out.global['cloudfront.https'] = flat(cf, (r) => r.a.usagetype === 'US-Requests-HTTPS-Proxy')
  out.published.AmazonCloudFront = cf.publicationDate.slice(0, 10)
  const r53 = await offer('AmazonRoute53')
  out.global['route53.zone'] = flat(r53, (r) => /HostedZone$/.test(r.a.usagetype ?? '') && /first 25|per Hosted Zone for the first/i.test(r.desc)) ?? flat(r53, (r) => /HostedZone$/.test(r.a.usagetype ?? ''))
}
writeFileSync(new URL('../src/core/pricing/aws-rates.json', import.meta.url), JSON.stringify(out))
process.stderr.write('wrote src/core/pricing/aws-rates.json\n')
