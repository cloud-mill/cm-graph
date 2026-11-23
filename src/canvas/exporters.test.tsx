// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultProps, docCost } from '../core/catalog'
import { budgetCsv, download, pngBlob, slug, svgString } from './exporters'
import { TEMPLATES } from '../core/templates'
import { docOf, edge, node } from '../test/helpers'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml')

describe('svgString', () => {
  const doc = TEMPLATES[0].make()
  it('produces a standalone, well-formed SVG sized to the diagram', () => {
    const { svg, w, h } = svgString(doc)
    const dom = parse(svg)
    expect(dom.querySelector('parsererror')).toBeNull()
    const root = dom.documentElement
    expect(root.tagName).toBe('svg')
    expect(root.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg')
    expect(Number(root.getAttribute('width'))).toBe(Math.round(w))
    expect(Number(root.getAttribute('height'))).toBe(Math.round(h))
    const vb = root.getAttribute('viewBox')!.split(' ').map(Number)
    expect(vb[2]).toBeCloseTo(w)
    expect(vb[3]).toBeCloseTo(h)
    expect(w).toBeGreaterThan(400)
    expect(h).toBeGreaterThan(200)
  })
  it('strips editor-only attributes', () => {
    const { svg } = svgString(doc)
    expect(svg).not.toMatch(/data-kind|data-id|cursor:/)
    expect(svg).not.toMatch(/undefined|NaN/)
  })
  it('paints a background in the chosen theme unless told not to', () => {
    const first = (o: Parameters<typeof svgString>[1]) => parse(svgString(doc, o).svg).documentElement.firstElementChild!
    expect(first({}).tagName).toBe('rect')
    expect(first({}).getAttribute('fill')).toBe('#ffffff') // exports default to the light theme
    expect(first({ theme: 'dark' }).getAttribute('fill')).toBe('#060606')
    expect(first({ background: false }).tagName).not.toBe('rect')
  })
  it('includes component names unless labels are off', () => {
    expect(svgString(doc).svg).toContain('orders-db')
    expect(svgString(doc, { labels: false }).svg).not.toContain('orders-db')
    // text labels placed on the canvas are part of the drawing either way
    expect(svgString(doc, { labels: false }).svg).toContain('Three-tier web app')
  })
  it('renders the plan view and custom camera angles with different framing', () => {
    const iso = svgString(doc), flat = svgString(doc, { flat: true }), cam = svgString(doc, { cam: { yaw: 120, pitch: 60 } })
    expect(flat.svg).not.toBe(iso.svg)
    expect(cam.svg).not.toBe(iso.svg)
    expect([flat.w, flat.h]).not.toEqual([iso.w, iso.h])
    // an explicit camera wins over the flat flag
    expect(svgString(doc, { flat: true, cam: { yaw: 120, pitch: 60 } }).svg).toBe(cam.svg)
    for (const r of [flat, cam]) expect(parse(r.svg).querySelector('parsererror')).toBeNull()
  })
  it('escapes names that contain markup', () => {
    const d = docOf([node('a', 'ec2', 0, 0, { name: '<script>alert(1)</script> & "co"' })], [], { labels: [{ id: 'l', x: 0, y: 5, text: '<b>bold</b>', size: 20, dir: 'x' }] })
    const { svg } = svgString(d)
    expect(svg).not.toContain('<script>')
    expect(svg).not.toContain('<b>bold')
    const dom = parse(svg)
    expect(dom.querySelector('parsererror')).toBeNull()
    expect(dom.querySelector('script')).toBeNull()
    expect(dom.documentElement.textContent).toContain('<script>alert(1)</script> & "co"')
  })
  it('renders an empty blueprint, connections to missing components and unknown types without failing', () => {
    expect(parse(svgString(docOf()).svg).querySelector('parsererror')).toBeNull()
    const odd = docOf([node('a', 'mystery-type'), node('b', 'ec2', 4, 0, { scale: 3 })], [edge('1', 'a', 'ghost'), edge('2', 'a', 'b')])
    expect(parse(svgString(odd).svg).querySelector('parsererror')).toBeNull()
  })
  it('is deterministic for the same blueprint', () => {
    expect(svgString(doc).svg).toBe(svgString(doc).svg)
  })
})

describe('budgetCsv', () => {
  const rows = (csv: string) => csv.trimEnd().split('\n')
  it('lists one row per cost line with monthly and yearly amounts, then a total', () => {
    const d = docOf([node('a', 'ec2', 0, 0, { name: 'web', props: { ...defaultProps('ec2'), family: 'm5', size: 'large', count: 1, disk: 100 } }), node('u', 'users')], [], { region: 'us-east-1' })
    const csv = budgetCsv(d, 'ondemand')
    expect(rows(csv)).toEqual([
      'Component,Service,Category,Line item,Monthly (USD),Yearly (USD),Basis,Note',
      'web,EC2,compute,1 × m5.large,70.08,840.96,"Published rate, provisioned capacity",',
      'web,EC2,compute,100 GB gp3,8.00,96.00,"Published rate, provisioned capacity",',
      expect.stringMatching(/^Total,,,us-east-1 · ondemand,78\.08,936\.96,,"AWS prices: AWS Price List Bulk API, read \d{4}-\d\d-\d\d\. Excludes tax/),
    ])
    expect(csv.endsWith('\n')).toBe(true)
  })
  it('follows the pricing model and region', () => {
    const d = docOf([node('a', 'ec2', 0, 0, { props: { ...defaultProps('ec2'), family: 'm5', size: 'large', count: 1, disk: 0 } })], [], { region: 'eu-central-1' })
    // Frankfurt's 3-year no-upfront reserved price for m5.large is $0.05 an hour
    const last = rows(budgetCsv(d, 'commit3')).at(-1)!
    expect(last.startsWith(`Total,,,eu-central-1 · commit3,${(0.05 * 730).toFixed(2)},${(0.05 * 730 * 12).toFixed(2)},`)).toBe(true)
    expect(rows(budgetCsv(d, 'commit3'))[1]).toMatch(/Reserved for 3 years/)
  })
  it('totals match the budget for every template', () => {
    for (const t of TEMPLATES) for (const model of ['ondemand', 'commit1', 'commit3'] as const) {
      const d = t.make()
      const total = Number(rows(budgetCsv(d, model)).at(-1)!.split(',')[4])
      expect(total).toBeCloseTo(docCost(d, model).total, 1)
    }
  })
  it('quotes cells containing commas, quotes or line breaks', () => {
    const d = docOf([
      node('a', 'saas', 0, 0, { name: 'Acme, Inc.', props: { fee: 10 } }),
      node('b', 'saas', 0, 0, { name: 'The "best" API', props: { fee: 20 } }),
      node('c', 'saas', 0, 0, { name: 'two\nlines', props: { fee: 30 } }),
    ])
    const csv = budgetCsv(d, 'ondemand')
    expect(csv).toContain('"Acme, Inc.",External service,external,Subscription,10.00,120.00')
    expect(csv).toContain('"The ""best"" API",External service,external,Subscription,20.00,240.00')
    expect(csv).toContain('"two\nlines",External service')
    // a label with thousands separators is quoted too
    const big = docOf([node('f', 'lambda', 0, 0, { name: 'fn' })])
    expect(budgetCsv(big, 'ondemand')).toMatch(/fn,Lambda,compute,"[\d,]+ GB-seconds",/)
  })
  it('neutralises names a spreadsheet would run as a formula', () => {
    const d = docOf(['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\tTab'].map((name, i) => node('n' + i, 'saas', 0, 0, { name, props: { fee: 1 } })))
    const lines = rows(budgetCsv(d, 'ondemand')).slice(1, 6)
    for (const l of lines) expect(l).toMatch(/^"?'/)
    expect(lines[0].startsWith(`"'=HYPERLINK(""http://evil"",""x"")",External service,external,Subscription,1.00,12.00,`)).toBe(true)
    // ordinary names and the numeric columns are untouched
    expect(budgetCsv(docOf([node('a', 'saas', 0, 0, { name: 'plain-name', props: { fee: 1 } })]), 'ondemand')).toContain('plain-name,External service')
  })
  it('an empty or free blueprint yields a header and a zero total', () => {
    const empty = rows(budgetCsv(docOf(), 'ondemand'))
    expect(empty[0]).toBe('Component,Service,Category,Line item,Monthly (USD),Yearly (USD),Basis,Note')
    expect(empty[1].startsWith('Total,,,us-east-1 · ondemand,0.00,0.00,')).toBe(true)
    expect(empty).toHaveLength(2)
    expect(rows(budgetCsv(docOf([node('u', 'users'), node('g', 'igw')]), 'ondemand'))).toHaveLength(2)
  })
})

describe('slug', () => {
  it('makes a safe file name', () => {
    expect(slug('Three-tier Web App')).toBe('three-tier-web-app')
    expect(slug('  Prod / EU (v2)!  ')).toBe('prod-eu-v2')
    expect(slug('../../etc/passwd')).toBe('etc-passwd')
    expect(slug('Ünïcødé')).toBe('n-c-d')
    expect(slug('')).toBe('blueprint')
    expect(slug('!!!')).toBe('blueprint')
    expect(slug('日本語')).toBe('blueprint')
  })
})

describe('download', () => {
  it('clicks a temporary link carrying the file name, then cleans up', () => {
    vi.useFakeTimers()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:abc')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    let attached = false
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { attached = document.body.contains(this) })
    download('main.tf', 'resource {}')
    expect(click).toHaveBeenCalledOnce()
    expect(attached).toBe(true)
    const link = click.mock.contexts[0] as HTMLAnchorElement
    expect(link.download).toBe('main.tf')
    expect(link.href).toBe('blob:abc')
    expect(document.querySelector('a')).toBeNull()
    const blob = create.mock.calls[0][0] as Blob
    expect(blob.type).toBe('text/plain')
    expect(blob.size).toBe(11)
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(revoke).toHaveBeenCalledWith('blob:abc')
  })
  it('uses the given type for text and passes a Blob through untouched', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    download('a.csv', 'a,b', 'text/csv')
    expect((create.mock.calls[0][0] as Blob).type).toBe('text/csv')
    const png = new Blob(['x'], { type: 'image/png' })
    download('a.png', png)
    expect(create.mock.calls[1][0]).toBe(png)
  })
})

describe('pngBlob', () => {
  const doc = docOf([node('a', 'ec2'), node('b', 'rds', 6, 0)], [edge('1', 'a', 'b')])
  /** Stand-ins for the image decoder and canvas, which jsdom does not provide. */
  function fakeRaster(opts: { fail?: boolean; noBlob?: boolean } = {}) {
    const canvases: any[] = []
    class FakeImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      set src(_: string) { queueMicrotask(() => (opts.fail ? this.onerror?.() : this.onload?.())) }
    }
    vi.stubGlobal('Image', FakeImage)
    const real = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return real(tag)
      const c: any = { width: 0, height: 0, drawn: null, getContext: () => ({ drawImage: (...a: any[]) => { c.drawn = a } }), toBlob: (cb: (b: Blob | null) => void, type: string) => cb(opts.noBlob ? null : new Blob(['png'], { type })) }
      canvases.push(c)
      return c
    }) as any)
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:svg')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    return { canvases, create, revoke }
  }
  it('rasterises the SVG at the requested scale', async () => {
    const { canvases, create, revoke } = fakeRaster()
    const { w, h } = svgString(doc)
    const blob = await pngBlob(doc, {}, 2)
    expect(blob.type).toBe('image/png')
    expect((create.mock.calls[0][0] as Blob).type).toBe('image/svg+xml')
    expect([canvases[0].width, canvases[0].height]).toEqual([Math.round(w * 2), Math.round(h * 2)])
    expect(canvases[0].drawn.slice(1)).toEqual([0, 0, canvases[0].width, canvases[0].height])
    expect(revoke).toHaveBeenCalledWith('blob:svg')
    await pngBlob(doc, {}, 1)
    expect(canvases[1].width).toBe(Math.round(w))
  })
  it('caps the output at 8192 pixels on the longest side', async () => {
    const { canvases } = fakeRaster()
    const wide = docOf([node('a', 'ec2', 0, 0), node('b', 'ec2', 400, 0)])
    const { w, h } = svgString(wide)
    expect(w * 4).toBeGreaterThan(8192)
    await pngBlob(wide, {}, 4)
    expect(Math.max(canvases[0].width, canvases[0].height)).toBeLessThanOrEqual(8192)
    expect(canvases[0].width / canvases[0].height).toBeCloseTo(w / h, 1)
  })
  it('reports a failed render and still releases the temporary URL', async () => {
    const { revoke } = fakeRaster({ fail: true })
    await expect(pngBlob(doc)).rejects.toThrow('Could not rasterise diagram')
    expect(revoke).toHaveBeenCalledWith('blob:svg')
  })
  it('reports a canvas that cannot produce a file', async () => {
    const { revoke } = fakeRaster({ noBlob: true })
    await expect(pngBlob(doc)).rejects.toThrow('Export failed')
    expect(revoke).toHaveBeenCalledOnce()
  })
})
