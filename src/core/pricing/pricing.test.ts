import { describe, expect, it } from 'vitest'
import { CATALOG_LIST, HOURS, REGIONS, costOf, defaultProps, docCost } from '../catalog'
import { TEMPLATES } from '../templates'
import type { NodeT, PricingModel } from '../types'
import { docOf, node } from '../../test/helpers'
import { ALLOWANCES, RATE_CARD, credits, ec2Rate, flat, nodeRate, rdsRate } from './index'
import card from './aws-rates.json'

/**
 * The reference numbers in this file were looked up independently of the rate
 * card's generator, on 2026-11-20:
 *
 *   AWS    Price List Bulk API offer files, and the EC2 on-demand pricing page feed
 *   Azure  Retail Prices API (prices.azure.com), East US
 *   GCP    cloud.google.com pricing pages for each product, Iowa
 *
 * They are written here as the provider publishes them (per hour, per GB, per
 * million) and multiplied out in the test, so a wrong unit conversion in the
 * app cannot hide behind a matching mistake in the expectation.
 */

const n = (type: string, props: Record<string, any> = {}): NodeT => node('x', type, 0, 0, { props: { ...defaultProps(type), ...props } })
const cost = (type: string, props: Record<string, any> = {}, region = 'us-east-1', model: PricingModel = 'ondemand') => costOf(n(type, props), region, model)
const line = (type: string, props: Record<string, any>, i: number, region = 'us-east-1', model: PricingModel = 'ondemand') => cost(type, props, region, model).lines[i]
const US = { region: 'us-east-1', model: 'ondemand' as const }

