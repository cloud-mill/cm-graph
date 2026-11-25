/**
 * The component catalog: what can be placed on a blueprint, the settings each
 * component has, and how those settings turn into monthly cost lines.
 *
 * The core AWS components are defined here and priced from the generated rate
 * card in `./pricing`, region by region. Google Cloud, Azure and the long tail
 * of AWS are defined in `./clouds` and appended at load. This file also owns
 * cross-cloud equivalents (`equivalent`, `translateDoc`) and the two functions
 * everything else prices through: `costOf` for one component and `docCost`
 * for a blueprint.
 *
 * Lookups never fail: an unknown type resolves to the generic `block`, and a
 * setting a saved component lacks takes its default.
 */
import { CLOUD_DEFS } from './clouds'
import { HOURS, type Quote, type Rate, credits, ec2Rate, fixed, flat, nodeRate, rdsRate, usage } from './pricing'
import type { CostBasis, CostLine, Doc, NodeT, PricingModel } from './types'

/** The 3D shape a component is drawn as. */
export type ModelKind =
  | 'tower' | 'rack' | 'slab' | 'tile' | 'cylinder' | 'bucket'
  | 'stack' | 'cluster' | 'people' | 'globe' | 'disc' | 'gate'

export type Category =
  | 'compute' | 'database' | 'storage' | 'network' | 'messaging' | 'security' | 'analytics' | 'ai' | 'devops' | 'external'

export type Provider = 'aws' | 'gcp' | 'azure' | 'any'
export const PROVIDERS: { id: Exclude<Provider, 'any'>; name: string; short: string; color: string }[] = [
  { id: 'aws', name: 'Amazon Web Services', short: 'AWS', color: '#FF9900' },
  { id: 'gcp', name: 'Google Cloud', short: 'GCP', color: '#4285F4' },
  { id: 'azure', name: 'Microsoft Azure', short: 'Azure', color: '#2F9BEF' },
]

/** One setting of a component, as the inspector edits it. `key` is the name it is stored under in `NodeT.props`. */
export interface PropDef {
  key: string
  label: string
  type: 'select' | 'number' | 'toggle'
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  step?: number
  unit?: string
  default: any
  showIf?: (p: Record<string, any>) => boolean
}

export interface CompDef {
  type: string
  name: string
  provider: Provider
  /** the cloud's own product name, shown as a subtitle */
  svc: string
  /** canonical component this one is equivalent to (defaults to its own type) */
  role?: string
  /** Terraform resource type, with aliases that import as the same component */
  tf?: string
  tfAlso?: string[]
  /** extra attribute lines for the exported Terraform block; falsy entries are dropped */
  tfAttrs?: (p: Record<string, any>) => (string | false | undefined)[]
  category: Category
  model: ModelKind
  glyph: string
  color: string
  /** rough request-path rank, used by auto-layout and edge direction heuristics */
  tier: number
  props: PropDef[]
  /** list-price cost lines for these settings, in the region and pricing model asked for. Absent means the component is never billed. Call it through `costOf`, which fills in defaults first. */
  cost?: (p: Record<string, any>, q: Quote) => CostLine[]
  summary?: (p: Record<string, any>) => string
  keywords?: string
}

export const CATEGORIES: { id: Category; name: string; color: string }[] = [
  { id: 'compute', name: 'Compute', color: '#F2903A' },
  { id: 'database', name: 'Database', color: '#4F7FF2' },
  { id: 'storage', name: 'Storage', color: '#3DB87F' },
  { id: 'network', name: 'Networking', color: '#8F6FF2' },
  { id: 'messaging', name: 'Messaging', color: '#E85C9C' },
  { id: 'analytics', name: 'Analytics', color: '#2BB5D4' },
  { id: 'ai', name: 'AI & ML', color: '#A45CF0' },
  { id: 'security', name: 'Security', color: '#E5574F' },
  { id: 'devops', name: 'Dev & ops', color: '#6C8BB0' },
  { id: 'external', name: 'External', color: '#8792A8' },
]
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.color])) as Record<Category, string>

export { HOURS }
// `opts`, `num`, `sel` and `tog` below are repeated in `clouds.ts`: this file imports that one at load, so it cannot import them back
const opts = (...v: (string | [string, string])[]) =>
  v.map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: o[0], label: o[1] }))

// ---- what can be chosen. Prices are not here: they come from the rate card in ./pricing ----

export const EC2_FAMILY: Record<string, { arm?: boolean; gen: 'current' | 'previous'; upgrade?: string }> = {
  t3: { gen: 'current', upgrade: 't4g' },
  t4g: { arm: true, gen: 'current' },
  t2: { gen: 'previous', upgrade: 't4g' },
  m4: { gen: 'previous', upgrade: 'm7g' },
  m5: { gen: 'current', upgrade: 'm7g' },
  m6i: { gen: 'current', upgrade: 'm7g' },
  m7g: { arm: true, gen: 'current' },
  c5: { gen: 'current', upgrade: 'c7g' },
  c7g: { arm: true, gen: 'current' },
  r5: { gen: 'current', upgrade: 'r7g' },
  r7g: { arm: true, gen: 'current' },
  g5: { gen: 'current' },
}
/** vCPUs relative to `large`. Within a family most sizes are priced in this proportion, but not all (GPU sizes are not), so it is only used to stand in for a size that is not sold */
export const SIZE_MULT: Record<string, number> = {
  nano: 1 / 16, micro: 1 / 8, small: 1 / 4, medium: 1 / 2, large: 1, xlarge: 2, '2xlarge': 4, '4xlarge': 8, '8xlarge': 16,
}
const SIZES = Object.keys(SIZE_MULT)

