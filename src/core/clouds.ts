import type { Category, CompDef, ModelKind, PropDef, Provider } from './catalog'
import type { Quote } from './pricing'
import type { CostBasis, CostLine, PricingModel } from './types'

/**
 * Google Cloud, Azure and the long tail of AWS.
 *
 * Every definition carries a `role`: the id of the canonical component it is
 * equivalent to. Roles are what the advisor, auto-layout and cloud translation
 * reason about, so a Cloud SQL instance is reviewed exactly like an RDS one.
 */

const HOURS = 730
const opts = (...v: (string | [string, string])[]) =>
  v.map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: o[0], label: o[1] }))
const num = (key: string, label: string, def: number, unit?: string, extra: Partial<PropDef> = {}): PropDef =>
  ({ key, label, type: 'number', default: def, unit, min: 0, ...extra })
const sel = (key: string, label: string, def: string, o: { value: string; label: string }[]): PropDef =>
  ({ key, label, type: 'select', default: def, options: o })
const tog = (key: string, label: string, def = false): PropDef => ({ key, label, type: 'toggle', default: def })

type Base = Pick<CompDef, 'provider' | 'type' | 'svc' | 'tf'> & Partial<Pick<CompDef, 'tfAlso' | 'color' | 'name'>>
type Raw = Omit<CompDef, 'color'> & { color?: string }

// ---- rich factories for the components people size carefully -----------------
//
// Google Cloud and Azure are priced at their US list rates in every region:
// neither cloud's regional price lists are loaded. Rates marked verified were
// checked on 2026-11-20 against the Compute Engine, Cloud SQL, Cloud Run, Firestore,
// Identity Platform, Pub/Sub, Cloud Tasks and API Gateway pricing pages
// (cloud.google.com, Iowa) and the Azure Retail Prices API (prices.azure.com, East US).
// Everything else is an estimate and is labelled as one.

/** a reserved or committed-use discount, by pricing model */
type Commit = Partial<Record<PricingModel, number>>
const off = (c: Commit | undefined, q: Quote) => c?.[q.model] ?? 0
const commitNote = (c: Commit | undefined, q: Quote, what: string) =>
  q.model === 'ondemand' ? undefined : off(c, q) ? `${what} of ${Math.round(off(c, q) * 100)}% applied.` : 'No commitment price is verified for this, so it stays on-demand.'

/** hourly price: Linux, or [Linux, Windows] where the Windows price is published */
type Machines = Record<string, number | [number, number]>
interface VmOpts { disk: number; diskName: string; diskVerified?: boolean; attr: string; commit?: (machine: string) => Commit | undefined; commitName: string; windows?: string }

const vm = (b: Base, machines: Machines, dflt: string, o: VmOpts): Raw => ({
  name: 'Virtual machine', category: 'compute', model: 'tower', glyph: 'server', tier: 3, role: 'ec2', keywords: 'instance server vm', ...b,
  props: [
    sel('machine', 'Machine type', dflt, opts(...Object.keys(machines))),
    sel('os', 'Platform', 'linux', opts(['linux', 'Linux'], ['windows', 'Windows'])),
    num('count', 'Instances', 1, undefined, { min: 1, max: 500 }),
    num('disk', 'Boot disk', 30, 'GB'),
  ],
  cost: (p, q) => {
    const m = machines[p.machine], linux = Array.isArray(m) ? m[0] : m ?? 0.1, win = Array.isArray(m) ? m[1] : undefined
    const windows = p.os === 'windows'
    const c = windows ? undefined : o.commit?.(p.machine)
    // a Windows price that is not published is the Linux price plus the licence, which is an estimate
    const hourly = windows ? win ?? linux * 1.48 : linux
    return [
      { label: `${p.count} × ${p.machine}${windows ? ' (Windows)' : ''}`, monthly: hourly * (1 - off(c, q)) * HOURS * p.count, basis: (windows && win === undefined) || m === undefined ? 'estimate' : 'fixed',
        note: [windows && win === undefined ? o.windows ?? 'Windows licence estimated at 48% over the Linux price.' : '', windows && q.model !== 'ondemand' ? 'Windows is shown on-demand.' : windows ? '' : commitNote(c, q, o.commitName)].filter(Boolean).join(' ') || undefined },
      { label: `${p.disk * p.count} GB ${o.diskName}`, monthly: p.disk * p.count * o.disk, basis: o.diskVerified ? 'fixed' : 'estimate' },
    ]
  },
  summary: (p) => `${p.count > 1 ? p.count + ' × ' : ''}${p.machine}`,
  tfAttrs: (p) => [p.count > 1 && `count = ${p.count}`, `${o.attr} = "${p.machine}"`],
})

const fn = (b: Base, reqRate: number, gbsRate: number, o: { meter: string; gbsVerified?: boolean; note?: string }): Raw => ({
  name: 'Function', category: 'compute', model: 'tile', glyph: 'lambda', tier: 3, role: 'lambda', keywords: 'serverless faas', ...b,
  props: [
    num('requests', 'Invocations', 5, 'M / mo', { step: 0.5 }),
    num('duration', 'Avg duration', 120, 'ms', { step: 10 }),
    sel('memory', 'Memory', '512', opts(['256', '256 MB'], ['512', '512 MB'], ['1024', '1 GB'], ['2048', '2 GB'], ['4096', '4 GB'], ['8192', '8 GB'])),
  ],
  // list price for this function alone: the monthly free grant belongs to the account, so it is taken off once for the whole blueprint
  cost: (p) => {
    const gbs = p.requests * 1e6 * (p.duration / 1000) * (Number(p.memory) / 1024)
    return [
      { label: `${p.requests}M invocations`, monthly: p.requests * reqRate, basis: 'usage', meter: { key: o.meter + '.req', qty: p.requests * 1e6, rate: reqRate / 1e6 } },
      { label: `${Math.round(gbs).toLocaleString()} GB-seconds`, monthly: gbs * gbsRate, basis: o.gbsVerified ? 'usage' : 'estimate', note: o.note, meter: { key: o.meter + '.gbs', qty: gbs, rate: gbsRate } },
    ]
  },
  summary: (p) => `${p.memory} MB · ${p.requests}M/mo`,
})

const containers = (b: Base, vcpuH: number, gbH: number, unit: string): Raw => ({
  name: 'Container service', category: 'compute', model: 'cluster', glyph: 'container', tier: 3, role: 'ecs', keywords: 'docker serverless containers', ...b,
  props: [
    num('tasks', unit, 3, undefined, { min: 1 }),
    sel('vcpu', 'vCPU each', '1', opts('0.25', '0.5', '1', '2', '4')),
    sel('mem', 'Memory each', '2', opts(['0.5', '0.5 GB'], ['1', '1 GB'], ['2', '2 GB'], ['4', '4 GB'], ['8', '8 GB'], ['16', '16 GB'])),
  ],
  cost: (p) => [{
    label: `${p.tasks} × ${p.vcpu} vCPU / ${p.mem} GB`,
    monthly: p.tasks * (Number(p.vcpu) * vcpuH + Number(p.mem) * gbH) * HOURS, basis: 'estimate',
    note: 'Assumes every instance runs all month. Indicative rate, not checked against the current price list.',
  }],
  summary: (p) => `${p.tasks} × ${p.vcpu} vCPU`,
})

const k8s = (b: Base, machines: Machines, dflt: string, o: { plane: CostLine; commit?: (machine: string) => Commit | undefined; commitName: string }): Raw => ({
  name: 'Kubernetes cluster', category: 'compute', model: 'cluster', glyph: 'wheel', tier: 3, role: 'eks', color: '#5B6CF0', keywords: 'k8s kubernetes', ...b,
  props: [
    num('nodes', 'Worker nodes', 3, undefined, { min: 0 }),
    sel('machine', 'Node type', dflt, opts(...Object.keys(machines))),
  ],
  cost: (p, q) => {
    const m = machines[p.machine], hourly = Array.isArray(m) ? m[0] : m ?? 0.1, c = o.commit?.(p.machine)
    return [
      o.plane,
      { label: `${p.nodes} × ${p.machine}`, monthly: hourly * (1 - off(c, q)) * HOURS * p.nodes, basis: m === undefined ? 'estimate' : 'fixed', note: commitNote(c, q, o.commitName) },
    ]
  },
  summary: (p) => `${p.nodes} × ${p.machine}`,
})

