/**
 * Terraform in and out.
 *
 * Import is a text scan, not an HCL parser, and nothing in the pasted source
 * is ever evaluated. It reads `resource "type" "name" { ... }` blocks only:
 * modules, data sources, variables, locals and outputs are not looked at.
 * Settings are read from literal values on the attribute's own line: a
 * variable or an expression is not resolved, `for_each` is not expanded and
 * heredocs are not understood, so such a component mostly keeps its defaults.
 * Resource types are looked up with own-key checks, because the source is
 * untrusted and a type may be called `constructor`. Connections are inferred
 * from references between blocks, which says two resources are related, not
 * that traffic flows.
 *
 * Export writes a starting point, not a deployable configuration: it refers to
 * variables, roles and data sources it does not declare, and it writes no
 * connections and no areas other than VPCs. Names are escaped on the way out.
 */
import { CATALOG_LIST, EC2_FAMILY, RDS_CLASS, REGIONS, SIZE_MULT, defOf, defaultProps, nodeName, roleOf } from './catalog'
import { autoLayout } from './layout'
import { type Doc, type NodeT, emptyDoc, uid } from './types'
import { guessKind, kindInfo } from './links'

/** One `resource` block as scanned. */
interface Res {
  /** `type.name`, the form other blocks refer to it by */
  key: string
  type: string
  name: string
  /** the text between the block's braces, comments removed */
  body: string
  /** `key = value` lines anywhere in the body, nested blocks included, values as written (quotes kept). The first of a repeated key wins. */
  attrs: Record<string, string>
  /** every other resource the body mentions as `type.name`, each once, wherever it appears, strings included */
  refs: string[]
}

// Terraform resource type to component type, for the core AWS set; several resource types can import as one component
const TYPE_MAP: Record<string, string> = {
  aws_instance: 'ec2', aws_autoscaling_group: 'ec2', aws_spot_instance_request: 'ec2',
  aws_db_instance: 'rds', aws_rds_cluster: 'rds',
  aws_lambda_function: 'lambda',
  aws_s3_bucket: 's3',
  aws_lb: 'alb', aws_alb: 'alb', aws_elb: 'alb',
  aws_dynamodb_table: 'dynamodb',
  aws_elasticache_cluster: 'elasticache', aws_elasticache_replication_group: 'elasticache',
  aws_sqs_queue: 'sqs', aws_sns_topic: 'sns',
  aws_cloudfront_distribution: 'cloudfront',
  aws_route53_zone: 'route53',
  aws_api_gateway_rest_api: 'apigw', aws_apigatewayv2_api: 'apigw',
  aws_ecs_service: 'ecs', aws_eks_cluster: 'eks',
  aws_nat_gateway: 'nat', aws_internet_gateway: 'igw',
  aws_kinesis_stream: 'kinesis', aws_efs_file_system: 'efs', aws_ebs_volume: 'ebs',
  aws_redshift_cluster: 'redshift', aws_opensearch_domain: 'opensearch', aws_elasticsearch_domain: 'opensearch',
  aws_wafv2_web_acl: 'waf', aws_cognito_user_pool: 'cognito',
  aws_secretsmanager_secret: 'secrets', aws_cloudwatch_event_bus: 'eventbridge',
}
// every other cloud and the AWS long tail declare their Terraform types in the catalog
for (const d of CATALOG_LIST) for (const t of [d.tf, ...(d.tfAlso ?? [])]) if (t && !(t in TYPE_MAP)) TYPE_MAP[t] = d.type

/** Component a Terraform resource type maps to. Own keys only, so a resource called `constructor` is simply unknown. */
const typeFor = (t: string): string | undefined => (Object.hasOwn(TYPE_MAP, t) ? TYPE_MAP[t] : undefined)