export const RDS_CLASS: Record<string, { upgrade?: string }> = {
  't3': { upgrade: 't4g' },
  't4g': {},
  'm5': { upgrade: 'm7g' },
  'm7g': {},
  'r5': { upgrade: 'r7g' },
  'r7g': {},
}
const CACHE_NODE = ['cache.t4g.micro', 'cache.t4g.small', 'cache.m7g.large', 'cache.r7g.large', 'cache.r7g.xlarge']
const REDSHIFT_NODE = ['dc2.large', 'ra3.xlplus', 'ra3.4xlarge']
const SEARCH_NODE = ['t3.small.search', 'm6g.large.search', 'r6g.large.search', 'r6g.xlarge.search']
const S3_KEY: Record<string, string> = { standard: 's3.standard', 'infrequent-access': 's3.ia', 'glacier-instant': 's3.gir', 'deep-archive': 's3.gda' }
const EBS_TYPE = ['gp3', 'io2', 'st1', 'sc1']

/** `count` things billed by the hour, all month. */
const perHour = (label: string, count: number, rate: Rate | undefined, note?: string) => fixed(label, count, rate, HOURS, note)

/** The nearest size that is actually sold, scaled by vCPU count: a stand-in, and labelled as one. */
function standIn(size: string, sold: (size: string) => Rate | undefined, name: (size: string) => string, vendor = 'AWS'): Rate | undefined {
  const want = SIZE_MULT[size] ?? 1
  const near = SIZES.filter((x) => sold(x)).sort((x, y) => Math.abs(Math.log(SIZE_MULT[x] / want)) - Math.abs(Math.log(SIZE_MULT[y] / want)))[0]
  const base = near ? sold(near) : undefined
  return base && { usd: (base.usd * want) / SIZE_MULT[near], local: false, note: `${vendor} does not sell ${name(size)}. This is ${name(near)} scaled by size, as a stand-in.` }
}
/** An EC2 hourly rate that always tries to answer: the exact type, else Linux standing in for an unsold Windows, else the nearest size scaled. Every stand-in is non-local, so its line is an estimate. `undefined` only for a family the card does not have. */
function ec2Price(q: Quote, family: string, size: string, windows: boolean): Rate | undefined {
  const type = `${family}.${size}`
  const exact = ec2Rate(q, type, windows)
  if (exact) return exact
  if (windows) {
    const linux = ec2Price(q, family, size, false)
    return linux && { ...linux, local: false, note: `Windows is not sold on ${type} (Graviton runs Linux only). Priced as Linux.` }
  }
  return standIn(size, (x) => ec2Rate(q, `${family}.${x}`), (x) => `${family}.${x}`)
}
const ENGINE_NAME: Record<string, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', aurora: 'Aurora', sqlserver: 'SQL Server Standard' }
/** The same for RDS: the exact engine and class, else the nearest size of that engine scaled, else PostgreSQL on the same class. */
function rdsPrice(q: Quote, engine: string, cls: string): Rate | undefined {
  const exact = rdsRate(q, engine, cls)
  if (exact) return engine === 'sqlserver' ? { ...exact, note: [exact.note, 'SQL Server Standard, licence included.'].filter(Boolean).join(' ') } : exact
  const [family, size] = cls.split('.')
  const scaled = standIn(size, (x) => rdsRate(q, engine, `${family}.${x}`), (x) => `${ENGINE_NAME[engine] ?? engine} on db.${family}.${x}`)
  if (scaled) return scaled
  // the engine is not sold on this class at all
  const pg = engine !== 'postgres' ? rdsPrice(q, 'postgres', cls) : undefined
  return pg && { ...pg, local: false, note: `${ENGINE_NAME[engine] ?? engine} is not sold on db.${family}. Priced as PostgreSQL on the same class.` }
}

/** Where a blueprint can be priced. AWS prices are loaded for each of these; other clouds are priced at their US rates everywhere. */
export const REGIONS: { id: string; name: string; gcp: string; azure: string }[] = [
  { id: 'us-east-1', name: 'US East (N. Virginia)', gcp: 'us-east4', azure: 'eastus' },
  { id: 'us-west-2', name: 'US West (Oregon)', gcp: 'us-west1', azure: 'westus2' },
  { id: 'eu-west-1', name: 'Europe (Ireland)', gcp: 'europe-west1', azure: 'northeurope' },
  { id: 'eu-central-1', name: 'Europe (Frankfurt)', gcp: 'europe-west3', azure: 'germanywestcentral' },
  { id: 'ap-south-1', name: 'Asia Pacific (Mumbai)', gcp: 'asia-south1', azure: 'centralindia' },
  { id: 'ap-southeast-1', name: 'Asia Pacific (Singapore)', gcp: 'asia-southeast1', azure: 'southeastasia' },
  { id: 'ap-northeast-1', name: 'Asia Pacific (Tokyo)', gcp: 'asia-northeast1', azure: 'japaneast' },
  { id: 'sa-east-1', name: 'South America (São Paulo)', gcp: 'southamerica-east1', azure: 'brazilsouth' },
]
// anywhere else, a line priced from a US list price held in the catalog (not from the rate card) is marked as an estimate
const US_REGIONS = new Set(['us-east-1', 'us-west-2'])

/**
 * Blanket commitment discounts by cloud, for lines that are not on the AWS rate card.
 * `costOf` applies one only to a line that carries `commit: true`, and no cost
 * function in the catalog sets that flag, so today this table changes no figure.
 * The discounts that do apply are per machine type: published reserved rates on
 * the rate card for AWS, and the `Commit` tables in `clouds.ts` (`GCE_CUD`, `AZ_RI`,
 * Cloud SQL) for Google Cloud and Azure.
 */
export const COMMIT_DISCOUNT: Record<Provider, Record<PricingModel, number>> = {
  aws: { ondemand: 0, commit1: 0, commit3: 0 },
  gcp: { ondemand: 0, commit1: 0.37, commit3: 0.55 },
  azure: { ondemand: 0, commit1: 0.37, commit3: 0.57 },
  any: { ondemand: 0, commit1: 0, commit3: 0 },
}