interface SqlOpts { storage: number; storageVerified?: boolean; ha: string; attr: string; commit?: Commit; commitName: string }
/** tiers: [id, label, USD per hour, verified]; engines: [id, label, multiplier on the tier price, verified] */
const sql = (b: Base, tiers: [string, string, number, boolean?][], dflt: string, engines: [string, string, number, boolean?][], o: SqlOpts): Raw => ({
  name: 'Relational database', category: 'database', model: 'cylinder', glyph: 'db', tier: 6, role: 'rds', keywords: 'postgres mysql sql', ...b,
  props: [
    sel('engine', 'Engine', engines[0][0], opts(...engines.map((e) => [e[0], e[1]] as [string, string]))),
    sel('tier', 'Tier', dflt, opts(...tiers.map((t) => [t[0], t[1]] as [string, string]))),
    tog('multiAZ', o.ha, false),
    num('replicas', 'Read replicas', 0, undefined, { max: 15 }),
    num('storage', 'Storage', 100, 'GB'),
  ],
  cost: (p, q) => {
    const t = tiers.find((x) => x[0] === p.tier), e = engines.find((x) => x[0] === p.engine)
    const verified = !!t?.[3] && !!e?.[3]
    const c = verified ? o.commit : undefined
    const h = (t?.[2] ?? 0.14) * (e?.[2] ?? 1) * (1 - off(c, q))
    const basis: CostBasis = verified ? 'fixed' : 'estimate'
    const note = [verified ? '' : 'Indicative rate for this tier or engine, not checked against the current price list.', commitNote(c, q, o.commitName)].filter(Boolean).join(' ') || undefined
    const lines: CostLine[] = [
      // high availability runs a second instance and keeps a second copy of the storage
      { label: `${p.tier}${p.multiAZ ? ' (HA)' : ''}`, monthly: h * HOURS * (p.multiAZ ? 2 : 1), basis, note },
      { label: `${p.storage} GB storage${p.multiAZ ? ' (HA)' : ''}`, monthly: p.storage * o.storage * (p.multiAZ ? 2 : 1), basis: o.storageVerified ? 'fixed' : 'estimate' },
    ]
    if (p.replicas > 0) lines.push({ label: `${p.replicas} read replica${p.replicas > 1 ? 's' : ''}`, monthly: h * HOURS * p.replicas, basis, note })
    return lines
  },
  summary: (p) => `${p.engine} · ${p.tier}`,
  tfAttrs: (p) => [o.attr.includes('.') ? `${o.attr.split('.')[0]} {\n    ${o.attr.split('.')[1]} = "${p.tier}"\n  }` : `${o.attr} = "${p.tier}"`],
})

/** classes: [id, label, USD per GB-month, verified] */
const obj = (b: Base, classes: [string, string, number, boolean?][], reqRate: number, egressRate: number, o: { reqVerified?: boolean } = {}): Raw => ({
  name: 'Object storage', category: 'storage', model: 'bucket', glyph: 'bucket', tier: 6, role: 's3', keywords: 'bucket blob files', ...b,
  props: [
    num('storage', 'Storage', 500, 'GB'),
    sel('class', 'Storage class', 'standard', opts(...classes.map((c) => [c[0], c[1]] as [string, string]))),
    num('requests', 'Read requests', 10, 'M / mo'),
    num('egress', 'Data transfer out', 50, 'GB'),
  ],
  cost: (p) => {
    const c = classes.find((x) => x[0] === p.class) ?? classes[0]
    return [
      { label: `${p.storage} GB ${c[1]}`, monthly: p.storage * c[2], basis: c[3] ? 'fixed' : 'estimate' },
      { label: `${p.requests}M read requests`, monthly: p.requests * reqRate, basis: o.reqVerified ? 'usage' : 'estimate' },
      { label: `${p.egress} GB to the internet`, monthly: p.egress * egressRate, basis: 'estimate', note: 'Indicative first-tier internet egress rate. Free monthly egress, where the provider gives any, is not taken off.' },
    ]
  },
  summary: (p) => `${p.storage} GB · ${(classes.find((x) => x[0] === p.class) ?? classes[0])[1]}`,
})

// ---- metered services: one row each ----------------------------------------------

/** [label, unit, default, USD per unit per month, free-allowance key?, how many base units one unit is?] */
type Meter = [string, string, number, number, string?, number?]
interface Extra {
  role?: string; tf?: string; tfAlso?: string[]; color?: string; base?: number; commit?: boolean; dlq?: boolean
  /** the rates were checked against the provider's own price list (see the note at the top of this file) */
  verified?: boolean
  note?: string
}

function svc(provider: Provider, type: string, name: string, service: string, category: Category, model: ModelKind, glyph: string, tier: number, keywords: string, meters: Meter[], x: Extra = {}): Raw {
  const props: PropDef[] = meters.map((m, i) => num('m' + i, m[0], m[2], m[1] || undefined))
  if (x.dlq) props.push(tog('dlq', 'Dead-letter queue', false))
  const fmt = (v: number, unit: string) => `${Number(v).toLocaleString()}${unit ? ' ' + unit.replace(' / mo', '/mo') : ''}`
  // a meter counted per month is usage the user entered; anything else is capacity that is simply there
  const basisOf = (unit: string): CostBasis => (!x.verified ? 'estimate' : unit.includes('/ mo') || /MAU/.test(unit) ? 'usage' : 'fixed')
  const note = x.note ?? (x.verified ? undefined : 'Indicative rate, not checked against the current price list.')
  return {
    provider, type, name, svc: service, category, model, glyph, tier, keywords, props,
    role: x.role, tf: x.tf, tfAlso: x.tfAlso, color: x.color,
    cost: (p) => {
      const lines: CostLine[] = x.base ? [{ label: 'Base fee', monthly: x.base, basis: x.verified ? 'fixed' : 'estimate', note }] : []
      meters.forEach((m, i) => {
        const qty = Number(p['m' + i])
        lines.push({ label: `${fmt(qty, m[1])} ${/[A-Z0-9]/.test(m[0].slice(1)) ? m[0] : m[0].toLowerCase()}`, monthly: qty * m[3], basis: basisOf(m[1]), note, ...(m[4] ? { meter: { key: m[4], qty: qty * (m[5] ?? 1), rate: m[3] / (m[5] ?? 1) } } : {}) })
      })
      return lines
    },
    summary: meters.length ? (p) => fmt(p.m0, meters[0][1]) : () => (x.base ? 'Flat rate' : 'No direct charge'),
  }
}

const M = ' / mo'

// ---- AWS: the long tail ----------------------------------------------------------