// The four ways a resource type is treated. One in TYPE_MAP becomes a component. NETWORK becomes a VPC area.
// STRUCTURAL and IGNORED are dropped without comment (STRUCTURAL ones are still followed to find which
// network a component sits in). Anything else is reported as skipped, and is also treated as a "connector"
// whose references can join two components (a listener, an attachment, a mapping).
const NETWORK = /^(aws_vpc|google_compute_network|azurerm_virtual_network)$/
// resources that describe placement, not traffic
const STRUCTURAL = /^(aws_(subnet|security_group|db_subnet_group|elasticache_subnet_group|route_table|route|network_acl|eip|vpc_)|google_compute_(subnetwork|firewall|router$|route$|address|global_address|network_peering)|google_vpc_access_connector|azurerm_(subnet|network_security_group|network_interface|public_ip|route_table|route$|virtual_network_peering))/
const IGNORED = /^(aws_(iam_|kms_|cloudwatch_log|cloudwatch_metric|acm_certificate_validation|key_pair|ami|s3_bucket_(policy|acl|versioning|public|server|lifecycle|ownership))|google_(project|service_account|kms_|storage_bucket_iam|[a-z0-9_]+_iam_)|azurerm_(resource_group|role_|key_vault_(secret|key|access_policy)|service_plan|storage_account_network_rules|monitor_(metric|action)))/
// a reference to another resource: `aws_lb.web`, with or without an attribute after it
const REF = /\b((?:aws|google|azurerm)_[a-z0-9_]+)\.([A-Za-z_][\w-]*)/

/** Removes block comments, whole-line `#` and `//` comments, and a trailing `#` comment that has no quote after it. A `//` after code on the same line is left in place. */
function stripComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(#|\/\/).*$/gm, '').replace(/\s+#[^"\n]*$/gm, '')
}

/**
 * Extract `resource "type" "name" { ... }` blocks with brace matching.
 * Braces inside double-quoted strings do not count. An unterminated block takes what is left of the input.
 */
export function parseResources(source: string): Res[] {
  const src = stripComments(source)
  const out: Res[] = []
  const re = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 1
    let i = re.lastIndex
    let inStr = false
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i]
      if (inStr) {
        if (ch === '\\') i++
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    const body = src.slice(re.lastIndex, i - 1)
    const attrs: Record<string, string> = {}
    for (const a of body.matchAll(/^\s*([a-zA-Z_][\w]*)\s*=\s*(.+?)\s*$/gm)) if (!(a[1] in attrs)) attrs[a[1]] = a[2]
    const refs = [...new Set([...body.matchAll(new RegExp(REF, 'g'))].map((r) => r[1] + '.' + r[2]))]
    out.push({ key: m[1] + '.' + m[2], type: m[1], name: m[2], body, attrs, refs })
    re.lastIndex = i
  }
  return out
}

const str = (v?: string) => (v ? v.replace(/^"|"$/g, '') : undefined)
const int = (v?: string) => {
  const n = v ? parseInt(str(v)!, 10) : NaN
  return isNaN(n) ? undefined : n
}

/**
 * The settings that can be read off a resource. Only keys that were actually found are returned, so the caller
 * can lay them over the defaults. Select values are taken only when the component offers them, so an unknown
 * instance family, size, machine or tier leaves the default in place.
 */
