import { describe, expect, it } from 'vitest'
import {
  CATALOG, CATALOG_LIST, CATEGORIES, EC2_FAMILY, PROVIDERS, RDS_CLASS, REGIONS,
  costOf, defOf, defaultProps, docProviders, equivalent, money, nodeColor, nodeName, providerOf, roleOf, translateDoc,
} from './catalog'
import { CLOUD_DEFS } from './clouds'
import { RATE_CARD } from './pricing'
import { docOf, node } from '../test/helpers'

const n = (type: string, props: Record<string, any> = {}) => node('x', type, 0, 0, { props: { ...defaultProps(type), ...props } })
const cost = (type: string, props: Record<string, any> = {}, region = 'us-east-1', model: any = 'ondemand') => costOf(n(type, props), region, model)

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
  it('has usable regions and providers', () => {
    expect(REGIONS.map((r) => r.id)).toContain('us-east-1')
    // every region the app offers has its own AWS price list loaded
    for (const r of REGIONS) { expect(RATE_CARD.regions).toContain(r.id); expect(r.gcp).toBeTruthy(); expect(r.azure).toBeTruthy() }
    expect(PROVIDERS.map((p) => p.id)).toEqual(['aws', 'gcp', 'azure'])
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
