import { describe, expect, it } from 'vitest'
import { CATALOG_LIST, defaultProps, providerOf, roleOf, translateDoc } from './catalog'
import { inArea } from './layout'
import { TEMPLATES } from './templates'
import { SAMPLE_TF, exportTerraform, importTerraform, parseResources } from './terraform'
import type { Doc } from './types'
import { docOf, node } from '../test/helpers'

const res = (type: string, name: string, body = '') => `resource "${type}" "${name}" {\n${body}\n}\n`
const one = (type: string, body = '') => importTerraform(res(type, 'x', body)).doc.nodes.find((n) => n.type !== 'users')!
const edgesOf = (doc: Doc) => doc.edges.map((e) => `${doc.nodes.find((n) => n.id === e.from)!.name}>${doc.nodes.find((n) => n.id === e.to)!.name}`).sort()

describe('parseResources', () => {
  it('returns nothing for empty, blank or unrelated input', () => {
    for (const src of ['', '   \n\n', 'hello world', '{"json": true}', 'variable "x" { default = 1 }', 'resource "only_one_label" {}', 'resource aws_instance web {}']) expect(parseResources(src), src).toEqual([])
  })
  it('reads type, name, attributes and references', () => {
    const [r] = parseResources('resource "aws_instance" "web" {\n  instance_type = "m5.large"\n  count         = 3\n  subnet_id     = aws_subnet.private.id\n  tags = { Name = "front" }\n}')
    expect(r).toMatchObject({ key: 'aws_instance.web', type: 'aws_instance', name: 'web' })
    expect(r.attrs).toMatchObject({ instance_type: '"m5.large"', count: '3', subnet_id: 'aws_subnet.private.id' })
    expect(r.refs).toEqual(['aws_subnet.private'])
  })
  it('keeps the first value when an attribute repeats in nested blocks', () => {
    const [r] = parseResources(res('aws_x', 'a', '  name = "outer"\n  inner {\n    name = "inner"\n  }'))
    expect(r.attrs.name).toBe('"outer"')
  })
  it('strips every comment form without touching strings', () => {
    const src = `# leading comment with resource "aws_s3_bucket" "ghost" {}
// another with resource "aws_s3_bucket" "ghost2" {}
/* block
   resource "aws_s3_bucket" "ghost3" {}
*/
resource "aws_instance" "a" { # trailing
  ami  = "ami-123" # trailing after a value
  url  = "http://example.com/#anchor"
  /* inline */ type = "x"
}`
    const r = parseResources(src)
    expect(r.map((x) => x.key)).toEqual(['aws_instance.a'])
    expect(r[0].attrs.ami).toBe('"ami-123"')
    expect(r[0].attrs.url).toBe('"http://example.com/#anchor"')
  })
  it('matches braces through nested blocks, strings containing braces and escaped quotes', () => {
    const src = 'resource "aws_instance" "a" {\n  user_data = "if [ x ]; then { echo \\"}\\" ; } fi"\n  a { b { c = 1 } }\n}\nresource "aws_s3_bucket" "b" {}'
    expect(parseResources(src).map((x) => x.key)).toEqual(['aws_instance.a', 'aws_s3_bucket.b'])
  })
  it('copes with an unterminated block', () => {
    const r = parseResources('resource "aws_instance" "a" {\n  instance_type = "m5.large"\n')
    expect(r).toHaveLength(1)
    expect(r[0].attrs.instance_type).toBe('"m5.large"')
    expect(parseResources('resource "aws_instance" "a" {')).toHaveLength(1)
  })
  it('handles one-line and adjacent blocks, and names with dashes', () => {
    const r = parseResources('resource "aws_sqs_queue" "q-1" {}resource "aws_sns_topic" "t_2" { name = "x" }')
    expect(r.map((x) => x.key)).toEqual(['aws_sqs_queue.q-1', 'aws_sns_topic.t_2'])
    expect(parseResources(res('aws_lambda_function', 'f', '  role = aws_sqs_queue.q-1.arn'))[0].refs).toEqual(['aws_sqs_queue.q-1'])
  })
  it('lists each reference once, across all three providers, ignoring data sources and variables', () => {
    const [r] = parseResources(res('aws_x', 'a', '  a = aws_vpc.main.id\n  b = aws_vpc.main.arn\n  c = google_compute_network.net.id\n  d = azurerm_subnet.app.id\n  e = var.name\n  f = data.aws_ami.default.id\n  g = module.x.out'))
    expect(r.refs).toEqual(['aws_vpc.main', 'google_compute_network.net', 'azurerm_subnet.app', 'aws_ami.default'])
  })
  it('parses a large file quickly', () => {
    const src = Array.from({ length: 2000 }, (_, i) => res('aws_instance', 'n' + i, '  instance_type = "m5.large"')).join('\n')
    const t0 = performance.now()
    expect(parseResources(src)).toHaveLength(2000)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})

describe('import: settings', () => {
  it('EC2 reads the instance type and the group size', () => {
    expect(one('aws_instance', '  instance_type = "c5.2xlarge"\n  count = 4').props).toMatchObject({ family: 'c5', size: '2xlarge', count: 4 })
    expect(one('aws_autoscaling_group', '  desired_capacity = 6\n  min_size = 2').props.count).toBe(6)
    expect(one('aws_autoscaling_group', '  min_size = 2\n  max_size = 9').props.count).toBe(2)
    expect(one('aws_spot_instance_request', '').props).toMatchObject({ count: 1, family: 'm7g', size: 'large' })
    // an unknown or malformed type keeps the defaults rather than inventing a price
    for (const bad of ['"x9.large"', '"m5.colossal"', '"m5"', 'var.instance_type', '"m5.large.extra"']) expect(one('aws_instance', `  instance_type = ${bad}`).props, bad).toMatchObject({ family: 'm7g', size: 'large' })
  })
  it('RDS reads class, engine, Multi-AZ and storage', () => {
    expect(one('aws_db_instance', '  instance_class = "db.r5.xlarge"\n  engine = "mysql"\n  multi_az = true\n  allocated_storage = 250').props).toMatchObject({ family: 'r5', size: 'xlarge', engine: 'mysql', multiAZ: true, storage: 250 })
    expect(one('aws_db_instance', '  engine = "mariadb"\n  multi_az = false').props).toMatchObject({ engine: 'mariadb', multiAZ: false })
    expect(one('aws_db_instance', '  engine = "sqlserver-se"').props.engine).toBe('sqlserver')
    expect(one('aws_db_instance', '  engine = "aurora-postgresql"').props.engine).toBe('aurora')
    expect(one('aws_db_instance', '  engine = "oracle-ee"').props.engine).toBe('postgres')
    expect(one('aws_db_instance', '').props).toMatchObject({ engine: 'postgres', multiAZ: false, storage: 100 })
    expect(one('aws_rds_cluster', '  engine = "mysql"').props.engine).toBe('aurora')
  })
  it('Lambda reads memory and architecture', () => {
    expect(one('aws_lambda_function', '  memory_size = 1024\n  architectures = ["arm64"]').props).toMatchObject({ memory: '1024', arch: 'arm64' })
    expect(one('aws_lambda_function', '').props).toMatchObject({ memory: '512', arch: 'x86_64' })
  })
  it('reads the remaining AWS services', () => {
    expect(one('aws_lb', '  load_balancer_type = "network"').props.kind).toBe('network')
    expect(one('aws_lb', '').props.kind).toBe('application')
    expect(one('aws_elb', '').type).toBe('alb')
    expect(one('aws_sqs_queue', '  fifo_queue = true\n  redrive_policy = jsonencode({})').props).toMatchObject({ kind: 'fifo', dlq: true })
    expect(one('aws_sqs_queue', '').props).toMatchObject({ kind: 'standard', dlq: false })
    expect(one('aws_apigatewayv2_api', '').props.kind).toBe('http')
    expect(one('aws_api_gateway_rest_api', '').props.kind).toBe('rest')
    expect(one('aws_ecs_service', '  desired_count = 7').props.tasks).toBe(7)
    expect(one('aws_ecs_service', '').props.tasks).toBe(3)
    expect(one('aws_kinesis_stream', '  shard_count = 12').props.shards).toBe(12)
    expect(one('aws_ebs_volume', '  size = 500').props.size).toBe(500)
    expect(one('aws_elasticache_cluster', '  num_cache_nodes = 3').props.nodes).toBe(3)
    expect(one('aws_elasticache_replication_group', '  num_cache_clusters = 5').props.nodes).toBe(5)
    expect(one('aws_elasticache_cluster', '').props.nodes).toBe(2)
  })
  it('names a component from its Name tag, else from the resource name', () => {
    expect(importTerraform(res('aws_instance', 'web_server', '  tags = { Name = "Front door" }')).doc.nodes[0].name).toBe('Front door')
    expect(importTerraform(res('aws_instance', 'web_server')).doc.nodes[0].name).toBe('web-server')
    // an interpolated tag is not a usable name
    expect(importTerraform(res('aws_instance', 'web_server', '  tags = { Name = "${var.env}-web" }')).doc.nodes[0].name).toBe('web-server')
  })
  it('Google Cloud and Azure read machine, tier, counts and engine', () => {
    expect(one('google_compute_instance', '  machine_type = "n2-standard-4"\n  count = 3').props).toMatchObject({ machine: 'n2-standard-4', count: 3 })
    expect(one('google_compute_instance', '  machine_type = "made-up-9"').props.machine).toBe('e2-standard-2')
    expect(one('google_compute_instance_group_manager', '  target_size = 5').props.count).toBe(5)
    expect(one('azurerm_linux_virtual_machine', '  size = "Standard_D4s_v5"').props.machine).toBe('Standard_D4s_v5')
    expect(one('azurerm_linux_virtual_machine_scale_set', '  sku = "Standard_B2s"\n  instances = 4').props).toMatchObject({ machine: 'Standard_B2s', count: 4 })
    expect(one('google_container_cluster', '  initial_node_count = 6').props.nodes).toBe(6)
    expect(one('azurerm_kubernetes_cluster', '  default_node_pool {\n    node_count = 4\n  }').props.nodes).toBe(4)
    const sql = one('google_sql_database_instance', '  database_version = "MYSQL_8_0"\n  settings {\n    tier = "db-custom-4-15360"\n    availability_type = "REGIONAL"\n  }')
    expect(sql.props).toMatchObject({ engine: 'mysql', tier: 'db-custom-4-15360', multiAZ: true })
    expect(one('google_sql_database_instance', '  database_version = "SQLSERVER_2022_STANDARD"').props).toMatchObject({ engine: 'sqlserver', multiAZ: false })
    expect(one('google_sql_database_instance', '').props.engine).toBe('postgres')
    expect(one('azurerm_postgresql_flexible_server', '  sku_name = "GP_Standard_D4ds_v5"\n  zone_redundant = true').props).toMatchObject({ engine: 'postgres', tier: 'GP_Standard_D4ds_v5', multiAZ: true })
    expect(one('azurerm_mysql_flexible_server', '').props.engine).toBe('mysql')
    expect(one('azurerm_mssql_server', '').props.engine).toBe('sqlserver')
    // a metered service has none of these settings: it simply keeps its defaults
    expect(one('google_pubsub_topic', '  count = 3').props).toEqual(defaultProps('gcp-pubsub'))
  })
  it('recognises every Terraform type the catalog declares', () => {
    for (const d of CATALOG_LIST) for (const t of [d.tf, ...(d.tfAlso ?? [])]) {
      if (!t) continue
      const r = importTerraform(res(t, 'x'))
      expect(r.mapped, t).toBe(1)
      expect(r.doc.nodes[0].type, t).toBe(d.type)
      expect(r.doc.nodes[0].props).toMatchObject(Object.fromEntries(Object.keys(defaultProps(d.type)).map((k) => [k, expect.anything()])))
    }
  })
})

describe('import: structure', () => {
  it('returns an empty blueprint for empty or unusable input', () => {
    for (const src of ['', 'garbage {{{', res('totally_unknown', 'x'), res('constructor', 'x'), res('toString', 'x')]) {
      const r = importTerraform(src)
      expect(r.mapped, src).toBe(0)
      expect(r.doc.nodes).toEqual([])
      expect(r.doc.edges).toEqual([])
    }
    expect(importTerraform('').resources).toBe(0)
    expect(importTerraform('', 'Named').doc.name).toBe('Named')
    expect(importTerraform('').doc.name).toBe('Imported from Terraform')
  })
  it('reports unknown resource types once each, but not networking or plumbing', () => {
    const src = res('aws_vpc', 'v') + res('aws_subnet', 's') + res('aws_iam_policy', 'p') + res('aws_kms_key', 'k') + res('aws_security_group', 'sg') +
      res('aws_mystery_thing', 'a') + res('aws_mystery_thing', 'b') + res('google_project', 'p') + res('azurerm_resource_group', 'rg') + res('aws_lb_listener', 'l') + res('aws_instance', 'i')
    const r = importTerraform(src)
    expect(r.resources).toBe(11)
    expect(r.mapped).toBe(1)
    expect(r.skipped.sort()).toEqual(['aws_lb_listener', 'aws_mystery_thing'])
  })
  it('draws a direct reference from the referrer, ordered by request tier', () => {
    const d = importTerraform(res('aws_lambda_function', 'fn', '  env = aws_dynamodb_table.items.name') + res('aws_dynamodb_table', 'items')).doc
    expect(edgesOf(d)).toEqual(['fn>items'])
    // a lower-tier resource always points at the higher one, whoever holds the reference
    const r = importTerraform(res('aws_dynamodb_table', 'items', '  stream_fn = aws_lambda_function.fn.arn') + res('aws_lambda_function', 'fn')).doc
    expect(edgesOf(r)).toEqual(['fn>items'])
  })
  it('never connects a component to itself or twice to the same peer', () => {
    const d = importTerraform(res('aws_lambda_function', 'a', '  self = aws_lambda_function.a.arn\n  x = aws_sqs_queue.q.arn\n  y = aws_sqs_queue.q.url') + res('aws_sqs_queue', 'q', '  back = aws_lambda_function.a.arn')).doc
    expect(d.edges).toHaveLength(1)
  })
  it('follows explicitly directed connectors', () => {
    const d = importTerraform(
      res('aws_sqs_queue', 'jobs') + res('aws_lambda_function', 'worker') + res('aws_sns_topic', 'alerts') + res('aws_s3_bucket', 'uploads') +
      res('aws_lambda_event_source_mapping', 'm', '  event_source_arn = aws_sqs_queue.jobs.arn\n  function_name = aws_lambda_function.worker.arn') +
      res('aws_sns_topic_subscription', 's', '  topic_arn = aws_sns_topic.alerts.arn\n  endpoint = aws_sqs_queue.jobs.arn') +
      res('aws_s3_bucket_notification', 'n', '  bucket = aws_s3_bucket.uploads.id\n  lambda_function_arn = aws_lambda_function.worker.arn'),
    ).doc
    expect(edgesOf(d)).toEqual(['alerts>jobs', 'jobs>worker', 'uploads>worker'])
  })
  it('ignores a directed connector that is missing an end, and does not double up', () => {
    const d = importTerraform(
      res('aws_sqs_queue', 'jobs') + res('aws_lambda_function', 'worker') +
      res('aws_lambda_event_source_mapping', 'a', '  event_source_arn = aws_sqs_queue.jobs.arn\n  function_name = aws_lambda_function.worker.arn') +
      res('aws_lambda_event_source_mapping', 'b', '  event_source_arn = aws_sqs_queue.jobs.arn\n  function_name = aws_lambda_function.worker.arn') +
      res('aws_lambda_event_source_mapping', 'c', '  event_source_arn = var.other\n  function_name = aws_lambda_function.worker.arn') +
      res('aws_lambda_event_source_mapping', 'd', '  event_source_arn = aws_sqs_queue.jobs.arn\n  function_name = aws_sqs_queue.jobs.arn'),
    ).doc
    expect(edgesOf(d)).toEqual(['jobs>worker'])
  })
  it('links through chains of supporting resources', () => {
    // alb ← listener → target group ← asg: the balancer reaches the group through two connectors
    const d = importTerraform(
      res('aws_lb', 'front') + res('aws_lb_target_group', 'tg') + res('aws_lb_listener', 'l', '  load_balancer_arn = aws_lb.front.arn\n  target = aws_lb_target_group.tg.arn') +
      res('aws_autoscaling_group', 'app', '  target_group_arns = [aws_lb_target_group.tg.arn]'),
    ).doc
    expect(edgesOf(d)).toContain('front>app')
  })
  it('does not link same-tier components that merely share a supporting resource', () => {
    const d = importTerraform(
      res('aws_db_instance', 'a', '  g = aws_db_parameter_group.shared.name') + res('aws_dynamodb_table', 'b', '  g = aws_db_parameter_group.shared.name') + res('aws_db_parameter_group', 'shared'),
    ).doc
    expect(d.edges).toEqual([])
  })
  it('adds a Users client in front of unreferenced entry points, dashed for DNS', () => {
    const d = importTerraform(res('aws_lb', 'front') + res('aws_route53_zone', 'zone') + res('aws_instance', 'app', '  lb = aws_lb.front.arn')).doc
    const users = d.nodes.filter((n) => n.type === 'users')
    expect(users).toHaveLength(1)
    const out = d.edges.filter((e) => e.from === users[0].id)
    expect(out.map((e) => [d.nodes.find((n) => n.id === e.to)!.name, e.style]).sort()).toEqual([['front', 'solid'], ['zone', 'dashed']])
    // nothing to front: no synthetic client
    expect(importTerraform(res('aws_instance', 'app')).doc.nodes.map((n) => n.type)).toEqual(['ec2'])
  })
  it('wraps each network around the resources placed in it, through subnets and groups', () => {
    const src = res('aws_vpc', 'main_net', '  cidr_block = "10.1.0.0/16"') + res('aws_vpc', 'unused') +
      res('aws_subnet', 'priv', '  vpc_id = aws_vpc.main_net.id') + res('aws_security_group', 'sg', '  vpc_id = aws_vpc.main_net.id') + res('aws_db_subnet_group', 'dbs', '  subnet_ids = [aws_subnet.priv.id]') +
      res('aws_instance', 'app', '  subnet_id = aws_subnet.priv.id') + res('aws_db_instance', 'db', '  db_subnet_group_name = aws_db_subnet_group.dbs.name') +
      res('aws_lambda_function', 'fn', '  sg = aws_security_group.sg.id') + res('aws_s3_bucket', 'outside')
    const { doc } = importTerraform(src)
    expect(doc.areas).toHaveLength(1)
    expect(doc.areas[0]).toMatchObject({ kind: 'vpc', name: 'main-net · 10.1.0.0/16' })
    expect(doc.nodes.filter((n) => inArea(doc.areas[0], n)).map((n) => n.name).sort()).toEqual(['app', 'db', 'fn'])
  })
  it('recognises Google and Azure networks, with or without an address range', () => {
    const g = importTerraform(res('google_compute_network', 'net') + res('google_compute_subnetwork', 'sub', '  network = google_compute_network.net.id\n  ip_cidr_range = "10.2.0.0/20"') + res('google_compute_instance', 'vm', '  subnetwork = google_compute_subnetwork.sub.id')).doc
    expect(g.areas.map((a) => a.name)).toEqual(['net'])
    const a = importTerraform(res('azurerm_virtual_network', 'vnet', '  address_space = ["10.3.0.0/16"]') + res('azurerm_subnet', 'sub', '  virtual_network_name = azurerm_virtual_network.vnet.name') + res('azurerm_linux_virtual_machine', 'vm', '  subnet_id = azurerm_subnet.sub.id')).doc
    expect(a.areas.map((x) => x.name)).toEqual(['vnet · 10.3.0.0/16'])
    expect(a.nodes.filter((n) => inArea(a.areas[0], n)).map((n) => n.name)).toEqual(['vm'])
  })
  it('gives up on reference chains deeper than a network would have', () => {
    const chain = res('aws_vpc', 'v') + res('aws_subnet', 's1', '  vpc_id = aws_vpc.v.id') +
      ['s2', 's3', 's4', 's5', 's6'].map((n, i) => res('aws_subnet', n, `  parent = aws_subnet.s${i + 1}.id`)).join('') + res('aws_instance', 'deep', '  subnet_id = aws_subnet.s6.id')
    expect(importTerraform(chain).doc.areas).toEqual([])
  })
  it('lays the sample out as a clean, connected diagram', () => {
    const r = importTerraform(SAMPLE_TF)
    expect(r.resources).toBe(21)
    expect(r.mapped).toBe(10)
    expect(r.doc.edges.every((e) => typeof e.from === 'string' && typeof e.to === 'string')).toBe(true)
    const linked = new Set(r.doc.edges.flatMap((e) => [e.from, e.to]))
    expect(r.doc.nodes.filter((n) => !linked.has(n.id)).map((n) => n.name)).toEqual([])
    expect(importTerraform(SAMPLE_TF).doc.nodes.map((n) => [n.name, n.x, n.y])).toEqual(r.doc.nodes.map((n) => [n.name, n.x, n.y]))
  })
})

describe('export', () => {
  const hcl = (nodes: ReturnType<typeof node>[], extra: Partial<Doc> = {}) => exportTerraform(docOf(nodes, [], extra))
  const named = (type: string, name: string, props = {}) => node(name, type, 0, 0, { name, props: { ...defaultProps(type), ...props } })

  it('writes a header, the provider block and the chosen region', () => {
    const out = hcl([], { name: 'My "great" plan', region: 'eu-west-1' })
    expect(out.split('\n')[0]).toBe('# Generated by CloudMill Graph from "My "great" plan"')
    expect(out).toContain('source  = "hashicorp/aws"')
    expect(out).toContain('provider "aws" {\n  region = "eu-west-1"\n}')
    expect(out).not.toContain('google')
    expect(out).not.toContain('azurerm')
    expect(out.endsWith('}\n')).toBe(true)
    expect(out).not.toMatch(/\n\n\n/)
  })
  it('falls back to the first region for an unknown one', () => {
    expect(hcl([], { region: 'atlantis-1' })).toContain('region = "us-east-1"')
  })
  it('declares only the providers in use, mapping the region for each', () => {
    const g = hcl([named('gcp-gce', 'vm')], { region: 'eu-central-1' })
    expect(g).toContain('provider "google" {\n  project = var.project_id\n  region  = "europe-west3"\n}')
    expect(g).not.toContain('provider "aws"')
    const a = hcl([named('az-vm', 'vm')], { region: 'ap-northeast-1', name: 'Shop Platform!' })
    expect(a).toContain('provider "azurerm" {\n  features {}\n}')
    expect(a).toContain('resource "azurerm_resource_group" "main" {\n  name     = "shop-platform"\n  location = "japaneast"\n}')
    const mixed = hcl([named('ec2', 'a'), named('gcp-gce', 'b'), named('az-vm', 'c')])
    for (const p of ['provider "aws"', 'provider "google"', 'provider "azurerm"']) expect(mixed).toContain(p)
    // neutral components alone still produce a valid AWS skeleton
    expect(hcl([named('users', 'People')])).toContain('provider "aws"')
  })
  it('writes each hand-tuned AWS resource with its settings', () => {
    const cases: [string, Record<string, any>, string[]][] = [
      ['ec2', { family: 'c5', size: 'xlarge', count: 3, disk: 80 }, ['resource "aws_instance" "n"', 'count = 3', 'instance_type = "c5.xlarge"', 'volume_size = 80', 'tags = { Name = "n" }']],
      ['lambda', { memory: '2048', arch: 'x86_64' }, ['resource "aws_lambda_function" "n"', 'memory_size = 2048', 'architectures = ["x86_64"]', 'function_name = "n"']],
      ['ecs', { tasks: 5 }, ['resource "aws_ecs_service" "n"', 'desired_count = 5', 'launch_type = "FARGATE"']],
      ['eks', {}, ['resource "aws_eks_cluster" "n"', 'subnet_ids = var.private_subnet_ids']],
      ['rds', { engine: 'mysql', family: 'r5', size: 'large', storage: 300, multiAZ: true }, ['resource "aws_db_instance" "n"', 'engine = "mysql"', 'instance_class = "db.r5.large"', 'allocated_storage = 300', 'multi_az = true', 'storage_encrypted = true']],
      ['rds', { engine: 'aurora' }, ['engine = "aurora-postgresql"', 'multi_az = false']],
      ['rds', { engine: 'sqlserver' }, ['engine = "sqlserver-se"']],
      ['dynamodb', {}, ['resource "aws_dynamodb_table" "n"', 'billing_mode = "PAY_PER_REQUEST"', 'hash_key = "pk"']],
      ['elasticache', { node: 'cache.r7g.large', nodes: 4 }, ['resource "aws_elasticache_replication_group" "n"', 'node_type = "cache.r7g.large"', 'num_cache_clusters = 4']],
      ['s3', {}, ['resource "aws_s3_bucket" "n"', 'bucket = "n"']],
      ['ebs', { size: 64, vol: 'io2' }, ['resource "aws_ebs_volume" "n"', 'size = 64', 'type = "io2"']],
      ['efs', {}, ['resource "aws_efs_file_system" "n"', 'encrypted = true']],
      ['alb', { kind: 'network' }, ['resource "aws_lb" "n"', 'load_balancer_type = "network"']],
      ['route53', {}, ['resource "aws_route53_zone" "n"', 'name = "example.com"']],
      ['apigw', { kind: 'http' }, ['resource "aws_apigatewayv2_api" "n"', 'protocol_type = "HTTP"']],
      ['apigw', { kind: 'rest' }, ['resource "aws_api_gateway_rest_api" "n"']],
      ['nat', {}, ['resource "aws_nat_gateway" "n"', 'allocation_id = aws_eip.nat.id']],
      ['igw', {}, ['resource "aws_internet_gateway" "n"']],
      ['sqs', { kind: 'fifo' }, ['resource "aws_sqs_queue" "n"', 'name = "n.fifo"', 'fifo_queue = true']],
      ['sns', {}, ['resource "aws_sns_topic" "n"']],
      ['eventbridge', {}, ['resource "aws_cloudwatch_event_bus" "n"']],
      ['kinesis', { shards: 9 }, ['resource "aws_kinesis_stream" "n"', 'shard_count = 9']],
      ['redshift', { node: 'dc2.large', nodes: 3 }, ['resource "aws_redshift_cluster" "n"', 'node_type = "dc2.large"', 'number_of_nodes = 3']],
      ['opensearch', { node: 'r6g.large.search', nodes: 2 }, ['resource "aws_opensearch_domain" "n"', 'instance_type  = "r6g.large.search"', 'instance_count = 2']],
      ['waf', {}, ['resource "aws_wafv2_web_acl" "n"', 'scope = "REGIONAL"', 'metric_name                = "n"']],
      ['cognito', {}, ['resource "aws_cognito_user_pool" "n"']],
      ['secrets', {}, ['resource "aws_secretsmanager_secret" "n"']],
    ]
    for (const [type, props, wants] of cases) {
      const out = hcl([named(type, 'n', props)])
      for (const w of wants) expect(out, `${type}: ${w}`).toContain(w)
      expect(out, type).not.toMatch(/undefined|NaN|\[object/)
    }
  })
  it('omits optional lines that do not apply', () => {
    expect(hcl([named('ec2', 'n', { count: 1 })])).not.toContain('count =')
    const sqs = hcl([named('sqs', 'n', { kind: 'standard' })])
    expect(sqs).toContain('name = "n"')
    expect(sqs).not.toContain('fifo')
    expect(hcl([named('gcp-gce', 'n', { count: 1 })])).not.toMatch(/^\s*count =/m)
  })
  it('uses a real domain for a DNS zone only when the name looks like one', () => {
    expect(hcl([named('route53', 'shop.example.org')])).toContain('name = "shop.example.org"')
    expect(hcl([named('route53', 'Main zone')])).toContain('name = "example.com"')
  })
  it('leaves a note for components with no single resource, and skips neutral ones', () => {
    expect(hcl([named('cloudfront', 'Edge')])).toContain('# Edge: aws_cloudfront_distribution needs origins and cache behaviours; add them here.')
    expect(hcl([named('cloudwatch', 'Mon')])).toContain('# Mon: CloudWatch has no single Terraform resource; add it by hand.')
    expect(hcl([named('az-devops', 'CI')])).toContain('# CI: Azure Pipelines has no single Terraform resource; add it by hand.')
    const neutral = hcl([named('users', 'People'), named('block', 'Thing'), named('saas', 'Stripe')])
    expect(neutral).not.toContain('resource "')
    expect(neutral).not.toMatch(/People|Thing|Stripe/)
  })
  it('writes catalog-driven resources for all three clouds', () => {
    const aws = hcl([named('docdb', 'docs')])
    expect(aws).toContain('resource "aws_docdb_cluster" "docs" {\n  name = "docs"\n  # DocumentDB: 3\n}')
    const g = hcl([named('gcp-run', 'api'), named('gcp-sql', 'db', { tier: 'db-custom-4-15360' }), named('gcp-pubsub', 'events')], { region: 'us-west-2' })
    expect(g).toMatch(/resource "google_cloud_run_v2_service" "api" \{\n  name = "api"\n  location = "us-west1"/)
    expect(g).toContain('settings {\n    tier = "db-custom-4-15360"\n  }')
    expect(g).toMatch(/resource "google_pubsub_topic" "events" \{\n  name = "events"\n  # Pub\/Sub/) // not a regional resource: no location line
    const a = hcl([named('az-vm', 'web', { count: 2, machine: 'Standard_B2s' }), named('az-sql', 'db')])
    expect(a).toMatch(/resource "azurerm_linux_virtual_machine" "web" \{\n  name = "web"\n  location = azurerm_resource_group\.main\.location\n  resource_group_name = azurerm_resource_group\.main\.name\n  count = 2\n  size = "Standard_B2s"/)
    expect(a).toContain('sku_name = "GP_Standard_D2ds_v5"')
  })
  it('writes one resource or note per cloud component, for the whole catalog', () => {
    for (const d of CATALOG_LIST.filter((x) => x.provider !== 'any')) {
      const out = hcl([named(d.type, 'thing')])
      expect(out.includes('resource "') || out.includes('# thing:'), d.type).toBe(true)
      expect(out, d.type).not.toMatch(/undefined|NaN|\[object/)
      expect((out.match(/\{/g) ?? []).length, d.type + ' braces').toBe((out.match(/\}/g) ?? []).length)
    }
  })
  it('makes resource names valid, unique identifiers', () => {
    const out = hcl([named('ec2', 'Web Server #1'), named('ec2', 'web-server (1)'), named('ec2', 'WEB SERVER 1'), named('ec2', '!!!'), named('ec2', '3rd tier'), named('s3', 'web_server_1_2')])
    const names = [...out.matchAll(/resource "aws_[a-z0-9_]+" "([^"]+)"/g)].map((m) => m[1])
    expect(names).toHaveLength(6)
    expect(new Set(names).size).toBe(6)
    for (const n of names) expect(n).toMatch(/^[a-z_][a-z0-9_]*$/)
    expect(names.slice(0, 2)).toEqual(['web_server_1', 'web_server_1_2'])
    expect(names[3]).toBe('resource')
    // an unnamed component is named after its kind
    expect(exportTerraform(docOf([node('a', 'ec2'), node('b', 'ec2')]))).toMatch(/"virtual_machine"[\s\S]*"virtual_machine_2"/)
  })
  it('escapes quotes, backslashes and interpolation in names so the file stays valid', () => {
    const out = hcl([named('ec2', 'the "main" box'), named('lambda', 'a\\b ${var.x}'), named('cognito', 'pool %{if}')])
    expect(out).toContain('tags = { Name = "the \\"main\\" box" }')
    expect(out).toContain('function_name = "a\\\\b $${var.x}"')
    expect(out).toContain('name = "pool %%{if}"')
    // every quoted string on every line is balanced
    for (const l of out.split('\n').filter((x) => !x.trim().startsWith('#'))) expect((l.replace(/\\\\/g, '').replace(/\\"/g, '').match(/"/g) ?? []).length % 2, l).toBe(0)
    expect(parseResources(out).map((r) => r.type)).toEqual(['aws_instance', 'aws_lambda_function', 'aws_cognito_user_pool'])
  })
  it('writes a network for each VPC area, on the blueprint\'s main cloud', () => {
    const areas = [
      { id: 'v', kind: 'vpc' as const, name: 'Prod "east" · 10.9.0.0/16', x: 0, y: 0, w: 4, d: 4, color: '#000000' },
      { id: 'v2', kind: 'vpc' as const, name: 'Shared', x: 0, y: 0, w: 4, d: 4, color: '#000000' },
      { id: 's', kind: 'subnet' as const, name: 'Public', x: 0, y: 0, w: 2, d: 2, color: '#000000' },
    ]
    const aws = hcl([named('ec2', 'a')], { areas })
    expect(aws).toContain('resource "aws_vpc" "prod_east" {\n  cidr_block = "10.9.0.0/16"\n  enable_dns_hostnames = true\n  tags = { Name = "Prod \\"east\\"" }\n}')
    expect(aws).toContain('resource "aws_vpc" "shared" {\n  cidr_block = "10.0.0.0/16"')
    expect(aws).not.toContain('public')
    expect(hcl([named('gcp-gce', 'a')], { areas })).toContain('resource "google_compute_network" "prod_east" {\n  name = "prod-east"\n  auto_create_subnetworks = false\n}')
    expect(hcl([named('az-vm', 'a')], { areas })).toContain('resource "azurerm_virtual_network" "prod_east" {\n  name = "prod-east"\n  address_space = ["10.9.0.0/16"]')
  })
  it('fills in defaults for components saved without settings', () => {
    const out = exportTerraform(docOf([{ id: 'a', type: 'ec2', x: 0, y: 0, props: {} }, { id: 'b', type: 'rds', x: 0, y: 0, props: {} }]))
    expect(out).toContain('instance_type = "m7g.large"')
    expect(out).toContain('instance_class = "db.m7g.large"')
    expect(out).not.toMatch(/undefined/)
  })
})

describe('round trip', () => {
  it('every template exports to HCL that re-imports as the same set of components', () => {
    for (const t of TEMPLATES) {
      const src = t.make()
      const out = exportTerraform(src)
      const exported = src.nodes.filter((n) => out.includes(`"${(n.name ?? '').replace(/"/g, '')}"`) || providerOf(n.type) !== 'any')
      const back = importTerraform(out)
      const want = parseResources(out).map((r) => r.type).filter((ty) => !/^(aws_vpc|google_compute_network|azurerm_virtual_network|azurerm_resource_group)$/.test(ty)).length
      expect(back.mapped, t.id).toBe(want)
      expect(back.skipped, t.id).toEqual([])
      expect(exported.length).toBeGreaterThan(5)
      const count = (d: Doc) => {
        const m: Record<string, number> = {}
        for (const n of d.nodes) if (providerOf(n.type) !== 'any') m[n.type] = (m[n.type] ?? 0) + 1
        return m
      }
      const before = count(src), after = count(back.doc)
      for (const type of Object.keys(after)) expect(after[type], `${t.id}: ${type}`).toBe(before[type])
      expect(back.doc.areas.length).toBeLessThanOrEqual(src.areas.filter((a) => a.kind === 'vpc').length)
    }
  })
  it('keeps the sizing of the main AWS components', () => {
    const src = docOf([
      node('vm', 'ec2', 0, 0, { name: 'web', props: { ...defaultProps('ec2'), family: 'c5', size: 'xlarge', count: 4 } }),
      node('db', 'rds', 0, 0, { name: 'orders', props: { ...defaultProps('rds'), engine: 'mysql', family: 'r5', size: '2xlarge', multiAZ: true, storage: 640 } }),
      node('fn', 'lambda', 0, 0, { name: 'worker', props: { ...defaultProps('lambda'), memory: '2048', arch: 'x86_64' } }),
      node('q', 'sqs', 0, 0, { name: 'jobs', props: { ...defaultProps('sqs'), kind: 'fifo' } }),
      node('lb', 'alb', 0, 0, { name: 'edge', props: { ...defaultProps('alb'), kind: 'network' } }),
      node('k', 'kinesis', 0, 0, { name: 'stream', props: { ...defaultProps('kinesis'), shards: 7 } }),
      node('c', 'elasticache', 0, 0, { name: 'cache', props: { ...defaultProps('elasticache'), nodes: 5 } }),
      node('v', 'ebs', 0, 0, { name: 'vol', props: { ...defaultProps('ebs'), size: 750 } }),
      node('t', 'ecs', 0, 0, { name: 'tasks', props: { ...defaultProps('ecs'), tasks: 9 } }),
      node('g', 'apigw', 0, 0, { name: 'api', props: { ...defaultProps('apigw'), kind: 'rest' } }),
    ])
    const back = importTerraform(exportTerraform(src)).doc
    const by = (type: string) => back.nodes.find((n) => n.type === type)!.props
    expect(by('ec2')).toMatchObject({ family: 'c5', size: 'xlarge', count: 4 })
    expect(by('rds')).toMatchObject({ engine: 'mysql', family: 'r5', size: '2xlarge', multiAZ: true, storage: 640 })
    expect(by('lambda')).toMatchObject({ memory: '2048', arch: 'x86_64' })
    expect(by('sqs').kind).toBe('fifo')
    expect(by('alb').kind).toBe('network')
    expect(by('kinesis').shards).toBe(7)
    expect(by('elasticache').nodes).toBe(5)
    expect(by('ebs').size).toBe(750)
    expect(by('ecs').tasks).toBe(9)
    expect(by('apigw').kind).toBe('rest')
    expect(back.nodes.find((n) => n.type === 'ec2')!.name).toBe('web')
  })
  it('survives a translated blueprint on each cloud', () => {
    for (const p of ['gcp', 'azure'] as const) for (const t of TEMPLATES.slice(0, 4)) {
      const src = translateDoc(t.make(), p).doc
      const back = importTerraform(exportTerraform(src))
      expect(back.skipped, `${p} ${t.id}`).toEqual([])
      expect(back.doc.nodes.some((n) => roleOf(n.type) !== 'users')).toBe(true)
    }
  })
})

describe('import: where connections come from', () => {
  it('lines read from references are marked as from code, with a kind guessed from what they join', () => {
    const { doc } = importTerraform(SAMPLE_TF)
    const real = doc.edges.filter((e) => e.origin === 'imported')
    expect(real.length).toBeGreaterThan(2)
    for (const e of real) expect(['request', 'data', 'event', 'replication']).toContain(e.kind)
    const users = doc.nodes.find((n) => n.type === 'users')
    if (users) for (const e of doc.edges.filter((x) => x.from === users.id)) expect(e.origin).toBe('inferred')
  })
  it('nothing imported claims to be observed traffic', () => {
    const { doc } = importTerraform(SAMPLE_TF)
    for (const e of doc.edges) expect(['imported', 'inferred']).toContain(e.origin)
  })
})
