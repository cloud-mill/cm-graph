import { describe, expect, it } from 'vitest'
import { analyze } from './advisor'
import { CATALOG_LIST, costOf, defOf, defaultProps, docCost, equivalent, providerOf, roleOf, translateDoc } from './catalog'
import { ISO, FLAT, makeCam, makeProj, pt, unproject, upright } from './iso'
import { autoLayout, inArea } from './layout'
import { route } from './linePath'
import { coerceDoc } from './storage'
import { TEMPLATES } from './templates'
import { emptyDoc } from './types'
import { SAMPLE_TF, exportTerraform, importTerraform, parseResources } from './terraform'
import { GLYPHS } from '../canvas/glyphs'
import { sceneBounds } from '../canvas/Scene'
import { moveItems } from './store'

describe('projection', () => {
  it('round-trips through unproject at any blend', () => {
    for (const t of [0, 0.3, 0.7, 1]) {
      const p = makeProj(t)
      const [sx, sy] = pt(p, 7.5, -3.25)
      const [x, y] = unproject(p, sx, sy)
      expect(x).toBeCloseTo(7.5, 6)
      expect(y).toBeCloseTo(-3.25, 6)
    }
  })
  it('is true isometric at t=0 and flat at t=1', () => {
    expect(Math.hypot(...pt(ISO, 1, 0))).toBeCloseTo(40, 6)
    const flat = pt(FLAT, 1, 2, 5)
    expect(flat[0] / flat[1]).toBeCloseTo(0.5, 6) // undistorted plan, height ignored
    expect(pt(FLAT, 1, 2, 0)[1]).toBeCloseTo(flat[1], 6)
  })
  it('orbits: unproject inverts any camera angle and faces swap with the view', () => {
    for (const yaw of [0, 30, 45, 120, 200, 315, -40]) for (const pitch of [12, 35, 60, 90]) {
      const p = makeCam(yaw, pitch)
      const [x, y] = unproject(p, ...pt(p, -4.5, 9.25))
      expect(x).toBeCloseTo(-4.5, 5)
      expect(y).toBeCloseTo(9.25, 5)
    }
    // from the home view +x and +y faces are towards the camera; from the opposite side they are not
    expect(makeCam(45, 35).c > 0 && makeCam(45, 35).d > 0).toBe(true)
    expect(makeCam(225, 35).c < 0 && makeCam(225, 35).d < 0).toBe(true)
    // text laid along the upright basis always runs screen-right and reads top-down
    for (const yaw of [10, 100, 190, 280]) {
      const p = makeCam(yaw, 40), { u, v } = upright(p)
      expect(u[0] * p.a + u[1] * p.b).toBeGreaterThan(0)
      expect(v[0] * p.c + v[1] * p.d).toBeGreaterThan(0)
    }
  })
})

describe('catalog', () => {
  it('every component has a glyph, defaults and a finite cost', () => {
    for (const d of CATALOG_LIST) {
      expect(GLYPHS[d.glyph], d.type).toBeTruthy()
      const c = costOf({ id: 'x', type: d.type, x: 0, y: 0, props: defaultProps(d.type) }, 'us-east-1')
      expect(Number.isFinite(c.monthly)).toBe(true)
      expect(c.monthly).toBeGreaterThanOrEqual(0)
    }
  })
  it('prices EC2 and applies region and commitment modifiers', () => {
    const n = { id: 'a', type: 'ec2', x: 0, y: 0, props: { ...defaultProps('ec2'), family: 'm5', size: 'xlarge', count: 2, disk: 0 } }
    const base = costOf(n, 'us-east-1').monthly
    expect(base).toBeCloseTo(0.096 * 2 * 730 * 2, 4)
    // Frankfurt publishes m5.xlarge at $0.23 an hour; a 1-year no-upfront reservation in N. Virginia is $0.121
    expect(costOf(n, 'eu-central-1').monthly).toBeCloseTo(0.23 * 730 * 2, 4)
    expect(costOf(n, 'us-east-1', 'commit1').monthly).toBeCloseTo(0.121 * 730 * 2, 4)
  })
})

describe('routing', () => {
  it('produces orthogonal segments', () => {
    const pts = route({ x: 0, y: 0 }, { x: 8, y: 6 })
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = Math.abs(pts[i + 1][0] - pts[i][0]), dy = Math.abs(pts[i + 1][1] - pts[i][1])
      expect(Math.min(dx, dy)).toBeLessThan(1e-9)
    }
    expect(route({ x: 0, y: 0 }, { x: 6, y: 0 })).toHaveLength(2)
  })
})

