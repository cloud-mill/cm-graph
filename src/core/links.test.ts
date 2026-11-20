import { describe, expect, it } from 'vitest'
import { docOf, edge, node } from '../test/helpers'
import { KINDS, ORIGINS, captionOf, describe as say, guessKind, kindInfo, linkProblems, traceFlow, wireOf } from './links'

const web = node('web', 'ec2', 0, 0, { name: 'web' }), api = node('api', 'lambda', 4, 0, { name: 'api' }), db = node('db', 'rds', 8, 0, { name: 'db' })
const q = node('q', 'sqs', 12, 0, { name: 'jobs' }), s3 = node('s3', 's3', 16, 0, { name: 'files' }), users = node('u', 'users', -4, 0, { name: 'Users' })
const replica = node('db2', 'rds', 8, 4, { name: 'db-replica' })

describe('kinds of connection', () => {
  it('each has a name, a meaning and a default look', () => {
    expect(KINDS.map((k) => k.id)).toEqual(['request', 'data', 'event', 'replication', 'dependency'])
    for (const k of KINDS) { expect(k.blurb.length).toBeGreaterThan(10); expect(k.verb).toBeTruthy() }
    expect(kindInfo('event')).toMatchObject({ style: 'dashed', arrow: 'end' })
    expect(kindInfo('replication')).toMatchObject({ arrow: 'both' })
    expect(kindInfo(undefined)).toBeUndefined()
  })
  it('a dependency is described as implying no traffic', () => {
    expect(kindInfo('dependency')!.blurb).toMatch(/no traffic/i)
  })
  it('guesses from what is joined: a starting point, not a fact', () => {
    expect(guessKind(web, api)).toBe('request')
    expect(guessKind(api, db)).toBe('data')
    expect(guessKind(api, s3)).toBe('data')
    expect(guessKind(api, q)).toBe('event')
    expect(guessKind(q, api)).toBe('event')
    expect(guessKind(db, replica)).toBe('replication')
  })
  it('says where a connection came from, and never calls any of it observed', () => {
    expect(Object.keys(ORIGINS)).toEqual(['drawn', 'imported', 'inferred'])
    expect(ORIGINS.inferred.blurb).toMatch(/guess/i)
    for (const o of Object.values(ORIGINS)) expect(o.blurb).not.toMatch(/observed|measured|live traffic/i)
  })
})

describe('captions and sentences', () => {
  it('joins the label with protocol and port', () => {
    expect(wireOf(edge('e', 'a', 'b', { protocol: 'HTTPS', port: '443' }))).toBe('HTTPS 443')
    expect(wireOf(edge('e', 'a', 'b', { port: '5432' }))).toBe('5432')
    expect(captionOf(edge('e', 'a', 'b', { label: 'orders', protocol: 'gRPC' }))).toBe('orders · gRPC')
    expect(captionOf(edge('e', 'a', 'b'))).toBe('')
  })
  it('describes a connection in a sentence', () => {
    const doc = docOf([web, api, db])
    expect(say(doc, edge('e', 'web', 'api', { kind: 'request', protocol: 'HTTPS', port: '443' }))).toBe('web calls api over HTTPS 443')
    expect(say(doc, edge('e', 'api', 'db', { kind: 'data' }))).toBe('api reads and writes db')
    expect(say(doc, edge('e', 'web', 'api'))).toBe('web connects to api')
    expect(say(doc, edge('e', 'web', 'api', { arrow: 'both' }))).toBe('web talks both ways with api')
    expect(say(doc, edge('e', 'web', 'api', { arrow: 'none' }))).toBe('web is connected to api')
    expect(say(doc, edge('e', 'web', 'gone'))).toBe('')
  })
})

