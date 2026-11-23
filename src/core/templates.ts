/**
 * The starter templates, and the small builder they are written with.
 * Each template is a function that draws a blueprint from scratch, so every
 * use gets its own ids. Positions are hand-placed: nothing here runs layout.
 */
import { defaultProps, translateDoc } from './catalog'
import { guessKind, kindInfo } from './links'
import { type AreaKind, type Doc, type EdgeT, emptyDoc, uid } from './types'

/** Builds a blueprint a piece at a time. Positions, and an area's width and depth, are in cells on the ground plane; `n` returns the new component's id for `e` to join. */
export class Builder {
  doc: Doc
  constructor(name: string) {
    this.doc = emptyDoc(name)
  }
  n(type: string, x: number, y: number, name?: string, props: Record<string, any> = {}) {
    const id = uid()
    this.doc.nodes.push({ id, type, x, y, name, props: { ...defaultProps(type), ...props } })
    return id
  }
  e(from: string, to: string, label?: string, o: Partial<EdgeT> = {}) {
    const a = this.doc.nodes.find((n) => n.id === from), b = this.doc.nodes.find((n) => n.id === to)
    // each line says what it is; a style given explicitly for a template still wins
    const kind = a && b ? guessKind(a, b) : undefined, k = kindInfo(kind)
    this.doc.edges.push({ id: uid(), from, to, label, style: k?.style ?? 'solid', arrow: k?.arrow ?? 'end', width: 2, kind, origin: 'drawn', ...o })
  }
  area(kind: AreaKind, name: string, x: number, y: number, w: number, d: number, color: string) {
    this.doc.areas.push({ id: uid(), kind, name, x, y, w, d, color })
  }
  label(text: string, x: number, y: number, size = 22, dir: 'x' | 'y' = 'x') {
    this.doc.labels.push({ id: uid(), text, x, y, size, dir })
  }
}

export const AREA_COLORS = { vpc: '#8F6FF2', public: '#3DB87F', private: '#4F7FF2', data: '#E8A33D', group: '#8792A8' }

function threeTier() {
  const b = new Builder('Three-tier web application')
  const users = b.n('users', -13, 3, 'Customers')
  const dns = b.n('route53', -13, -2, 'example.com')
  const cdn = b.n('cloudfront', -8, 3, 'Edge CDN')
  const assets = b.n('s3', -8, 8, 'static-assets', { storage: 120 })
  const lb = b.n('alb', 0, 3, 'public-alb')
  const nat = b.n('nat', 0, 8, 'nat-a')
  const webA = b.n('ec2', 6, 1, 'web-a', { family: 'm5', size: 'large', count: 2 })
  const webB = b.n('ec2', 6, 7, 'web-b', { family: 'm5', size: 'large', count: 2 })
  const db = b.n('rds', 12, 1, 'orders-db', { family: 'r5', size: 'xlarge', storage: 400 })
  const cache = b.n('elasticache', 12, 7, 'session-cache')
  b.n('cloudwatch', 19, 1, 'Observability')
  b.n('secrets', 19, 6, 'App secrets')
  b.area('vpc', 'Production VPC · 10.0.0.0/16', -2.5, -1.5, 19.5, 13.5, AREA_COLORS.vpc)
  b.area('subnet', 'Public', -1, 0, 4, 11, AREA_COLORS.public)
  b.area('subnet', 'App tier', 5, 0, 4, 11, AREA_COLORS.private)
  b.area('subnet', 'Data tier', 11, 0, 4, 11, AREA_COLORS.data)
  b.e(users, dns, 'resolve', { style: 'dashed' })
  b.e(users, cdn, 'HTTPS')
  b.e(cdn, assets, 'static')
  b.e(cdn, lb, 'dynamic')
  b.e(lb, webA)
  b.e(lb, webB)
  b.e(webA, db)
  b.e(webB, db)
  b.e(webA, cache)
  b.e(webB, cache)
  b.e(webB, nat, 'egress', { style: 'dashed' })
  b.label('Three-tier web app', -13, -6.5, 30)
  return b.doc
}