const num = (key: string, label: string, def: number, unit?: string, extra: Partial<PropDef> = {}): PropDef =>
  ({ key, label, type: 'number', default: def, unit, min: 0, ...extra })
const sel = (key: string, label: string, def: string, o: { value: string; label: string }[], extra: Partial<PropDef> = {}): PropDef =>
  ({ key, label, type: 'select', default: def, options: o, ...extra })
const tog = (key: string, label: string, def = false): PropDef => ({ key, label, type: 'toggle', default: def })

/** A definition in this file: AWS unless it is in the `external` category, which is cloud-neutral, and coloured by its category unless it says otherwise. */
const def = (d: Omit<CompDef, 'color' | 'provider'> & { color?: string; provider?: Provider }): CompDef =>
  ({ provider: d.category === 'external' ? 'any' : 'aws', ...d, color: d.color ?? CAT[d.category] })

const DEFS: CompDef[] = [
  // ---- compute
  def({
    type: 'ec2', name: 'Virtual machine', svc: 'EC2', category: 'compute', model: 'tower', glyph: 'server', tier: 3,
    keywords: 'instance server vm',
    props: [
      sel('family', 'Family', 'm7g', opts(...Object.keys(EC2_FAMILY))),
      sel('size', 'Size', 'large', opts(...SIZES)),
      sel('os', 'Platform', 'linux', opts(['linux', 'Linux'], ['windows', 'Windows'])),
      num('count', 'Instances', 1, undefined, { min: 1, max: 500 }),
      num('disk', 'Root volume', 30, 'GB'),
    ],
    cost: (p, q) => {
      const type = `${p.family}.${p.size}`
      const win = p.os === 'windows'
      return [
        perHour(`${p.count} × ${type}${win ? ' (Windows)' : ''}`, p.count, ec2Price(q, p.family, p.size, win)),
        fixed(`${p.disk * p.count} GB gp3`, p.disk * p.count, flat(q, 'ebs.gp3')),
      ]
    },
    summary: (p) => `${p.count > 1 ? p.count + ' × ' : ''}${p.family}.${p.size}`,
  }),
  def({
    type: 'lambda', name: 'Function', svc: 'Lambda', category: 'compute', model: 'tile', glyph: 'lambda', tier: 3,
    keywords: 'serverless faas',
    props: [
      num('requests', 'Invocations', 5, 'M / mo', { step: 0.5 }),
      num('duration', 'Avg duration', 120, 'ms', { step: 10 }),
      sel('memory', 'Memory', '512', opts(['128', '128 MB'], ['256', '256 MB'], ['512', '512 MB'], ['1024', '1 GB'], ['2048', '2 GB'], ['4096', '4 GB'], ['10240', '10 GB'])),
      sel('arch', 'Architecture', 'arm64', opts(['arm64', 'arm64 (Graviton)'], ['x86_64', 'x86_64'])),
    ],
    cost: (p, q) => {
      const gbs = p.requests * 1e6 * (p.duration / 1000) * (Number(p.memory) / 1024)
      return [
        usage(`${p.requests}M requests`, p.requests * 1e6, flat(q, 'lambda.req'), 'aws.lambda.req'),
        usage(`${Math.round(gbs).toLocaleString()} GB-seconds`, gbs, flat(q, p.arch === 'arm64' ? 'lambda.gbs.arm' : 'lambda.gbs'), 'aws.lambda.gbs'),
      ]
    },
    summary: (p) => `${p.memory} MB · ${p.requests}M/mo`,
  }),
  def({
    type: 'ecs', name: 'Container service', svc: 'ECS on Fargate', category: 'compute', model: 'cluster', glyph: 'container', tier: 3,
    keywords: 'docker fargate task',
    props: [
      num('tasks', 'Tasks', 3, undefined, { min: 1 }),
      sel('vcpu', 'vCPU / task', '0.5', opts('0.25', '0.5', '1', '2', '4')),
      sel('mem', 'Memory / task', '1', opts(['0.5', '0.5 GB'], ['1', '1 GB'], ['2', '2 GB'], ['4', '4 GB'], ['8', '8 GB'], ['16', '16 GB'])),
    ],
    cost: (p, q) => {
      const v = flat(q, 'fargate.vcpu'), g = flat(q, 'fargate.gb')
      const rate = v && g ? { usd: Number(p.vcpu) * v.usd + Number(p.mem) * g.usd, local: v.local && g.local, note: v.note ?? g.note } : undefined
      return [fixed(`${p.tasks} tasks × ${p.vcpu} vCPU / ${p.mem} GB`, p.tasks, rate, HOURS, q.model !== 'ondemand' ? 'Fargate is covered by Savings Plans, not reservations; those are not modelled, so this stays on-demand.' : undefined)]
    },
    summary: (p) => `${p.tasks} tasks · ${p.vcpu} vCPU`,
  }),
  def({
    type: 'eks', name: 'Kubernetes cluster', svc: 'EKS', category: 'compute', model: 'cluster', glyph: 'wheel', tier: 3, color: '#5B6CF0',
    keywords: 'k8s kubernetes',
    props: [
      num('nodes', 'Worker nodes', 3, undefined, { min: 0 }),
      sel('family', 'Node family', 'm7g', opts(...Object.keys(EC2_FAMILY))),
      sel('size', 'Node size', 'xlarge', opts(...SIZES)),
    ],
    cost: (p, q) => [
      fixed('Control plane', 1, flat(q, 'eks.cluster'), HOURS),
      perHour(`${p.nodes} × ${p.family}.${p.size}`, p.nodes, ec2Price(q, p.family, p.size, false)),
    ],
    summary: (p) => `${p.nodes} × ${p.family}.${p.size}`,
  }),
  // ---- database
  def({
    type: 'rds', name: 'Relational database', svc: 'RDS / Aurora', category: 'database', model: 'cylinder', glyph: 'db', tier: 6,
    keywords: 'postgres mysql sql aurora',
    props: [
      sel('engine', 'Engine', 'postgres', opts(['postgres', 'PostgreSQL'], ['mysql', 'MySQL'], ['mariadb', 'MariaDB'], ['aurora', 'Aurora'], ['sqlserver', 'SQL Server'])),
      sel('family', 'Class', 'm7g', opts(...Object.keys(RDS_CLASS).map((k) => [k, 'db.' + k] as [string, string]))),
      sel('size', 'Size', 'large', opts(...SIZES.slice(1))),
      tog('multiAZ', 'Multi-AZ standby', false),
      num('replicas', 'Read replicas', 0, undefined, { max: 15 }),
      num('storage', 'Storage', 100, 'GB'),
    ],
    cost: (p, q) => {
      const cls = `${p.family}.${p.size}`
      const aurora = p.engine === 'aurora'
      const rate = rdsPrice(q, p.engine, cls)
      const lines: CostLine[] = []
      if (aurora) {
        // Aurora has no standby instance to pay for: it keeps six copies of the data across three zones, and a failover target is a replica
        lines.push(perHour(`db.${cls} writer`, 1, rate, p.multiAZ ? 'Aurora has no separate Multi-AZ standby; add a replica for a failover target.' : undefined))
        if (p.replicas > 0) lines.push(perHour(`${p.replicas} Aurora replica${p.replicas > 1 ? 's' : ''}`, p.replicas, rate))
        lines.push(fixed(`${p.storage} GB Aurora storage`, p.storage, flat(q, 'aurora.storage'), 1, 'Aurora also bills $0.20 per million I/O requests, which depends on workload and is not included.'))
      } else {
        lines.push(perHour(`db.${cls}${p.multiAZ ? ' (Multi-AZ)' : ''}`, p.multiAZ ? 2 : 1, rate))
        lines.push(fixed(`${p.storage} GB gp3 storage${p.multiAZ ? ' (Multi-AZ)' : ''}`, p.storage * (p.multiAZ ? 2 : 1), flat(q, 'rds.gp3')))
        if (p.replicas > 0) lines.push(perHour(`${p.replicas} read replica${p.replicas > 1 ? 's' : ''}`, p.replicas, rate))
      }
      return lines
    },
    summary: (p) => `${p.engine} · db.${p.family}.${p.size}`,
  }),
  def({
    type: 'dynamodb', name: 'NoSQL table', svc: 'DynamoDB', category: 'database', model: 'stack', glyph: 'table', tier: 6,
    keywords: 'key value document nosql',
    props: [
      num('reads', 'Reads', 20, 'M / mo'),
      num('writes', 'Writes', 5, 'M / mo'),
      num('storage', 'Storage', 25, 'GB'),
    ],
    cost: (p, q) => [
      usage(`${p.reads}M read units`, p.reads * 1e6, flat(q, 'ddb.read')),
      usage(`${p.writes}M write units`, p.writes * 1e6, flat(q, 'ddb.write')),
      usage(`${p.storage} GB`, p.storage, flat(q, 'ddb.storage'), 'aws.ddb.storage'),
    ],
    summary: (p) => `on-demand · ${p.storage} GB`,
  }),
  def({
    type: 'elasticache', name: 'In-memory cache', svc: 'ElastiCache', category: 'database', model: 'slab', glyph: 'bolt', tier: 5, color: '#3D9BF0',
    keywords: 'redis valkey memcached cache',
    props: [
      sel('node', 'Node type', 'cache.m7g.large', opts(...CACHE_NODE)),
      num('nodes', 'Nodes', 2, undefined, { min: 1 }),
    ],
    cost: (p, q) => [perHour(`${p.nodes} × ${p.node}`, p.nodes, nodeRate(q, 'cache', p.node), 'Redis OSS rate. Valkey nodes are 20% cheaper.')],
    summary: (p) => `${p.nodes} × ${String(p.node).replace('cache.', '')}`,
  }),
  // ---- storage
  def({
    type: 's3', name: 'Object storage', svc: 'S3', category: 'storage', model: 'bucket', glyph: 'bucket', tier: 6,
    keywords: 'bucket blob files',
    props: [
      num('storage', 'Storage', 500, 'GB'),
      sel('class', 'Storage class', 'standard', opts(['standard', 'Standard'], ['infrequent-access', 'Infrequent Access'], ['glacier-instant', 'Glacier Instant'], ['deep-archive', 'Deep Archive'])),
      num('requests', 'GET requests', 10, 'M / mo'),
      num('egress', 'Data transfer out', 50, 'GB'),
    ],
    cost: (p, q) => [
      // the generated card has no `s3.gda` rate in any region, so Deep Archive is the one rate typed in here, and it is marked as an estimate
      fixed(`${p.storage} GB ${p.class}`, p.storage, flat(q, S3_KEY[p.class] ?? 's3.standard') ?? (p.class === 'deep-archive' ? { usd: 0.00099, local: false, note: 'Rate from the S3 pricing page; the price file loaded has no row for it.' } : undefined), 1, p.storage > 51200 ? 'Priced at the first-50-TB rate; storage beyond that is slightly cheaper.' : undefined),
      usage(`${p.requests}M GET requests`, p.requests * 1e6, flat(q, 's3.get')),
      usage(`${p.egress} GB to the internet`, p.egress, flat(q, 'egress'), 'aws.egress'),
    ],
    summary: (p) => `${p.storage} GB · ${p.class}`,
  }),
  def({
    type: 'ebs', name: 'Block volume', svc: 'EBS', category: 'storage', model: 'slab', glyph: 'disk', tier: 6, color: '#35A89A',
    keywords: 'disk volume ssd',
    props: [
      sel('vol', 'Volume type', 'gp3', opts(...EBS_TYPE)),
      num('size', 'Size', 200, 'GB'),
    ],
    cost: (p, q) => [fixed(`${p.size} GB ${p.vol}`, p.size, flat(q, 'ebs.' + p.vol), 1, p.vol === 'io2' ? 'Provisioned IOPS are billed on top and are not included.' : undefined)],
    summary: (p) => `${p.size} GB ${p.vol}`,
  }),
  def({
    type: 'efs', name: 'File system', svc: 'EFS', category: 'storage', model: 'stack', glyph: 'folder', tier: 6, color: '#5BBF5A',
    keywords: 'nfs shared files',
    props: [num('storage', 'Storage', 100, 'GB')],
    cost: (p, q) => [fixed(`${p.storage} GB standard`, p.storage, flat(q, 'efs.standard'))],
    summary: (p) => `${p.storage} GB`,
  }),
  // ---- network
  def({
    type: 'alb', name: 'Load balancer', svc: 'ELB', category: 'network', model: 'slab', glyph: 'balance', tier: 2,
    keywords: 'alb nlb elb balancer',
    props: [
      sel('kind', 'Type', 'application', opts(['application', 'Application (L7)'], ['network', 'Network (L4)'])),
      num('lcu', 'Capacity units', 5, 'LCU avg'),
    ],
    cost: (p, q) => {
      const n = p.kind === 'network'
      return [
        fixed(`${p.kind} load balancer`, 1, flat(q, n ? 'nlb.hour' : 'alb.hour'), HOURS),
        usage(`${p.lcu} ${n ? 'NLCU' : 'LCU'} on average`, p.lcu * HOURS, flat(q, n ? 'nlb.lcu' : 'alb.lcu')),
      ]
    },
    summary: (p) => (p.kind === 'network' ? 'Network · L4' : 'Application · L7'),
  }),
  def({
    type: 'cloudfront', name: 'CDN', svc: 'CloudFront', category: 'network', model: 'disc', glyph: 'globe', tier: 1,
    keywords: 'edge cache distribution',
    props: [
      num('transfer', 'Data transfer', 500, 'GB / mo'),
      num('requests', 'Requests', 20, 'M / mo'),
    ],
    cost: (p, q) => [
      usage(`${p.transfer} GB to internet`, p.transfer, flat(q, 'cloudfront.gb'), 'aws.cloudfront.gb', 'North America and Europe edge rate, first 10 TB tier. Other continents cost more.'),
      usage(`${p.requests}M HTTPS requests`, p.requests * 1e6, flat(q, 'cloudfront.https'), 'aws.cloudfront.req'),
    ],
    summary: (p) => `${p.transfer} GB/mo`,
  }),
  def({
    type: 'route53', name: 'DNS', svc: 'Route 53', category: 'network', model: 'disc', glyph: 'compass', tier: 0, color: '#A367E8',
    keywords: 'domain zone',
    props: [num('zones', 'Hosted zones', 1), num('queries', 'Queries', 10, 'M / mo')],
    cost: (p, q) => [
      fixed(`${p.zones} hosted zone${p.zones === 1 ? '' : 's'}`, p.zones, flat(q, 'route53.zone')),
      usage(`${p.queries}M queries`, p.queries * 1e6, flat(q, 'route53.queries')),
    ],
    summary: (p) => `${p.zones} zone${p.zones === 1 ? '' : 's'}`,
  }),
  def({
    type: 'apigw', name: 'API gateway', svc: 'API Gateway', category: 'network', model: 'gate', glyph: 'code', tier: 2,
    keywords: 'rest http api',
    props: [
      sel('kind', 'Type', 'http', opts(['http', 'HTTP API'], ['rest', 'REST API'])),
      num('requests', 'Requests', 10, 'M / mo'),
    ],
    cost: (p, q) => [usage(`${p.requests}M ${p.kind.toUpperCase()} requests`, p.requests * 1e6, flat(q, p.kind === 'rest' ? 'apigw.rest' : 'apigw.http'))],
    summary: (p) => `${p.kind.toUpperCase()} · ${p.requests}M/mo`,
  }),
  def({
    type: 'nat', name: 'NAT gateway', svc: 'NAT Gateway', category: 'network', model: 'gate', glyph: 'swap', tier: 4, color: '#7C7FE8',
    keywords: 'egress outbound',
    props: [num('data', 'Data processed', 200, 'GB / mo')],
    cost: (p, q) => [
      fixed('Gateway hours', 1, flat(q, 'nat.hour'), HOURS),
      usage(`${p.data} GB processed`, p.data, flat(q, 'nat.gb')),
    ],
    summary: (p) => `${p.data} GB/mo`,
  }),
  def({
    type: 'igw', name: 'Internet gateway', svc: 'Internet Gateway', category: 'network', model: 'gate', glyph: 'globe', tier: 1, color: '#9D8CF5',
    keywords: 'igw ingress',
    props: [],
    cost: () => [],
    summary: () => 'No hourly charge',
  }),
  // ---- messaging
  def({
    type: 'sqs', name: 'Queue', svc: 'SQS', category: 'messaging', model: 'stack', glyph: 'queue', tier: 4,
    keywords: 'message queue fifo',
    props: [
      sel('kind', 'Type', 'standard', opts(['standard', 'Standard'], ['fifo', 'FIFO'])),
      num('requests', 'Requests', 10, 'M / mo'),
      tog('dlq', 'Dead-letter queue', false),
    ],
    cost: (p, q) => [usage(`${p.requests}M requests`, p.requests * 1e6, flat(q, p.kind === 'fifo' ? 'sqs.fifo' : 'sqs.standard'), 'aws.sqs')],
    summary: (p) => `${p.kind} · ${p.requests}M/mo`,
  }),
  def({
    type: 'sns', name: 'Pub/sub topic', svc: 'SNS', category: 'messaging', model: 'slab', glyph: 'broadcast', tier: 4, color: '#EA6F8B',
    keywords: 'notification topic fanout',
    props: [num('messages', 'Publishes', 5, 'M / mo')],
    cost: (p, q) => [usage(`${p.messages}M publishes`, p.messages * 1e6, flat(q, 'sns.publish'), 'aws.sns', 'Publishes only; delivery to HTTP, email or SMS is billed separately.')],
    summary: (p) => `${p.messages}M/mo`,
  }),
  def({
    type: 'eventbridge', name: 'Event bus', svc: 'EventBridge', category: 'messaging', model: 'tile', glyph: 'hub', tier: 4, color: '#D858C8',
    keywords: 'events rules schedule cron',
    props: [num('events', 'Custom events', 5, 'M / mo')],
    cost: (p, q) => [usage(`${p.events}M custom events`, p.events * 1e6, flat(q, 'events.custom'))],
    summary: (p) => `${p.events}M/mo`,
  }),
  // ---- analytics
  def({
    type: 'kinesis', name: 'Data stream', svc: 'Kinesis', category: 'analytics', model: 'slab', glyph: 'stream', tier: 4,
    keywords: 'streaming kafka ingest',
    props: [num('shards', 'Shards', 4, undefined, { min: 1 }), num('records', 'PUT records', 100, 'M / mo')],
    cost: (p, q) => [
      fixed(`${p.shards} shard${p.shards === 1 ? '' : 's'}`, p.shards, flat(q, 'kinesis.shard'), HOURS),
      usage(`${p.records}M PUT units`, p.records * 1e6, flat(q, 'kinesis.put')),
    ],
    summary: (p) => `${p.shards} shards`,
  }),
  def({
    type: 'redshift', name: 'Data warehouse', svc: 'Redshift', category: 'analytics', model: 'rack', glyph: 'warehouse', tier: 7, color: '#2F8FD8',
    keywords: 'olap warehouse sql analytics',
    props: [
      sel('node', 'Node type', 'ra3.xlplus', opts(...REDSHIFT_NODE)),
      num('nodes', 'Nodes', 2, undefined, { min: 1 }),
    ],
    cost: (p, q) => [perHour(`${p.nodes} × ${p.node}`, p.nodes, nodeRate(q, 'redshift', p.node), String(p.node).startsWith('ra3') ? 'RA3 managed storage is billed per GB on top ($0.024 in N. Virginia) and is not included.' : undefined)],
    summary: (p) => `${p.nodes} × ${p.node}`,
  }),
  def({
    type: 'opensearch', name: 'Search cluster', svc: 'OpenSearch', category: 'analytics', model: 'cylinder', glyph: 'search', tier: 6, color: '#22A9B8',
    keywords: 'elasticsearch logs search',
    props: [
      sel('node', 'Node type', 'm6g.large.search', opts(...SEARCH_NODE)),
      num('nodes', 'Data nodes', 3, undefined, { min: 1 }),
      num('storage', 'Storage / node', 100, 'GB'),
    ],
    cost: (p, q) => [
      perHour(`${p.nodes} × ${p.node}`, p.nodes, nodeRate(q, 'search', p.node)),
      fixed(`${p.nodes * p.storage} GB gp3`, p.nodes * p.storage, flat(q, 'search.gp3')),
    ],
    summary: (p) => `${p.nodes} × ${String(p.node).replace('.search', '')}`,
  }),
  def({
    type: 'cloudwatch', name: 'Monitoring', svc: 'CloudWatch', category: 'analytics', model: 'tile', glyph: 'chart', tier: 8, color: '#4FB8A8',
    keywords: 'logs metrics alarms observability',
    props: [num('metrics', 'Custom metrics', 50), num('logs', 'Log ingestion', 50, 'GB / mo')],
    cost: (p, q) => [
      fixed(`${p.metrics} custom metrics`, p.metrics, flat(q, 'cw.metric')),
      usage(`${p.logs} GB logs ingested`, p.logs, flat(q, 'cw.logs'), undefined, 'Ingestion only; stored logs cost $0.03 per GB-month after compression.'),
    ],
    summary: (p) => `${p.logs} GB logs/mo`,
  }),
  // ---- security
  def({
    type: 'waf', name: 'Web firewall', svc: 'WAF', category: 'security', model: 'gate', glyph: 'shield', tier: 1,
    keywords: 'firewall acl rules',
    props: [num('rules', 'Rules', 10), num('requests', 'Requests inspected', 20, 'M / mo')],
    cost: (p, q) => [
      fixed('Web ACL', 1, flat(q, 'waf.acl')),
      fixed(`${p.rules} rules`, p.rules, flat(q, 'waf.rule')),
      usage(`${p.requests}M requests`, p.requests * 1e6, flat(q, 'waf.req')),
    ],
    summary: (p) => `${p.rules} rules`,
  }),
  def({
    type: 'cognito', name: 'Identity provider', svc: 'Cognito', category: 'security', model: 'tile', glyph: 'user', tier: 2, color: '#E0705A',
    keywords: 'auth login users oauth',
    props: [num('mau', 'Monthly active users', 25000, 'MAU', { step: 1000 })],
    cost: (p, q) => [usage(`${Number(p.mau).toLocaleString()} MAU`, Number(p.mau), flat(q, 'cognito.lite'), 'aws.cognito', 'Lite tier rate. The Essentials tier, the default for new user pools, is $0.015 per user.')],
    summary: (p) => `${Number(p.mau).toLocaleString()} MAU`,
  }),
  def({
    type: 'secrets', name: 'Secrets & keys', svc: 'Secrets Manager / KMS', category: 'security', model: 'tile', glyph: 'key', tier: 8, color: '#D4524E',
    keywords: 'kms secret key vault encryption',
    props: [num('secrets', 'Secrets', 12), num('keys', 'Customer keys', 3)],
    cost: (p, q) => [
      fixed(`${p.secrets} secrets`, p.secrets, flat(q, 'secrets.secret')),
      fixed(`${p.keys} KMS keys`, p.keys, flat(q, 'kms.key')),
    ],
    summary: (p) => `${p.secrets} secrets · ${p.keys} keys`,
  }),
  // ---- external
  def({
    type: 'users', name: 'Users', svc: 'Clients', category: 'external', model: 'people', glyph: 'user', tier: -2, color: '#6F7C96',
    keywords: 'people customers clients browser', props: [],
  }),
  def({
    type: 'internet', name: 'Internet', svc: 'Public network', category: 'external', model: 'globe', glyph: 'globe', tier: -1, color: '#5E8CC9',
    keywords: 'web public', props: [],
  }),
  def({
    type: 'mobile', name: 'Mobile app', svc: 'Client device', category: 'external', model: 'tile', glyph: 'phone', tier: -2,
    keywords: 'ios android phone client', props: [],
  }),
  def({
    type: 'onprem', name: 'On-prem datacenter', svc: 'Corporate DC', category: 'external', model: 'rack', glyph: 'server', tier: -1, color: '#707A8C',
    keywords: 'datacenter legacy vpn direct connect', props: [],
  }),
  def({
    type: 'saas', name: 'Third-party API', svc: 'External service', category: 'external', model: 'slab', glyph: 'plug', tier: 7, color: '#9A8F7A',
    keywords: 'stripe twilio webhook vendor external',
    props: [num('fee', 'Monthly fee', 0, 'USD')],
    cost: (p) => (p.fee > 0 ? [{ label: 'Subscription', monthly: Number(p.fee), basis: 'fixed', note: 'The fee you entered.' }] : []),
  }),
  def({
    type: 'block', name: 'Generic block', svc: 'Custom component', category: 'external', model: 'tower', glyph: 'cube', tier: 3, color: '#566178',
    keywords: 'custom box service',
    props: [num('fee', 'Monthly cost', 0, 'USD')],
    cost: (p) => (p.fee > 0 ? [{ label: 'Custom', monthly: Number(p.fee), basis: 'fixed', note: 'The fee you entered.' }] : []),
  }),
]

