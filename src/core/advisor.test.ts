import { describe, expect, it } from 'vitest'
import { type Finding, analyze } from './advisor'
import { costOf, defaultProps, docCost } from './catalog'
import { TEMPLATES } from './templates'
import type { Doc } from './types'
import { docOf, edge, node } from '../test/helpers'

const P = (type: string, props: Record<string, any> = {}) => ({ props: { ...defaultProps(type), ...props } })
const ids = (d: Doc) => analyze(d).findings.map((f) => f.id)
/** rule ids without the blueprint-wide commitment hint, which any costly fixture trips */
const own = (d: Doc) => ids(d).filter((i) => i !== 'commit')
const find = (d: Doc, prefix: string): Finding | undefined => analyze(d).findings.find((f) => f.id.startsWith(prefix))
/** applying a finding's fix must make that exact finding go away */
const fixes = (d: Doc, id: string) => {
  const f = analyze(d).findings.find((x) => x.id === id)!
  expect(f, id).toBeTruthy()
  expect(f.fix, id + ' has a fix').toBeTruthy()
  const after = f.fix!.apply(d)
  expect(after).not.toBe(d)
  expect(ids(after)).not.toContain(id)
  return { f, after }
}

describe('scoring', () => {
  it('an empty blueprint scores 100 with no findings', () => {
    expect(analyze(docOf())).toEqual({ findings: [], score: 100 })
  })
  it('a clean blueprint scores 100', () => {
    const d = docOf([node('lb', 'alb'), node('a', 'ec2', 0, 0, P('ec2', { count: 2 })), node('db', 'rds', 0, 0, P('rds', { multiAZ: true }))], [edge('1', 'lb', 'a'), edge('2', 'a', 'db')])
    expect(analyze(d)).toEqual({ findings: [], score: 100 })
  })
  it('subtracts 14 per high, 7 per medium and 2.5 per low finding', () => {
    const high = docOf([node('db', 'rds')])
    expect(analyze(high).findings.map((f) => f.severity)).toEqual(['high'])
    expect(analyze(high).score).toBe(86)
    const medium = docOf([node('lb', 'alb')])
    expect(analyze(medium).findings.map((f) => f.severity)).toEqual(['medium'])
    expect(analyze(medium).score).toBe(93)
    const low = docOf([node('a', 'ec2'), node('b', 'ec2')])
    expect(analyze(low).findings.map((f) => f.severity)).toEqual(['low', 'low'])
    expect(analyze(low).score).toBe(95)
  })
  it('never drops below zero', () => {
    const d = docOf(Array.from({ length: 12 }, (_, i) => node('db' + i, 'rds')))
    expect(analyze(d).findings.length).toBeGreaterThanOrEqual(12)
    expect(analyze(d).score).toBe(0)
  })
  it('sorts by severity, then by the largest saving', () => {
    for (const t of TEMPLATES) {
      const { findings } = analyze(t.make())
      const rank = { high: 0, medium: 1, low: 2 }
      for (let i = 1; i < findings.length; i++) {
        const a = findings[i - 1], b = findings[i]
        expect(rank[a.severity]).toBeLessThanOrEqual(rank[b.severity])
        if (a.severity === b.severity) expect(a.saving ?? 0).toBeGreaterThanOrEqual(b.saving ?? 0)
      }
      expect(new Set(findings.map((f) => f.id)).size).toBe(findings.length)
    }
  })
  it('does not mutate the blueprint it reviews, or when fixing', () => {
    const d = TEMPLATES[0].make()
    const before = JSON.stringify(d)
    for (const f of analyze(d).findings) f.fix?.apply(d)
    expect(JSON.stringify(d)).toBe(before)
  })
})