function serverless() {
  const b = new Builder('Serverless API platform')
  const users = b.n('users', -11, 2, 'Web users')
  const mobile = b.n('mobile', -11, 7, 'Mobile app')
  const cdn = b.n('cloudfront', -6, 2, 'CDN')
  const spa = b.n('s3', -6, -3, 'web-app', { storage: 5, requests: 30 })
  const auth = b.n('cognito', -1, 7, 'User pool')
  const api = b.n('apigw', -1, 2, 'Public API', { requests: 40 })
  const fOrders = b.n('lambda', 5, -2, 'orders-fn', { requests: 18 })
  const fUsers = b.n('lambda', 5, 2, 'users-fn', { requests: 14 })
  const fSearch = b.n('lambda', 5, 6, 'search-fn', { requests: 8, memory: '1024', arch: 'x86_64' })
  const tOrders = b.n('dynamodb', 11, -2, 'orders', { reads: 60, writes: 18 })
  const tUsers = b.n('dynamodb', 11, 2, 'users')
  const search = b.n('opensearch', 11, 6, 'catalog-search', { nodes: 2 })
  const bus = b.n('eventbridge', 11, -7, 'domain-events')
  const q = b.n('sqs', 16, -7, 'fulfilment-queue')
  const worker = b.n('lambda', 21, -7, 'fulfilment-fn', { duration: 900, memory: '1024' })
  const sns = b.n('sns', 21, -2, 'notifications')
  const stripe = b.n('saas', 16, 2, 'Payments API', { fee: 0 })
  b.area('group', 'API functions', 4, -3, 4, 11.5, AREA_COLORS.group)
  b.e(users, cdn)
  b.e(cdn, spa, 'SPA')
  b.e(cdn, api, '/api/*')
  b.e(mobile, auth, 'sign-in', { style: 'dashed' })
  b.e(mobile, api)
  b.e(api, auth, 'authorize', { style: 'dashed' })
  b.e(api, fOrders)
  b.e(api, fUsers)
  b.e(api, fSearch)
  b.e(fOrders, tOrders)
  b.e(fUsers, tUsers)
  b.e(fSearch, search)
  b.e(fOrders, bus, 'OrderPlaced')
  b.e(bus, q)
  b.e(q, worker)
  b.e(worker, sns)
  b.e(fUsers, stripe, 'charge', { style: 'dashed' })
  b.label('Serverless API', -11, -7.5, 30)
  return b.doc
}

function dataPlatform() {
  const b = new Builder('Streaming data platform')
  const apps = b.n('mobile', -11, 0, 'Product events')
  const dc = b.n('onprem', -11, 5, 'Legacy ERP')
  const stream = b.n('kinesis', -5, 2, 'ingest-stream', { shards: 8, records: 900 })
  const xform = b.n('lambda', 0, 2, 'enrich-fn', { requests: 90, duration: 60 })
  const hot = b.n('dynamodb', 5, -3, 'realtime-features', { reads: 200, writes: 90 })
  const lake = b.n('s3', 5, 2, 'data-lake', { storage: 42000, class: 'standard', requests: 60, egress: 400 })
  const spark = b.n('eks', 5, 8, 'spark-jobs', { nodes: 6, family: 'r5', size: '2xlarge' })
  const wh = b.n('redshift', 11, 2, 'warehouse', { nodes: 4 })
  const idx = b.n('opensearch', 11, -3, 'log-search')
  const analysts = b.n('users', 17, 2, 'Analysts')
  const mon = b.n('cloudwatch', 0, 8, 'Pipeline metrics')
  b.area('zone', 'Ingest', -6.5, -4.5, 9.5, 16, '#2BB5D4')
  b.area('zone', 'Store & serve', 4, -4.5, 10.5, 16, '#4F7FF2')
  b.e(apps, stream)
  b.e(dc, stream, 'CDC')
  b.e(stream, xform)
  b.e(xform, hot)
  b.e(xform, lake, 'parquet')
  b.e(xform, mon, undefined, { style: 'dotted' })
  b.e(spark, lake, 'batch', { arrow: 'both' })
  b.e(lake, wh, 'COPY')
  b.e(hot, idx, undefined, { style: 'dashed' })
  b.e(analysts, wh, 'SQL')
  b.label('Streaming data platform', -11, -9, 30)
  return b.doc
}