/**
 * Everything defined in this file, captured before `clouds.ts` is appended: the components priced from the
 * AWS rate card, region by region, plus the cloud-neutral ones. `costOf` returns their lines untouched.
 * Everything else carries a US list price.
 */
const ON_CARD = new Set(DEFS.map((d) => d.type))
for (const d of CLOUD_DEFS) DEFS.push({ ...d, color: d.color ?? CAT[d.category] })
// keep each category together, clouds in a fixed order
const P_ORDER: Record<Provider, number> = { aws: 0, gcp: 1, azure: 2, any: 3 }
DEFS.sort((a, b) => P_ORDER[a.provider] - P_ORDER[b.provider])

export const CATALOG: Record<string, CompDef> = Object.fromEntries(DEFS.map((d) => [d.type, d]))
/** Every definition, AWS first, then Google Cloud, Azure and the cloud-neutral ones, in the order they are defined within each. */
export const CATALOG_LIST = DEFS
export const FOOT = 2 // every component occupies a 2×2 footprint, in cells, before its own `scale`

// own keys only: a type called `constructor` or `toString` (from a hand-edited file) must not resolve to Object's members
export const defOf = (type: string): CompDef => (Object.hasOwn(CATALOG, type) ? CATALOG[type] : CATALOG.block)
/** the canonical component a type behaves like: `gcp-sql` and `az-sql` are both `rds` */
export const roleOf = (type: string): string => { const d = defOf(type); return d.role ?? d.type }
export const providerOf = (type: string): Provider => defOf(type).provider

