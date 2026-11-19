import { CLOUD_DEFS } from './clouds'
import type { CostLine, Doc, NodeT, PricingModel } from './types'

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
  tfAttrs?: (p: Record<string, any>) => (string | false | undefined)[]
  category: Category
  model: ModelKind
  glyph: string
  color: string
  /** rough request-path rank, used by auto-layout and edge direction heuristics */
  tier: number
  props: PropDef[]
  cost?: (p: Record<string, any>) => CostLine[]
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

export const HOURS = 730
const opts = (...v: (string | [string, string])[]) =>
  v.map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: o[0], label: o[1] }))

// ---- price tables (USD, us-east-1 list-price approximations) ---------------

export const EC2_FAMILY: Record<string, { large: number; arm?: boolean; gen: 'current' | 'previous'; upgrade?: string }> = {
  t3: { large: 0.0832, gen: 'current', upgrade: 't4g' },
  t4g: { large: 0.0672, arm: true, gen: 'current' },
  t2: { large: 0.0928, gen: 'previous', upgrade: 't4g' },
  m4: { large: 0.1, gen: 'previous', upgrade: 'm7g' },
  m5: { large: 0.096, gen: 'current', upgrade: 'm7g' },
  m6i: { large: 0.096, gen: 'current', upgrade: 'm7g' },
  m7g: { large: 0.0816, arm: true, gen: 'current' },
  c5: { large: 0.085, gen: 'current', upgrade: 'c7g' },
  c7g: { large: 0.0725, arm: true, gen: 'current' },
  r5: { large: 0.126, gen: 'current', upgrade: 'r7g' },
  r7g: { large: 0.1071, arm: true, gen: 'current' },
  g5: { large: 0.503, gen: 'current' },
}
export const SIZE_MULT: Record<string, number> = {
  nano: 1 / 16, micro: 1 / 8, small: 1 / 4, medium: 1 / 2, large: 1, xlarge: 2, '2xlarge': 4, '4xlarge': 8, '8xlarge': 16,
}
const SIZES = Object.keys(SIZE_MULT)

export const RDS_CLASS: Record<string, { large: number; upgrade?: string }> = {
  't3': { large: 0.145, upgrade: 't4g' },
  't4g': { large: 0.129 },
  'm5': { large: 0.171, upgrade: 'm7g' },
  'm7g': { large: 0.168 },
  'r5': { large: 0.25, upgrade: 'r7g' },
  'r7g': { large: 0.2385 },
}
const RDS_ENGINE: Record<string, number> = { postgres: 1, mysql: 0.96, mariadb: 0.96, aurora: 1.2, sqlserver: 2.1 }

const CACHE_NODE: Record<string, number> = {
  'cache.t4g.micro': 0.016, 'cache.t4g.small': 0.032, 'cache.m7g.large': 0.158, 'cache.r7g.large': 0.219, 'cache.r7g.xlarge': 0.437,
}
const REDSHIFT_NODE: Record<string, number> = { 'dc2.large': 0.25, 'ra3.xlplus': 1.086, 'ra3.4xlarge': 3.26 }
const SEARCH_NODE: Record<string, number> = { 't3.small.search': 0.036, 'm6g.large.search': 0.128, 'r6g.large.search': 0.167, 'r6g.xlarge.search': 0.335 }
const S3_CLASS: Record<string, number> = { standard: 0.023, 'infrequent-access': 0.0125, 'glacier-instant': 0.004, 'deep-archive': 0.00099 }
const EBS_TYPE: Record<string, number> = { gp3: 0.08, io2: 0.125, st1: 0.045, sc1: 0.015 }