describe('reliability rules', () => {
  it('single-zone database: flagged on every cloud, fixed by enabling a standby', () => {
    for (const [type, label] of [['rds', 'Enable Multi-AZ'], ['gcp-sql', 'Enable high availability'], ['az-sql', 'Enable zone-redundant HA']]) {
      const d = docOf([node('db', type, 0, 0, { name: 'orders' })])
      const { f, after } = fixes(d, 'multiaz:db')
      expect(f).toMatchObject({ severity: 'high', pillar: 'Reliability', nodes: ['db'], title: 'orders runs in a single availability zone' })
      expect(f.fix!.label).toBe(label)
      expect(after.nodes[0].props.multiAZ).toBe(true)
    }
    expect(ids(docOf([node('db', 'rds', 0, 0, P('rds', { multiAZ: true }))]))).toEqual([])
    // non-relational stores are not held to this rule
    expect(ids(docOf([node('t', 'dynamodb')]))).toEqual([])
  })
  it('one instance behind a load balancer is a single point of failure', () => {
    const d = docOf([node('lb', 'alb'), node('vm', 'ec2', 0, 0, { name: 'web' })], [edge('1', 'lb', 'vm')])
    const { f, after } = fixes(d, 'spof:lb')
    expect(f).toMatchObject({ severity: 'high', nodes: ['lb', 'vm'], title: 'web is a single point of failure' })
    expect(after.nodes[1].props.count).toBe(2)
  })
  it('redundant targets are not a single point of failure', () => {
    const lbTo = (...targets: ReturnType<typeof node>[]) => docOf([node('lb', 'alb'), ...targets], targets.map((t, i) => edge('e' + i, 'lb', t.id)))
    expect(ids(lbTo(node('vm', 'ec2', 0, 0, P('ec2', { count: 2 }))))).not.toContain('spof:lb')
    expect(ids(lbTo(node('a', 'ec2'), node('b', 'ec2')))).not.toContain('spof:lb')
    expect(ids(lbTo(node('a', 'ec2'), node('c', 'ecs')))).not.toContain('spof:lb')
    expect(ids(lbTo(node('a', 'ec2'), node('f', 'lambda')))).not.toContain('spof:lb')
    // containers and functions alone are not judged by instance count
    expect(ids(lbTo(node('c', 'ecs', 0, 0, P('ecs', { tasks: 1 }))))).not.toContain('spof:lb')
    // other clouds follow the same rule
    expect(ids(docOf([node('lb', 'gcp-lb'), node('vm', 'gcp-gce')], [edge('1', 'lb', 'vm')]))).toContain('spof:lb')
  })
  it('a queue with consumers but no dead-letter queue', () => {
    const d = docOf([node('q', 'sqs'), node('f', 'lambda')], [edge('1', 'q', 'f')])
    const { f, after } = fixes(d, 'dlq:q')
    expect(f).toMatchObject({ severity: 'low', pillar: 'Reliability' })
    expect(after.nodes[0].props.dlq).toBe(true)
    // no consumers: nothing can fail processing yet
    expect(ids(docOf([node('p', 'lambda'), node('q', 'sqs')], [edge('1', 'p', 'q')]))).not.toContain('dlq:q')
    expect(ids(docOf([node('q', 'az-servicebus'), node('f', 'az-functions')], [edge('1', 'q', 'f')]))).toContain('dlq:q')
  })
})