// where a cloud has no direct counterpart, the service teams usually reach for instead
const NEAREST: Record<string, string> = {
  eventbridge: 'sns', aurora: 'rds', newsql: 'rds', docdb: 'dynamodb', graphdb: 'dynamodb', kafka: 'kinesis', streamproc: 'kinesis',
  archive: 's3', graphql: 'apigw', scheduler: 'eventbridge', airflow: 'workflow', query: 'redshift', iot: 'sns', ddos: 'waf',
}

/** The first-choice component for a role in a given cloud: the first one defined with that role, or with the nearest role that cloud does have. Cloud-neutral components are their own equivalent. `undefined` when there is no reasonable counterpart. */
export function equivalent(type: string, provider: Provider): CompDef | undefined {
  const d = defOf(type)
  if (d.provider === 'any' || d.provider === provider) return d
  const role = roleOf(type)
  const pick = (r?: string) => (r ? DEFS.find((x) => x.provider === provider && (x.role ?? x.type) === r) : undefined)
  // follow the chain of nearest services until this cloud has one (scheduler → event bus → topic)
  for (let r: string | undefined = role, hops = 0; r && hops < 4; r = NEAREST[r], hops++) {
    const hit = pick(r)
    if (hit) return hit
  }
  return undefined
}

/**
 * Re-home a blueprint on another cloud, carrying over every setting the two components share.
 * A setting is shared when both sides have the same key and kind of control, and for a select, when
 * the target offers the value. The metered keys `m0`, `m1`, ... are positional, so they are carried
 * only when the labels match too. `moved` counts components that changed type, `kept` those on
 * another cloud with no equivalent, which stay as they are. The input is not modified.
 */