function propsFor(r: Res, type: string): Record<string, any> {
  const a = r.attrs
  const p: Record<string, any> = {}
  // NOTE: `in` also accepts names inherited from Object.prototype (`constructor`, `toString`), unlike the own-key checks elsewhere in this file
  const splitType = (v: string | undefined, table: Record<string, unknown>) => {
    const parts = (str(v) ?? '').replace(/^db\./, '').split('.')
    if (parts.length === 2 && parts[0] in table && parts[1] in SIZE_MULT) { p.family = parts[0]; p.size = parts[1] }
  }
  const d = defOf(type)
  if (d.provider !== 'aws') {
    // the rich GCP and Azure components share prop names, so a few attributes cover them
    const pick = (key: string, v?: string) => { const o = d.props.find((x) => x.key === key); if (v && o?.options?.some((x) => x.value === v)) p[key] = v }
    pick('machine', str(a.machine_type) ?? str(a.size) ?? str(a.sku))
    pick('tier', str(a.tier) ?? str(a.sku_name) ?? r.body.match(/\btier\s*=\s*"([^"]+)"/)?.[1])
    const count = int(a.count) ?? int(a.target_size) ?? int(a.instances)
    if (count && d.props.some((x) => x.key === 'count')) p.count = count
    const nodes = int(a.initial_node_count) ?? int(a.node_count) ?? int(r.body.match(/\bnode_count\s*=\s*(\d+)/)?.[1])
    if (nodes && d.props.some((x) => x.key === 'nodes')) p.nodes = nodes
    if (roleOf(type) === 'rds') {
      const v = (str(a.database_version) ?? r.type).toLowerCase()
      p.engine = /mysql/.test(v) ? 'mysql' : /sqlserver|mssql/.test(v) ? 'sqlserver' : 'postgres'
      if (/availability_type\s*=\s*"REGIONAL"|ZoneRedundant|zone_redundant\s*=\s*true/.test(r.body)) p.multiAZ = true
    }
    return p
  }
  switch (type) {
    case 'ec2':
      splitType(a.instance_type, EC2_FAMILY)
      p.count = int(a.desired_capacity) ?? int(a.min_size) ?? int(a.count) ?? 1
      break
    case 'rds': {
      splitType(a.instance_class, RDS_CLASS)
      const eng = str(a.engine) ?? ''
      p.engine = r.type === 'aws_rds_cluster' || eng.startsWith('aurora') ? 'aurora' : ['postgres', 'mysql', 'mariadb'].includes(eng) ? eng : eng.startsWith('sqlserver') ? 'sqlserver' : 'postgres'
      if (a.multi_az) p.multiAZ = a.multi_az === 'true'
      if (int(a.allocated_storage)) p.storage = int(a.allocated_storage)
      break
    }
    case 'lambda':
      if (int(a.memory_size)) p.memory = String(int(a.memory_size))
      p.arch = /arm64/.test(r.body) ? 'arm64' : 'x86_64'
      break
    case 'alb': p.kind = str(a.load_balancer_type) === 'network' ? 'network' : 'application'; break
    case 'sqs': p.kind = a.fifo_queue === 'true' ? 'fifo' : 'standard'; p.dlq = /redrive_policy/.test(r.body); break
    case 'apigw': p.kind = r.type === 'aws_apigatewayv2_api' ? 'http' : 'rest'; break
    case 'ecs': if (int(a.desired_count)) p.tasks = int(a.desired_count); break
    case 'kinesis': if (int(a.shard_count)) p.shards = int(a.shard_count); break
    case 'ebs': if (int(a.size)) p.size = int(a.size); break
    case 'elasticache':
      if (int(a.num_cache_nodes) ?? int(a.num_cache_clusters)) p.nodes = int(a.num_cache_nodes) ?? int(a.num_cache_clusters)
      break
  }
  return p
}

export interface ImportResult {
  doc: Doc
  /** how many `resource` blocks were found */
  resources: number
  /** how many of them became components */
  mapped: number
  /** resource types that were not recognised, each once. Networking and plumbing that is dropped on purpose is not listed. */
  skipped: string[]
}

/**
 * Build a laid-out blueprint from Terraform HCL source. Source with no recognisable resource gives an
 * empty blueprint. Every line is marked `imported` (read from a reference)
 * or `inferred` (the synthetic Users client), and its kind is a guess from what it joins.
 */