describe('the rate card', () => {
  it('says where it came from and when', () => {
    expect(RATE_CARD.source).toBe('AWS Price List Bulk API')
    expect(RATE_CARD.generated).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (const d of Object.values(RATE_CARD.published)) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (const s of ['AmazonEC2', 'AmazonRDS', 'AmazonS3', 'AWSLambda']) expect(RATE_CARD.published[s]).toBeTruthy()
  })
  it('covers every region the app offers', () => {
    expect(RATE_CARD.regions.sort()).toEqual(REGIONS.map((r) => r.id).sort())
  })
  it('holds only sane numbers: positive, reserved never above on-demand, Windows never below Linux', () => {
    for (const [region, r] of Object.entries(card.regions as Record<string, any>)) {
      for (const [type, row] of Object.entries(r.ec2 as Record<string, (number | null)[]>)) {
        const [linux, windows, r1, r3] = row
        expect(linux, `${region} ${type}`).toBeGreaterThan(0)
        if (windows != null) expect(windows, `${region} ${type} windows`).toBeGreaterThanOrEqual(linux!)
        if (r1 != null) expect(r1, `${region} ${type} 1yr`).toBeLessThan(linux!)
        if (r1 != null && r3 != null) expect(r3, `${region} ${type} 3yr`).toBeLessThan(r1)
      }
      for (const [engine, classes] of Object.entries(r.rds as Record<string, Record<string, (number | null)[]>>))
        for (const [cls, [od, r1, r3]] of Object.entries(classes)) {
          expect(od, `${region} ${engine} ${cls}`).toBeGreaterThan(0)
          // AWS publishes a few reserved rates for licensed engines that are no cheaper than on-demand; the engine never applies those
          const q1 = rdsRate({ region, model: 'commit1' }, engine, cls)!, q3 = rdsRate({ region, model: 'commit3' }, engine, cls)!
          expect(q1.usd, `${region} ${engine} ${cls} 1yr`).toBeLessThanOrEqual(od!)
          expect(q3.usd, `${region} ${engine} ${cls} 3yr`).toBeLessThanOrEqual(od!)
          void r1; void r3
        }
      for (const [k, v] of Object.entries(r.flat as Record<string, number>)) expect(v, `${region} ${k}`).toBeGreaterThan(0)
    }
  })
  it('matches the published N. Virginia prices it was checked against', () => {
    // EC2 on-demand, Linux then Windows, USD per hour
    const ec2: Record<string, [number, number?]> = {
      't3.large': [0.0832, 0.1108], 't4g.large': [0.0672], 't2.large': [0.0928], 'm4.large': [0.1], 'm5.large': [0.096, 0.188], 'm6i.xlarge': [0.192, 0.376],
      'm7g.large': [0.0816], 'c7g.large': [0.0725], 'r5.2xlarge': [0.504, 0.872], 'r7g.large': [0.1071], 'g5.xlarge': [1.006], 'g5.2xlarge': [1.212],
    }
    for (const [type, [linux, windows]] of Object.entries(ec2)) {
      expect(ec2Rate(US, type)!.usd, type).toBe(linux)
      if (windows) expect(ec2Rate(US, type, true)!.usd, type + ' windows').toBe(windows)
    }
    // RDS Single-AZ, USD per hour
    expect(rdsRate(US, 'postgres', 'm5.large')!.usd).toBe(0.178)
    expect(rdsRate(US, 'mysql', 'm5.large')!.usd).toBe(0.171)
    expect(rdsRate(US, 'mariadb', 'm5.large')!.usd).toBe(0.171)
    expect(rdsRate(US, 'postgres', 't3.large')!.usd).toBe(0.145)
    expect(rdsRate(US, 'postgres', 'r5.xlarge')!.usd).toBe(0.5)
    expect(rdsRate(US, 'sqlserver', 'm5.large')!.usd).toBe(0.977)
    expect(rdsRate(US, 'aurora', 'r7g.large')!.usd).toBe(0.276)
    expect(rdsRate(US, 'aurora', 't3.large')!.usd).toBe(0.164)
    expect(nodeRate(US, 'cache', 'cache.m7g.large')!.usd).toBe(0.158)
    expect(nodeRate(US, 'cache', 'cache.t4g.micro')!.usd).toBe(0.016)
    expect(nodeRate(US, 'redshift', 'ra3.xlplus')!.usd).toBe(1.086)
    expect(nodeRate(US, 'redshift', 'ra3.4xlarge')!.usd).toBe(3.26)
    expect(nodeRate(US, 'redshift', 'dc2.large')!.usd).toBe(0.25)
    expect(nodeRate(US, 'search', 'm6g.large.search')!.usd).toBe(0.128)
    expect(nodeRate(US, 'search', 't3.small.search')!.usd).toBe(0.036)
    // single rates, as published
    const rates: Record<string, number> = {
      'lambda.req': 0.2 / 1e6, 'lambda.gbs': 0.0000166667, 'lambda.gbs.arm': 0.0000133334, 'fargate.vcpu': 0.04048, 'fargate.gb': 0.004445, 'eks.cluster': 0.1,
      'alb.hour': 0.0225, 'alb.lcu': 0.008, 'nlb.hour': 0.0225, 'nlb.lcu': 0.006, 'nat.hour': 0.045, 'nat.gb': 0.045,
      'ebs.gp3': 0.08, 'ebs.io2': 0.125, 'ebs.st1': 0.045, 'ebs.sc1': 0.015, 'rds.gp3': 0.115, 'aurora.storage': 0.1, 'search.gp3': 0.122, 'efs.standard': 0.3,
      's3.standard': 0.023, 's3.ia': 0.0125, 's3.gir': 0.004, 's3.get': 0.4 / 1e6, egress: 0.09,
      'ddb.read': 0.125 / 1e6, 'ddb.write': 0.625 / 1e6, 'ddb.storage': 0.25, 'kinesis.shard': 0.015, 'kinesis.put': 0.014 / 1e6,
      'cw.metric': 0.3, 'cw.logs': 0.5, 'route53.zone': 0.5, 'route53.queries': 0.4 / 1e6, 'apigw.http': 1 / 1e6, 'apigw.rest': 3.5 / 1e6,
      'waf.acl': 5, 'waf.rule': 1, 'waf.req': 0.6 / 1e6, 'cognito.lite': 0.0055, 'secrets.secret': 0.4, 'kms.key': 1,
      'sqs.standard': 0.4 / 1e6, 'sqs.fifo': 0.5 / 1e6, 'sns.publish': 0.5 / 1e6, 'events.custom': 1 / 1e6, 'cloudfront.gb': 0.085, 'cloudfront.https': 1 / 1e6,
    }
    for (const [key, usd] of Object.entries(rates)) expect(flat(US, key)!.usd, key).toBeCloseTo(usd, 12)
  })
  it('matches published reserved prices: effective hourly, no upfront', () => {
    expect(ec2Rate({ region: 'us-east-1', model: 'commit1' }, 'm5.large')!.usd).toBe(0.06)
    expect(ec2Rate({ region: 'us-east-1', model: 'commit3' }, 'm5.large')!.usd).toBe(0.041)
    expect(rdsRate({ region: 'us-east-1', model: 'commit1' }, 'postgres', 'm5.large')!.usd).toBe(0.114)
    expect(nodeRate({ region: 'us-east-1', model: 'commit1' }, 'cache', 'cache.m7g.large')!.usd).toBe(0.107)
    expect(nodeRate({ region: 'us-east-1', model: 'commit3' }, 'redshift', 'ra3.xlplus')!.usd).toBe(0.4725)
  })
  it('matches published prices in other regions, service by service', () => {
    const at = (region: string) => ({ region, model: 'ondemand' as const })
    // EC2 is dearer abroad by an amount that differs per region
    expect(ec2Rate(at('eu-central-1'), 'm5.large')!.usd).toBe(0.115)
    expect(ec2Rate(at('sa-east-1'), 'm5.large')!.usd).toBe(0.153)
    expect(ec2Rate(at('us-west-2'), 'm5.large')!.usd).toBe(0.096)
    // S3 moves by a different amount again
    expect(flat(at('eu-central-1'), 's3.standard')!.usd).toBe(0.0245)
    expect(flat(at('sa-east-1'), 's3.standard')!.usd).toBe(0.0405)
    // and Lambda does not move at all
    for (const r of REGIONS) expect(flat(at(r.id), 'lambda.gbs')!.usd, r.id).toBe(0.0000166667)
    expect(flat(at('eu-west-1'), 'nat.hour')!.usd).toBe(0.048)
    expect(flat(at('eu-central-1'), 'fargate.vcpu')!.usd).toBe(0.04656)
    expect(flat(at('ap-northeast-1'), 'egress')!.usd).toBe(0.114)
    // global services are the same everywhere
    for (const r of REGIONS) { expect(flat(at(r.id), 'cloudfront.gb')!.usd).toBe(0.085); expect(flat(at(r.id), 'route53.zone')!.usd).toBe(0.5) }
  })
})