describe('security rules', () => {
  it('a data store reached directly by a client', () => {
    for (const client of ['users', 'internet', 'mobile']) for (const store of ['rds', 'dynamodb', 'elasticache', 'opensearch', 'redshift', 'gcp-firestore', 'az-cosmos', 'docdb']) {
      const d = docOf([node('c', client, 0, 0, { name: 'Shoppers' }), node('s', store, 0, 0, { name: 'data' })], [edge('1', 'c', 's')])
      const f = find(d, 'exposed:')!
      expect(f, `${client} → ${store}`).toMatchObject({ severity: 'high', pillar: 'Security', nodes: ['s', 'c'], title: 'data is reachable directly by shoppers' })
      expect(f.fix).toBeUndefined()
    }
    // behind an application tier, or for stores that are meant to be public, it is fine
    expect(ids(docOf([node('u', 'users'), node('a', 'ec2'), node('s', 'rds', 0, 0, P('rds', { multiAZ: true }))], [edge('1', 'u', 'a'), edge('2', 'a', 's')]))).not.toContain('exposed:s')
    expect(ids(docOf([node('u', 'users'), node('s', 's3')], [edge('1', 'u', 's')]))).toEqual([])
  })
  it('an arrow drawn from the store to the client is not exposure, unless it is two-way', () => {
    const d = (arrow: 'end' | 'both' | 'none') => docOf([node('u', 'users'), node('s', 'dynamodb')], [edge('1', 's', 'u', { arrow })])
    expect(ids(d('end'))).toEqual([])
    expect(ids(d('none'))).toEqual([])
    expect(ids(d('both'))).toEqual(['exposed:s'])
  })
  it('a virtual machine taking traffic straight from the internet', () => {
    const d = docOf([node('u', 'internet'), node('vm', 'ec2', 0, 0, P('ec2', { family: 'm7g' }))], [edge('1', 'u', 'vm')])
    expect(find(d, 'public-vm:')).toMatchObject({ severity: 'medium', pillar: 'Security', nodes: ['vm'] })
    expect(ids(docOf([node('u', 'internet'), node('f', 'lambda')], [edge('1', 'u', 'f')]))).not.toContain('public-vm:f')
    expect(ids(docOf([node('lb', 'alb'), node('vm', 'ec2', 0, 0, P('ec2', { count: 2 }))], [edge('1', 'lb', 'vm')]))).toEqual([])
  })
  it('public entry points without a web firewall', () => {
    for (const entry of ['alb', 'apigw', 'cloudfront', 'ec2', 'apprunner', 'appsync', 'gcp-lb', 'az-apim']) {
      const d = docOf([node('u', 'users'), node('e', entry), node('x', 'lambda')], [edge('1', 'u', 'e'), edge('2', 'e', 'x')])
      expect(find(d, 'no-waf'), entry).toMatchObject({ severity: 'medium', pillar: 'Security', nodes: ['e'] })
    }
    const guarded = docOf([node('u', 'users'), node('w', 'waf'), node('e', 'alb'), node('x', 'lambda')], [edge('1', 'u', 'w'), edge('2', 'w', 'e'), edge('3', 'e', 'x')])
    expect(ids(guarded)).not.toContain('no-waf')
    // a firewall anywhere in the blueprint satisfies the rule, on any cloud
    expect(ids(docOf([node('u', 'users'), node('e', 'gcp-lb'), node('x', 'gcp-functions'), node('w', 'gcp-armor')], [edge('1', 'u', 'e'), edge('2', 'e', 'x'), edge('3', 'w', 'e')]))).not.toContain('no-waf')
    // an entry point nobody reaches from outside is not public
    expect(ids(docOf([node('a', 'lambda'), node('e', 'alb'), node('x', 'lambda')], [edge('1', 'a', 'e'), edge('2', 'e', 'x')]))).not.toContain('no-waf')
  })
  it('lists every public entry point in one finding', () => {
    const d = docOf([node('u', 'users'), node('a', 'alb'), node('b', 'apigw'), node('x', 'lambda')], [edge('1', 'u', 'a'), edge('2', 'u', 'b'), edge('3', 'a', 'x'), edge('4', 'b', 'x')])
    expect(find(d, 'no-waf')!.nodes).toEqual(['a', 'b'])
  })
})