function microservices() {
  const b = new Builder('Kubernetes microservices')
  const users = b.n('users', -14, 2, 'Users')
  const dns = b.n('route53', -14, -3, 'DNS')
  const waf = b.n('waf', -9, 2, 'Edge firewall')
  const lb = b.n('alb', -2, 2, 'ingress-alb', { lcu: 14 })
  const nat = b.n('nat', -2, 8, 'nat')
  const eks = b.n('eks', 4, 2, 'platform-cluster', { nodes: 9, family: 'm6i', size: 'xlarge' })
  const workers = b.n('ecs', 4, 8, 'async-workers', { tasks: 6, vcpu: '1', mem: '2' })
  const db = b.n('rds', 10, -2, 'core-db', { engine: 'aurora', family: 'r7g', size: '2xlarge', multiAZ: true, replicas: 2, storage: 800 })
  const cache = b.n('elasticache', 10, 3, 'redis', { nodes: 3 })
  const q = b.n('sqs', 10, 8, 'jobs', { dlq: true, requests: 80 })
  const s3 = b.n('s3', 17, 8, 'uploads', { storage: 2400 })
  const pay = b.n('saas', 17, -2, 'Payments', { fee: 0 })
  b.n('cloudwatch', 17, 3, 'Telemetry', { logs: 600, metrics: 400 })
  b.area('vpc', 'Platform VPC', -3.5, -3.5, 17.5, 15, AREA_COLORS.vpc)
  b.area('subnet', 'Public subnets', -3, -2.5, 4.5, 13.5, AREA_COLORS.public)
  b.area('subnet', 'Private subnets', 2.5, -2.5, 11, 13.5, AREA_COLORS.private)
  b.e(users, dns, undefined, { style: 'dashed' })
  b.e(users, waf)
  b.e(waf, lb)
  b.e(lb, eks)
  b.e(eks, db)
  b.e(eks, cache)
  b.e(eks, q, 'enqueue')
  b.e(q, workers)
  b.e(workers, s3)
  b.e(workers, nat, undefined, { style: 'dashed' })
  b.e(eks, pay, 'HTTPS', { style: 'dashed' })
  b.label('Microservices on Kubernetes', -14, -8, 30)
  return b.doc
}

/** An AWS template re-homed on another cloud, under a new name. Components with no equivalent there stay as they are. */
const on = (cloud: 'gcp' | 'azure', doc: Doc, name: string): Doc => ({ ...translateDoc(doc, cloud).doc, name })

export interface Template {
  id: string
  name: string
  blurb: string
  tags: string[]
  /** draws the blueprint afresh: a new document with new ids on every call */
  make: () => Doc
}

export const TEMPLATES: Template[] = [
  { id: 'three-tier', name: 'Three-tier web app', blurb: 'CDN, load-balanced VMs, relational DB and cache inside a segmented VPC.', tags: ['VPC', 'EC2', 'RDS'], make: threeTier },
  { id: 'serverless', name: 'Serverless API', blurb: 'API gateway, functions, NoSQL tables and an event-driven fulfilment flow.', tags: ['Lambda', 'DynamoDB', 'Events'], make: serverless },
  { id: 'data', name: 'Streaming data platform', blurb: 'Stream ingest, enrichment, a data lake, a warehouse and batch compute.', tags: ['Kinesis', 'S3', 'Redshift'], make: dataPlatform },
  { id: 'k8s', name: 'Kubernetes microservices', blurb: 'Ingress, a managed cluster, async workers and managed data services.', tags: ['EKS', 'Aurora', 'SQS'], make: microservices },
  { id: 'gcp-serverless', name: 'Serverless API on Google Cloud', blurb: 'The serverless pattern on Cloud Run functions, Firestore, Pub/Sub and Eventarc.', tags: ['GCP', 'Functions', 'Firestore'], make: () => on('gcp', serverless(), 'Serverless API on Google Cloud') },
  { id: 'azure-three-tier', name: 'Three-tier web app on Azure', blurb: 'Front Door, Application Gateway, virtual machines and Azure SQL in a virtual network.', tags: ['Azure', 'VMs', 'SQL'], make: () => on('azure', threeTier(), 'Three-tier web app on Azure') },
]

/** Fresh copy of a template with new ids, so each instantiation is independent. */
export function instantiate(t: Template): Doc {
  return t.make()
}