describe('AWS components, N. Virginia, on demand', () => {
  it('EC2: the published price of the exact instance type, times hours, times count', () => {
    expect(line('ec2', { family: 'm5', size: 'large', count: 1 }, 0)).toMatchObject({ monthly: 0.096 * HOURS, basis: 'fixed' })
    expect(line('ec2', { family: 'm5', size: 'large', count: 4 }, 0).monthly).toBeCloseTo(4 * 0.096 * 730, 6)
    expect(line('ec2', { family: 'm5', size: 'large', count: 2, disk: 30 }, 1)).toMatchObject({ monthly: 60 * 0.08, basis: 'fixed' })
  })
  it('EC2 sizes are not assumed to scale: a GPU instance twice the size is not twice the price', () => {
    const x = line('ec2', { family: 'g5', size: 'xlarge' }, 0).monthly, xx = line('ec2', { family: 'g5', size: '2xlarge' }, 0).monthly
    expect(x).toBeCloseTo(1.006 * 730, 6)
    expect(xx).toBeCloseTo(1.212 * 730, 6)
    expect(xx / x).toBeLessThan(1.25)
  })
  it('Windows is the published Windows price, which is not a fixed surcharge', () => {
    expect(line('ec2', { family: 'm5', size: 'large', os: 'windows' }, 0).monthly).toBeCloseTo(0.188 * 730, 6)
    expect(line('ec2', { family: 't3', size: 'large', os: 'windows' }, 0).monthly).toBeCloseTo(0.1108 * 730, 6) // not 0.0832 + 0.092
  })
  it('a size or platform AWS does not sell is priced as a stand-in and says so', () => {
    const nano = line('ec2', { family: 'm5', size: 'nano' }, 0)
    expect(nano.basis).toBe('estimate')
    expect(nano.note).toMatch(/AWS does not sell m5\.nano/)
    expect(nano.monthly).toBeCloseTo((0.096 / 16) * 730, 6)
    const arm = line('ec2', { family: 'm7g', size: 'large', os: 'windows' }, 0)
    expect(arm.basis).toBe('estimate')
    expect(arm.note).toMatch(/Windows is not sold on m7g\.large/)
    expect(arm.monthly).toBeCloseTo(0.0816 * 730, 6)
    expect(line('ec2', { family: 'nope', size: 'large' }, 0)).toMatchObject({ monthly: 0, basis: 'estimate' })
  })
  it('Lambda: requests and GB-seconds, cheaper on Arm', () => {
    // 5M requests of 120 ms at 512 MB = 300,000 GB-seconds
    const c = cost('lambda', { requests: 5, duration: 120, memory: '512', arch: 'arm64' })
    expect(c.lines[0]).toMatchObject({ monthly: 1, basis: 'usage' })
    expect(c.lines[1].monthly).toBeCloseTo(300_000 * 0.0000133334, 6)
    expect(cost('lambda', { requests: 5, duration: 120, memory: '512', arch: 'x86_64' }).lines[1].monthly).toBeCloseTo(300_000 * 0.0000166667, 6)
  })
  it('Fargate and EKS', () => {
    expect(cost('ecs', { tasks: 3, vcpu: '0.5', mem: '1' }).monthly).toBeCloseTo(3 * (0.5 * 0.04048 + 1 * 0.004445) * 730, 6)
    const eks = cost('eks', { nodes: 3, family: 'm7g', size: 'xlarge' })
    expect(eks.lines[0].monthly).toBeCloseTo(0.1 * 730, 6)
    expect(eks.lines[1].monthly).toBeCloseTo(3 * 0.1632 * 730, 6)
  })
  it('RDS: each engine at its own published price, Multi-AZ doubling instance and storage', () => {
    const one = (p: object) => cost('rds', { family: 'm5', size: 'large', storage: 100, replicas: 0, multiAZ: false, ...p })
    expect(one({ engine: 'postgres' }).lines[0].monthly).toBeCloseTo(0.178 * 730, 6)
    expect(one({ engine: 'mysql' }).lines[0].monthly).toBeCloseTo(0.171 * 730, 6)
    // SQL Server Standard with its licence is several times the open-source engines, not a little more
    expect(one({ engine: 'sqlserver' }).lines[0].monthly).toBeCloseTo(0.977 * 730, 6)
    expect(one({ engine: 'postgres' }).lines[1].monthly).toBeCloseTo(100 * 0.115, 6)
    const maz = one({ engine: 'postgres', multiAZ: true, replicas: 2 })
    expect(maz.lines[0].monthly).toBeCloseTo(2 * 0.178 * 730, 6)
    expect(maz.lines[1].monthly).toBeCloseTo(100 * 0.23, 6)
    expect(maz.lines[2].monthly).toBeCloseTo(2 * 0.178 * 730, 6) // replicas are Single-AZ instances
  })
  it('Aurora is one writer plus its replicas: "Multi-AZ" adds no phantom standby and storage is billed once', () => {
    const base = { engine: 'aurora', family: 'r7g', size: 'large', storage: 200 }
    const plain = cost('rds', { ...base, multiAZ: false, replicas: 2 })
    const maz = cost('rds', { ...base, multiAZ: true, replicas: 2 })
    expect(plain.lines[0].monthly).toBeCloseTo(0.276 * 730, 6)
    expect(plain.lines[1].monthly).toBeCloseTo(2 * 0.276 * 730, 6)
    expect(plain.lines[2].monthly).toBeCloseTo(200 * 0.1, 6)
    expect(maz.monthly).toBeCloseTo(plain.monthly, 6)
    expect(maz.lines[0].note).toMatch(/no separate Multi-AZ standby/)
    expect(plain.lines[2].note).toMatch(/I\/O requests.*not included/)
  })
  it('an engine that is not sold on a class is priced as a stand-in and says so', () => {
    const l = line('rds', { engine: 'aurora', family: 'm5', size: 'large' }, 0)
    expect(l.basis).toBe('estimate')
    expect(l.note).toMatch(/Aurora is not sold on db\.m5/)
  })
  it('caches, warehouses, search and storage', () => {
    expect(cost('elasticache', { node: 'cache.m7g.large', nodes: 2 }).monthly).toBeCloseTo(2 * 0.158 * 730, 6)
    expect(cost('redshift', { node: 'ra3.xlplus', nodes: 4 }).monthly).toBeCloseTo(4 * 1.086 * 730, 6)
    const os = cost('opensearch', { node: 'm6g.large.search', nodes: 2, storage: 100 })
    expect(os.lines[0].monthly).toBeCloseTo(2 * 0.128 * 730, 6)
    expect(os.lines[1].monthly).toBeCloseTo(200 * 0.122, 6)
    const s3 = cost('s3', { storage: 500, class: 'standard', requests: 10, egress: 50 })
    expect(s3.lines.map((l) => +l.monthly.toFixed(4))).toEqual([500 * 0.023, 10 * 0.4, 50 * 0.09])
    expect(cost('s3', { storage: 1000, class: 'glacier-instant', requests: 0, egress: 0 }).monthly).toBeCloseTo(4, 6)
    expect(cost('ebs', { vol: 'gp3', size: 200 }).monthly).toBeCloseTo(16, 6)
    expect(cost('efs', { storage: 100 }).monthly).toBeCloseTo(30, 6)
    const ddb = cost('dynamodb', { reads: 20, writes: 5, storage: 25 })
    expect(ddb.lines.map((l) => +l.monthly.toFixed(4))).toEqual([2.5, 3.125, 6.25])
  })
  it('network, messaging and the rest: each at its published rate', () => {
    expect(cost('alb', { kind: 'application', lcu: 5 }).lines.map((l) => +l.monthly.toFixed(3))).toEqual([16.425, 29.2])
    expect(cost('alb', { kind: 'network', lcu: 5 }).lines[1].monthly).toBeCloseTo(5 * 0.006 * 730, 6)
    expect(cost('cloudfront', { transfer: 500, requests: 20 }).lines.map((l) => +l.monthly.toFixed(2))).toEqual([42.5, 20])
    expect(cost('nat', { data: 200 }).lines.map((l) => +l.monthly.toFixed(2))).toEqual([32.85, 9])
    expect(cost('route53', { zones: 1, queries: 10 }).monthly).toBeCloseTo(4.5, 6)
    expect(cost('apigw', { kind: 'http', requests: 40 }).monthly).toBeCloseTo(40, 6)
    expect(cost('apigw', { kind: 'rest', requests: 40 }).monthly).toBeCloseTo(140, 6)
    expect(cost('sqs', { kind: 'standard', requests: 10 }).monthly).toBeCloseTo(4, 6)
    expect(cost('sqs', { kind: 'fifo', requests: 10 }).monthly).toBeCloseTo(5, 6)
    expect(cost('sns', { messages: 5 }).monthly).toBeCloseTo(2.5, 6)
    expect(cost('eventbridge', { events: 5 }).monthly).toBeCloseTo(5, 6)
    expect(cost('kinesis', { shards: 8, records: 900 }).lines.map((l) => +l.monthly.toFixed(2))).toEqual([87.6, 12.6])
    expect(cost('cloudwatch', { metrics: 50, logs: 50 }).monthly).toBeCloseTo(40, 6)
    expect(cost('waf', { rules: 10, requests: 20 }).monthly).toBeCloseTo(5 + 10 + 12, 6)
    expect(cost('cognito', { mau: 25000 }).monthly).toBeCloseTo(25000 * 0.0055, 6)
    expect(cost('secrets', { secrets: 12, keys: 3 }).monthly).toBeCloseTo(7.8, 6)
  })
  it('things with no price cost nothing, and a fee you type is exactly that fee, in any region', () => {
    for (const t of ['users', 'internet', 'mobile', 'onprem', 'igw', 'iam']) expect(cost(t).monthly, t).toBe(0)
    expect(cost('saas', { fee: 250 }).monthly).toBe(250)
    expect(cost('saas', { fee: 250 }, 'sa-east-1', 'commit3').monthly).toBe(250)
    expect(cost('block', { fee: 0 }).lines).toEqual([])
  })
})