export function translateDoc(doc: Doc, provider: Exclude<Provider, 'any'>): { doc: Doc; moved: number; kept: number } {
  let moved = 0, kept = 0
  const nodes = doc.nodes.map((n) => {
    const from = defOf(n.type)
    if (from.provider === 'any' || from.provider === provider) return n
    const to = equivalent(n.type, provider)
    if (!to) { kept++; return n }
    moved++
    const props = defaultProps(to.type)
    for (const p of to.props) {
      const v = n.props[p.key]
      const old = from.props.find((o) => o.key === p.key)
      if (v === undefined || !old || old.type !== p.type || (/^m\d$/.test(p.key) && old.label !== p.label)) continue
      if (p.type === 'select' && !p.options!.some((o) => o.value === v)) continue
      props[p.key] = v
    }
    return { ...n, type: to.type, props }
  })
  return { doc: { ...doc, nodes }, moved, kept }
}

/** Which clouds a blueprint uses, most-used first. */
export function docProviders(doc: Doc): Exclude<Provider, 'any'>[] {
  const count = new Map<Provider, number>()
  for (const n of doc.nodes) { const p = providerOf(n.type); if (p !== 'any') count.set(p, (count.get(p) ?? 0) + 1) }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]) as Exclude<Provider, 'any'>[]
}