const AWS: Raw[] = [
  svc('aws', 'apprunner', 'Web app platform', 'App Runner', 'compute', 'tile', 'window', 3, 'paas beanstalk web app', [['Instances', '', 2, 51], ['Requests', 'M' + M, 5, 0]], { role: 'paas', tf: 'aws_apprunner_service', tfAlso: ['aws_elastic_beanstalk_environment'], commit: true }),
  svc('aws', 'batch', 'Batch compute', 'AWS Batch', 'compute', 'rack', 'cpu', 3, 'jobs hpc', [['vCPU hours', 'h' + M, 2000, 0.04]], { role: 'batch', tf: 'aws_batch_compute_environment', color: '#D97A2B' }),
  svc('aws', 'docdb', 'Document database', 'DocumentDB', 'database', 'cylinder', 'doc', 6, 'mongodb mongo json', [['Instances', '', 3, 202], ['Storage', 'GB', 100, 0.1]], { role: 'docdb', tf: 'aws_docdb_cluster', commit: true, color: '#4668E0' }),
  svc('aws', 'neptune', 'Graph database', 'Neptune', 'database', 'cylinder', 'graph', 6, 'graph gremlin sparql', [['Instances', '', 2, 254], ['Storage', 'GB', 50, 0.1]], { role: 'graphdb', tf: 'aws_neptune_cluster', commit: true, color: '#5A58D6' }),
  svc('aws', 'timestream', 'Time-series database', 'Timestream', 'database', 'stack', 'clock', 6, 'metrics iot time series', [['Writes', 'M' + M, 50, 0.5], ['Storage', 'GB', 100, 0.03]], { role: 'tsdb', tf: 'aws_timestreamwrite_database', color: '#3F8CE8' }),
  svc('aws', 'glacier', 'Archive storage', 'S3 Glacier', 'storage', 'bucket', 'archive', 7, 'cold archive vault', [['Storage', 'GB', 5000, 0.0036]], { role: 'archive', tf: 'aws_glacier_vault', color: '#2E9C8B' }),
  svc('aws', 'backup', 'Backup vault', 'AWS Backup', 'storage', 'slab', 'archive', 8, 'snapshot restore dr', [['Protected data', 'GB', 500, 0.05]], { role: 'backup', tf: 'aws_backup_vault', color: '#48A86C' }),
  svc('aws', 'vpn', 'VPN gateway', 'Site-to-Site VPN', 'network', 'gate', 'link', 1, 'ipsec tunnel hybrid', [['Connections', '', 1, 36.5], ['Data out', 'GB', 100, 0.09]], { role: 'vpn', tf: 'aws_vpn_gateway', tfAlso: ['aws_vpn_connection'], color: '#7F86EE' }),
  svc('aws', 'dx', 'Dedicated link', 'Direct Connect', 'network', 'gate', 'link', 1, 'private line hybrid fiber', [['1 Gbps ports', '', 1, 219], ['Data out', 'GB', 500, 0.02]], { role: 'interconnect', tf: 'aws_dx_connection', color: '#6E74D8' }),
  svc('aws', 'tgw', 'Network hub', 'Transit Gateway', 'network', 'disc', 'hub', 2, 'transit hub spoke peering', [['Attachments', '', 3, 36.5], ['Data processed', 'GB', 500, 0.02]], { role: 'nethub', tf: 'aws_ec2_transit_gateway', color: '#9A7CF0' }),
  svc('aws', 'privatelink', 'Private endpoint', 'PrivateLink', 'network', 'tile', 'lock', 4, 'vpc endpoint private', [['Endpoints', '', 2, 7.3], ['Data processed', 'GB', 200, 0.01]], { role: 'privatelink', tf: 'aws_vpc_endpoint', color: '#8478E6' }),
  svc('aws', 'appsync', 'GraphQL API', 'AppSync', 'network', 'gate', 'graph', 2, 'graphql realtime subscriptions', [['Operations', 'M' + M, 10, 4]], { role: 'graphql', tf: 'aws_appsync_graphql_api', color: '#B565E0' }),
  svc('aws', 'stepfn', 'Workflow', 'Step Functions', 'messaging', 'tile', 'flow', 4, 'state machine orchestration saga', [['State transitions', 'M' + M, 2, 25]], { role: 'workflow', tf: 'aws_sfn_state_machine', color: '#E0559A' }),
  svc('aws', 'ses', 'Email service', 'SES', 'messaging', 'tile', 'mail', 7, 'smtp transactional email', [['Emails', 'k' + M, 500, 0.1]], { role: 'email', tf: 'aws_sesv2_email_identity', tfAlso: ['aws_ses_domain_identity'], color: '#E8708F' }),
  svc('aws', 'iot', 'IoT hub', 'IoT Core', 'messaging', 'disc', 'chip', 2, 'mqtt devices telemetry', [['Messages', 'M' + M, 50, 1], ['Devices', 'k', 10, 3.5]], { role: 'iot', tf: 'aws_iot_topic_rule', tfAlso: ['aws_iot_thing'], color: '#D267B8' }),
  svc('aws', 'msk', 'Kafka cluster', 'MSK', 'analytics', 'rack', 'stream', 4, 'kafka streaming brokers', [['Brokers', '', 3, 153], ['Storage', 'GB', 500, 0.1]], { role: 'kafka', tf: 'aws_msk_cluster', commit: true, color: '#2AA6C2' }),
  svc('aws', 'glue', 'ETL jobs', 'Glue', 'analytics', 'tile', 'flow', 5, 'etl spark crawler catalog', [['DPU hours', 'h' + M, 300, 0.44]], { role: 'etl', tf: 'aws_glue_job', color: '#30A7B6' }),
  svc('aws', 'athena', 'Serverless query', 'Athena', 'analytics', 'tile', 'search', 7, 'sql presto lake query', [['Data scanned', 'TB' + M, 5, 5]], { role: 'query', tf: 'aws_athena_workgroup', color: '#3A9FD0' }),
  svc('aws', 'emr', 'Big-data cluster', 'EMR', 'analytics', 'rack', 'cpu', 7, 'spark hadoop hive', [['Core nodes', '', 4, 180], ['Storage', 'GB', 1000, 0.08]], { role: 'hadoop', tf: 'aws_emr_cluster', commit: true, color: '#2793C8' }),
  svc('aws', 'quicksight', 'BI dashboards', 'QuickSight', 'analytics', 'tile', 'chart', 8, 'bi reports dashboards', [['Authors', '', 5, 24], ['Readers', '', 50, 3]], { role: 'bi', tf: 'aws_quicksight_data_source', color: '#49B5A0' }),
  svc('aws', 'sagemaker', 'ML platform', 'SageMaker', 'ai', 'rack', 'brain', 5, 'machine learning training inference endpoint', [['Endpoint instances', '', 2, 168], ['Training hours', 'h' + M, 40, 1.2]], { role: 'ml', tf: 'aws_sagemaker_endpoint', tfAlso: ['aws_sagemaker_domain', 'aws_sagemaker_notebook_instance'], commit: true }),
  svc('aws', 'bedrock', 'Foundation models', 'Bedrock', 'ai', 'tile', 'spark', 5, 'llm genai claude generative agents', [['Input tokens', 'M' + M, 200, 3], ['Output tokens', 'M' + M, 40, 15]], { role: 'genai', tf: 'aws_bedrockagent_agent', tfAlso: ['aws_bedrock_guardrail'] }),
  svc('aws', 'rekognition', 'Vision AI', 'Rekognition', 'ai', 'tile', 'eye', 5, 'image video ocr labels', [['Images', 'k' + M, 500, 1]], { role: 'vision', tf: 'aws_rekognition_collection', color: '#B26AE8' }),
  svc('aws', 'transcribe', 'Speech AI', 'Transcribe / Polly', 'ai', 'tile', 'wave', 5, 'speech to text voice tts', [['Audio', 'h' + M, 500, 1.44]], { role: 'speech', tf: 'aws_transcribe_vocabulary', color: '#C56BD8' }),
  svc('aws', 'iam', 'Identity & access', 'IAM', 'security', 'tile', 'badge', 8, 'roles policies permissions sso', [], { role: 'iam', tf: 'aws_iam_role', color: '#D9605A' }),
  svc('aws', 'guardduty', 'Threat detection', 'GuardDuty', 'security', 'tile', 'eye', 8, 'siem detection findings security hub', [['Events analysed', 'M' + M, 50, 1.2]], { role: 'threat', tf: 'aws_guardduty_detector', color: '#CF4F64' }),
  svc('aws', 'shield', 'DDoS protection', 'Shield Advanced', 'security', 'gate', 'shield', 1, 'ddos mitigation', [], { role: 'ddos', tf: 'aws_shield_protection', base: 3000, color: '#E0564A' }),
  svc('aws', 'netfw', 'Network firewall', 'Network Firewall', 'security', 'gate', 'wall', 2, 'firewall ids ips egress filtering', [['Endpoints', '', 2, 288], ['Traffic', 'GB', 500, 0.065]], { role: 'firewall', tf: 'aws_networkfirewall_firewall', color: '#E36A45' }),
  svc('aws', 'acm', 'Certificates', 'Certificate Manager', 'security', 'tile', 'lock', 8, 'tls ssl certificate', [['Private CAs', '', 0, 400]], { role: 'certs', tf: 'aws_acm_certificate', color: '#C9584C' }),
  svc('aws', 'ecr', 'Container registry', 'ECR', 'devops', 'stack', 'box', 8, 'docker images registry artifacts', [['Storage', 'GB', 50, 0.1]], { role: 'registry', tf: 'aws_ecr_repository' }),
  svc('aws', 'codepipeline', 'CI/CD pipeline', 'CodePipeline / CodeBuild', 'devops', 'tile', 'git', 8, 'build deploy ci cd release', [['Pipelines', '', 3, 1], ['Build minutes', 'min' + M, 2000, 0.005]], { role: 'cicd', tf: 'aws_codepipeline', tfAlso: ['aws_codebuild_project'] }),
  svc('aws', 'cloudtrail', 'Audit log', 'CloudTrail', 'devops', 'tile', 'doc', 8, 'audit trail compliance api log', [['Data events', 'M' + M, 20, 1]], { role: 'audit', tf: 'aws_cloudtrail', color: '#7E8CA6' }),
  svc('aws', 'xray', 'Tracing', 'X-Ray', 'devops', 'tile', 'wave', 8, 'apm traces distributed tracing', [['Traces', 'M' + M, 10, 5]], { role: 'tracing', tf: 'aws_xray_sampling_rule', color: '#6FA0B8' }),
]