describe('regions', () => {
  it('each line moves by its own published regional price, not by one factor', () => {
    const us = cost('ec2', { family: 'm5', size: 'large', disk: 0 }), de = cost('ec2', { family: 'm5', size: 'large', disk: 0 }, 'eu-central-1')
    expect(de.monthly / us.monthly).toBeCloseTo(0.115 / 0.096, 6)
    expect(cost('lambda', {}, 'sa-east-1').monthly).toBeCloseTo(cost('lambda').monthly, 6)
    expect(cost('route53', {}, 'sa-east-1').monthly).toBeCloseTo(cost('route53').monthly, 6)
    expect(cost('cloudfront', {}, 'ap-northeast-1').monthly).toBeCloseTo(cost('cloudfront').monthly, 6)
    expect(cost('s3', { storage: 1000, requests: 0, egress: 0 }, 'sa-east-1').monthly).toBeCloseTo(40.5, 6)
  })
  it('AWS lines stay verified abroad; a region with no price list falls back to N. Virginia and says so', () => {
    for (const l of cost('ec2', {}, 'eu-west-1').lines) expect(l.basis).toBe('fixed')
    const odd = cost('ec2', { family: 'm5', size: 'large' }, 'mars-north-1')
    expect(odd.lines[0].basis).toBe('estimate')
    expect(odd.lines[0].note).toMatch(/N\. Virginia rate/)
    expect(odd.lines[0].monthly).toBeCloseTo(0.096 * 730, 6)
  })
  it('Google Cloud and Azure are priced at US rates abroad, marked as estimates, never silently scaled', () => {
    for (const type of ['gcp-gce', 'az-vm', 'gcp-firestore', 'az-appgw']) {
      const us = cost(type), eu = cost(type, {}, 'eu-central-1')
      expect(eu.monthly, type).toBeCloseTo(us.monthly, 6)
      for (const l of eu.lines) { expect(l.basis, type).toBe('estimate'); expect(l.note, type).toMatch(/Priced at US rates/) }
    }
  })
})

