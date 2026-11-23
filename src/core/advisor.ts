/**
 * The advisor: a fixed set of well-architected rules run over a blueprint.
 *
 * It reads only what is drawn: component types (through their `role`, so the
 * same rule covers every cloud), their settings, and which components the
 * lines join. It knows nothing about areas, so "in a private subnet" is never
 * checked, and it never changes the blueprint itself: a fix is a function the
 * caller applies.
 */
import { EC2_FAMILY, RDS_CLASS, costOf, defOf, defaultProps, docCost, nodeName, providerOf, roleOf } from './catalog'
import type { Doc, NodeT } from './types'

export type Severity = 'high' | 'medium' | 'low'
export type Pillar = 'Reliability' | 'Security' | 'Cost' | 'Hygiene'

export interface Finding {
  /** the rule, then the component it is about (`multiaz:<node id>`), or the bare rule for a blueprint-wide finding. Stable across runs, so a finding can be recognised again after a fix. */
  id: string
  severity: Severity
  pillar: Pillar
  title: string
  detail: string
  /** ids of the components involved, the subject first; empty for a blueprint-wide finding */
  nodes: string[]
  /** estimated monthly saving in USD, for cost findings */
  saving?: number
  /** a one-click remedy. `apply` returns a new blueprint and leaves the one it is given untouched. */
  fix?: { label: string; apply: (doc: Doc) => Doc }
}

const patch = (id: string, props: Record<string, any>) => (doc: Doc): Doc => ({
  ...doc,
  nodes: doc.nodes.map((n) => (n.id === id ? { ...n, props: { ...n.props, ...props } } : n)),
})

// all three sets hold roles, not types. Clients are where outside traffic starts; DATA stores must not be
// reached straight from one; ENTRY_ROLES are what counts as a public entry point when a client reaches it.
const CLIENTS = new Set(['users', 'internet', 'mobile'])
const DATA = new Set(['rds', 'aurora', 'newsql', 'dynamodb', 'docdb', 'graphdb', 'tsdb', 'elasticache', 'opensearch', 'redshift'])
const ENTRY_ROLES = ['alb', 'apigw', 'cloudfront', 'ec2', 'paas', 'graphql']
const HA: Record<string, string> = { aws: 'Multi-AZ', gcp: 'high availability', azure: 'zone-redundant HA', any: 'a standby' }
const ENTRY = new Set(ENTRY_ROLES)
const is = (n: NodeT, role: string) => roleOf(n.type) === role

/**
 * Static analysis of a blueprint against a handful of well-architected rules.
 * Findings come back most severe first, then by largest saving. The score starts at 100 and loses
 * 14, 7 or 2.5 points per high, medium or low finding, never going below 0; an empty blueprint scores 100.
 */