export const REGIONS: { id: string; name: string; mult: number; gcp: string; azure: string }[] = [
  { id: 'us-east-1', name: 'US East (N. Virginia)', mult: 1, gcp: 'us-east4', azure: 'eastus' },
  { id: 'us-west-2', name: 'US West (Oregon)', mult: 1, gcp: 'us-west1', azure: 'westus2' },
  { id: 'eu-west-1', name: 'Europe (Ireland)', mult: 1.09, gcp: 'europe-west1', azure: 'northeurope' },
  { id: 'eu-central-1', name: 'Europe (Frankfurt)', mult: 1.15, gcp: 'europe-west3', azure: 'germanywestcentral' },
  { id: 'ap-south-1', name: 'Asia Pacific (Mumbai)', mult: 1.05, gcp: 'asia-south1', azure: 'centralindia' },
  { id: 'ap-southeast-1', name: 'Asia Pacific (Singapore)', mult: 1.2, gcp: 'asia-southeast1', azure: 'southeastasia' },
  { id: 'ap-northeast-1', name: 'Asia Pacific (Tokyo)', mult: 1.24, gcp: 'asia-northeast1', azure: 'japaneast' },
  { id: 'sa-east-1', name: 'South America (São Paulo)', mult: 1.55, gcp: 'southamerica-east1', azure: 'brazilsouth' },
]

export const COMMIT_DISCOUNT: Record<PricingModel, number> = { ondemand: 0, commit1: 0.28, commit3: 0.5 }

const num = (key: string, label: string, def: number, unit?: string, extra: Partial<PropDef> = {}): PropDef =>
  ({ key, label, type: 'number', default: def, unit, min: 0, ...extra })
const sel = (key: string, label: string, def: string, o: { value: string; label: string }[], extra: Partial<PropDef> = {}): PropDef =>
  ({ key, label, type: 'select', default: def, options: o, ...extra })
