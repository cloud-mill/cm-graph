import { describe, expect, it } from 'vitest'
import {
  CATALOG, CATALOG_LIST, CATEGORIES, COMMIT_DISCOUNT, EC2_FAMILY, HOURS, PROVIDERS, RDS_CLASS, REGIONS, SIZE_MULT,
  costOf, defOf, defaultProps, docCost, docProviders, equivalent, money, nodeColor, nodeName, providerOf, roleOf, translateDoc,
} from './catalog'
import { CLOUD_DEFS } from './clouds'
import { docOf, node } from '../test/helpers'

const n = (type: string, props: Record<string, any> = {}) => node('x', type, 0, 0, { props: { ...defaultProps(type), ...props } })
const cost = (type: string, props: Record<string, any> = {}, region = 'us-east-1', model: any = 'ondemand') => costOf(n(type, props), region, model)
const line = (type: string, props: Record<string, any>, i: number) => cost(type, props).lines[i].monthly

describe('catalog integrity', () => {
  it('lists every definition once, grouped by cloud', () => {
    expect(Object.keys(CATALOG)).toHaveLength(CATALOG_LIST.length)
    const order = CATALOG_LIST.map((d) => ['aws', 'gcp', 'azure', 'any'].indexOf(d.provider))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(CLOUD_DEFS.every((d) => CATALOG[d.type])).toBe(true)
  })
  it('gives every component a known category, a colour, a tier and sane prop definitions', () => {
    const cats = new Set(CATEGORIES.map((c) => c.id))
    for (const d of CATALOG_LIST) {
      expect(cats.has(d.category), d.type).toBe(true)
      expect(d.color, d.type).toMatch(/^#[0-9a-f]{6}$/i)
      expect(Number.isFinite(d.tier), d.type).toBe(true)
      expect(d.name && d.svc, d.type).toBeTruthy()
      expect(new Set(d.props.map((p) => p.key)).size, d.type + ' duplicate prop keys').toBe(d.props.length)
      for (const p of d.props) {
        if (p.type === 'select') {
          expect(p.options!.length, `${d.type}.${p.key}`).toBeGreaterThan(1)
          expect(p.options!.some((o) => o.value === p.default), `${d.type}.${p.key} default is an option`).toBe(true)
          expect(new Set(p.options!.map((o) => o.value)).size).toBe(p.options!.length)
        } else if (p.type === 'number') {
          expect(typeof p.default, `${d.type}.${p.key}`).toBe('number')
          expect(p.default).toBeGreaterThanOrEqual(p.min ?? 0)
          if (p.max != null) expect(p.default).toBeLessThanOrEqual(p.max)
        } else expect(typeof p.default).toBe('boolean')
      }
    }
  })
  it('prefixes other clouds\' types and marks external components as cloud-neutral', () => {
    for (const d of CATALOG_LIST) {
      if (d.provider === 'gcp') expect(d.type).toMatch(/^gcp-/)
      else if (d.provider === 'azure') expect(d.type).toMatch(/^az-/)
      else expect(d.type).not.toMatch(/^(gcp|az)-/)
      expect(d.provider === 'any').toBe(d.category === 'external')
    }
    expect(CATALOG_LIST.filter((d) => d.provider === 'any').map((d) => d.type).sort()).toEqual(['block', 'internet', 'mobile', 'onprem', 'saas', 'users'])
  })
  it('maps each Terraform resource type to exactly one component', () => {
    const seen = new Map<string, string>()
    for (const d of CATALOG_LIST) for (const t of [d.tf, ...(d.tfAlso ?? [])]) {
      if (!t) continue
      expect(seen.get(t), `${t} claimed by ${seen.get(t)} and ${d.type}`).toBeUndefined()
      seen.set(t, d.type)
      expect(t).toMatch(d.provider === 'aws' ? /^aws_/ : d.provider === 'gcp' ? /^google_/ : /^azurerm_/)
    }
  })
  it('has usable regions, providers and discounts', () => {
    expect(REGIONS[0]).toMatchObject({ id: 'us-east-1', mult: 1 })
    expect(new Set(REGIONS.map((r) => r.id)).size).toBe(REGIONS.length)
    for (const r of REGIONS) { expect(r.mult).toBeGreaterThanOrEqual(1); expect(r.gcp && r.azure && r.name).toBeTruthy() }
    expect(PROVIDERS.map((p) => p.id)).toEqual(['aws', 'gcp', 'azure'])
    expect(COMMIT_DISCOUNT).toEqual({ ondemand: 0, commit1: 0.28, commit3: 0.5 })
    for (const f of Object.values(EC2_FAMILY)) if (f.upgrade) expect(EC2_FAMILY[f.upgrade].arm).toBe(true)
    for (const c of Object.values(RDS_CLASS)) if (c.upgrade) expect(RDS_CLASS[c.upgrade]).toBeTruthy()
  })
})

describe('every component, with every option', () => {
  it('prices, summarises and exports without NaN, negatives or "undefined"', () => {
    for (const d of CATALOG_LIST) {
      const variants: Record<string, any>[] = [defaultProps(d.type)]
      for (const p of d.props) {
        if (p.type === 'select') for (const o of p.options!) variants.push({ ...defaultProps(d.type), [p.key]: o.value })
        else if (p.type === 'toggle') variants.push({ ...defaultProps(d.type), [p.key]: !p.default })
        else variants.push({ ...defaultProps(d.type), [p.key]: 0 }, { ...defaultProps(d.type), [p.key]: p.max ?? 1e6 })
      }
      for (const props of variants) {
        const tag = `${d.type} ${JSON.stringify(props)}`
        const c = costOf({ id: 'x', type: d.type, x: 0, y: 0, props }, 'us-east-1')
        expect(Number.isFinite(c.monthly) && c.monthly >= 0, tag).toBe(true)
        for (const l of c.lines) { expect(l.monthly, tag).toBeGreaterThan(0); expect(l.label, tag).not.toMatch(/undefined|NaN/) }
        expect(c.monthly).toBeCloseTo(c.lines.reduce((s, l) => s + l.monthly, 0), 6)
        if (d.summary) expect(d.summary(props), tag).not.toMatch(/undefined|NaN/)
        for (const a of d.tfAttrs?.(props) ?? []) if (a) expect(a, tag).not.toMatch(/undefined|NaN/)
        for (const p of d.props) if (p.showIf) expect(typeof p.showIf(props)).toBe('boolean')
      }
    }
  })
  it('every select option of the sized components changes or keeps the price, never breaks it', () => {
    for (const type of ['ec2', 'eks', 'rds', 'elasticache', 'redshift', 'opensearch', 'ebs', 's3', 'gcp-gce', 'gcp-gke', 'gcp-sql', 'gcp-gcs', 'az-vm', 'az-aks', 'az-sql', 'az-blob']) {
      const d = defOf(type)
      for (const p of d.props.filter((x) => x.type === 'select' && !['os', 'engine'].includes(x.key))) {
        const prices = p.options!.map((o) => cost(type, { [p.key]: o.value }).monthly)
        // a price table that silently fell back to a default would make options collide
        expect(new Set(prices.map((v) => v.toFixed(4))).size, `${type}.${p.key}`).toBeGreaterThan(Math.min(2, p.options!.length) - 1)
        expect(Math.min(...prices)).toBeGreaterThan(0)
      }
    }
  })
})

describe('AWS pricing', () => {
  it('EC2: family × size × count, Windows surcharge, gp3 disk', () => {
    expect(line('ec2', { family: 'm5', size: 'large', count: 1, disk: 0 }, 0)).toBeCloseTo(0.096 * HOURS)
    expect(line('ec2', { family: 'm5', size: '2xlarge', count: 3, disk: 0 }, 0)).toBeCloseTo(0.096 * 4 * 3 * HOURS)
    expect(line('ec2', { family: 'm5', size: 'nano', count: 1, disk: 0 }, 0)).toBeCloseTo((0.096 / 16) * HOURS)
    expect(line('ec2', { family: 'm5', size: 'xlarge', os: 'windows', count: 1, disk: 0 }, 0)).toBeCloseTo((0.096 + 0.092) * 2 * HOURS)
    expect(line('ec2', { count: 4, disk: 50 }, 1)).toBeCloseTo(200 * 0.08)
    expect(cost('ec2', { count: 4, disk: 50 }).lines.map((l) => l.label)).toEqual(['4 × m7g.large', '200 GB gp3'])
    for (const size of Object.keys(SIZE_MULT)) expect(line('ec2', { family: 't3', size, count: 1 }, 0)).toBeCloseTo(0.0832 * SIZE_MULT[size] * HOURS)
  })
  it('EC2 falls back to a sensible rate for an unknown family or size', () => {
    expect(line('ec2', { family: 'zz9', size: 'large', count: 1, disk: 0 }, 0)).toBeCloseTo(0.1 * HOURS)
    expect(line('ec2', { family: 'm5', size: 'colossal', count: 1, disk: 0 }, 0)).toBeCloseTo(0.096 * HOURS)
  })
  it('Lambda: requests plus GB-seconds, cheaper on arm64', () => {
    const p = { requests: 10, duration: 200, memory: '1024' }
    expect(line('lambda', { ...p, arch: 'x86_64' }, 0)).toBeCloseTo(2)
    expect(line('lambda', { ...p, arch: 'x86_64' }, 1)).toBeCloseTo(2e6 * 0.0000166667)
    expect(line('lambda', { ...p, arch: 'arm64' }, 1)).toBeCloseTo(2e6 * 0.0000133334)
    expect(cost('lambda', { ...p, memory: '2048' }).lines[1].label).toBe('4,000,000 GB-seconds')
    expect(cost('lambda', { requests: 0 }).lines).toEqual([])
  })
  it('ECS and EKS', () => {
    expect(cost('ecs', { tasks: 4, vcpu: '2', mem: '8' }).monthly).toBeCloseTo(4 * (2 * 0.04048 + 8 * 0.004445) * HOURS)
    const eks = cost('eks', { nodes: 5, family: 'm5', size: 'xlarge' })
    expect(eks.lines[0]).toMatchObject({ label: 'Control plane', monthly: 73 })
    expect(eks.lines[1].monthly).toBeCloseTo(0.096 * 2 * 5 * HOURS)
    expect(cost('eks', { nodes: 0 }).lines.map((l) => l.label)).toEqual(['Control plane'])
  })
  it('RDS: engine multiplier, Multi-AZ doubling, replicas, storage', () => {
    const base = { family: 'm5', size: 'large', storage: 100, engine: 'postgres' }
    expect(line('rds', base, 0)).toBeCloseTo(0.171 * HOURS)
    expect(line('rds', base, 1)).toBeCloseTo(11.5)
    expect(line('rds', { ...base, engine: 'mysql' }, 0)).toBeCloseTo(0.171 * 0.96 * HOURS)
    expect(line('rds', { ...base, engine: 'aurora' }, 0)).toBeCloseTo(0.171 * 1.2 * HOURS)
    expect(line('rds', { ...base, engine: 'sqlserver' }, 0)).toBeCloseTo(0.171 * 2.1 * HOURS)
    const ha = cost('rds', { ...base, multiAZ: true, replicas: 2 })
    expect(ha.lines.map((l) => l.label)).toEqual(['db.m5.large (Multi-AZ)', '100 GB storage', '2 read replicas'])
    expect(ha.lines[0].monthly).toBeCloseTo(0.171 * HOURS * 2)
    expect(ha.lines[1].monthly).toBeCloseTo(23)
    expect(ha.lines[2].monthly).toBeCloseTo(0.171 * HOURS * 2)
    expect(cost('rds', { ...base, replicas: 1 }).lines[2].label).toBe('1 read replica')
  })
  it('storage and data services', () => {
    expect(cost('dynamodb', { reads: 10, writes: 2, storage: 40 }).monthly).toBeCloseTo(1.25 + 1.25 + 10)
    expect(cost('elasticache', { node: 'cache.t4g.micro', nodes: 3 }).monthly).toBeCloseTo(0.016 * HOURS * 3)
    expect(cost('s3', { storage: 1000, class: 'standard', requests: 0, egress: 0 }).monthly).toBeCloseTo(23)
    expect(cost('s3', { storage: 1000, class: 'deep-archive', requests: 0, egress: 0 }).monthly).toBeCloseTo(0.99)
    // the first 100 GB of egress are free
    expect(cost('s3', { storage: 0, requests: 0, egress: 100 }).lines).toEqual([])
    expect(cost('s3', { storage: 0, requests: 0, egress: 300 }).monthly).toBeCloseTo(18)
    expect(cost('ebs', { vol: 'io2', size: 100 }).monthly).toBeCloseTo(12.5)
    expect(cost('efs', { storage: 10 }).monthly).toBeCloseTo(3)
    expect(cost('redshift', { node: 'dc2.large', nodes: 2 }).monthly).toBeCloseTo(0.25 * HOURS * 2)
    expect(cost('opensearch', { node: 't3.small.search', nodes: 2, storage: 10 }).monthly).toBeCloseTo(0.036 * HOURS * 2 + 20 * 0.122)
    expect(cost('kinesis', { shards: 1, records: 0 }).lines).toMatchObject([{ label: '1 shard' }])
    expect(cost('cloudwatch', { metrics: 10, logs: 4 }).monthly).toBeCloseTo(5)
  })
  it('network and messaging services, including free tiers', () => {
    expect(cost('alb', { kind: 'application', lcu: 10 }).monthly).toBeCloseTo((0.0225 + 0.08) * HOURS)
    expect(cost('alb', { kind: 'network', lcu: 10 }).monthly).toBeCloseTo((0.0225 + 0.06) * HOURS)
    expect(cost('cloudfront', { transfer: 100, requests: 5 }).monthly).toBeCloseTo(13.5)
    expect(cost('route53', { zones: 2, queries: 0 }).lines).toMatchObject([{ label: '2 hosted zones', monthly: 1 }])
    expect(cost('route53', { zones: 1, queries: 0 }).lines[0].label).toBe('1 hosted zone')
    expect(cost('apigw', { kind: 'http', requests: 10 }).monthly).toBeCloseTo(10)
    expect(cost('apigw', { kind: 'rest', requests: 10 }).monthly).toBeCloseTo(35)
    expect(cost('apigw', { kind: 'rest', requests: 10 }).lines[0].label).toBe('10M REST requests')
    expect(cost('nat', { data: 100 }).monthly).toBeCloseTo(0.045 * HOURS + 4.5)
    expect(cost('igw')).toEqual({ lines: [], monthly: 0 })
    expect(cost('sqs', { requests: 1 }).monthly).toBe(0)
    expect(cost('sqs', { requests: 11, kind: 'standard' }).monthly).toBeCloseTo(4)
    expect(cost('sqs', { requests: 11, kind: 'fifo' }).monthly).toBeCloseTo(5)
    expect(cost('sns', { messages: 0.5 }).monthly).toBe(0)
    expect(cost('sns', { messages: 3 }).monthly).toBeCloseTo(1)
    expect(cost('eventbridge', { events: 7 }).monthly).toBeCloseTo(7)
    expect(cost('waf', { rules: 5, requests: 10 }).monthly).toBeCloseTo(16)
    expect(cost('cognito', { mau: 10000 }).monthly).toBe(0)
    expect(cost('cognito', { mau: 30000 }).monthly).toBeCloseTo(110)
    expect(cost('secrets', { secrets: 10, keys: 2 }).monthly).toBeCloseTo(6)
  })
  it('external components cost only what you say they do', () => {
    for (const t of ['users', 'internet', 'mobile', 'onprem']) expect(cost(t)).toEqual({ lines: [], monthly: 0 })
    expect(cost('saas', { fee: 0 }).monthly).toBe(0)
    expect(cost('saas', { fee: 99 })).toEqual({ lines: [{ label: 'Subscription', monthly: 99 }], monthly: 99 })
    expect(cost('block', { fee: '250' }).monthly).toBe(250)
    expect(cost('block', { fee: -5 }).monthly).toBe(0)
  })
})

describe('Google Cloud and Azure pricing', () => {
  it('virtual machines: machine rate, Windows uplift, boot disks', () => {
    expect(line('gcp-gce', { machine: 'e2-standard-2', count: 2, disk: 0 }, 0)).toBeCloseTo(0.067 * HOURS * 2)
    expect(line('gcp-gce', { machine: 'e2-standard-2', os: 'windows', count: 1, disk: 0 }, 0)).toBeCloseTo(0.067 * 1.48 * HOURS)
    expect(line('az-vm', { machine: 'Standard_D4s_v5', count: 1, disk: 100 }, 1)).toBeCloseTo(10)
    expect(cost('az-vm', { count: 3 }).lines[0].label).toBe('3 × Standard_D2s_v5')
    expect(defOf('gcp-gce').summary!({ count: 1, machine: 'e2-micro' })).toBe('e2-micro')
    expect(defOf('gcp-gce').summary!({ count: 3, machine: 'e2-micro' })).toBe('3 × e2-micro')
    expect(defOf('gcp-gce').tfAttrs!({ count: 1, machine: 'e2-micro' })).toEqual([false, 'machine_type = "e2-micro"'])
    expect(defOf('az-vm').tfAttrs!({ count: 2, machine: 'Standard_B1s' })).toEqual(['count = 2', 'size = "Standard_B1s"'])
  })
  it('functions have a free allowance', () => {
    expect(cost('gcp-functions', { requests: 2, duration: 100, memory: '256' }).monthly).toBe(0)
    const c = cost('gcp-functions', { requests: 12, duration: 1000, memory: '1024' })
    expect(c.lines[0].monthly).toBeCloseTo(10 * 0.4)
    expect(c.lines[1].monthly).toBeCloseTo((12e6 - 400000) * 0.0000165)
    expect(cost('az-functions', { requests: 12, duration: 1000, memory: '1024' }).lines[0].monthly).toBeCloseTo(2)
  })
  it('containers and Kubernetes', () => {
    expect(cost('gcp-run', { tasks: 2, vcpu: '1', mem: '2' }).monthly).toBeCloseTo(2 * (0.0864 + 0.018) * HOURS)
    expect(cost('az-containerapps', { tasks: 1, vcpu: '0.5', mem: '1' }).monthly).toBeCloseTo((0.0432 + 0.0108) * HOURS)
    expect(cost('gcp-gke', { nodes: 3, machine: 'e2-standard-4' }).monthly).toBeCloseTo(73 + 0.134 * HOURS * 3)
    expect(cost('az-aks', { nodes: 0 }).monthly).toBeCloseTo(73)
  })
  it('managed SQL: tier × engine, HA doubling, replicas', () => {
    const c = cost('gcp-sql', { tier: 'db-custom-4-15360', engine: 'sqlserver', multiAZ: true, replicas: 1, storage: 50 })
    expect(c.lines.map((l) => l.label)).toEqual(['db-custom-4-15360 (HA)', '50 GB storage', '1 read replica'])
    expect(c.lines[0].monthly).toBeCloseTo(0.2772 * 1.9 * HOURS * 2)
    expect(c.lines[1].monthly).toBeCloseTo(50 * 0.17 * 2)
    expect(c.lines[2].monthly).toBeCloseTo(0.2772 * 1.9 * HOURS)
    expect(cost('az-sql', { tier: 'B_Standard_B1ms', engine: 'postgres', storage: 0 }).monthly).toBeCloseTo(0.026 * HOURS)
    expect(cost('gcp-sql', { replicas: 3 }).lines[2].label).toBe('3 read replicas')
    expect(defOf('gcp-sql').tfAttrs!({ tier: 'db-f1-micro' })).toEqual(['settings {\n    tier = "db-f1-micro"\n  }'])
    expect(defOf('az-sql').tfAttrs!({ tier: 'B_Standard_B2s' })).toEqual(['sku_name = "B_Standard_B2s"'])
    expect(defOf('az-sql').summary!({ engine: 'mysql', tier: 'X' })).toBe('mysql · X')
  })
  it('object storage uses each cloud\'s own class names and falls back to the first class', () => {
    expect(cost('gcp-gcs', { storage: 1000, class: 'infrequent-access', requests: 0, egress: 0 }).lines).toEqual([{ label: '1000 GB Nearline', monthly: 10 }])
    expect(cost('az-blob', { storage: 1000, class: 'standard', requests: 5, egress: 200 }).monthly).toBeCloseTo(18 + 2 + 8.7)
    expect(cost('az-blob', { storage: 1000, class: 'bogus', requests: 0, egress: 0 }).lines[0].label).toBe('1000 GB Hot')
    expect(defOf('gcp-gcs').summary!({ storage: 5, class: 'deep-archive' })).toBe('5 GB · Archive')
    expect(defOf('gcp-gcs').summary!({ storage: 5, class: 'bogus' })).toBe('5 GB · Standard')
  })
  it('metered services: base fees, units in labels and summaries', () => {
    const nat = cost('gcp-nat', { m0: 100 })
    expect(nat.lines).toEqual([{ label: 'Base fee', monthly: 32, commit: undefined }, { label: '100 GB/mo data processed', monthly: 4.5, commit: undefined }])
    expect(defOf('gcp-nat').summary!({ m0: 1500 })).toBe('1,500 GB/mo')
    expect(defOf('docdb').summary!({ m0: 3 })).toBe('3')
    expect(cost('shield').lines).toMatchObject([{ label: 'Base fee', monthly: 3000 }])
    expect(defOf('shield').summary!({})).toBe('Flat rate')
    expect(cost('iam')).toEqual({ lines: [], monthly: 0 })
    expect(defOf('iam').summary!({})).toBe('No direct charge')
    expect(defOf('az-servicebus').props.map((p) => p.key)).toEqual(['m0', 'dlq'])
    expect(defOf('gcp-tasks').props.at(-1)).toMatchObject({ key: 'dlq', type: 'toggle', default: false })
  })
})

describe('regions and commitments', () => {
  it('multiplies every line by the region factor and ignores unknown regions', () => {
    const base = cost('rds').monthly
    for (const r of REGIONS) expect(cost('rds', {}, r.id).monthly).toBeCloseTo(base * r.mult, 6)
    expect(cost('rds', {}, 'mars-north-1').monthly).toBeCloseTo(base, 6)
  })
  it('discounts only the committable lines', () => {
    const od = cost('ec2', { family: 'm5', size: 'large', count: 1, disk: 100 })
    const c1 = cost('ec2', { family: 'm5', size: 'large', count: 1, disk: 100 }, 'us-east-1', 'commit1')
    const c3 = cost('ec2', { family: 'm5', size: 'large', count: 1, disk: 100 }, 'us-east-1', 'commit3')
    expect(c1.lines[0].monthly).toBeCloseTo(od.lines[0].monthly * 0.72)
    expect(c3.lines[0].monthly).toBeCloseTo(od.lines[0].monthly * 0.5)
    expect(c1.lines[1].monthly).toBeCloseTo(od.lines[1].monthly)
    // pay-per-use services are unaffected
    for (const t of ['lambda', 's3', 'dynamodb', 'sqs', 'cloudfront', 'gcp-functions', 'az-blob']) expect(cost(t, {}, 'us-east-1', 'commit3').monthly, t).toBeCloseTo(cost(t).monthly, 6)
    for (const t of ['rds', 'ecs', 'eks', 'elasticache', 'redshift', 'opensearch', 'gcp-gce', 'az-sql', 'docdb', 'gcp-memorystore']) expect(cost(t, {}, 'us-east-1', 'commit1').monthly, t).toBeLessThan(cost(t).monthly)
  })
  it('region and commitment compose', () => {
    const p = { family: 'm5', size: 'large', count: 1, disk: 0 }
    expect(cost('ec2', p, 'sa-east-1', 'commit3').monthly).toBeCloseTo(0.096 * HOURS * 1.55 * 0.5)
  })
  it('fills in missing settings from the defaults', () => {
    expect(costOf({ id: 'x', type: 'ec2', x: 0, y: 0, props: {} }, 'us-east-1').monthly).toBeCloseTo(cost('ec2').monthly)
    expect(costOf({ id: 'x', type: 'ec2', x: 0, y: 0, props: { count: 2 } }, 'us-east-1').lines[0].label).toBe('2 × m7g.large')
  })
  it('totals a blueprint per component and per category', () => {
    const d = docOf([node('a', 'ec2'), node('b', 'ec2'), node('c', 'rds'), node('u', 'users'), node('s', 's3')], [], { region: 'eu-central-1' })
    const c = docCost(d)
    expect(c.perNode.size).toBe(5)
    expect(c.perNode.get('u')).toEqual({ lines: [], monthly: 0 })
    expect(c.byCategory.get('compute')).toBeCloseTo(cost('ec2', {}, 'eu-central-1').monthly * 2)
    expect(c.byCategory.get('database')).toBeCloseTo(cost('rds', {}, 'eu-central-1').monthly)
    expect(c.byCategory.get('external')).toBe(0)
    expect(c.total).toBeCloseTo([...c.byCategory.values()].reduce((s, v) => s + v, 0))
    expect(docCost(d, 'commit1').total).toBeLessThan(c.total)
    expect(docCost(docOf())).toMatchObject({ total: 0 })
  })
})

describe('money', () => {
  it('shows cents under $100 and whole dollars above', () => {
    expect(money(0)).toBe('$0.00')
    expect(money(0.004)).toBe('$0.00')
    expect(money(9.5)).toBe('$9.50')
    expect(money(99.99)).toBe('$99.99')
    expect(money(100)).toBe('$100')
    expect(money(1234.56)).toBe('$1,235')
    expect(money(9999999)).toBe('$9,999,999')
  })
  it('never rounds a two-decimal amount up into a mismatched format', () => {
    expect(money(99.999)).toBe('$100')
  })
  it('abbreviates large amounts when compact', () => {
    expect(money(9999, true)).toBe('$9,999')
    expect(money(10000, true)).toBe('$10.0k')
    expect(money(12345, true)).toBe('$12.3k')
    expect(money(99999, true)).toBe('$100.0k')
    expect(money(100000, true)).toBe('$100k')
    expect(money(999999, true)).toBe('$1000k')
    expect(money(1e6, true)).toBe('$1.00M')
    expect(money(2.5e6, true)).toBe('$2.50M')
    expect(money(1e7, true)).toBe('$10.0M')
    expect(money(9.99e8, true)).toBe('$999.0M')
  })
  it('always abbreviates billions', () => {
    expect(money(1e9)).toBe('$1.0B')
    expect(money(2.34e9, true)).toBe('$2.3B')
    expect(money(1e10)).toBe('$10B')
  })
  it('puts the sign before the currency symbol for negative amounts', () => {
    expect(money(-5)).toBe('-$5.00')
    expect(money(-12345, true)).toBe('-$12.3k')
    expect(money(NaN)).toBe('$0.00')
    expect(money(Infinity)).toBe('$0.00')
  })
})

describe('lookups', () => {
  it('falls back to the generic block for unknown types', () => {
    expect(defOf('ec2').svc).toBe('EC2')
    expect(defOf('who-knows')).toBe(CATALOG.block)
    expect(defOf('')).toBe(CATALOG.block)
    expect(defOf('constructor')).toBe(CATALOG.block)
    expect(defOf('__proto__')).toBe(CATALOG.block)
    expect(defaultProps('who-knows')).toEqual({ fee: 0 })
    expect(defaultProps('users')).toEqual({})
  })
  it('knows the role and provider of each component', () => {
    expect([roleOf('ec2'), roleOf('gcp-gce'), roleOf('az-vm')]).toEqual(['ec2', 'ec2', 'ec2'])
    expect([roleOf('gcp-sql'), roleOf('az-sql'), roleOf('gcp-alloydb')]).toEqual(['rds', 'rds', 'aurora'])
    expect(roleOf('apprunner')).toBe('paas')
    expect(roleOf('nope')).toBe('block')
    expect([providerOf('ec2'), providerOf('gcp-gce'), providerOf('az-vm'), providerOf('users'), providerOf('nope')]).toEqual(['aws', 'gcp', 'azure', 'any', 'any'])
  })
  it('names and colours a component, preferring its own', () => {
    expect(nodeName(node('a', 'ec2'))).toBe('Virtual machine')
    expect(nodeName(node('a', 'ec2', 0, 0, { name: 'web' }))).toBe('web')
    expect(nodeName(node('a', 'ec2', 0, 0, { name: '' }))).toBe('Virtual machine')
    expect(nodeColor(node('a', 'ec2'))).toBe(defOf('ec2').color)
    expect(nodeColor(node('a', 'ec2', 0, 0, { color: '#123456' }))).toBe('#123456')
  })
})

describe('equivalent', () => {
  it('returns the same definition for the same cloud and for neutral components', () => {
    expect(equivalent('ec2', 'aws')).toBe(defOf('ec2'))
    expect(equivalent('users', 'gcp')).toBe(defOf('users'))
    expect(equivalent('block', 'azure')).toBe(defOf('block'))
    expect(equivalent('gcp-gce', 'gcp')).toBe(defOf('gcp-gce'))
  })
  it('finds the first-choice counterpart in each direction', () => {
    expect(equivalent('ec2', 'gcp')!.type).toBe('gcp-gce')
    expect(equivalent('ec2', 'azure')!.type).toBe('az-vm')
    expect(equivalent('az-vm', 'aws')!.type).toBe('ec2')
    expect(equivalent('gcp-sql', 'azure')!.type).toBe('az-sql')
    expect(equivalent('az-cosmos', 'gcp')!.type).toBe('gcp-firestore')
    expect(equivalent('s3', 'azure')!.type).toBe('az-blob')
    expect(equivalent('gcp-pubsub', 'aws')!.type).toBe('sns')
  })
  it('falls back to the nearest service where a cloud has no direct counterpart', () => {
    expect(equivalent('eventbridge', 'azure')!.type).toBe('az-eventgrid') // via sns
    expect(equivalent('gcp-alloydb', 'aws')!.type).toBe('rds')
    expect(equivalent('gcp-spanner', 'azure')!.type).toBe('az-sql')
    expect(equivalent('docdb', 'gcp')!.type).toBe('gcp-firestore')
    expect(equivalent('msk', 'azure')!.type).toBe('az-eventhubs')
    expect(equivalent('glacier', 'gcp')!.type).toBe('gcp-gcs')
    expect(equivalent('appsync', 'azure')!.type).toBe('az-apim')
    expect(equivalent('shield', 'gcp')!.type).toBe('gcp-armor')
    expect(equivalent('athena', 'azure')!.type).toBe('az-synapse')
    expect(equivalent('az-streamanalytics', 'aws')!.type).toBe('kinesis')
  })
  it('returns nothing when there is no reasonable counterpart', () => {
    expect(equivalent('igw', 'gcp')).toBeUndefined()
    expect(equivalent('igw', 'azure')).toBeUndefined()
    expect(equivalent('quicksight', 'gcp')!.type).toBe('gcp-looker')
    expect(equivalent('gcp-scheduler', 'azure')!.type).toBe('az-eventgrid') // scheduler → event bus → topic
  })
  it('every component maps somewhere or nowhere, never to the wrong cloud', () => {
    for (const d of CATALOG_LIST) for (const p of ['aws', 'gcp', 'azure'] as const) {
      const e = equivalent(d.type, p)
      if (e) expect(e.provider === p || e.provider === 'any', `${d.type} → ${p}`).toBe(true)
    }
    // the known gaps: Google Cloud has no email service here, Azure no certificate manager, and only AWS models an internet gateway
    const homeless = CATALOG_LIST.filter((d) => (['aws', 'gcp', 'azure'] as const).some((p) => !equivalent(d.type, p))).map((d) => d.type)
    expect(homeless).toEqual(['igw', 'ses', 'acm', 'gcp-certs', 'az-email'])
  })
})

describe('translateDoc', () => {
  const src = docOf([
    node('vm', 'ec2', 1, 2, { name: 'web', color: '#111111', notes: 'n', scale: 2, props: { ...defaultProps('ec2'), count: 4, disk: 80, os: 'windows', family: 'm5' } }),
    node('db', 'rds', 5, 2, { props: { ...defaultProps('rds'), engine: 'mysql', multiAZ: true, replicas: 2, storage: 300 } }),
    node('gw', 'igw'), node('u', 'users'), node('g', 'gcp-gcs'),
  ])
  it('counts what moved and what had no equivalent, leaving the source untouched', () => {
    const before = JSON.stringify(src)
    const r = translateDoc(src, 'gcp')
    expect(r.moved).toBe(2)
    expect(r.kept).toBe(1)
    expect(JSON.stringify(src)).toBe(before)
    expect(r.doc.nodes.map((n) => n.type)).toEqual(['gcp-gce', 'gcp-sql', 'igw', 'users', 'gcp-gcs'])
    expect(r.doc.edges).toBe(src.edges)
  })
  it('keeps identity, position, appearance and notes', () => {
    const vm = translateDoc(src, 'azure').doc.nodes[0]
    expect(vm).toMatchObject({ id: 'vm', x: 1, y: 2, name: 'web', color: '#111111', notes: 'n', scale: 2, type: 'az-vm' })
  })
  it('carries over settings both sides understand and defaults the rest', () => {
    const [vm, db] = translateDoc(src, 'gcp').doc.nodes
    expect(vm.props).toEqual({ machine: 'e2-standard-2', os: 'windows', count: 4, disk: 80 })
    expect(db.props).toEqual({ engine: 'mysql', tier: 'db-custom-2-7680', multiAZ: true, replicas: 2, storage: 300 })
  })
  it('drops a select value the target does not offer', () => {
    const d = docOf([node('db', 'rds', 0, 0, { props: { ...defaultProps('rds'), engine: 'aurora' } }), node('f', 'lambda', 0, 0, { props: { ...defaultProps('lambda'), memory: '128' } })])
    const [db, f] = translateDoc(d, 'gcp').doc.nodes
    expect(db.props.engine).toBe('postgres')
    expect(f.props.memory).toBe('512')
  })
  it('only carries a metered value when it means the same thing on both sides', () => {
    // SQS "Requests" (key requests) vs Cloud Tasks "Operations" (m0): different keys, so defaults apply; the DLQ toggle is shared
    const q = translateDoc(docOf([node('q', 'sqs', 0, 0, { props: { ...defaultProps('sqs'), requests: 999, dlq: true } })]), 'gcp').doc.nodes[0]
    expect(q.type).toBe('gcp-tasks')
    expect(q.props).toEqual({ m0: 10, dlq: true })
    // Cloud Tasks m0 "Operations" → Service Bus m0 "Operations": same label, carried
    const sb = translateDoc(docOf([node('q', 'gcp-tasks', 0, 0, { props: { m0: 77, dlq: true } })]), 'azure').doc.nodes[0]
    expect(sb.props).toEqual({ m0: 77, dlq: true })
    // Memorystore m0 "Capacity" → DocumentDB? no: pick a pair whose m0 labels differ
    const cdn = translateDoc(docOf([node('c', 'gcp-lb', 0, 0, { props: { m0: 9, m1: 1234 } })]), 'azure').doc.nodes[0]
    expect(cdn.type).toBe('az-appgw')
    expect(cdn.props).toEqual({ m0: 1, m1: 5 }) // "Forwarding rules"/"Data processed" are not "Gateways"/"Capacity units"
  })
  it('is a no-op for a blueprint already on that cloud', () => {
    const r = translateDoc(translateDoc(src, 'gcp').doc, 'gcp')
    expect(r.moved).toBe(0)
    expect(r.kept).toBe(1) // the internet gateway still has nowhere to go
    expect(translateDoc(docOf(), 'aws')).toMatchObject({ moved: 0, kept: 0 })
    const neutral = docOf([node('u', 'users'), node('b', 'block')])
    expect(translateDoc(neutral, 'azure').doc.nodes).toEqual(neutral.nodes)
  })
})

describe('docProviders', () => {
  it('lists the clouds in use, most-used first, ignoring neutral components', () => {
    expect(docProviders(docOf())).toEqual([])
    expect(docProviders(docOf([node('u', 'users'), node('b', 'block')]))).toEqual([])
    expect(docProviders(docOf([node('a', 'ec2'), node('b', 'gcp-gce'), node('c', 'gcp-sql'), node('d', 'az-vm'), node('e', 'az-sql'), node('f', 'az-blob'), node('u', 'users')]))).toEqual(['azure', 'gcp', 'aws'])
  })
})