/** A fresh object holding every setting of a component type at its default. */
export function defaultProps(type: string): Record<string, any> {
  return Object.fromEntries(defOf(type).props.map((p) => [p.key, p.default]))
}

export const nodeName = (n: NodeT) => n.name || defOf(n.type).name
export const nodeColor = (n: NodeT) => n.color || defOf(n.type).color

// ---- cost ------------------------------------------------------------------

export interface NodeCost {
  lines: CostLine[]
  monthly: number
}

/**
 * The monthly list-price lines of one component, in USD, before any free allowance.
 * Missing settings take their defaults. Lines of rate-card components are final as built. The others
 * (Google Cloud, Azure, the AWS long tail) are priced from US list prices, so outside the US regions
 * they are all marked as estimates, at the same amount: nothing is scaled by region.
 */
export function costOf(n: NodeT, region: string, model: PricingModel = 'ondemand'): NodeCost {
  // What a component costs depends on its type and settings, the region and the pricing model: not on where it stands.
  // A component that is moved keeps the same settings object, so its cost is remembered against that, and a blueprint of
  // thousands is not priced again from nothing each time one of them is nudged. What is handed back is shared: read it, never change it
  const settings: unknown = n.props
  if (!settings || typeof settings !== 'object') return priceOf(n, region, model)
  const was = priced.get(settings)
  if (was && was.type === n.type && was.region === region && was.model === model) return was.cost
  const cost = priceOf(n, region, model)
  priced.set(settings, { type: n.type, region, model, cost })
  return cost
}
const priced = new WeakMap<object, { type: string; region: string; model: PricingModel; cost: NodeCost }>()
function priceOf(n: NodeT, region: string, model: PricingModel): NodeCost {
  const d = defOf(n.type)
  if (!d.cost) return { lines: [], monthly: 0 }
  const props = { ...defaultProps(n.type), ...n.props }
  const disc = COMMIT_DISCOUNT[d.provider][model]
  const abroad = !US_REGIONS.has(region)
  const lines = d
    .cost(props, { region, model })
    .map((l): CostLine => {
      // these came from the rate card for this very region and are already final
      if (ON_CARD.has(d.type)) return l
      // everything else is priced from a US list price held in the catalogue
      const basis: CostBasis = l.basis ?? 'estimate'
      const notes = [l.note]
      let monthly = l.monthly
      if (l.commit && disc > 0) { monthly *= 1 - disc; notes.push(`Committed-use discount of ${Math.round(disc * 100)}% applied.`) }
      else if (l.commit && model !== 'ondemand') notes.push('No commitment price is verified for this, so it stays on-demand.')
      if (abroad && d.provider !== 'any') notes.push('Priced at US rates: regional prices for this service are not loaded.')
      return { ...l, monthly, basis: abroad && d.provider !== 'any' ? 'estimate' : basis, note: notes.filter(Boolean).join(' ') || undefined }
    })
    // lines that come to nothing are dropped, except one saying a price is missing, which must stay visible.
    // The text matched here is the note written by `fixed` and `usage` in ./pricing.
    .filter((l) => l.monthly > 0.0001 || (l.basis === 'estimate' && l.monthly === 0 && /No published price/.test(l.note ?? '')))
  return { lines, monthly: lines.reduce((s, l) => s + l.monthly, 0) }
}