describe('templates', () => {
  it('are valid, connected and priced', () => {
    for (const t of TEMPLATES) {
      const d = t.make()
      const ids = new Set(d.nodes.map((n) => n.id))
      expect(d.nodes.length).toBeGreaterThan(8)
      for (const e of d.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true)
      expect(docCost(d).total).toBeGreaterThan(100)
      // no two components overlap
      for (const a of d.nodes) for (const b of d.nodes) if (a !== b) expect(Math.abs(a.x - b.x) >= 2 || Math.abs(a.y - b.y) >= 2, `${t.id}: ${a.name}/${b.name}`).toBe(true)
    }
  })
})

describe('advisor', () => {
  it('flags single-AZ databases and fixes them', () => {
    const d = TEMPLATES[0].make()
    const r = analyze(d)
    const f = r.findings.find((x) => x.id.startsWith('multiaz'))!
    expect(f).toBeTruthy()
    const fixed = f.fix!.apply(d)
    expect(analyze(fixed).findings.some((x) => x.id.startsWith('multiaz'))).toBe(false)
    expect(analyze(fixed).score).toBeGreaterThan(r.score)
  })
  it('estimates savings that match the real price delta', () => {
    const d = TEMPLATES[0].make()
    const f = analyze(d).findings.find((x) => x.id.startsWith('graviton'))!
    const before = docCost(d).total
    expect(before - docCost(f.fix!.apply(d)).total).toBeCloseTo(f.saving!, 4)
  })
  it('flags databases exposed to clients', () => {
    const d = TEMPLATES[0].make()
    const users = d.nodes.find((n) => n.type === 'users')!, db = d.nodes.find((n) => n.type === 'rds')!
    d.edges.push({ id: 'e', from: users.id, to: db.id, style: 'solid', arrow: 'end', width: 2 })
    expect(analyze(d).findings.some((x) => x.id.startsWith('exposed'))).toBe(true)
  })
})

describe('clouds', () => {
  const CORE = ['ec2', 'lambda', 'ecs', 'eks', 'rds', 'dynamodb', 'elasticache', 's3', 'ebs', 'efs', 'alb', 'cloudfront', 'route53', 'apigw', 'nat', 'sqs', 'sns', 'redshift', 'cloudwatch', 'waf', 'cognito', 'secrets']
  it('has a sound catalog entry for every component', () => {
    expect(new Set(CATALOG_LIST.map((d) => d.type)).size).toBe(CATALOG_LIST.length)
    for (const d of CATALOG_LIST) {
      expect(GLYPHS[d.glyph], d.type + ' glyph').toBeTruthy()
      const c = costOf({ id: 'x', type: d.type, x: 0, y: 0, props: defaultProps(d.type) }, 'us-east-1')
      expect(Number.isFinite(c.monthly) && c.monthly >= 0, d.type + ' cost').toBe(true)
      if (d.summary) expect(typeof d.summary(defaultProps(d.type))).toBe('string')
    }
  })
  it('covers the core building blocks on all three clouds', () => {
    for (const p of ['gcp', 'azure'] as const) for (const role of CORE) expect(equivalent(role, p), `${p} ${role}`).toBeTruthy()
    for (const p of ['aws', 'gcp', 'azure']) expect(CATALOG_LIST.filter((d) => d.provider === p).length).toBeGreaterThan(45)
  })
  it('translates a blueprint between clouds and back', () => {
    const aws = TEMPLATES[0].make()
    for (const p of ['gcp', 'azure'] as const) {
      const t = translateDoc(aws, p)
      expect(t.kept).toBe(0)
      expect(t.doc.nodes.every((n) => ['any', p].includes(providerOf(n.type)))).toBe(true)
      expect(t.doc.edges).toEqual(aws.edges)
      const back = translateDoc(t.doc, 'aws').doc
      expect(back.nodes.map((n) => n.type)).toEqual(aws.nodes.map((n) => n.type))
      // sizing that both sides understand survives the trip
      const vm = aws.nodes.find((n) => n.type === 'ec2')!
      expect(t.doc.nodes.find((n) => n.id === vm.id)!.props.count).toBe(vm.props.count)
    }
  })
  it('reviews other clouds with the same rules', () => {
    const d = emptyDoc()
    d.nodes.push({ id: 'db', type: 'gcp-sql', x: 0, y: 0, props: defaultProps('gcp-sql') }, { id: 'q', type: 'az-servicebus', x: 4, y: 0, props: defaultProps('az-servicebus') }, { id: 'f', type: 'az-functions', x: 8, y: 0, props: defaultProps('az-functions') })
    d.edges.push({ id: 'e', from: 'q', to: 'f', style: 'solid', arrow: 'end', width: 2 })
    const ids = analyze(d).findings.map((f) => f.id)
    expect(ids).toContain('multiaz:db')
    expect(ids).toContain('dlq:q')
  })
  it('round-trips Google Cloud and Azure through Terraform', () => {
    for (const p of ['gcp', 'azure'] as const) {
      const src = translateDoc(TEMPLATES[0].make(), p).doc
      const hcl = exportTerraform(src)
      expect(hcl).toContain(p === 'gcp' ? 'provider "google"' : 'provider "azurerm"')
      expect(hcl).not.toContain('provider "aws"')
      const back = importTerraform(hcl).doc
      const want = src.nodes.filter((n) => defOf(n.type).tf).map((n) => n.type).sort()
      expect(back.nodes.filter((n) => providerOf(n.type) !== 'any').map((n) => n.type).sort()).toEqual(want)
      const vm = src.nodes.find((n) => roleOf(n.type) === 'ec2')!
      expect(back.nodes.find((n) => n.type === vm.type)!.props.machine).toBe(vm.props.machine)
    }
  })
})