export function analyze(doc: Doc): { findings: Finding[]; score: number } {
  const F: Finding[] = []
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const outs = new Map<string, NodeT[]>()
  const ins = new Map<string, NodeT[]>()
  for (const n of doc.nodes) { outs.set(n.id, []); ins.set(n.id, []) }
  // who can reach whom: a line counts in its drawn direction, and both ways when it has an arrow at each end
  for (const e of doc.edges) {
    const a = byId.get(e.from), b = byId.get(e.to)
    if (!a || !b) continue
    outs.get(a.id)!.push(b); ins.get(b.id)!.push(a)
    if (e.arrow === 'both') { outs.get(b.id)!.push(a); ins.get(a.id)!.push(b) }
  }
  // measured on the whole blueprint, so a change that also moves how much of a free allowance is used is counted honestly
  const before = docCost(doc).total
  const saving = (n: NodeT, props: Record<string, any>) =>
    before - docCost({ ...doc, nodes: doc.nodes.map((x) => (x.id === n.id ? { ...x, props: { ...x.props, ...props } } : x)) }).total

  for (const n of doc.nodes) {
    const name = nodeName(n)
    // settings a component does not carry (an older file, a hand-written import) mean the defaults
    const p = { ...defaultProps(n.type), ...n.props }
    if (is(n, 'rds') && !p.multiAZ) {
      F.push({
        id: 'multiaz:' + n.id, severity: 'high', pillar: 'Reliability', nodes: [n.id],
        title: `${name} runs in a single availability zone`,
        detail: 'A zone outage or a failed instance takes the database down until it is restored. A standby in a second zone gives automatic failover in about a minute.',
        fix: { label: `Enable ${HA[providerOf(n.type)]}`, apply: patch(n.id, { multiAZ: true }) },
      })
    }
    if (DATA.has(roleOf(n.type))) {
      const exposed = ins.get(n.id)!.filter((s) => CLIENTS.has(roleOf(s.type)))
      if (exposed.length) {
        F.push({
          id: 'exposed:' + n.id, severity: 'high', pillar: 'Security', nodes: [n.id, ...exposed.map((s) => s.id)],
          title: `${name} is reachable directly by ${nodeName(exposed[0]).toLowerCase()}`,
          detail: 'Data stores should sit behind an application or API layer in private subnets. Direct client access widens the attack surface and bypasses authorisation logic.',
        })
      }
    }
    if (is(n, 'alb')) {
      const targets = outs.get(n.id)!
      if (!targets.length) {
        F.push({
          id: 'idle-lb:' + n.id, severity: 'medium', pillar: 'Cost', nodes: [n.id], saving: costOf(n, doc.region).monthly,
          title: `${name} has no targets`,
          detail: 'This load balancer does not route to anything, but it is still billed hourly. Connect it to a target or remove it.',
          fix: { label: 'Remove load balancer', apply: (d) => ({ ...d, nodes: d.nodes.filter((x) => x.id !== n.id), edges: d.edges.filter((e) => e.from !== n.id && e.to !== n.id) }) },
        })
      } else {
        const vms = targets.filter((t) => is(t, 'ec2'))
        // instances and container tasks are counted; any other kind of target is taken to be redundant already (2)
        const capacity = targets.reduce((s, t) => s + (is(t, 'ec2') ? t.props.count ?? 1 : is(t, 'ecs') ? t.props.tasks ?? 1 : 2), 0)
        if (vms.length && capacity < 2) {
          F.push({
            id: 'spof:' + n.id, severity: 'high', pillar: 'Reliability', nodes: [n.id, vms[0].id],
            title: `${nodeName(vms[0])} is a single point of failure`,
            detail: 'The load balancer fronts exactly one instance, so it provides no redundancy. Run at least two instances across availability zones.',
            fix: { label: 'Scale to 2 instances', apply: patch(vms[0].id, { count: 2 }) },
          })
        }
      }
    }
    if (is(n, 'ec2')) {
      const direct = ins.get(n.id)!.filter((s) => CLIENTS.has(roleOf(s.type)))
      if (direct.length) {
        F.push({
          id: 'public-vm:' + n.id, severity: 'medium', pillar: 'Security', nodes: [n.id],
          title: `${name} takes traffic straight from the internet`,
          detail: 'Putting a load balancer or CDN in front of instances lets you terminate TLS, absorb spikes, and keep instances in private subnets.',
        })
      }
      const fam = EC2_FAMILY[p.family]
      if (fam?.upgrade && p.os !== 'windows') {
        const s = saving(n, { family: fam.upgrade })
        if (s > 1) {
          F.push({
            id: 'graviton:' + n.id, severity: fam.gen === 'previous' ? 'medium' : 'low', pillar: 'Cost', nodes: [n.id], saving: s,
            title: `Move ${name} from ${p.family} to ${fam.upgrade}`,
            detail: `${fam.gen === 'previous' ? 'This is a previous-generation family. ' : ''}Arm-based ${fam.upgrade} instances deliver comparable or better performance at a lower hourly rate for most Linux workloads.`,
            fix: { label: `Switch to ${fam.upgrade}.${p.size}`, apply: patch(n.id, { family: fam.upgrade }) },
          })
        }
      }
    }
    if (is(n, 'rds')) {
      const up = RDS_CLASS[p.family]?.upgrade
      if (up && p.engine !== 'sqlserver') {
        const s = saving(n, { family: up })
        if (s > 1) {
          F.push({
            id: 'rds-graviton:' + n.id, severity: 'low', pillar: 'Cost', nodes: [n.id], saving: s,
            title: `Move ${name} to db.${up}`,
            detail: 'Graviton database classes are cheaper per hour and typically faster for open-source engines. The change is an instance-class modification.',
            fix: { label: `Switch to db.${up}.${p.size}`, apply: patch(n.id, { family: up }) },
          })
        }
      }
    }
    if (is(n, 'lambda') && p.arch === 'x86_64') {
      const s = saving(n, { arch: 'arm64' })
      if (s > 0.5) {
        F.push({
          id: 'lambda-arm:' + n.id, severity: 'low', pillar: 'Cost', nodes: [n.id], saving: s,
          title: `Run ${name} on arm64`,
          detail: 'Functions on Graviton are billed about 20% less per GB-second. Most runtimes need no code change.',
          fix: { label: 'Switch to arm64', apply: patch(n.id, { arch: 'arm64' }) },
        })
      }
    }
    if (is(n, 'sqs') && !p.dlq && outs.get(n.id)!.length) {
      F.push({
        id: 'dlq:' + n.id, severity: 'low', pillar: 'Reliability', nodes: [n.id],
        title: `${name} has no dead-letter queue`,
        detail: 'Messages that repeatedly fail processing will be retried until they expire and are then lost. A DLQ keeps them for inspection and replay.',
        fix: { label: 'Add dead-letter queue', apply: patch(n.id, { dlq: true }) },
      })
    }
    if (is(n, 's3') && p.class === 'standard' && p.storage >= 10000 && p.requests / p.storage < 0.01) {
      const s = saving(n, { class: 'infrequent-access' })
      F.push({
        id: 's3-tier:' + n.id, severity: 'low', pillar: 'Cost', nodes: [n.id], saving: s,
        title: `Tier ${name} to infrequent access`,
        detail: 'A large bucket with a low request rate is a good candidate for lifecycle rules that move cold objects to a cheaper storage class.',
        fix: { label: `Use ${defOf(n.type).props.find((k) => k.key === 'class')?.options?.find((o) => o.value === 'infrequent-access')?.label ?? 'Infrequent Access'}`, apply: patch(n.id, { class: 'infrequent-access' }) },
      })
    }
    if (doc.nodes.length > 1 && !ins.get(n.id)!.length && !outs.get(n.id)!.length && !['cloudwatch', 'secrets', 'iam', 'audit', 'tracing', 'threat', 'certs', 'registry', 'cicd', 'backup', 'ddos'].includes(roleOf(n.type))) {
      F.push({
        id: 'orphan:' + n.id, severity: 'low', pillar: 'Hygiene', nodes: [n.id],
        title: `${name} is not connected to anything`,
        detail: 'Unconnected components make the diagram harder to read and often indicate forgotten or unused resources.',
      })
    }
  }

  const entries = doc.nodes.filter((n) => ENTRY.has(roleOf(n.type)) && ins.get(n.id)!.some((s) => CLIENTS.has(roleOf(s.type))))
  if (entries.length && !doc.nodes.some((n) => is(n, 'waf'))) {
    F.push({
      id: 'no-waf', severity: 'medium', pillar: 'Security', nodes: entries.map((n) => n.id),
      title: 'Public entry points have no web application firewall',
      detail: 'Internet-facing endpoints benefit from managed rule sets for common exploits, bot control and rate limiting.',
    })
  }

  // the saving is whatever a 1-year commitment takes off the whole bill, so it only reflects components that have a commitment price
  const od = docCost(doc, 'ondemand').total
  const c1 = docCost(doc, 'commit1').total
  if (od - c1 > 150) {
    F.push({
      id: 'commit', severity: 'low', pillar: 'Cost', nodes: [], saving: od - c1,
      title: 'Steady compute is billed on-demand',
      detail: `Reserving the always-on instances, databases and caches for a year, with no upfront payment, would lower this bill by ${Math.round(((od - c1) / od) * 100)}% at published reserved rates. Compare pricing models in the Budget tab.`,
    })
  }

  const weight = { high: 14, medium: 7, low: 2.5 }
  const score = Math.max(0, Math.round(100 - F.reduce((s, x) => s + weight[x.severity], 0)))
  const order = { high: 0, medium: 1, low: 2 }
  F.sort((a, b) => order[a.severity] - order[b.severity] || (b.saving ?? 0) - (a.saving ?? 0))
  return { findings: F, score: doc.nodes.length ? score : 100 }
}