const tog = (key: string, label: string, def = false): PropDef => ({ key, label, type: 'toggle', default: def })

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
    cost: (p) => {
      const m = SIZE_MULT[p.size] ?? 1
      const hourly = (EC2_FAMILY[p.family]?.large ?? 0.1) * m + (p.os === 'windows' ? 0.092 * m : 0)
      return [
        { label: `${p.count} × ${p.family}.${p.size}`, monthly: hourly * HOURS * p.count, commit: true },
        { label: `${p.disk * p.count} GB gp3`, monthly: p.disk * p.count * 0.08 },
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
    cost: (p) => {
      const gbs = p.requests * 1e6 * (p.duration / 1000) * (Number(p.memory) / 1024)
      return [
        { label: `${p.requests}M requests`, monthly: p.requests * 0.2 },
        { label: `${Math.round(gbs).toLocaleString()} GB-seconds`, monthly: gbs * (p.arch === 'arm64' ? 0.0000133334 : 0.0000166667) },
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
    cost: (p) => [{
      label: `${p.tasks} tasks × ${p.vcpu} vCPU / ${p.mem} GB`,
      monthly: p.tasks * (Number(p.vcpu) * 0.04048 + Number(p.mem) * 0.004445) * HOURS, commit: true,
    }],
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
    cost: (p) => [
      { label: 'Control plane', monthly: 0.1 * HOURS },
      { label: `${p.nodes} × ${p.family}.${p.size}`, monthly: (EC2_FAMILY[p.family]?.large ?? 0.1) * (SIZE_MULT[p.size] ?? 1) * HOURS * p.nodes, commit: true },
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
    cost: (p) => {
      const h = (RDS_CLASS[p.family]?.large ?? 0.17) * (SIZE_MULT[p.size] ?? 1) * (RDS_ENGINE[p.engine] ?? 1)
      const lines: CostLine[] = [
        { label: `db.${p.family}.${p.size}${p.multiAZ ? ' (Multi-AZ)' : ''}`, monthly: h * HOURS * (p.multiAZ ? 2 : 1), commit: true },
        { label: `${p.storage} GB storage`, monthly: p.storage * 0.115 * (p.multiAZ ? 2 : 1) },
      ]
      if (p.replicas > 0) lines.push({ label: `${p.replicas} read replica${p.replicas > 1 ? 's' : ''}`, monthly: h * HOURS * p.replicas, commit: true })
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
    cost: (p) => [
      { label: `${p.reads}M reads`, monthly: p.reads * 0.125 },
      { label: `${p.writes}M writes`, monthly: p.writes * 0.625 },
      { label: `${p.storage} GB`, monthly: p.storage * 0.25 },
    ],
    summary: (p) => `on-demand · ${p.storage} GB`,
  }),
  def({
    type: 'elasticache', name: 'In-memory cache', svc: 'ElastiCache', category: 'database', model: 'slab', glyph: 'bolt', tier: 5, color: '#3D9BF0',
    keywords: 'redis valkey memcached cache',
    props: [
      sel('node', 'Node type', 'cache.m7g.large', opts(...Object.keys(CACHE_NODE))),
      num('nodes', 'Nodes', 2, undefined, { min: 1 }),
    ],
    cost: (p) => [{ label: `${p.nodes} × ${p.node}`, monthly: (CACHE_NODE[p.node] ?? 0.15) * HOURS * p.nodes, commit: true }],
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
    cost: (p) => [
      { label: `${p.storage} GB ${p.class}`, monthly: p.storage * (S3_CLASS[p.class] ?? 0.023) },
      { label: `${p.requests}M requests`, monthly: p.requests * 0.4 },
      { label: `${p.egress} GB egress`, monthly: Math.max(0, p.egress - 100) * 0.09 },
    ],
    summary: (p) => `${p.storage} GB · ${p.class}`,
  }),
  def({
    type: 'ebs', name: 'Block volume', svc: 'EBS', category: 'storage', model: 'slab', glyph: 'disk', tier: 6, color: '#35A89A',
    keywords: 'disk volume ssd',
    props: [
      sel('vol', 'Volume type', 'gp3', opts(...Object.keys(EBS_TYPE))),
      num('size', 'Size', 200, 'GB'),
    ],
    cost: (p) => [{ label: `${p.size} GB ${p.vol}`, monthly: p.size * (EBS_TYPE[p.vol] ?? 0.08) }],
    summary: (p) => `${p.size} GB ${p.vol}`,
  }),
  def({
    type: 'efs', name: 'File system', svc: 'EFS', category: 'storage', model: 'stack', glyph: 'folder', tier: 6, color: '#5BBF5A',
    keywords: 'nfs shared files',
    props: [num('storage', 'Storage', 100, 'GB')],
    cost: (p) => [{ label: `${p.storage} GB standard`, monthly: p.storage * 0.3 }],
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
    cost: (p) => [
      { label: `${p.kind} load balancer`, monthly: 0.0225 * HOURS },
      { label: `${p.lcu} LCU`, monthly: p.lcu * (p.kind === 'network' ? 0.006 : 0.008) * HOURS },
    ],
    summary: (p) => (p.kind === 'network' ? 'Network · L4' : 'Application · L7'),
  }),
  def({
    type: 'cloudfront', name: 'CDN', svc: 'CloudFront', category: 'network', model: 'disc', glyph: 'globe', tier: 1,
    keywords: 'edge cache distribution',
    props: [
      num('transfer', 'Data transfer', 500, 'GB / mo'),
      num('requests', 'Requests', 20, 'M / mo'),
    ],
    cost: (p) => [
      { label: `${p.transfer} GB to internet`, monthly: p.transfer * 0.085 },
      { label: `${p.requests}M HTTPS requests`, monthly: p.requests * 1.0 },
    ],
    summary: (p) => `${p.transfer} GB/mo`,
  }),
  def({
    type: 'route53', name: 'DNS', svc: 'Route 53', category: 'network', model: 'disc', glyph: 'compass', tier: 0, color: '#A367E8',
    keywords: 'domain zone',
    props: [num('zones', 'Hosted zones', 1), num('queries', 'Queries', 10, 'M / mo')],
    cost: (p) => [
      { label: `${p.zones} hosted zone${p.zones === 1 ? '' : 's'}`, monthly: p.zones * 0.5 },
      { label: `${p.queries}M queries`, monthly: p.queries * 0.4 },
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
    cost: (p) => [{ label: `${p.requests}M ${p.kind.toUpperCase()} requests`, monthly: p.requests * (p.kind === 'rest' ? 3.5 : 1.0) }],
    summary: (p) => `${p.kind.toUpperCase()} · ${p.requests}M/mo`,
  }),
  def({
    type: 'nat', name: 'NAT gateway', svc: 'NAT Gateway', category: 'network', model: 'gate', glyph: 'swap', tier: 4, color: '#7C7FE8',
    keywords: 'egress outbound',
    props: [num('data', 'Data processed', 200, 'GB / mo')],
    cost: (p) => [
      { label: 'Gateway hours', monthly: 0.045 * HOURS },
      { label: `${p.data} GB processed`, monthly: p.data * 0.045 },
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
    cost: (p) => [{ label: `${p.requests}M requests`, monthly: Math.max(0, p.requests - 1) * (p.kind === 'fifo' ? 0.5 : 0.4) }],
    summary: (p) => `${p.kind} · ${p.requests}M/mo`,
  }),
  def({
    type: 'sns', name: 'Pub/sub topic', svc: 'SNS', category: 'messaging', model: 'slab', glyph: 'broadcast', tier: 4, color: '#EA6F8B',
    keywords: 'notification topic fanout',
    props: [num('messages', 'Publishes', 5, 'M / mo')],
    cost: (p) => [{ label: `${p.messages}M publishes`, monthly: Math.max(0, p.messages - 1) * 0.5 }],
    summary: (p) => `${p.messages}M/mo`,
  }),
  def({
    type: 'eventbridge', name: 'Event bus', svc: 'EventBridge', category: 'messaging', model: 'tile', glyph: 'hub', tier: 4, color: '#D858C8',
    keywords: 'events rules schedule cron',
    props: [num('events', 'Custom events', 5, 'M / mo')],
    cost: (p) => [{ label: `${p.events}M events`, monthly: p.events * 1.0 }],
    summary: (p) => `${p.events}M/mo`,
  }),
  // ---- analytics
  def({
    type: 'kinesis', name: 'Data stream', svc: 'Kinesis', category: 'analytics', model: 'slab', glyph: 'stream', tier: 4,
    keywords: 'streaming kafka ingest',
    props: [num('shards', 'Shards', 4, undefined, { min: 1 }), num('records', 'PUT records', 100, 'M / mo')],
    cost: (p) => [
      { label: `${p.shards} shard${p.shards === 1 ? '' : 's'}`, monthly: p.shards * 0.015 * HOURS },
      { label: `${p.records}M PUT units`, monthly: p.records * 0.014 },
    ],
    summary: (p) => `${p.shards} shards`,
  }),
  def({
    type: 'redshift', name: 'Data warehouse', svc: 'Redshift', category: 'analytics', model: 'rack', glyph: 'warehouse', tier: 7, color: '#2F8FD8',
    keywords: 'olap warehouse sql analytics',
    props: [
      sel('node', 'Node type', 'ra3.xlplus', opts(...Object.keys(REDSHIFT_NODE))),
      num('nodes', 'Nodes', 2, undefined, { min: 1 }),
    ],
    cost: (p) => [{ label: `${p.nodes} × ${p.node}`, monthly: (REDSHIFT_NODE[p.node] ?? 1) * HOURS * p.nodes, commit: true }],
    summary: (p) => `${p.nodes} × ${p.node}`,
  }),
  def({
    type: 'opensearch', name: 'Search cluster', svc: 'OpenSearch', category: 'analytics', model: 'cylinder', glyph: 'search', tier: 6, color: '#22A9B8',
    keywords: 'elasticsearch logs search',
    props: [
      sel('node', 'Node type', 'm6g.large.search', opts(...Object.keys(SEARCH_NODE))),
      num('nodes', 'Data nodes', 3, undefined, { min: 1 }),
      num('storage', 'Storage / node', 100, 'GB'),
    ],
    cost: (p) => [
      { label: `${p.nodes} × ${p.node}`, monthly: (SEARCH_NODE[p.node] ?? 0.13) * HOURS * p.nodes, commit: true },
      { label: `${p.nodes * p.storage} GB gp3`, monthly: p.nodes * p.storage * 0.122 },
    ],
    summary: (p) => `${p.nodes} × ${String(p.node).replace('.search', '')}`,
  }),
  def({
    type: 'cloudwatch', name: 'Monitoring', svc: 'CloudWatch', category: 'analytics', model: 'tile', glyph: 'chart', tier: 8, color: '#4FB8A8',
    keywords: 'logs metrics alarms observability',
    props: [num('metrics', 'Custom metrics', 50), num('logs', 'Log ingestion', 50, 'GB / mo')],
    cost: (p) => [
      { label: `${p.metrics} metrics`, monthly: p.metrics * 0.3 },
      { label: `${p.logs} GB logs`, monthly: p.logs * 0.5 },
    ],
    summary: (p) => `${p.logs} GB logs/mo`,
  }),
  // ---- security
  def({
    type: 'waf', name: 'Web firewall', svc: 'WAF', category: 'security', model: 'gate', glyph: 'shield', tier: 1,
    keywords: 'firewall acl rules',
    props: [num('rules', 'Rules', 10), num('requests', 'Requests inspected', 20, 'M / mo')],
    cost: (p) => [
      { label: `Web ACL + ${p.rules} rules`, monthly: 5 + p.rules },
      { label: `${p.requests}M requests`, monthly: p.requests * 0.6 },
    ],
    summary: (p) => `${p.rules} rules`,
  }),
  def({
    type: 'cognito', name: 'Identity provider', svc: 'Cognito', category: 'security', model: 'tile', glyph: 'user', tier: 2, color: '#E0705A',
    keywords: 'auth login users oauth',
    props: [num('mau', 'Monthly active users', 25000, 'MAU', { step: 1000 })],
    cost: (p) => [{ label: `${Number(p.mau).toLocaleString()} MAU`, monthly: Math.max(0, p.mau - 10000) * 0.0055 }],
    summary: (p) => `${Number(p.mau).toLocaleString()} MAU`,
  }),
  def({
    type: 'secrets', name: 'Secrets & keys', svc: 'Secrets Manager / KMS', category: 'security', model: 'tile', glyph: 'key', tier: 8, color: '#D4524E',
    keywords: 'kms secret key vault encryption',
    props: [num('secrets', 'Secrets', 12), num('keys', 'Customer keys', 3)],
    cost: (p) => [
      { label: `${p.secrets} secrets`, monthly: p.secrets * 0.4 },
      { label: `${p.keys} KMS keys`, monthly: p.keys * 1 },
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
    cost: (p) => (p.fee > 0 ? [{ label: 'Subscription', monthly: Number(p.fee) }] : []),
  }),
  def({
    type: 'block', name: 'Generic block', svc: 'Custom component', category: 'external', model: 'tower', glyph: 'cube', tier: 3, color: '#566178',
    keywords: 'custom box service',
    props: [num('fee', 'Monthly cost', 0, 'USD')],
    cost: (p) => (p.fee > 0 ? [{ label: 'Custom', monthly: Number(p.fee) }] : []),
  }),
]

for (const d of CLOUD_DEFS) DEFS.push({ ...d, color: d.color ?? CAT[d.category] })
// keep each category together, clouds in a fixed order
const P_ORDER: Record<Provider, number> = { aws: 0, gcp: 1, azure: 2, any: 3 }
DEFS.sort((a, b) => P_ORDER[a.provider] - P_ORDER[b.provider])

export const CATALOG: Record<string, CompDef> = Object.fromEntries(DEFS.map((d) => [d.type, d]))
export const CATALOG_LIST = DEFS
export const FOOT = 2 // every component occupies a 2×2 footprint

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

/** The first-choice component for a role in a given cloud, if that cloud has one. */
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

/** Re-home a blueprint on another cloud, carrying over every setting the two components share. */
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

export function costOf(n: NodeT, region: string, model: PricingModel = 'ondemand'): NodeCost {
  const d = defOf(n.type)
  if (!d.cost) return { lines: [], monthly: 0 }
  const props = { ...defaultProps(n.type), ...n.props }
  const mult = REGIONS.find((r) => r.id === region)?.mult ?? 1
  const disc = 1 - COMMIT_DISCOUNT[model]
  const lines = d
    .cost(props)
    .map((l) => ({ ...l, monthly: l.monthly * mult * (l.commit ? disc : 1) }))
    .filter((l) => l.monthly > 0.0001)
  return { lines, monthly: lines.reduce((s, l) => s + l.monthly, 0) }
}

export function docCost(doc: Doc, model: PricingModel = 'ondemand') {
  const perNode = new Map<string, NodeCost>()
  const byCategory = new Map<Category, number>()
  let total = 0
  for (const n of doc.nodes) {
    const c = costOf(n, doc.region, model)
    perNode.set(n.id, c)
    total += c.monthly
    const cat = defOf(n.type).category
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + c.monthly)
  }
  return { perNode, byCategory, total }
}

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