export interface DocCost {
  perNode: Map<string, NodeCost>
  byCategory: Map<Category, number>
  /** how much of the total rests on each kind of figure, before allowances */
  byBasis: Record<CostBasis, number>
  /** list price of everything, before free allowances */
  list: number
  /** account-wide free allowances this blueprint's usage qualifies for */
  credits: ReturnType<typeof credits>
  /** what the month is expected to cost: list price less allowances */
  total: number
}

/**
 * What a whole blueprint costs a month in its own region. Each component is priced on its own at list price,
 * then the account-wide free allowances are worked out once over every line together and taken off the total.
 * So `perNode`, `byCategory` and `byBasis` all add up to `list`, not to `total`.
 */
export function docCost(doc: Doc, model: PricingModel = 'ondemand'): DocCost {
  const perNode = new Map<string, NodeCost>()
  const byCategory = new Map<Category, number>()
  const byBasis: Record<CostBasis, number> = { fixed: 0, usage: 0, estimate: 0 }
  const all: CostLine[] = []
  let list = 0
  for (const n of doc.nodes) {
    const c = costOf(n, doc.region, model)
    perNode.set(n.id, c)
    list += c.monthly
    const cat = defOf(n.type).category
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + c.monthly)
    for (const l of c.lines) { byBasis[l.basis ?? 'estimate'] += l.monthly; all.push(l) }
  }
  const free = credits(all)
  const off = free.reduce((s, c) => s + c.monthly, 0)
  return { perNode, byCategory, byBasis, list, credits: free, total: Math.max(0, list - off) }
}

/** A USD amount for display: cents below $100, whole dollars above, billions always abbreviated, and anything from $10,000 too when `compact`. Anything that is not a finite number reads `$0.00`. */
export function money(v: number, compact = false): string {
  if (!Number.isFinite(v)) return '$0.00'
  if (v < 0) return '-' + money(-v, compact)
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + 'B'
  if (compact && v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e7 ? 1 : 2) + 'M'
  if (compact && v >= 10000) return '$' + (v / 1000).toFixed(v >= 100000 ? 0 : 1) + 'k'
  // decide the format from the rounded amount, so $99.999 reads $100 rather than $100.00
  const cents = Math.round(v * 100) / 100 < 100
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })
}