describe('component size', () => {
  it('routes connections to the centre and edge of a resized component', () => {
    const big = { x: 10, y: 0, scale: 2 }
    const r = route({ x: 0, y: 0 }, big)
    // ends are pulled back to each footprint, further for the bigger one
    expect(r[0][0]).toBeCloseTo(1.9)
    expect(r[r.length - 1][0]).toBeCloseTo(12 - 2.04)
    expect(r[r.length - 1][1]).toBeCloseTo(2) // arrives on the row of the big component's centre
    expect(route({ x: 0, y: 0 }, { x: 10, y: 0 })).toEqual(route({ x: 0, y: 0, scale: 1 }, { x: 10, y: 0, scale: 1 }))
  })
  it('uses the real footprint for area membership and bounds', () => {
    const area = { id: 'a', x: 0, y: 0, w: 4, d: 4, name: '', color: '', kind: 'group' as const }
    expect(inArea(area, { x: 3, y: 3 })).toBe(true) // centre (4,4) sits on the border
    expect(inArea(area, { x: 3, y: 3, scale: 2 })).toBe(false) // centre (5,5) is outside
    const plain = sceneBounds({ ...emptyDoc(), nodes: [{ id: 'n', type: 'ec2', x: 0, y: 0, props: {} }] }, ISO, 0)
    const large = sceneBounds({ ...emptyDoc(), nodes: [{ id: 'n', type: 'ec2', x: 0, y: 0, props: {}, scale: 3 }] }, ISO, 0)
    expect(large.w).toBeGreaterThan(plain.w * 1.8)
  })
  it('keeps a valid size through save and load, and drops a bad one', () => {
    const d = emptyDoc()
    d.nodes.push({ id: 'a', type: 'ec2', x: 0, y: 0, props: {}, scale: 1.5 }, { id: 'b', type: 'ec2', x: 4, y: 0, props: {}, scale: 99 })
    const back = coerceDoc(JSON.parse(JSON.stringify(d)))!
    expect(back.nodes[0].scale).toBe(1.5)
    expect(back.nodes[1].scale).toBeUndefined()
  })
})