export function importTerraform(source: string, name = 'Imported from Terraform'): ImportResult {
  const res = parseResources(source)
  const byKey = new Map(res.map((r) => [r.key, r]))
  const doc = emptyDoc(name)
  const nodeOf = new Map<string, NodeT>()
  const skipped = new Set<string>()

  for (const r of res) {
    const type = typeFor(r.type)
    if (!type) {
      if (!NETWORK.test(r.type) && !STRUCTURAL.test(r.type) && !IGNORED.test(r.type)) skipped.add(r.type)
      continue
    }
    const tagName = r.body.match(/Name\s*=\s*"((?:[^"\\$]|\\.)+)"/)?.[1]?.replace(/\\(.)/g, '$1')
    const n: NodeT = { id: uid(), type, x: 0, y: 0, name: tagName ?? r.name.replace(/_/g, '-'), props: { ...defaultProps(type), ...propsFor(r, type) } }
    nodeOf.set(r.key, n)
    doc.nodes.push(n)
  }

  // --- edges
  // Until they are finished (see the map over doc.edges below) the lines hold the two components themselves in
  // `from` and `to`, not their ids, hence the casts. Direction follows the request path: the lower tier points at
  // the higher, and between equals the one holding the reference points at the one it refers to.
  const tier = (n: NodeT) => defOf(n.type).tier
  const pairs = new Set<string>()
  const link = (a: NodeT, b: NodeT, referrerFirst = true) => {
    if (a.id === b.id) return
    let from = a, to = b
    if (tier(a) > tier(b) || (tier(a) === tier(b) && !referrerFirst)) { from = b; to = a }
    const k = from.id + '>' + to.id
    if (pairs.has(k) || pairs.has(to.id + '>' + from.id)) return
    pairs.add(k)
    doc.edges.push({ id: uid(), from, to, style: 'solid', arrow: 'end', width: 2, origin: 'imported' } as any)
  }
  const isConnector = (r?: Res) => !!r && !typeFor(r.type) && !NETWORK.test(r.type) && !STRUCTURAL.test(r.type) && !IGNORED.test(r.type)

  // direct references between mapped resources
  for (const r of res) {
    const a = nodeOf.get(r.key)
    if (!a) continue
    for (const k of r.refs) {
      const b = nodeOf.get(k)
      if (b) link(a, b)
    }
  }
  // references that pass through connector resources (listeners, attachments, mappings…)
  const adj = new Map<string, Set<string>>()
  const addAdj = (a: string, b: string) => { (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b); (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a) }
  for (const r of res) {
    if (!isConnector(r) && !nodeOf.has(r.key)) continue
    for (const k of r.refs) {
      const t = byKey.get(k)
      if (!t || (!isConnector(t) && !nodeOf.has(k))) continue
      if (isConnector(r) || isConnector(t)) addAdj(r.key, k)
    }
  }
  const seen = new Set<string>()
  // connectors whose attributes state the direction of flow explicitly
  const DIRECTED: Record<string, [string, string]> = {
    aws_lambda_event_source_mapping: ['event_source_arn', 'function_name'],
    aws_sns_topic_subscription: ['topic_arn', 'endpoint'],
    aws_s3_bucket_notification: ['bucket', 'lambda_function_arn'],
    google_pubsub_subscription: ['topic', 'push_config'],
    azurerm_eventgrid_event_subscription: ['scope', 'service_bus_queue_endpoint_id'],
  }
  const refIn = (v?: string) => {
    const m = v?.match(REF)
    return m ? nodeOf.get(m[1] + '.' + m[2]) : undefined
  }
  // these are drawn exactly as stated, without the tier ordering `link` applies
  for (const r of res) {
    const dir = Object.hasOwn(DIRECTED, r.type) ? DIRECTED[r.type] : undefined
    if (!dir) continue
    const from = refIn(r.attrs[dir[0]]), to = refIn(r.attrs[dir[1]])
    if (!from || !to || from === to) continue
    seen.add(r.key)
    const k = from.id + '>' + to.id
    if (pairs.has(k) || pairs.has(to.id + '>' + from.id)) continue
    pairs.add(k)
    doc.edges.push({ id: uid(), from, to, style: 'solid', arrow: 'end', width: 2, origin: 'imported' } as any)
  }
  // every remaining group of connectors that refer to one another is walked once, collecting the components at its edges
  for (const r of res) {
    if (!isConnector(r) || seen.has(r.key)) continue
    const users: NodeT[] = []
    const targets: NodeT[] = []
    const stack = [r.key]
    seen.add(r.key)
    while (stack.length) {
      const k = stack.pop()!
      for (const nb of adj.get(k) ?? []) {
        const n = nodeOf.get(nb)
        if (n) {
          // a node that references the connector consumes it; one the connector references is its target
          const list = byKey.get(nb)!.refs.includes(k) ? users : targets
          if (!list.includes(n)) list.push(n)
        } else if (!seen.has(nb)) { seen.add(nb); stack.push(nb) }
      }
    }
    if (users.length && targets.length) {
      for (const u of users) for (const t of targets) link(u, t)
    } else {
      // only one side is known, so there is no direction to read: join the components, but only across tiers,
      // because two of the same tier that share a supporting resource (a parameter group) are not talking to each other
      const comp = users.length ? users : targets
      for (let i = 0; i < comp.length; i++) for (let j = i + 1; j < comp.length; j++) if (tier(comp[i]) !== tier(comp[j])) link(comp[i], comp[j])
    }
  }
  // a reference in code says two resources are related and which refers to which; what kind of relationship is a guess from what they are
  doc.edges = doc.edges.map((e: any) => { const kind = guessKind(e.from, e.to), k = kindInfo(kind)!; return { ...e, from: e.from.id, to: e.to.id, kind, style: k.style, arrow: k.arrow } })

  // synthetic client so the request path reads left to right
  const hasIn = new Set(doc.edges.map((e) => e.to))
  const entries = doc.nodes.filter((n) => ['cloudfront', 'alb', 'apigw', 'route53', 'waf'].includes(roleOf(n.type)) && !hasIn.has(n.id))
  if (entries.length) {
    const users: NodeT = { id: uid(), type: 'users', x: 0, y: 0, name: 'Users', props: {} }
    doc.nodes.push(users)
    for (const e of entries) doc.edges.push({ id: uid(), from: users.id, to: e.id, style: roleOf(e.type) === 'route53' ? 'dashed' : 'solid', arrow: 'end', width: 2, kind: 'request', origin: 'inferred' })
  }

  // --- VPC membership via structural references
  const membership = new Map<string, string[]>()
  // the network a resource sits in: the first one reached by following references through subnets, groups and the like.
  // The depth limit also stops a cycle of references from recursing for ever.
  const vpcOf = (key: string, depth = 0): string | undefined => {
    const r = byKey.get(key)
    if (!r || depth > 3) return
    for (const k of r.refs) {
      const t = byKey.get(k)
      if (!t) continue
      if (NETWORK.test(t.type)) return t.key
      if (STRUCTURAL.test(t.type) || t.type === 'aws_lb_target_group') {
        const v = vpcOf(k, depth + 1)
        if (v) return v
      }
    }
  }
  const vpcs = res.filter((r) => NETWORK.test(r.type))
  for (const v of vpcs) {
    const id = uid()
    const cidr = str(v.attrs.cidr_block) ?? v.body.match(/\d+\.\d+\.\d+\.\d+\/\d+/)?.[0]
    doc.areas.push({ id, kind: 'vpc', name: v.name.replace(/_/g, '-') + (cidr ? ' · ' + cidr : ''), color: '#8F6FF2', x: 0, y: 0, w: 4, d: 4 })
    membership.set(id, [...nodeOf.entries()].filter(([k]) => vpcOf(k) === v.key).map(([, n]) => n.id))
  }
  doc.areas = doc.areas.filter((a) => membership.get(a.id)!.length)

  return { doc: autoLayout(doc, membership), resources: res.length, mapped: nodeOf.size, skipped: [...skipped] }
}