// ---- Google Cloud -------------------------------------------------------------------

// Compute Engine on-demand, Iowa. Verified against cloud.google.com/products/compute/pricing (c3 and g2 not re-checked).
const GCE: Machines = {
  'e2-micro': 0.0084, 'e2-small': 0.0168, 'e2-medium': 0.0335, 'e2-standard-2': 0.067, 'e2-standard-4': 0.134, 'e2-standard-8': 0.268,
  'n2-standard-2': 0.0971, 'n2-standard-4': 0.1942, 'n2-standard-8': 0.3885, 'n2-highmem-4': 0.262, 'c3-standard-4': 0.2088,
  't2a-standard-2': 0.077, 't2a-standard-4': 0.154, 'g2-standard-4': 0.7068,
}
const GCE_CUD = (m: string): Commit | undefined => (/^(e2|n2)-/.test(m) ? { commit1: 0.37, commit3: 0.55 } : undefined)
const G = (type: string, service: string, tf: string, more: Partial<Base> = {}): Base => ({ provider: 'gcp', type: 'gcp-' + type, svc: service, tf, ...more })

const GCP: Raw[] = [
  vm(G('gce', 'Compute Engine', 'google_compute_instance', { tfAlso: ['google_compute_instance_group_manager', 'google_compute_instance_template'] }), GCE, 'e2-standard-2',
    { disk: 0.1, diskName: 'balanced PD', diskVerified: true, attr: 'machine_type', commit: GCE_CUD, commitName: 'Committed-use discount', windows: 'Windows licence estimated at 48% over the Linux price; Google bills it per vCPU.' }),
  fn(G('functions', 'Cloud Run functions', 'google_cloudfunctions2_function', { tfAlso: ['google_cloudfunctions_function'] }), 0.4, 0.0000165,
    { meter: 'gcp.run', note: 'Compute is billed per vCPU-second and per GiB-second; this folds both into one GB-second rate, assuming CPU scales with memory.' }),
  containers(G('run', 'Cloud Run', 'google_cloud_run_v2_service', { tfAlso: ['google_cloud_run_service'] }), 0.0864, 0.009, 'Instances'),
  k8s(G('gke', 'GKE', 'google_container_cluster'), GCE, 'e2-standard-4',
    { plane: { label: 'Cluster management fee', monthly: 0.1 * HOURS, basis: 'fixed', note: 'Each billing account gets a $74.40 monthly credit, enough for one zonal or Autopilot cluster; it is not taken off here.' }, commit: GCE_CUD, commitName: 'Committed-use discount' }),
  svc('gcp', 'gcp-appengine', 'Web app platform', 'App Engine', 'compute', 'tile', 'window', 3, 'paas web app', [['Instances', '', 2, 36.5], ['Requests', 'M' + M, 5, 0]], { role: 'paas', tf: 'google_app_engine_standard_app_version', tfAlso: ['google_app_engine_application'], commit: true }),
  svc('gcp', 'gcp-batch', 'Batch compute', 'Batch', 'compute', 'rack', 'cpu', 3, 'jobs hpc', [['vCPU hours', 'h' + M, 2000, 0.034]], { role: 'batch', tf: 'google_cloud_run_v2_job', color: '#D97A2B' }),
  sql(G('sql', 'Cloud SQL', 'google_sql_database_instance'),
    // Enterprise edition, Iowa: $0.0413 per vCPU-hour and $0.007 per GiB-hour (cloud.google.com/sql/pricing)
    [['db-f1-micro', 'db-f1-micro', 0.0105], ['db-custom-1-3840', '1 vCPU · 3.75 GB', 0.06755, true], ['db-custom-2-7680', '2 vCPU · 7.5 GB', 0.1351, true], ['db-custom-4-15360', '4 vCPU · 15 GB', 0.2702, true], ['db-custom-8-30720', '8 vCPU · 30 GB', 0.5404, true], ['db-custom-16-61440', '16 vCPU · 60 GB', 1.0808, true]],
    'db-custom-2-7680', [['postgres', 'PostgreSQL', 1, true], ['mysql', 'MySQL', 1, true], ['sqlserver', 'SQL Server', 1.9]],
    { storage: 0.17, ha: 'High availability', attr: 'settings.tier', commit: { commit1: 0.25, commit3: 0.52 }, commitName: 'Committed-use discount' }),
  svc('gcp', 'gcp-alloydb', 'PostgreSQL cluster', 'AlloyDB', 'database', 'cylinder', 'db', 6, 'postgres htap aurora', [['vCPUs', '', 4, 48.3], ['Storage', 'GB', 100, 0.3]], { role: 'aurora', tf: 'google_alloydb_cluster', commit: true, color: '#4668E0' }),
  svc('gcp', 'gcp-spanner', 'Global SQL database', 'Spanner', 'database', 'rack', 'globe', 6, 'newsql distributed global consistent', [['Processing units', '×100', 10, 65.7], ['Storage', 'GB', 100, 0.3]], { role: 'newsql', tf: 'google_spanner_instance', commit: true, color: '#3F6FE6' }),
  svc('gcp', 'gcp-firestore', 'NoSQL document store', 'Firestore', 'database', 'stack', 'table', 6, 'document nosql datastore', [['Reads', 'M' + M, 20, 0.3, 'gcp.firestore.read', 1e6], ['Writes', 'M' + M, 5, 0.9, 'gcp.firestore.write', 1e6], ['Storage', 'GB', 25, 0.15, 'gcp.firestore.storage']], { role: 'dynamodb', tf: 'google_firestore_database', verified: true }),
  svc('gcp', 'gcp-bigtable', 'Wide-column store', 'Bigtable', 'database', 'rack', 'table', 6, 'hbase wide column time series', [['Nodes', '', 3, 474.5], ['SSD storage', 'GB', 500, 0.17]], { role: 'tsdb', tf: 'google_bigtable_instance', commit: true, color: '#3F8CE8' }),
  svc('gcp', 'gcp-memorystore', 'In-memory cache', 'Memorystore', 'database', 'slab', 'bolt', 5, 'redis valkey memcached cache', [['Capacity', 'GB', 5, 35.8]], { role: 'elasticache', tf: 'google_redis_instance', tfAlso: ['google_memcache_instance'], commit: true, color: '#3D9BF0' }),
  obj(G('gcs', 'Cloud Storage', 'google_storage_bucket'), [['standard', 'Standard', 0.02], ['infrequent-access', 'Nearline', 0.01], ['glacier-instant', 'Coldline', 0.004], ['deep-archive', 'Archive', 0.0012]], 0.4, 0.12),
  svc('gcp', 'gcp-pd', 'Block volume', 'Persistent Disk', 'storage', 'slab', 'disk', 6, 'disk volume ssd', [['Balanced PD', 'GB', 200, 0.1]], { role: 'ebs', tf: 'google_compute_disk', color: '#35A89A' }),
  svc('gcp', 'gcp-filestore', 'File system', 'Filestore', 'storage', 'stack', 'folder', 6, 'nfs shared files', [['Capacity', 'GB', 1024, 0.2]], { role: 'efs', tf: 'google_filestore_instance', color: '#5BBF5A' }),
  svc('gcp', 'gcp-backup', 'Backup vault', 'Backup and DR', 'storage', 'slab', 'archive', 8, 'snapshot restore dr', [['Protected data', 'GB', 500, 0.05]], { role: 'backup', tf: 'google_backup_dr_backup_vault', color: '#48A86C' }),
  svc('gcp', 'gcp-lb', 'Load balancer', 'Cloud Load Balancing', 'network', 'slab', 'balance', 2, 'alb https global balancer', [['Forwarding rules', '', 1, 18.25], ['Data processed', 'GB', 500, 0.008]], { role: 'alb', tf: 'google_compute_backend_service', tfAlso: ['google_compute_global_forwarding_rule', 'google_compute_forwarding_rule', 'google_compute_url_map'] }),
  svc('gcp', 'gcp-cdn', 'CDN', 'Cloud CDN', 'network', 'disc', 'globe', 1, 'edge cache', [['Data transfer', 'GB' + M, 500, 0.08], ['Requests', 'M' + M, 20, 0.75]], { role: 'cloudfront', tf: 'google_compute_backend_bucket' }),
  svc('gcp', 'gcp-dns', 'DNS', 'Cloud DNS', 'network', 'disc', 'compass', 0, 'domain zone', [['Managed zones', '', 1, 0.2], ['Queries', 'M' + M, 10, 0.4]], { role: 'route53', tf: 'google_dns_managed_zone', color: '#A367E8' }),
  svc('gcp', 'gcp-apigw', 'API gateway', 'API Gateway / Apigee', 'network', 'gate', 'code', 2, 'rest http api apigee', [['Requests', 'M' + M, 10, 3, 'gcp.apigw', 1e6]], { role: 'apigw', verified: true, tf: 'google_api_gateway_gateway', tfAlso: ['google_api_gateway_api', 'google_apigee_organization'] }),
  svc('gcp', 'gcp-nat', 'NAT gateway', 'Cloud NAT', 'network', 'gate', 'swap', 4, 'egress outbound', [['Data processed', 'GB' + M, 200, 0.045]], { role: 'nat', tf: 'google_compute_router_nat', base: 32, color: '#7C7FE8' }),
  svc('gcp', 'gcp-vpn', 'VPN gateway', 'Cloud VPN', 'network', 'gate', 'link', 1, 'ipsec tunnel hybrid', [['Tunnels', '', 2, 36.5], ['Data out', 'GB', 100, 0.12]], { role: 'vpn', tf: 'google_compute_ha_vpn_gateway', tfAlso: ['google_compute_vpn_tunnel'], color: '#7F86EE' }),
  svc('gcp', 'gcp-interconnect', 'Dedicated link', 'Cloud Interconnect', 'network', 'gate', 'link', 1, 'private line hybrid fiber', [['10 Gbps circuits', '', 1, 1700], ['Data out', 'GB', 500, 0.02]], { role: 'interconnect', tf: 'google_compute_interconnect_attachment', color: '#6E74D8' }),
  svc('gcp', 'gcp-ncc', 'Network hub', 'Network Connectivity Center', 'network', 'disc', 'hub', 2, 'transit hub spoke peering', [['Spokes', '', 3, 36.5], ['Data processed', 'GB', 500, 0.02]], { role: 'nethub', tf: 'google_network_connectivity_hub', color: '#9A7CF0' }),
  svc('gcp', 'gcp-psc', 'Private endpoint', 'Private Service Connect', 'network', 'tile', 'lock', 4, 'private endpoint', [['Endpoints', '', 2, 7.3], ['Data processed', 'GB', 200, 0.01]], { role: 'privatelink', tf: 'google_compute_service_attachment', color: '#8478E6' }),
  svc('gcp', 'gcp-pubsub', 'Pub/sub topic', 'Pub/Sub', 'messaging', 'slab', 'broadcast', 4, 'topic subscription fanout messaging', [['Throughput', 'GB' + M, 50, 0.039, 'gcp.pubsub']], { role: 'sns', verified: true, tf: 'google_pubsub_topic', color: '#EA6F8B' }),
  svc('gcp', 'gcp-tasks', 'Queue', 'Cloud Tasks', 'messaging', 'stack', 'queue', 4, 'task queue', [['Operations', 'M' + M, 10, 0.4, 'gcp.tasks', 1e6]], { role: 'sqs', verified: true, tf: 'google_cloud_tasks_queue', dlq: true }),
  svc('gcp', 'gcp-eventarc', 'Event bus', 'Eventarc', 'messaging', 'tile', 'hub', 4, 'events triggers', [['Events', 'M' + M, 5, 1]], { role: 'eventbridge', tf: 'google_eventarc_trigger', color: '#D858C8' }),
  svc('gcp', 'gcp-workflows', 'Workflow', 'Workflows', 'messaging', 'tile', 'flow', 4, 'orchestration steps', [['Steps', 'M' + M, 2, 10]], { role: 'workflow', tf: 'google_workflows_workflow', color: '#E0559A' }),
  svc('gcp', 'gcp-scheduler', 'Scheduler', 'Cloud Scheduler', 'messaging', 'tile', 'clock', 4, 'cron schedule jobs', [['Jobs', '', 10, 0.1]], { role: 'scheduler', tf: 'google_cloud_scheduler_job', color: '#D66AA8' }),
  svc('gcp', 'gcp-dataflow', 'Stream processing', 'Dataflow', 'analytics', 'slab', 'stream', 4, 'beam streaming pipeline', [['Worker vCPU hours', 'h' + M, 1500, 0.069], ['Data processed', 'GB', 500, 0.011]], { role: 'kinesis', tf: 'google_dataflow_job', tfAlso: ['google_dataflow_flex_template_job'] }),
  svc('gcp', 'gcp-bigquery', 'Data warehouse', 'BigQuery', 'analytics', 'rack', 'warehouse', 7, 'olap warehouse sql analytics', [['Queries', 'TB' + M, 20, 6.25], ['Storage', 'GB', 2000, 0.02]], { role: 'redshift', tf: 'google_bigquery_dataset', tfAlso: ['google_bigquery_table'], color: '#2F8FD8' }),
  svc('gcp', 'gcp-dataproc', 'Big-data cluster', 'Dataproc', 'analytics', 'rack', 'cpu', 7, 'spark hadoop hive', [['Worker nodes', '', 4, 155], ['Storage', 'GB', 1000, 0.04]], { role: 'hadoop', tf: 'google_dataproc_cluster', commit: true, color: '#2793C8' }),
  svc('gcp', 'gcp-datafusion', 'ETL pipelines', 'Data Fusion', 'analytics', 'tile', 'flow', 5, 'etl pipelines integration', [['Instance hours', 'h' + M, 730, 1.8]], { role: 'etl', tf: 'google_data_fusion_instance', color: '#30A7B6' }),
  svc('gcp', 'gcp-composer', 'Workflow scheduler', 'Cloud Composer', 'analytics', 'tile', 'clock', 5, 'airflow dag orchestration', [['Environments', '', 1, 380]], { role: 'airflow', tf: 'google_composer_environment', color: '#3A9FD0' }),
  svc('gcp', 'gcp-search', 'Search service', 'Vertex AI Search', 'analytics', 'cylinder', 'search', 6, 'search index vector elasticsearch', [['Queries', 'k' + M, 100, 1.5], ['Index storage', 'GB', 50, 5]], { role: 'opensearch', tf: 'google_discovery_engine_search_engine', color: '#22A9B8' }),
  svc('gcp', 'gcp-looker', 'BI dashboards', 'Looker', 'analytics', 'tile', 'chart', 8, 'bi reports dashboards', [['Users', '', 20, 60]], { role: 'bi', tf: 'google_looker_instance', color: '#49B5A0' }),
  svc('gcp', 'gcp-monitoring', 'Monitoring', 'Cloud Monitoring / Logging', 'analytics', 'tile', 'chart', 8, 'logs metrics alerts observability', [['Log ingestion', 'GB' + M, 50, 0.5], ['Metrics', 'MiB' + M, 500, 0.258]], { role: 'cloudwatch', tf: 'google_monitoring_dashboard', color: '#4FB8A8' }),
  svc('gcp', 'gcp-vertex', 'ML platform', 'Vertex AI', 'ai', 'rack', 'brain', 5, 'machine learning training prediction endpoint', [['Endpoint nodes', '', 2, 160], ['Training hours', 'h' + M, 40, 1.1]], { role: 'ml', tf: 'google_vertex_ai_endpoint', commit: true }),
  svc('gcp', 'gcp-gemini', 'Foundation models', 'Gemini on Vertex AI', 'ai', 'tile', 'spark', 5, 'llm genai generative gemini agents', [['Input tokens', 'M' + M, 200, 1.25], ['Output tokens', 'M' + M, 40, 10]], { role: 'genai', tf: 'google_vertex_ai_reasoning_engine' }),
  svc('gcp', 'gcp-vision', 'Vision AI', 'Vision AI', 'ai', 'tile', 'eye', 5, 'image ocr labels document ai', [['Images', 'k' + M, 500, 1.5]], { role: 'vision', tf: 'google_document_ai_processor', color: '#B26AE8' }),
  svc('gcp', 'gcp-speech', 'Speech AI', 'Speech-to-Text', 'ai', 'tile', 'wave', 5, 'speech to text voice tts', [['Audio', 'h' + M, 500, 0.96]], { role: 'speech', tf: 'google_speech_recognizer', color: '#C56BD8' }),
  svc('gcp', 'gcp-armor', 'Web firewall', 'Cloud Armor', 'security', 'gate', 'shield', 1, 'waf ddos rules', [['Rules', '', 10, 1], ['Requests', 'M' + M, 20, 0.75]], { role: 'waf', tf: 'google_compute_security_policy', base: 5 }),
  svc('gcp', 'gcp-identity', 'Identity provider', 'Identity Platform', 'security', 'tile', 'user', 2, 'auth login users oauth firebase', [['Monthly active users', 'k MAU', 25, 5.5, 'gcp.identity', 1000]], { role: 'cognito', verified: true, note: 'Priced at the 50,000 to 100,000 user rate; larger pools pay less per user.', tf: 'google_identity_platform_config', color: '#E0705A' }),
  svc('gcp', 'gcp-secrets', 'Secrets & keys', 'Secret Manager / KMS', 'security', 'tile', 'key', 8, 'kms secret key encryption', [['Secrets', '', 12, 0.06], ['Keys', '', 3, 0.06]], { role: 'secrets', tf: 'google_secret_manager_secret', color: '#D4524E' }),
  svc('gcp', 'gcp-iam', 'Identity & access', 'Cloud IAM', 'security', 'tile', 'badge', 8, 'roles policies permissions service account', [], { role: 'iam', color: '#D9605A' }),
  svc('gcp', 'gcp-scc', 'Threat detection', 'Security Command Center', 'security', 'tile', 'eye', 8, 'siem detection findings', [['Protected vCPUs', '', 50, 5]], { role: 'threat', tf: 'google_scc_source', color: '#CF4F64' }),
  svc('gcp', 'gcp-firewall', 'Network firewall', 'Cloud NGFW', 'security', 'gate', 'wall', 2, 'firewall ids ips egress filtering', [['Endpoints', '', 2, 1277], ['Traffic', 'GB', 500, 0.018]], { role: 'firewall', tf: 'google_network_security_firewall_endpoint', color: '#E36A45' }),
  svc('gcp', 'gcp-certs', 'Certificates', 'Certificate Manager', 'security', 'tile', 'lock', 8, 'tls ssl certificate', [['Certificates', '', 5, 0.2]], { role: 'certs', tf: 'google_certificate_manager_certificate', color: '#C9584C' }),
  svc('gcp', 'gcp-registry', 'Container registry', 'Artifact Registry', 'devops', 'stack', 'box', 8, 'docker images registry artifacts', [['Storage', 'GB', 50, 0.1]], { role: 'registry', tf: 'google_artifact_registry_repository' }),
  svc('gcp', 'gcp-build', 'CI/CD pipeline', 'Cloud Build / Deploy', 'devops', 'tile', 'git', 8, 'build deploy ci cd release', [['Build minutes', 'min' + M, 2000, 0.003]], { role: 'cicd', tf: 'google_cloudbuild_trigger', tfAlso: ['google_clouddeploy_delivery_pipeline'] }),
  svc('gcp', 'gcp-audit', 'Audit log', 'Cloud Audit Logs', 'devops', 'tile', 'doc', 8, 'audit trail compliance', [['Data access logs', 'GB' + M, 20, 0.5]], { role: 'audit', tf: 'google_logging_project_sink', color: '#7E8CA6' }),
  svc('gcp', 'gcp-trace', 'Tracing', 'Cloud Trace', 'devops', 'tile', 'wave', 8, 'apm traces distributed tracing', [['Spans', 'M' + M, 50, 0.2]], { role: 'tracing', color: '#6FA0B8' }),
]