describe('commitments', () => {
  it('uses the published reserved price of each instance, not a flat percentage', () => {
    const ec2 = (m: PricingModel) => line('ec2', { family: 'm5', size: 'large' }, 0, 'us-east-1', m)
    expect(ec2('commit1').monthly).toBeCloseTo(0.06 * 730, 6)
    expect(ec2('commit3').monthly).toBeCloseTo(0.041 * 730, 6)
    expect(ec2('commit1').note).toMatch(/Reserved for 1 year, no upfront/)
    expect(line('rds', { engine: 'postgres', family: 'm5', size: 'large' }, 0, 'us-east-1', 'commit1').monthly).toBeCloseTo(0.114 * 730, 6)
    expect(cost('elasticache', { node: 'cache.m7g.large', nodes: 1 }, 'us-east-1', 'commit3').monthly).toBeCloseTo(0.082 * 730, 6)
  })
  it('leaves alone what cannot be reserved: storage, requests, and services with no reserved price', () => {
    for (const m of ['commit1', 'commit3'] as const) {
      expect(line('ec2', { disk: 100 }, 1, 'us-east-1', m).monthly).toBeCloseTo(8, 6)
      expect(cost('lambda', {}, 'us-east-1', m).monthly).toBeCloseTo(cost('lambda').monthly, 6)
      expect(cost('s3', {}, 'us-east-1', m).monthly).toBeCloseTo(cost('s3').monthly, 6)
      expect(cost('nat', {}, 'us-east-1', m).monthly).toBeCloseTo(cost('nat').monthly, 6)
    }
    const dc2 = line('redshift', { node: 'dc2.large', nodes: 1 }, 0, 'us-east-1', 'commit1')
    expect(dc2.monthly).toBeCloseTo(0.25 * 730, 6)
    expect(dc2.note).toMatch(/No reserved price is published/)
    const fargate = line('ecs', {}, 0, 'us-east-1', 'commit1')
    expect(fargate.monthly).toBeCloseTo(line('ecs', {}, 0).monthly, 6)
    expect(fargate.note).toMatch(/Savings Plans.*not modelled/)
  })
  it('never costs more than on demand, for any component', () => {
    for (const d of CATALOG_LIST) {
      const od = cost(d.type).monthly
      expect(cost(d.type, {}, 'us-east-1', 'commit1').monthly, d.type).toBeLessThanOrEqual(od + 1e-9)
      expect(cost(d.type, {}, 'us-east-1', 'commit3').monthly, d.type).toBeLessThanOrEqual(cost(d.type, {}, 'us-east-1', 'commit1').monthly + 1e-9)
    }
  })
  it('long-tail AWS services have no verified reserved price, so they are not discounted', () => {
    for (const t of ['docdb', 'neptune', 'msk', 'sagemaker']) expect(cost(t, {}, 'us-east-1', 'commit3').monthly, t).toBeCloseTo(cost(t).monthly, 6)
  })
})