describe('cost rules', () => {
  it('a load balancer with no targets', () => {
    const d = docOf([node('u', 'users'), node('lb', 'alb'), node('w', 'waf')], [edge('1', 'u', 'lb'), edge('2', 'w', 'lb')])
    const { f, after } = fixes(d, 'idle-lb:lb')
    expect(f).toMatchObject({ severity: 'medium', pillar: 'Cost' })
    expect(f.saving).toBeCloseTo(costOf(d.nodes[1], d.region).monthly)
    expect(after.nodes.map((n) => n.id)).toEqual(['u', 'w'])
    expect(after.edges).toEqual([])
  })
  it('previous-generation and x86 instances that have an Arm upgrade', () => {
    const vm = (family: string, extra = {}) => docOf([node('lb', 'alb'), node('vm', 'ec2', 0, 0, { name: 'api', ...P('ec2', { family, count: 2, ...extra }) })], [edge('1', 'lb', 'vm')])
    const cur = fixes(vm('m5'), 'graviton:vm')
    expect(cur.f).toMatchObject({ severity: 'low', pillar: 'Cost', title: 'Move api from m5 to m7g' })
    expect(cur.f.fix!.label).toBe('Switch to m7g.large')
    expect(cur.after.nodes[1].props.family).toBe('m7g')
    expect(cur.f.saving).toBeCloseTo(docCost(vm('m5')).total - docCost(cur.after).total)
    const old = find(vm('t2'), 'graviton:')!
    expect(old.severity).toBe('medium')
    expect(old.detail).toMatch(/^This is a previous-generation family\./)
    expect(find(vm('m5'), 'graviton:')!.detail).not.toMatch(/previous-generation/)
    // already on Arm, no upgrade path, Windows, or a saving too small to matter
    expect(ids(vm('m7g'))).toEqual([])
    expect(own(vm('g5'))).toEqual([])
    expect(ids(vm('m5', { os: 'windows' }))).toEqual([])
    expect(ids(docOf([node('vm', 'ec2', 0, 0, P('ec2', { family: 't3', size: 'nano' }))]))).toEqual([])
    // sized by region: the saving follows the regional price
    const tokyo = { ...vm('m5'), region: 'ap-northeast-1' }
    // Tokyo publishes m5.large at $0.124 and m7g.large at $0.1054 an hour
    expect(find(tokyo, 'graviton:')!.saving).toBeCloseTo(2 * (0.124 - 0.1054) * 730, 2)
    expect(find(tokyo, 'graviton:')!.saving).toBeGreaterThan(cur.f.saving!)
  })
  it('database classes with a Graviton equivalent', () => {
    const db = (extra = {}) => docOf([node('db', 'rds', 0, 0, P('rds', { family: 'r5', size: 'xlarge', multiAZ: true, ...extra }))])
    const { f, after } = fixes(db(), 'rds-graviton:db')
    expect(f).toMatchObject({ severity: 'low', title: 'Move Relational database to db.r7g' })
    expect(f.fix!.label).toBe('Switch to db.r7g.xlarge')
    expect(f.saving).toBeCloseTo(docCost(db()).total - docCost(after).total)
    expect(own(db({ family: 'r7g' }))).toEqual([])
    expect(own(db({ engine: 'sqlserver' }))).toEqual([])
    // other clouds' databases have no such class to move to
    expect(ids(docOf([node('db', 'gcp-sql', 0, 0, P('gcp-sql', { multiAZ: true }))]))).toEqual([])
  })
  it('x86 functions that would be cheaper on arm64', () => {
    const fn = (extra = {}) => docOf([node('f', 'lambda', 0, 0, P('lambda', { arch: 'x86_64', requests: 50, duration: 500, memory: '1024', ...extra }))])
    const { f, after } = fixes(fn(), 'lambda-arm:f')
    expect(after.nodes[0].props.arch).toBe('arm64')
    expect(f.saving).toBeCloseTo(docCost(fn()).total - docCost(after).total)
    expect(ids(fn({ arch: 'arm64' }))).toEqual([])
    expect(ids(fn({ requests: 0.1, duration: 10, memory: '128' }))).toEqual([]) // saves pennies
    expect(ids(docOf([node('f', 'gcp-functions')]))).toEqual([])
  })
  it('a large, rarely read bucket on the standard class', () => {
    const b = (extra = {}) => docOf([node('b', 's3', 0, 0, { name: 'lake', ...P('s3', { storage: 20000, requests: 10, class: 'standard', ...extra }) })])
    const { f, after } = fixes(b(), 's3-tier:b')
    expect(f).toMatchObject({ severity: 'low', pillar: 'Cost', title: 'Tier lake to infrequent access' })
    expect(f.fix!.label).toBe('Use Infrequent Access')
    expect(after.nodes[0].props.class).toBe('infrequent-access')
    expect(f.saving).toBeCloseTo(20000 * (0.023 - 0.0125))
    expect(ids(b({ storage: 9999 }))).toEqual([])
    expect(ids(b({ requests: 200 }))).toEqual([]) // 0.01 requests per GB: busy enough
    expect(ids(b({ class: 'infrequent-access' }))).toEqual([])
    // the fix is named after the target cloud's own storage class
    expect(find(docOf([node('b', 'gcp-gcs', 0, 0, P('gcp-gcs', { storage: 20000 }))]), 's3-tier:')!.fix!.label).toBe('Use Nearline')
    expect(find(docOf([node('b', 'az-blob', 0, 0, P('az-blob', { storage: 20000 }))]), 's3-tier:')!.fix!.label).toBe('Use Cool')
  })
  it('steady compute billed on demand, once the commitment saving passes $150', () => {
    const d = (count: number) => docOf([node('lb', 'alb'), node('vm', 'ec2', 0, 0, P('ec2', { family: 'm7g', size: 'xlarge', count }))], [edge('1', 'lb', 'vm')])
    const f = find(d(20), 'commit')!
    expect(f).toMatchObject({ severity: 'low', pillar: 'Cost', nodes: [] })
    expect(f.fix).toBeUndefined()
    expect(f.saving).toBeCloseTo(docCost(d(20)).total - docCost(d(20), 'commit1').total)
    expect(ids(d(2))).not.toContain('commit')
  })
})