// ---- export ----------------------------------------------------------------

/** A valid Terraform identifier: lower-case words joined by underscores, never starting with a digit. */
const ident = (s: string) => {
  const id = s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'resource'
  return /^[0-9]/.test(id) ? '_' + id : id
}
/** Text made safe inside an HCL double-quoted string: quotes, backslashes, newlines and template markers are escaped. */
const quoted = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n').replace(/\$\{/g, () => '$${').replace(/%\{/g, '%%{')
/** Text made safe on a single comment line. */
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ')
/** Hands out `name`, `name_2`, `name_3` and so on, so no two resources share an identifier. */
function namer() {
  const taken = new Set<string>()
  return (base: string) => {
    let name = base
    for (let i = 2; taken.has(name); i++) name = base + '_' + i
    taken.add(name)
    return name
  }
}

/**
 * Generate a Terraform starting point from a blueprint: provider blocks for the clouds in use (AWS when
 * neither Google Cloud nor Azure is), a network per VPC area on the main cloud, then one resource, or one comment, per component.
 * Component and blueprint names go through `ident`, `quoted` or `oneLine`. Setting values are written as stored.
 */
export function exportTerraform(doc: Doc): string {
  const unique = namer(), uniqueNet = namer()
  const region = REGIONS.find((r) => r.id === doc.region) ?? REGIONS[0]
  const clouds = new Set(doc.nodes.map((n) => defOf(n.type).provider))
  if (!clouds.has('gcp') && !clouds.has('azure')) clouds.add('aws')
  const req: string[] = []
  if (clouds.has('aws')) req.push('    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 5.0"\n    }')
  if (clouds.has('gcp')) req.push('    google = {\n      source  = "hashicorp/google"\n      version = "~> 6.0"\n    }')
  if (clouds.has('azure')) req.push('    azurerm = {\n      source  = "hashicorp/azurerm"\n      version = "~> 4.0"\n    }')
  const out: string[] = [
    `# Generated by CloudMill Graph from "${oneLine(doc.name)}"`,
    '# A starting point: review networking, IAM and secrets before applying.',
    '',
    `terraform {\n  required_providers {\n${req.join('\n')}\n  }\n}`,
    '',
  ]
  if (clouds.has('aws')) out.push(`provider "aws" {\n  region = "${region.id}"\n}`, '')
  if (clouds.has('gcp')) out.push(`provider "google" {\n  project = var.project_id\n  region  = "${region.gcp}"\n}`, '')
  if (clouds.has('azure')) out.push('provider "azurerm" {\n  features {}\n}', '', `resource "azurerm_resource_group" "main" {\n  name     = "${ident(doc.name).replace(/_/g, '-')}"\n  location = "${region.azure}"\n}`, '')
  const main = clouds.has('aws') ? 'aws' : clouds.has('gcp') ? 'gcp' : 'azure'
  const block = (type: string, name: string, lines: (string | false | undefined)[]) =>
    out.push(`resource "${type}" "${name}" {\n${lines.filter(Boolean).map((l) => '  ' + l).join('\n')}\n}`, '')
  for (const a of doc.areas.filter((x) => x.kind === 'vpc')) {
    const net = uniqueNet(ident(a.name.split('·')[0])), title = quoted(a.name.split('·')[0].trim()), cidr = a.name.match(/\d+\.\d+\.\d+\.\d+\/\d+/)?.[0] ?? '10.0.0.0/16'
    if (main === 'gcp') block('google_compute_network', net, [`name = "${net.replace(/_/g, '-')}"`, 'auto_create_subnetworks = false'])
    else if (main === 'azure') block('azurerm_virtual_network', net, [`name = "${net.replace(/_/g, '-')}"`, `address_space = ["${cidr}"]`, 'location = azurerm_resource_group.main.location', 'resource_group_name = azurerm_resource_group.main.name'])
    else block('aws_vpc', net, [`cidr_block = "${cidr}"`, 'enable_dns_hostnames = true', `tags = { Name = "${title}" }`])
  }
  for (const n of doc.nodes) {
    const p = { ...defaultProps(n.type), ...n.props }
    const name = unique(ident(nodeName(n)))
    // `nm` goes inside quoted strings, `note` on comment lines
    const nm = quoted(nodeName(n)), note = oneLine(nodeName(n))
    const tags = `tags = { Name = "${nm}" }`
    switch (n.type) {
      case 'ec2': block('aws_instance', name, [p.count > 1 && `count = ${p.count}`, 'ami = data.aws_ami.default.id', `instance_type = "${p.family}.${p.size}"`, `root_block_device {\n    volume_size = ${p.disk}\n    volume_type = "gp3"\n  }`, tags]); break
      case 'lambda': block('aws_lambda_function', name, [`function_name = "${nm}"`, 'role = aws_iam_role.lambda.arn', 'handler = "index.handler"', 'runtime = "nodejs22.x"', 'filename = "build/function.zip"', `memory_size = ${p.memory}`, `architectures = ["${p.arch}"]`]); break
      case 'ecs': block('aws_ecs_service', name, [`name = "${nm}"`, 'cluster = aws_ecs_cluster.main.id', 'task_definition = aws_ecs_task_definition.app.arn', `desired_count = ${p.tasks}`, 'launch_type = "FARGATE"']); break
      case 'eks': block('aws_eks_cluster', name, [`name = "${nm}"`, 'role_arn = aws_iam_role.eks.arn', 'vpc_config {\n    subnet_ids = var.private_subnet_ids\n  }']); break
      case 'rds': block('aws_db_instance', name, [`identifier = "${ident(nodeName(n)).replace(/_/g, '-')}"`, `engine = "${p.engine === 'aurora' ? 'aurora-postgresql' : p.engine === 'sqlserver' ? 'sqlserver-se' : p.engine}"`, `instance_class = "db.${p.family}.${p.size}"`, `allocated_storage = ${p.storage}`, `multi_az = ${!!p.multiAZ}`, 'storage_encrypted = true', 'username = var.db_username', 'manage_master_user_password = true']); break
      case 'dynamodb': block('aws_dynamodb_table', name, [`name = "${nm}"`, 'billing_mode = "PAY_PER_REQUEST"', 'hash_key = "pk"', 'attribute {\n    name = "pk"\n    type = "S"\n  }']); break
      case 'elasticache': block('aws_elasticache_replication_group', name, [`replication_group_id = "${ident(nodeName(n)).replace(/_/g, '-')}"`, 'description = "Managed by Terraform"', 'engine = "valkey"', `node_type = "${p.node}"`, `num_cache_clusters = ${p.nodes}`]); break
      case 's3': block('aws_s3_bucket', name, [`bucket = "${ident(nodeName(n)).replace(/_/g, '-')}"`, tags]); break
      case 'ebs': block('aws_ebs_volume', name, ['availability_zone = var.availability_zone', `size = ${p.size}`, `type = "${p.vol}"`]); break
      case 'efs': block('aws_efs_file_system', name, ['encrypted = true', tags]); break
      case 'alb': block('aws_lb', name, [`name = "${ident(nodeName(n)).replace(/_/g, '-')}"`, `load_balancer_type = "${p.kind}"`, 'subnets = var.public_subnet_ids']); break
      case 'cloudfront': out.push(`# ${note}: aws_cloudfront_distribution needs origins and cache behaviours; add them here.`, ''); break
      case 'route53': block('aws_route53_zone', name, [`name = "${/\./.test(nm) ? nm : 'example.com'}"`]); break
      case 'apigw': p.kind === 'http' ? block('aws_apigatewayv2_api', name, [`name = "${nm}"`, 'protocol_type = "HTTP"']) : block('aws_api_gateway_rest_api', name, [`name = "${nm}"`]); break
      case 'nat': block('aws_nat_gateway', name, ['allocation_id = aws_eip.nat.id', 'subnet_id = var.public_subnet_ids[0]', tags]); break
      case 'igw': block('aws_internet_gateway', name, [tags]); break
      case 'sqs': block('aws_sqs_queue', name, [`name = "${ident(nodeName(n)).replace(/_/g, '-')}${p.kind === 'fifo' ? '.fifo' : ''}"`, p.kind === 'fifo' && 'fifo_queue = true']); break
      case 'sns': block('aws_sns_topic', name, [`name = "${ident(nodeName(n)).replace(/_/g, '-')}"`]); break
      case 'eventbridge': block('aws_cloudwatch_event_bus', name, [`name = "${ident(nodeName(n)).replace(/_/g, '-')}"`]); break
      case 'kinesis': block('aws_kinesis_stream', name, [`name = "${ident(nodeName(n)).replace(/_/g, '-')}"`, `shard_count = ${p.shards}`]); break
      case 'redshift': block('aws_redshift_cluster', name, [`cluster_identifier = "${ident(nodeName(n)).replace(/_/g, '-')}"`, `node_type = "${p.node}"`, `number_of_nodes = ${p.nodes}`, 'master_username = var.db_username', 'manage_master_password = true']); break
      case 'opensearch': block('aws_opensearch_domain', name, [`domain_name = "${ident(nodeName(n)).replace(/_/g, '-')}"`, `cluster_config {\n    instance_type  = "${p.node}"\n    instance_count = ${p.nodes}\n  }`]); break
      case 'waf': block('aws_wafv2_web_acl', name, [`name = "${ident(nodeName(n)).replace(/_/g, '-')}"`, 'scope = "REGIONAL"', 'default_action {\n    allow {}\n  }', `visibility_config {\n    cloudwatch_metrics_enabled = true\n    metric_name                = "${name}"\n    sampled_requests_enabled   = true\n  }`]); break
      case 'cognito': block('aws_cognito_user_pool', name, [`name = "${nm}"`]); break
      case 'secrets': block('aws_secretsmanager_secret', name, [`name = "${ident(nodeName(n)).replace(/_/g, '-')}"`]); break
      default: {
        // everything outside the hand-written AWS set exports from its catalog entry
        const d = defOf(n.type)
        if (!d.tf) { if (d.provider !== 'any') out.push(`# ${note}: ${d.svc} has no single Terraform resource; add it by hand.`, ''); break }
        const dash = name.replace(/_/g, '-')
        block(d.tf, name, [
          `name = "${dash}"`,
          ...(d.tf.startsWith('azurerm_') ? ['location = azurerm_resource_group.main.location', 'resource_group_name = azurerm_resource_group.main.name'] : []),
          ...(d.tf.startsWith('google_') && /^google_(cloud_run|cloudfunctions2|redis|filestore|artifact_registry|workflows|cloud_tasks|eventarc|cloud_scheduler|vertex_ai)/.test(d.tf) ? [`location = "${region.gcp}"`] : []),
          ...(d.tfAttrs?.(p) ?? []),
          `# ${d.svc}: ${d.summary?.(p) ?? 'configure'}`,
        ])
      }
    }
  }
  return out.join('\n').trimEnd() + '\n'
}

export const SAMPLE_TF = `# Sample: load-balanced web tier with a queue-driven worker
resource "aws_vpc" "main" {
  cidr_block = "10.20.0.0/16"
}

resource "aws_subnet" "public" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.20.1.0/24"
}

resource "aws_subnet" "private" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.20.2.0/24"
}

resource "aws_route53_zone" "primary" {
  name = "shop.example.com"
}

resource "aws_cloudfront_distribution" "edge" {
  origin {
    domain_name = aws_lb.web.dns_name
    origin_id   = "alb"
  }
  origin {
    domain_name = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_id   = "assets"
  }
}

resource "aws_route53_record" "www" {
  zone_id = aws_route53_zone.primary.zone_id
  name    = "www"
  type    = "A"
  alias {
    name    = aws_cloudfront_distribution.edge.domain_name
    zone_id = aws_cloudfront_distribution.edge.hosted_zone_id
  }
}

resource "aws_s3_bucket" "assets" {
  bucket = "shop-static-assets"
}

resource "aws_lb" "web" {
  name               = "shop-web"
  load_balancer_type = "application"
  subnets            = [aws_subnet.public.id]
}

resource "aws_lb_target_group" "web" {
  port     = 8080
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.web.arn
  port              = 443
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_autoscaling_group" "web" {
  desired_capacity    = 3
  max_size            = 6
  min_size            = 2
  vpc_zone_identifier = [aws_subnet.private.id]
  target_group_arns   = [aws_lb_target_group.web.arn]
  launch_template {
    id = aws_launch_template.web.id
  }
}

resource "aws_db_instance" "orders" {
  engine            = "postgres"
  instance_class    = "db.m5.large"
  allocated_storage = 200
  multi_az          = false
  db_subnet_group_name = aws_db_subnet_group.main.name
}

resource "aws_db_subnet_group" "main" {
  subnet_ids = [aws_subnet.private.id]
}

resource "aws_elasticache_cluster" "sessions" {
  engine          = "redis"
  node_type       = "cache.t4g.small"
  num_cache_nodes = 1
  subnet_group_name = aws_elasticache_subnet_group.main.name
}

resource "aws_elasticache_subnet_group" "main" {
  subnet_ids = [aws_subnet.private.id]
}

resource "aws_launch_template" "web" {
  instance_type = "m5.large"
  user_data = base64encode(templatefile("boot.sh", {
    db_host    = aws_db_instance.orders.address
    redis_host = aws_elasticache_cluster.sessions.cache_nodes[0].address
  }))
}

resource "aws_sqs_queue" "emails" {
  name = "order-emails"
}

resource "aws_lambda_function" "mailer" {
  function_name = "order-mailer"
  memory_size   = 256
  architectures = ["x86_64"]
  environment {
    variables = {
      TEMPLATE_BUCKET = aws_s3_bucket.assets.bucket
    }
  }
}

resource "aws_lambda_event_source_mapping" "emails" {
  event_source_arn = aws_sqs_queue.emails.arn
  function_name    = aws_lambda_function.mailer.arn
}

resource "aws_sns_topic" "alerts" {
  name = "ops-alerts"
}

resource "aws_sns_topic_subscription" "queue_alerts" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.emails.arn
}
`