describe('Google Cloud and Azure', () => {
  it('Compute Engine: published machine prices and committed-use discounts', () => {
    expect(line('gcp-gce', { machine: 'e2-standard-2' }, 0)).toMatchObject({ basis: 'fixed' })
    expect(line('gcp-gce', { machine: 'e2-standard-2' }, 0).monthly).toBeCloseTo(0.067 * 730, 6)
    expect(line('gcp-gce', { machine: 'n2-standard-4' }, 0).monthly).toBeCloseTo(0.1942 * 730, 6)
    expect(line('gcp-gce', { machine: 'e2-standard-2', disk: 100 }, 1).monthly).toBeCloseTo(10, 6) // balanced PD, $0.10 per GB
    expect(line('gcp-gce', { machine: 'e2-standard-2' }, 0, 'us-east-1', 'commit1').monthly).toBeCloseTo(0.067 * 0.63 * 730, 6)
    expect(line('gcp-gce', { machine: 'e2-standard-2' }, 0, 'us-east-1', 'commit3').monthly).toBeCloseTo(0.067 * 0.45 * 730, 6)
    // no committed-use price was verified for Arm machines
    expect(line('gcp-gce', { machine: 't2a-standard-2' }, 0, 'us-east-1', 'commit3').monthly).toBeCloseTo(0.077 * 730, 6)
    expect(line('gcp-gce', { machine: 'e2-standard-2', os: 'windows' }, 0).basis).toBe('estimate')
  })
  it('Cloud SQL: per-vCPU and per-GiB rates, high availability doubling, its own discount', () => {
    // Enterprise edition: 2 vCPU at $0.0413 plus 7.5 GiB at $0.007
    const hourly = 2 * 0.0413 + 7.5 * 0.007
    expect(line('gcp-sql', { tier: 'db-custom-2-7680' }, 0).monthly).toBeCloseTo(hourly * 730, 4)
    expect(line('gcp-sql', { tier: 'db-custom-2-7680', multiAZ: true }, 0).monthly).toBeCloseTo(2 * hourly * 730, 4)
    expect(line('gcp-sql', { tier: 'db-custom-2-7680' }, 0, 'us-east-1', 'commit1').monthly).toBeCloseTo(hourly * 0.75 * 730, 4)
    expect(line('gcp-sql', { tier: 'db-custom-2-7680', engine: 'sqlserver' }, 0).basis).toBe('estimate')
  })
  it('Firestore, Identity Platform and the queues, at their published rates', () => {
    // $0.03 per 100,000 reads, $0.09 per 100,000 writes, about $0.15 per GiB-month
    expect(cost('gcp-firestore', { m0: 20, m1: 5, m2: 25 }).lines.map((l) => +l.monthly.toFixed(2))).toEqual([6, 4.5, 3.75])
    expect(cost('gcp-identity', { m0: 60 }).monthly).toBeCloseTo(60_000 * 0.0055, 6)
    expect(cost('gcp-tasks', { m0: 10 }).monthly).toBeCloseTo(4, 6)
    expect(cost('gcp-apigw', { m0: 10 }).monthly).toBeCloseTo(30, 6)
  })
  it('Azure VMs: published Linux and Windows prices and reserved discounts', () => {
    expect(line('az-vm', { machine: 'Standard_D2s_v5' }, 0).monthly).toBeCloseTo(0.096 * 730, 6)
    expect(line('az-vm', { machine: 'Standard_D2s_v5', os: 'windows' }, 0)).toMatchObject({ basis: 'fixed' })
    expect(line('az-vm', { machine: 'Standard_D2s_v5', os: 'windows' }, 0).monthly).toBeCloseTo(0.188 * 730, 6)
    expect(line('az-vm', { machine: 'Standard_D2s_v5' }, 0, 'us-east-1', 'commit1').monthly).toBeCloseTo(0.096 * 0.62 * 730, 6)
    expect(line('az-vm', { machine: 'Standard_D2s_v5' }, 0, 'us-east-1', 'commit3').monthly).toBeCloseTo(0.096 * 0.4 * 730, 6)
    // B-series lists no reservation
    expect(line('az-vm', { machine: 'Standard_B2s' }, 0, 'us-east-1', 'commit3').monthly).toBeCloseTo(0.0416 * 730, 6)
    expect(line('az-vm', { machine: 'Standard_D2ps_v5', os: 'windows' }, 0).basis).toBe('estimate')
  })
  it('Azure services checked against the Retail Prices API', () => {
    // Application Gateway Standard v2: $0.20 an hour fixed, $0.008 per capacity-unit hour
    expect(cost('az-appgw', { m0: 1, m1: 5 }).lines.map((l) => +l.monthly.toFixed(2))).toEqual([146, 29.2])
    // a Standard C3 (6 GB) Redis cache is $0.45 an hour
    expect(cost('az-redis', { m0: 1 }).monthly).toBeCloseTo(0.45 * 730, 6)
    expect(line('az-sql', { tier: 'GP_Standard_D2ds_v5' }, 0).monthly).toBeCloseTo(0.178 * 730, 6)
    expect(line('az-blob', { storage: 1000, class: 'standard' }, 0).monthly).toBeCloseTo(20.8, 6)
  })
  it('anything not checked against a price list is an estimate and says so', () => {
    for (const t of ['gcp-run', 'az-containerapps', 'gcp-search', 'az-frontdoor', 'msk', 'bedrock', 'docdb']) {
      for (const l of cost(t).lines) { expect(l.basis, t).toBe('estimate'); expect(l.note, t).toBeTruthy() }
    }
  })
})