// ---- Azure ----------------------------------------------------------------------------

// Linux and Windows pay-as-you-go, East US, from the Azure Retail Prices API (prices.azure.com) on 2026-11-20
const AZVM: Machines = {
  Standard_B1s: [0.0104, 0.014], Standard_B2s: [0.0416, 0.0496], Standard_B2ms: [0.0832, 0.0912], Standard_D2s_v5: [0.096, 0.188], Standard_D4s_v5: [0.192, 0.376], Standard_D8s_v5: [0.384, 0.752],
  Standard_D2ps_v5: 0.077, Standard_D4ps_v5: 0.154, Standard_E4s_v5: [0.252, 0.436], Standard_F4s_v2: [0.169, 0.354], Standard_NC4as_T4_v3: [0.526, 0.71],
}
// reserved instances, effective hourly against pay-as-you-go: 38% and 60% on Dsv5, 41% and 60–62% on Esv5, Dpsv5 and NCasT4 (same API). B- and F-series list none.
const AZ_RI = (m: string): Commit | undefined => (/^Standard_D\d+s_v5$/.test(m) ? { commit1: 0.38, commit3: 0.6 } : /^Standard_(E\d+s_v5|D\d+ps_v5|NC)/.test(m) ? { commit1: 0.41, commit3: 0.6 } : undefined)
const A = (type: string, service: string, tf: string, more: Partial<Base> = {}): Base => ({ provider: 'azure', type: 'az-' + type, svc: service, tf, ...more })