describe('terraform', () => {
  it('parses nested blocks and strings with braces', () => {
    const r = parseResources('resource "aws_instance" "a" {\n  user_data = "x { y }"\n  tags = { Name = "n" }\n}\nresource "aws_s3_bucket" "b" {}')
    expect(r.map((x) => x.key)).toEqual(['aws_instance.a', 'aws_s3_bucket.b'])
  })
  it('imports the sample into a connected, non-overlapping diagram', () => {
    const { doc, mapped } = importTerraform(SAMPLE_TF)
    expect(mapped).toBe(10)
    const name = (id: string) => doc.nodes.find((n) => n.id === id)!.name
    const edges = doc.edges.map((e) => `${name(e.from)}>${name(e.to)}`)
    expect(edges).toContain('web>web') // alb "web" -> asg "web"
    expect(edges).toContain('web>orders')
    expect(edges).toContain('web>sessions')
    expect(edges).toContain('emails>mailer')
    expect(edges).toContain('edge>assets')
    expect(edges).not.toContain('sessions>orders')
    const asg = doc.nodes.find((n) => n.type === 'ec2')!
    expect(asg.props.count).toBe(3)
    expect(doc.nodes.find((n) => n.type === 'rds')!.props).toMatchObject({ family: 'm5', size: 'large', storage: 200, multiAZ: false })
    for (const a of doc.nodes) for (const b of doc.nodes) if (a !== b) expect(Math.abs(a.x - b.x) >= 2 || Math.abs(a.y - b.y) >= 2).toBe(true)
    // the VPC wraps exactly its members
    const vpc = doc.areas[0]
    const inside = doc.nodes.filter((n) => inArea(vpc, n)).map((n) => n.type).sort()
    expect(inside).toEqual(['alb', 'ec2', 'elasticache', 'rds'])
  })
  it('exports HCL that re-imports to the same component set', () => {
    const d = TEMPLATES[1].make()
    const hcl = exportTerraform(d)
    const back = importTerraform(hcl).doc
    const count = (doc: typeof d, t: string) => doc.nodes.filter((n) => n.type === t).length
    for (const t of ['lambda', 'dynamodb', 'sqs', 'sns', 'apigw', 's3', 'opensearch', 'cognito']) expect(count(back, t), t).toBe(count(d, t))
  })
})

describe('layout & editing', () => {
  it('auto-layout never overlaps nodes and keeps area members inside', () => {
    for (const t of TEMPLATES) {
      const d = t.make()
      const before = new Map(d.areas.map((a) => [a.id, d.nodes.filter((n) => inArea(a, n)).map((n) => n.id)]))
      const l = autoLayout(d)
      for (const a of l.nodes) for (const b of l.nodes) if (a !== b) expect(Math.abs(a.x - b.x) >= 2 || Math.abs(a.y - b.y) >= 2).toBe(true)
      for (const a of l.areas) for (const id of before.get(a.id)!) expect(inArea(a, l.nodes.find((n) => n.id === id)!), t.id + ':' + a.name).toBe(true)
    }
  })
  it('auto-layout keeps outsiders out of areas and sibling areas apart', () => {
    for (const t of TEMPLATES) {
      const d = t.make()
      const before = new Map(d.areas.map((a) => [a.id, new Set(d.nodes.filter((n) => inArea(a, n)).map((n) => n.id))]))
      const l = autoLayout(d)
      for (const a of l.areas) for (const n of l.nodes) if (!before.get(a.id)!.has(n.id)) expect(inArea(a, n), `${t.id}: ${n.name} in ${a.name}`).toBe(false)
      const subs = l.areas.filter((a) => a.kind === 'subnet')
      for (const a of subs) for (const b of subs) if (a !== b) {
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d
        expect(overlap, `${t.id}: ${a.name} overlaps ${b.name}`).toBe(false)
      }
    }
  })
  it('moving an area carries its contents', () => {
    const d = TEMPLATES[0].make()
    const vpc = d.areas.find((a) => a.kind === 'vpc')!
    const inside = d.nodes.filter((n) => inArea(vpc, n))
    const m = moveItems(d, d, new Set([vpc.id]), 3, -2)
    for (const n of inside) expect(m.nodes.find((x) => x.id === n.id)).toMatchObject({ x: n.x + 3, y: n.y - 2 })
    const outside = d.nodes.find((n) => !inArea(vpc, n))!
    expect(m.nodes.find((x) => x.id === outside.id)).toMatchObject({ x: outside.x, y: outside.y })
  })
  it('coerceDoc rejects junk and drops dangling edges', () => {
    expect(coerceDoc({ foo: 1 })).toBeNull()
    const d = coerceDoc({ nodes: [{ id: 'a', type: 'ec2', x: 1, y: 2 }], edges: [{ from: 'a', to: 'zzz' }] })!
    expect(d.nodes).toHaveLength(1)
    expect(d.edges).toHaveLength(0)
  })
})