describe('hygiene and robustness', () => {
  it('flags unconnected components, but not supporting services or a lone component', () => {
    expect(ids(docOf([node('a', 'ec2')]))).toEqual([])
    expect(ids(docOf([node('a', 'ec2'), node('b', 'lambda')]))).toEqual(['orphan:a', 'orphan:b'])
    for (const quiet of ['cloudwatch', 'secrets', 'iam', 'cloudtrail', 'xray', 'guardduty', 'acm', 'ecr', 'codepipeline', 'backup', 'shield', 'gcp-monitoring', 'az-keyvault']) {
      const d = docOf([node('a', 'lambda'), node('b', 'dynamodb'), node('q', quiet)], [edge('1', 'a', 'b')])
      expect(ids(d).filter((i) => i.startsWith('orphan')), quiet).toEqual([])
    }
    expect(find(docOf([node('a', 'ec2', 0, 0, { name: 'stray' }), node('b', 'users')]), 'orphan:a')).toMatchObject({ severity: 'low', pillar: 'Hygiene', title: 'stray is not connected to anything' })
  })
  it('ignores connections whose ends do not exist', () => {
    const d = docOf([node('u', 'users'), node('db', 'rds', 0, 0, P('rds', { multiAZ: true }))], [edge('1', 'u', 'ghost'), edge('2', 'ghost', 'db'), edge('3', 'nope', 'nada')])
    expect(() => analyze(d)).not.toThrow()
    expect(ids(d)).toEqual(['orphan:u', 'orphan:db'])
  })
  it('reviews components whose settings are missing as if they had the defaults', () => {
    const bare = (type: string) => ({ id: type, type, x: 0, y: 0, props: {} })
    const d = docOf([bare('alb'), bare('ec2'), bare('rds'), bare('s3'), bare('lambda'), bare('sqs')], [edge('1', 'alb', 'ec2'), edge('2', 'ec2', 'rds'), edge('3', 'ec2', 's3'), edge('4', 'sqs', 'lambda')])
    const r = analyze(d)
    expect(r.findings.map((f) => f.id).sort()).toEqual(['dlq:sqs', 'multiaz:rds', 'spof:alb'])
    for (const f of r.findings) { expect(f.title).not.toMatch(/undefined|NaN/); expect(f.fix?.label ?? '').not.toMatch(/undefined|NaN/) }
    const old = docOf([{ id: 'vm', type: 'ec2', x: 0, y: 0, props: { family: 'm5' } }])
    expect(find(old, 'graviton:')!.fix!.label).toBe('Switch to m7g.large')
  })
  it('treats unknown component types as plain blocks', () => {
    const d = docOf([node('a', 'mystery'), node('b', 'ec2')], [edge('1', 'a', 'b')])
    expect(() => analyze(d)).not.toThrow()
    expect(ids(d)).toEqual([])
  })
  it('applying every fix clears every fixable finding in the templates', () => {
    for (const t of TEMPLATES) {
      const d = t.make()
      const fixed = analyze(d).findings.filter((f) => f.fix).reduce((acc, f) => f.fix!.apply(acc), d)
      const left = analyze(fixed).findings
      expect(left.filter((f) => f.fix).map((f) => f.id), t.id).toEqual([])
      expect(analyze(fixed).score).toBeGreaterThanOrEqual(analyze(d).score)
    }
  })
})