describe('following the flow', () => {
  // users -> web -> api -> db ; api -> q ; db <-> db2 ; s3 on its own
  const doc = docOf([users, web, api, db, q, s3, replica], [
    edge('e1', 'u', 'web'), edge('e2', 'web', 'api'), edge('e3', 'api', 'db'), edge('e4', 'api', 'q'), edge('e5', 'db', 'db2', { arrow: 'both' }),
  ])
  const ids = (s: Set<string>) => [...s].sort()
  it('from a component: everything it reaches and everything that reaches it', () => {
    const f = traceFlow(doc, 'api')!
    expect(ids(f.up)).toEqual(['u', 'web'])
    expect(ids(f.down)).toEqual(['db', 'db2', 'q'])
    expect(ids(f.edges)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
    expect(ids(f.start)).toEqual(['api'])
  })
  it('from the entry point there is nothing upstream; from the far end nothing downstream but its replica', () => {
    expect(ids(traceFlow(doc, 'u')!.up)).toEqual([])
    expect(ids(traceFlow(doc, 'u')!.down)).toEqual(['api', 'db', 'db2', 'q', 'web'])
    expect(ids(traceFlow(doc, 'q')!.down)).toEqual([])
    expect(ids(traceFlow(doc, 'q')!.up)).toEqual(['api', 'u', 'web'])
  })
  it('a two-headed line is followed both ways', () => {
    const f = traceFlow(doc, 'db2')!
    expect(ids(f.down)).toEqual(['db'])
    expect(f.up.has('api')).toBe(true)
  })
  it('a line with no arrowhead is followed either way rather than dropped', () => {
    const d = docOf([web, api], [edge('e', 'web', 'api', { arrow: 'none' })])
    expect(ids(traceFlow(d, 'api')!.down)).toEqual(['web'])
    expect(ids(traceFlow(d, 'api')!.up)).toEqual(['web'])
  })
  it('from a connection: upstream of where it leaves, downstream of where it arrives', () => {
    const f = traceFlow(doc, 'e2')!
    expect(ids(f.start)).toEqual(['api', 'web'])
    expect(ids(f.up)).toEqual(['u'])
    expect(ids(f.down)).toEqual(['db', 'db2', 'q'])
    expect(f.edges.has('e2')).toBe(true)
  })
  it('something unconnected reaches nothing, and survives loops', () => {
    expect(traceFlow(doc, 's3')).toMatchObject({ up: new Set(), down: new Set() })
    const loop = docOf([web, api], [edge('a', 'web', 'api'), edge('b', 'api', 'web')])
    expect(ids(traceFlow(loop, 'web')!.down)).toEqual(['api'])
  })
  it('ignores lines to components that are gone, and unknown ids', () => {
    const d = docOf([web], [edge('e', 'web', 'gone')])
    expect(traceFlow(d, 'web')!.edges.size).toBe(0)
    expect(traceFlow(d, 'nope')).toBeNull()
  })
})

describe('connections that look wrong', () => {
  const doc = (e: Parameters<typeof edge>[3], more = [] as ReturnType<typeof edge>[], from = 'web', to = 'api') => {
    const x = edge('e', from, to, e)
    return [docOf([users, web, api, db, s3, replica], [x, ...more]), x] as const
  }
  it('an ordinary connection has nothing to say', () => {
    expect(linkProblems(...doc({ kind: 'request', protocol: 'HTTPS', port: '443' }))).toEqual([])
    expect(linkProblems(...doc({ port: '8000-8080' }))).toEqual([])
    expect(linkProblems(...doc({ port: '80, 443' }))).toEqual([])
  })
  it('outside clients reaching a database directly', () => {
    expect(linkProblems(...doc({ kind: 'data' }, [], 'u', 'db'))[0]).toMatch(/directly/)
    // a public bucket is ordinary, and a dependency is not traffic
    expect(linkProblems(...doc({ kind: 'data' }, [], 'u', 's3'))).toEqual([])
    expect(linkProblems(...doc({ kind: 'dependency' }, [], 'u', 'db'))).toEqual([])
  })
  it('ports that are not ports', () => {
    expect(linkProblems(...doc({ port: 'https' }))[0]).toMatch(/not a number/)
    expect(linkProblems(...doc({ port: '70000' }))[0]).toMatch(/1 to 65535/)
    expect(linkProblems(...doc({ port: '0' }))[0]).toMatch(/1 to 65535/)
  })
  it('replication between unlike things', () => {
    expect(linkProblems(...doc({ kind: 'replication' }, [], 'web', 'db'))[0]).toMatch(/Replication usually/)
    expect(linkProblems(...doc({ kind: 'replication' }, [], 'db', 'db2'))).toEqual([])
  })
  it('two connections that say exactly the same thing', () => {
    expect(linkProblems(...doc({ kind: 'request' }, [edge('f', 'web', 'api', { kind: 'request' })]))[0]).toMatch(/exactly the same/)
    expect(linkProblems(...doc({ kind: 'request' }, [edge('f', 'web', 'api', { kind: 'event' })]))).toEqual([])
    expect(linkProblems(...doc({ kind: 'request', port: '443' }, [edge('f', 'web', 'api', { kind: 'request', port: '8443' })]))).toEqual([])
  })
  it('a connection to something that is gone is not judged', () => {
    expect(linkProblems(docOf([web]), edge('e', 'web', 'gone'))).toEqual([])
  })
})