const AZURE: Raw[] = [
  vm(A('vm', 'Virtual Machines', 'azurerm_linux_virtual_machine', { tfAlso: ['azurerm_windows_virtual_machine', 'azurerm_linux_virtual_machine_scale_set', 'azurerm_windows_virtual_machine_scale_set', 'azurerm_virtual_machine'] }), AZVM, 'Standard_D2s_v5',
    { disk: 0.1, diskName: 'Premium SSD', attr: 'size', commit: AZ_RI, commitName: 'Reserved-instance discount', windows: 'Windows is not sold on Arm (Dpsv5) sizes; licence estimated at 48% over the Linux price.' }),
  fn(A('functions', 'Azure Functions', 'azurerm_linux_function_app', { tfAlso: ['azurerm_windows_function_app', 'azurerm_function_app'] }), 0.2, 0.000016, { meter: 'azure.fn', gbsVerified: true }),
  containers(A('containerapps', 'Container Apps', 'azurerm_container_app', { tfAlso: ['azurerm_container_group'] }), 0.0864, 0.0108, 'Replicas'),
  k8s(A('aks', 'AKS', 'azurerm_kubernetes_cluster'), AZVM, 'Standard_D4s_v5',
    { plane: { label: 'Control plane (Standard tier)', monthly: 0.1 * HOURS, basis: 'estimate', note: 'The Free tier has no control-plane charge; the Standard tier, with its uptime SLA, is $0.10 an hour.' }, commit: AZ_RI, commitName: 'Reserved-instance discount' }),
  svc('azure', 'az-appservice', 'Web app platform', 'App Service', 'compute', 'tile', 'window', 3, 'paas web app', [['Instances', '', 2, 69.35], ['Requests', 'M' + M, 5, 0]], { role: 'paas', tf: 'azurerm_linux_web_app', tfAlso: ['azurerm_windows_web_app', 'azurerm_app_service', 'azurerm_static_web_app'], commit: true }),
  svc('azure', 'az-batch', 'Batch compute', 'Azure Batch', 'compute', 'rack', 'cpu', 3, 'jobs hpc', [['vCPU hours', 'h' + M, 2000, 0.048]], { role: 'batch', tf: 'azurerm_batch_account', color: '#D97A2B' }),
  sql(A('sql', 'Azure SQL / PostgreSQL', 'azurerm_postgresql_flexible_server', { tfAlso: ['azurerm_mysql_flexible_server', 'azurerm_mssql_server', 'azurerm_mssql_database', 'azurerm_sql_server'] }),
    // General Purpose Ddsv5 is $0.089 per vCore-hour in East US (Retail Prices API); burstable and memory-optimised tiers were not re-checked
    [['B_Standard_B1ms', 'Burstable B1ms', 0.026], ['B_Standard_B2s', 'Burstable B2s', 0.068], ['GP_Standard_D2ds_v5', 'D2ds v5 · 2 vCPU', 0.178, true], ['GP_Standard_D4ds_v5', 'D4ds v5 · 4 vCPU', 0.356, true], ['GP_Standard_D8ds_v5', 'D8ds v5 · 8 vCPU', 0.712, true], ['MO_Standard_E4ds_v5', 'E4ds v5 · memory', 0.478]],
    'GP_Standard_D2ds_v5', [['postgres', 'PostgreSQL', 1, true], ['mysql', 'MySQL', 1], ['sqlserver', 'Azure SQL', 1.6]],
    { storage: 0.115, ha: 'Zone-redundant HA', attr: 'sku_name', commitName: 'Reserved-capacity discount' }),
  svc('azure', 'az-cosmos', 'NoSQL database', 'Cosmos DB', 'database', 'stack', 'table', 6, 'document nosql global mongo', [['Request units', 'M RU' + M, 100, 0.25], ['Storage', 'GB', 25, 0.25]], { role: 'dynamodb', tf: 'azurerm_cosmosdb_account' }),
  svc('azure', 'az-redis', 'In-memory cache', 'Azure Cache for Redis', 'database', 'slab', 'bolt', 5, 'redis cache', [['Standard C3 caches (6 GB)', '', 1, 328.5]], { role: 'elasticache', tf: 'azurerm_redis_cache', tfAlso: ['azurerm_managed_redis'], verified: true, note: 'Standard tier, C3: a replicated 6 GB cache at $0.45 an hour.', color: '#3D9BF0' }),
  svc('azure', 'az-dataexplorer', 'Time-series database', 'Data Explorer', 'database', 'stack', 'clock', 6, 'kusto logs telemetry time series', [['Engine instances', '', 2, 175], ['Storage', 'GB', 500, 0.02]], { role: 'tsdb', tf: 'azurerm_kusto_cluster', commit: true, color: '#3F8CE8' }),
  obj(A('blob', 'Blob Storage', 'azurerm_storage_account', { tfAlso: ['azurerm_storage_container'] }), [['standard', 'Hot', 0.0208, true], ['infrequent-access', 'Cool', 0.01], ['glacier-instant', 'Cold', 0.0036], ['deep-archive', 'Archive', 0.00099]], 0.4, 0.087, { reqVerified: true }),
  svc('azure', 'az-disk', 'Block volume', 'Managed Disks', 'storage', 'slab', 'disk', 6, 'disk volume ssd', [['Premium SSD', 'GB', 256, 0.15]], { role: 'ebs', tf: 'azurerm_managed_disk', color: '#35A89A' }),
  svc('azure', 'az-files', 'File system', 'Azure Files', 'storage', 'stack', 'folder', 6, 'smb nfs shared files netapp', [['Capacity', 'GB', 500, 0.16]], { role: 'efs', tf: 'azurerm_storage_share', color: '#5BBF5A' }),
  svc('azure', 'az-backup', 'Backup vault', 'Azure Backup', 'storage', 'slab', 'archive', 8, 'snapshot restore dr site recovery', [['Protected data', 'GB', 500, 0.05]], { role: 'backup', tf: 'azurerm_recovery_services_vault', tfAlso: ['azurerm_data_protection_backup_vault'], color: '#48A86C' }),
  svc('azure', 'az-appgw', 'Load balancer', 'Application Gateway', 'network', 'slab', 'balance', 2, 'alb l7 load balancer', [['Gateways', '', 1, 146], ['Capacity units', '', 5, 5.84]], { role: 'alb', verified: true, tf: 'azurerm_application_gateway', tfAlso: ['azurerm_lb'] }),
  svc('azure', 'az-frontdoor', 'CDN', 'Front Door', 'network', 'disc', 'globe', 1, 'edge cache cdn global', [['Data transfer', 'GB' + M, 500, 0.083], ['Requests', 'M' + M, 20, 0.9]], { role: 'cloudfront', tf: 'azurerm_cdn_frontdoor_profile', tfAlso: ['azurerm_cdn_profile', 'azurerm_frontdoor'], base: 35 }),
  svc('azure', 'az-dns', 'DNS', 'Azure DNS', 'network', 'disc', 'compass', 0, 'domain zone traffic manager', [['Zones', '', 1, 0.5], ['Queries', 'M' + M, 10, 0.4]], { role: 'route53', tf: 'azurerm_dns_zone', color: '#A367E8' }),
  svc('azure', 'az-apim', 'API gateway', 'API Management', 'network', 'gate', 'code', 2, 'rest http api', [['Requests', 'M' + M, 10, 3.5]], { role: 'apigw', tf: 'azurerm_api_management' }),
  svc('azure', 'az-nat', 'NAT gateway', 'NAT Gateway', 'network', 'gate', 'swap', 4, 'egress outbound', [['Data processed', 'GB' + M, 200, 0.045]], { role: 'nat', tf: 'azurerm_nat_gateway', base: 32.85, color: '#7C7FE8' }),
  svc('azure', 'az-vpn', 'VPN gateway', 'VPN Gateway', 'network', 'gate', 'link', 1, 'ipsec tunnel hybrid', [['Gateways', '', 1, 138.7], ['Data out', 'GB', 100, 0.087]], { role: 'vpn', tf: 'azurerm_virtual_network_gateway', color: '#7F86EE' }),
  svc('azure', 'az-expressroute', 'Dedicated link', 'ExpressRoute', 'network', 'gate', 'link', 1, 'private line hybrid fiber', [['1 Gbps circuits', '', 1, 436], ['Data out', 'GB', 500, 0.025]], { role: 'interconnect', tf: 'azurerm_express_route_circuit', color: '#6E74D8' }),
  svc('azure', 'az-vwan', 'Network hub', 'Virtual WAN', 'network', 'disc', 'hub', 2, 'transit hub spoke peering', [['Hubs', '', 1, 182.5], ['Data processed', 'GB', 500, 0.02]], { role: 'nethub', tf: 'azurerm_virtual_hub', tfAlso: ['azurerm_virtual_wan'], color: '#9A7CF0' }),
  svc('azure', 'az-privatelink', 'Private endpoint', 'Private Link', 'network', 'tile', 'lock', 4, 'private endpoint', [['Endpoints', '', 2, 7.3], ['Data processed', 'GB', 200, 0.01]], { role: 'privatelink', tf: 'azurerm_private_endpoint', color: '#8478E6' }),
  svc('azure', 'az-servicebus', 'Queue', 'Service Bus', 'messaging', 'stack', 'queue', 4, 'message queue topics', [['Operations', 'M' + M, 10, 0.8]], { role: 'sqs', tf: 'azurerm_servicebus_queue', tfAlso: ['azurerm_servicebus_namespace', 'azurerm_storage_queue'], base: 9.8, dlq: true }),
  svc('azure', 'az-eventgrid', 'Pub/sub topic', 'Event Grid', 'messaging', 'slab', 'broadcast', 4, 'events topic fanout', [['Operations', 'M' + M, 5, 0.6]], { role: 'sns', tf: 'azurerm_eventgrid_topic', tfAlso: ['azurerm_eventgrid_system_topic'], color: '#EA6F8B' }),
  svc('azure', 'az-logicapps', 'Workflow', 'Logic Apps', 'messaging', 'tile', 'flow', 4, 'orchestration integration durable', [['Actions', 'M' + M, 2, 25]], { role: 'workflow', tf: 'azurerm_logic_app_workflow', tfAlso: ['azurerm_logic_app_standard'], color: '#E0559A' }),
  svc('azure', 'az-iothub', 'IoT hub', 'IoT Hub', 'messaging', 'disc', 'chip', 2, 'mqtt devices telemetry', [['S1 units', '', 2, 25]], { role: 'iot', tf: 'azurerm_iothub', color: '#D267B8' }),
  svc('azure', 'az-email', 'Email service', 'Communication Services', 'messaging', 'tile', 'mail', 7, 'email sms transactional', [['Emails', 'k' + M, 500, 0.25]], { role: 'email', tf: 'azurerm_communication_service', color: '#E8708F' }),
  svc('azure', 'az-eventhubs', 'Data stream', 'Event Hubs', 'analytics', 'slab', 'stream', 4, 'streaming kafka ingest', [['Throughput units', '', 4, 21.9], ['Ingress events', 'M' + M, 100, 0.028]], { role: 'kinesis', tf: 'azurerm_eventhub', tfAlso: ['azurerm_eventhub_namespace'] }),
  svc('azure', 'az-synapse', 'Data warehouse', 'Synapse / Fabric', 'analytics', 'rack', 'warehouse', 7, 'olap warehouse sql analytics fabric', [['DWU', '×100', 5, 1102], ['Storage', 'GB', 2000, 0.023]], { role: 'redshift', tf: 'azurerm_synapse_workspace', tfAlso: ['azurerm_synapse_sql_pool', 'azurerm_fabric_capacity'], commit: true, color: '#2F8FD8' }),
  svc('azure', 'az-databricks', 'Big-data cluster', 'Azure Databricks', 'analytics', 'rack', 'cpu', 7, 'spark lakehouse hdinsight', [['DBU', 'k' + M, 5, 400], ['Worker VMs', '', 4, 140]], { role: 'hadoop', tf: 'azurerm_databricks_workspace', tfAlso: ['azurerm_hdinsight_spark_cluster'], color: '#2793C8' }),
  svc('azure', 'az-datafactory', 'ETL pipelines', 'Data Factory', 'analytics', 'tile', 'flow', 5, 'etl pipelines integration', [['Activity runs', 'k' + M, 100, 1], ['Data flow vCore hours', 'h' + M, 300, 0.27]], { role: 'etl', tf: 'azurerm_data_factory', color: '#30A7B6' }),
  svc('azure', 'az-streamanalytics', 'Stream processing', 'Stream Analytics', 'analytics', 'tile', 'stream', 5, 'streaming sql real time', [['Streaming units', '', 3, 80.3]], { role: 'streamproc', tf: 'azurerm_stream_analytics_job', color: '#22A9B8' }),
  svc('azure', 'az-search', 'Search service', 'AI Search', 'analytics', 'cylinder', 'search', 6, 'search index vector cognitive', [['Search units', '', 1, 245]], { role: 'opensearch', tf: 'azurerm_search_service', commit: true, color: '#22A9B8' }),
  svc('azure', 'az-powerbi', 'BI dashboards', 'Power BI', 'analytics', 'tile', 'chart', 8, 'bi reports dashboards', [['Pro users', '', 20, 14]], { role: 'bi', tf: 'azurerm_powerbi_embedded', color: '#49B5A0' }),
  svc('azure', 'az-monitor', 'Monitoring', 'Azure Monitor', 'analytics', 'tile', 'chart', 8, 'logs metrics alerts log analytics', [['Log ingestion', 'GB' + M, 50, 2.3], ['Custom metrics', 'M samples', 50, 0.16]], { role: 'cloudwatch', tf: 'azurerm_log_analytics_workspace', color: '#4FB8A8' }),
  svc('azure', 'az-ml', 'ML platform', 'Azure Machine Learning', 'ai', 'rack', 'brain', 5, 'machine learning training inference endpoint', [['Endpoint instances', '', 2, 175], ['Training hours', 'h' + M, 40, 1.2]], { role: 'ml', tf: 'azurerm_machine_learning_workspace', commit: true }),
  svc('azure', 'az-openai', 'Foundation models', 'Azure OpenAI / AI Foundry', 'ai', 'tile', 'spark', 5, 'llm genai gpt generative agents', [['Input tokens', 'M' + M, 200, 2.5], ['Output tokens', 'M' + M, 40, 10]], { role: 'genai', tf: 'azurerm_cognitive_account', tfAlso: ['azurerm_ai_foundry', 'azurerm_cognitive_deployment'] }),
  svc('azure', 'az-vision', 'Vision AI', 'AI Vision', 'ai', 'tile', 'eye', 5, 'image ocr document intelligence', [['Images', 'k' + M, 500, 1]], { role: 'vision', color: '#B26AE8' }),
  svc('azure', 'az-speech', 'Speech AI', 'AI Speech', 'ai', 'tile', 'wave', 5, 'speech to text voice tts', [['Audio', 'h' + M, 500, 1]], { role: 'speech', color: '#C56BD8' }),
  svc('azure', 'az-waf', 'Web firewall', 'Web Application Firewall', 'security', 'gate', 'shield', 1, 'waf rules', [['Rules', '', 10, 1], ['Requests', 'M' + M, 20, 0.6]], { role: 'waf', tf: 'azurerm_web_application_firewall_policy', tfAlso: ['azurerm_cdn_frontdoor_firewall_policy'], base: 5 }),
  svc('azure', 'az-entra-external', 'Identity provider', 'Entra External ID', 'security', 'tile', 'user', 2, 'auth login users oauth b2c', [['Monthly active users', 'k MAU', 25, 0]], { role: 'cognito', tf: 'azurerm_aadb2c_directory', color: '#E0705A' }),
  svc('azure', 'az-keyvault', 'Secrets & keys', 'Key Vault', 'security', 'tile', 'key', 8, 'kms secret key certificates encryption', [['Operations', '10k' + M, 100, 0.03], ['HSM keys', '', 3, 1]], { role: 'secrets', tf: 'azurerm_key_vault', color: '#D4524E' }),
  svc('azure', 'az-entra', 'Identity & access', 'Microsoft Entra ID', 'security', 'tile', 'badge', 8, 'active directory roles rbac sso managed identity', [['P1 users', '', 0, 6]], { role: 'iam', tf: 'azurerm_user_assigned_identity', color: '#D9605A' }),
  svc('azure', 'az-defender', 'Threat detection', 'Defender for Cloud / Sentinel', 'security', 'tile', 'eye', 8, 'siem detection findings sentinel', [['Protected servers', '', 20, 14.6]], { role: 'threat', tf: 'azurerm_sentinel_log_analytics_workspace_onboarding', tfAlso: ['azurerm_security_center_subscription_pricing'], color: '#CF4F64' }),
  svc('azure', 'az-ddos', 'DDoS protection', 'DDoS Protection', 'security', 'gate', 'shield', 1, 'ddos mitigation', [], { role: 'ddos', tf: 'azurerm_network_ddos_protection_plan', base: 2944, color: '#E0564A' }),
  svc('azure', 'az-firewall', 'Network firewall', 'Azure Firewall', 'security', 'gate', 'wall', 2, 'firewall ids ips egress filtering', [['Firewalls', '', 1, 912.5], ['Traffic', 'GB', 500, 0.016]], { role: 'firewall', tf: 'azurerm_firewall', color: '#E36A45' }),
  svc('azure', 'az-acr', 'Container registry', 'Container Registry', 'devops', 'stack', 'box', 8, 'docker images registry artifacts', [['Registries', '', 1, 20], ['Extra storage', 'GB', 0, 0.1]], { role: 'registry', tf: 'azurerm_container_registry' }),
  svc('azure', 'az-devops', 'CI/CD pipeline', 'Azure Pipelines', 'devops', 'tile', 'git', 8, 'build deploy ci cd release github actions', [['Parallel jobs', '', 2, 40]], { role: 'cicd' }),
  svc('azure', 'az-activitylog', 'Audit log', 'Activity Log', 'devops', 'tile', 'doc', 8, 'audit trail compliance policy', [['Exported logs', 'GB' + M, 20, 0.5]], { role: 'audit', tf: 'azurerm_monitor_diagnostic_setting', color: '#7E8CA6' }),
  svc('azure', 'az-appinsights', 'Tracing', 'Application Insights', 'devops', 'tile', 'wave', 8, 'apm traces distributed tracing', [['Telemetry', 'GB' + M, 20, 2.3]], { role: 'tracing', tf: 'azurerm_application_insights', color: '#6FA0B8' }),
]

export const CLOUD_DEFS: Raw[] = [...AWS, ...GCP, ...AZURE]