describe('free allowances', () => {
  const fn = (id: string) => node(id, 'lambda', 0, 0, { props: { requests: 5, duration: 120, memory: '512', arch: 'arm64' } })
  it('belong to the account: four functions share one free grant, they do not get four', () => {
    const one = docCost(docOf([fn('a')])), four = docCost(docOf([fn('a'), fn('b'), fn('c'), fn('d')]))
    const credit = (c: typeof one, key: string) => c.credits.find((x) => x.key === key)?.monthly ?? 0
    expect(credit(one, 'aws.lambda.req')).toBeCloseTo(0.2, 6) // 1M requests at $0.20 per million
    expect(credit(four, 'aws.lambda.req')).toBeCloseTo(0.2, 6)
    expect(credit(four, 'aws.lambda.gbs')).toBeCloseTo(400_000 * 0.0000133334, 6)
    expect(four.total).toBeCloseTo(4 * (1 + 300_000 * 0.0000133334) - 0.2 - 400_000 * 0.0000133334, 6)
  })
  it('never exceed what was used', () => {
    const tiny = docCost(docOf([node('a', 'lambda', 0, 0, { props: { requests: 0.2, duration: 100, memory: '128', arch: 'arm64' } })]))
    expect(tiny.total).toBeCloseTo(0, 6)
    expect(tiny.list).toBeGreaterThan(0)
  })
  it('CloudFront: the first terabyte and ten million requests', () => {
    const cdn = (transfer: number, requests: number) => docCost(docOf([node('c', 'cloudfront', 0, 0, { props: { transfer, requests } })]))
    expect(cdn(500, 8).total).toBeCloseTo(0, 6)
    expect(cdn(2048, 30).total).toBeCloseTo(1024 * 0.085 + 20, 6)
  })
  it('Cognito and Identity Platform: the free users are free once', () => {
    expect(docCost(docOf([node('c', 'cognito', 0, 0, { props: { mau: 25000 } })])).total).toBeCloseTo(15000 * 0.0055, 6)
    expect(docCost(docOf([node('c', 'gcp-identity', 0, 0, { props: { m0: 25 } })])).total).toBeCloseTo(0, 6) // under 50,000
    expect(docCost(docOf([node('c', 'gcp-identity', 0, 0, { props: { m0: 80 } })])).total).toBeCloseTo(30_000 * 0.0055, 6)
  })
  it('internet egress: one hundred free gigabytes across every bucket', () => {
    const b = (id: string) => node(id, 's3', 0, 0, { props: { storage: 0, class: 'standard', requests: 0, egress: 80 } })
    expect(docCost(docOf([b('a'), b('b')])).total).toBeCloseTo(60 * 0.09, 6)
  })
  it('a mixed rate is credited at the average actually paid', () => {
    const lines = [
      { label: 'arm', monthly: 300_000 * 0.0000133334, meter: { key: 'aws.lambda.gbs', qty: 300_000, rate: 0.0000133334 } },
      { label: 'x86', monthly: 300_000 * 0.0000166667, meter: { key: 'aws.lambda.gbs', qty: 300_000, rate: 0.0000166667 } },
    ]
    expect(credits(lines)[0].monthly).toBeCloseTo((lines[0].monthly + lines[1].monthly) * (400_000 / 600_000), 8)
  })
  it('every allowance names its source, and none is a trial offer', () => {
    for (const a of ALLOWANCES) { expect(a.source).toMatch(/^https:\/\/(aws\.amazon\.com|cloud\.google\.com|azure\.microsoft\.com)\//); expect(a.qty).toBeGreaterThan(0) }
    expect(new Set(ALLOWANCES.map((a) => a.key)).size).toBe(ALLOWANCES.length)
  })
})

describe('whole blueprints', () => {
  it('total is list price less allowances, and the three kinds of figure add up to the list price', () => {
    for (const t of TEMPLATES) {
      const c = docCost(t.make())
      expect(c.byBasis.fixed + c.byBasis.usage + c.byBasis.estimate, t.id).toBeCloseTo(c.list, 6)
      expect(c.total, t.id).toBeCloseTo(c.list - c.credits.reduce((s, x) => s + x.monthly, 0), 6)
      expect([...c.byCategory.values()].reduce((s, v) => s + v, 0), t.id).toBeCloseTo(c.list, 6)
      expect([...c.perNode.values()].reduce((s, v) => s + v.monthly, 0), t.id).toBeCloseTo(c.list, 6)
    }
  })
  it('every line of every template is classified, and AWS templates rest on no estimates at all', () => {
    for (const t of TEMPLATES) {
      const c = docCost(t.make())
      for (const n of c.perNode.values()) for (const l of n.lines) expect(['fixed', 'usage', 'estimate']).toContain(l.basis)
      if (!/gcp|azure/.test(t.id)) expect(c.byBasis.estimate, t.id).toBe(0)
    }
  })
  it('the three-tier template, worked by hand from published rates', () => {
    const c = docCost(TEMPLATES.find((t) => t.id === 'three-tier')!.make())
    const list =
      0.5 * 730 + 400 * 0.115 +               // db.r5.xlarge PostgreSQL, 400 GB gp3
      2 * 0.158 * 730 +                       // 2 × cache.m7g.large
      2 * (2 * 0.096 * 730 + 60 * 0.08) +     // two groups of 2 × m5.large with 30 GB each
      500 * 0.085 + 20 * 1 +                  // CloudFront: 500 GB, 20M HTTPS requests
      0.0225 * 730 + 5 * 0.008 * 730 +        // ALB and 5 LCU
      0.045 * 730 + 200 * 0.045 +             // NAT gateway and 200 GB
      50 * 0.3 + 50 * 0.5 +                   // CloudWatch metrics and logs
      120 * 0.023 + 10 * 0.4 + 50 * 0.09 +    // S3: storage, GETs, egress
      12 * 0.4 + 3 * 1 +                      // secrets and keys
      0.5 + 10 * 0.4                          // Route 53
    const free = 500 * 0.085 + 10 * 1 + 50 * 0.09 // CloudFront's free terabyte and 10M requests, and the free 100 GB of egress
    expect(c.list).toBeCloseTo(list, 4)
    expect(c.total).toBeCloseTo(list - free, 4)
    expect(c.total).toBeCloseTo(1088.135, 2)
  })
  it('the Kubernetes template counts its Aurora cluster once: a writer and two replicas', () => {
    const doc = TEMPLATES.find((t) => t.id === 'k8s')!.make()
    const db = doc.nodes.find((x) => x.type === 'rds')!
    expect(db.props).toMatchObject({ engine: 'aurora', family: 'r7g', size: '2xlarge', replicas: 2 })
    expect(costOf(db, doc.region).monthly).toBeCloseTo(3 * 1.106 * 730 + 800 * 0.1, 4)
  })
  it('template totals, as displayed', () => {
    const totals = Object.fromEntries(TEMPLATES.map((t) => [t.id, Math.round(docCost(t.make()).total * 100) / 100]))
    expect(totals).toEqual({ 'three-tier': 1088.14, serverless: 502.01, data: 7055.48, k8s: 5081.18, 'gcp-serverless': 666.99, 'azure-three-tier': 1252.66 })
  })
  it('an empty blueprint, and one of only free things, cost nothing', () => {
    expect(docCost(docOf())).toMatchObject({ total: 0, list: 0, credits: [] })
    expect(docCost(docOf([node('u', 'users'), node('i', 'igw')])).total).toBe(0)
  })
  it('settings missing from an older file fall back to the defaults', () => {
    expect(costOf(node('x', 'ec2', 0, 0, { props: {} }), 'us-east-1').monthly).toBeCloseTo(cost('ec2').monthly, 6)
  })
})
