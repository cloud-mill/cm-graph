import { type Locator, type Page, expect, test as base } from '@playwright/test'

export interface SeedNode { id: string; type: string; x: number; y: number; name?: string; props?: Record<string, unknown>; scale?: number }
export interface SeedDoc {
  id: string; name: string; region: string
  nodes: (SeedNode & { props: Record<string, unknown> })[]
  edges: { id: string; from: string; to: string; style: string; arrow: string; width: number; label?: string }[]
  areas: { id: string; x: number; y: number; w: number; d: number; name: string; color: string; kind: string }[]
  labels: { id: string; x: number; y: number; text: string; size: number; dir: string }[]
  createdAt: number; updatedAt: number
}

const KEY = 'stratum:'

export function makeDoc(nodes: SeedNode[] = [], extra: Partial<SeedDoc> = {}): SeedDoc {
  return {
    id: 'e2edoc', name: 'E2E blueprint', region: 'us-east-1',
    nodes: nodes.map((n) => ({ props: {}, ...n })), edges: [], areas: [], labels: [],
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...extra,
  }
}

/** Three components on a known grid: `a` at the origin, `b` six cells along x, `c` six cells along y. */
export const TRIO = () => makeDoc([
  { id: 'a', type: 'ec2', x: 0, y: 0, name: 'web-1' },
  { id: 'b', type: 'rds', x: 6, y: 0, name: 'orders-db' },
  { id: 'c', type: 's3', x: 0, y: 6, name: 'assets' },
])

export class App {
  constructor(readonly page: Page) {}

  /** Store blueprints in the browser exactly as the app would, then open the first one. */
  async seed(...docs: SeedDoc[]) {
    await this.page.goto('/')
    await this.page.evaluate(([key, list]) => {
      const idx = JSON.parse(localStorage.getItem(key + 'index') || '[]')
      for (const d of list as any[]) {
        localStorage.setItem(key + 'doc:' + d.id, JSON.stringify(d))
        idx.push({ id: d.id, name: d.name, updatedAt: d.updatedAt, nodes: d.nodes.length })
      }
      localStorage.setItem(key + 'index', JSON.stringify(idx))
    }, [KEY, docs] as const)
  }

  async open(doc: SeedDoc) {
    await this.seed(doc)
    await this.page.goto('/#/d/' + doc.id)
    await this.ready()
  }

  /** Editor is on screen and the opening animation has finished. */
  async ready() {
    await expect(this.page.locator('.canvas-svg')).toBeVisible()
    await expect(this.page.locator('.canvas-wrap.intro')).toHaveCount(0, { timeout: 5000 })
  }

  async newBlueprint() {
    await this.page.goto('/')
    await this.page.getByRole('button', { name: 'New blueprint' }).click()
    await this.ready()
  }

  docId() { return this.page.url().match(/#\/d\/([\w-]+)/)?.[1] ?? '' }

  /** The blueprint as last written to browser storage. */
  async saved(id = this.docId()): Promise<SeedDoc | null> {
    return this.page.evaluate(([key, docId]) => JSON.parse(localStorage.getItem(key + 'doc:' + docId) || 'null'), [KEY, id] as const)
  }

  /** Wait for autosave to catch up with the canvas, then return what was stored. */
  async settled(): Promise<SeedDoc> {
    // the desktop bar spells the state out; the phone bar shows it as a dot with the same label
    await expect(this.page.locator('.save-state:text-is("Saved"), .save-dot[aria-label="Saved"]')).toBeVisible()
    return (await this.saved())!
  }

  node(id: string): Locator { return this.page.locator(`[data-kind="node"][data-id="${id}"]`) }
  nodes(): Locator { return this.page.locator('.canvas-svg [data-kind="node"]') }
  edges(): Locator { return this.page.locator('.canvas-svg [data-kind="edge"]') }
  tool(name: string): Locator { return this.page.locator('.toolbar').getByRole('button', { name, exact: true }) }
  tab(name: string): Locator { return this.page.getByRole('tab', { name: new RegExp('^' + name) }) }
  toast(text: string | RegExp): Locator { return this.page.locator('.toast').filter({ hasText: text }) }

  /** Exact screen position of a component's origin corner on the ground. */
  async corner(id: string): Promise<{ x: number; y: number }> {
    return this.node(id).evaluate((el) => { const m = (el as unknown as SVGGElement).getScreenCTM()!; return { x: m.e, y: m.f } })
  }

  /**
   * Screen position of a ground point, in grid cells. Measured from the three
   * seeded components (`a` at 0,0, `b` at 6,0 and `c` at 0,6), so it holds at
   * any zoom or camera angle. Only valid while those three have not moved.
   */
  async world(wx: number, wy: number): Promise<{ x: number; y: number }> {
    const [a, b, c] = await Promise.all([this.corner('a'), this.corner('b'), this.corner('c')])
    const ux = { x: (b.x - a.x) / 6, y: (b.y - a.y) / 6 }, uy = { x: (c.x - a.x) / 6, y: (c.y - a.y) / 6 }
    return { x: a.x + ux.x * wx + uy.x * wy, y: a.y + ux.y * wx + uy.y * wy }
  }

  /** Screen offset for a move of (dx, dy) grid cells. */
  async cells(dx: number, dy: number): Promise<{ x: number; y: number }> {
    const [o, t] = await Promise.all([this.world(0, 0), this.world(dx, dy)])
    return { x: t.x - o.x, y: t.y - o.y }
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }, opts: { button?: 'left' | 'right' | 'middle'; steps?: number } = {}) {
    const m = this.page.mouse
    await m.move(from.x, from.y)
    await m.down({ button: opts.button ?? 'left' })
    await m.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: opts.steps ?? 6 })
    await m.move(to.x, to.y, { steps: opts.steps ?? 6 })
    await m.up({ button: opts.button ?? 'left' })
  }

  async click(p: { x: number; y: number }, opts: { button?: 'left' | 'right' | 'middle'; shift?: boolean } = {}) {
    if (opts.shift) await this.page.keyboard.down('Shift')
    await this.page.mouse.click(p.x, p.y, { button: opts.button })
    if (opts.shift) await this.page.keyboard.up('Shift')
  }

  /** Arm a library tile for placing, as pressing the mouse on it does. */
  async tile(title: string): Promise<{ x: number; y: number }> {
    const t = this.page.locator(`.pal-item[title="${title}"]`)
    await t.scrollIntoViewIfNeeded()
    const b = (await t.boundingBox())!
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }

  /** Select a seeded component by clicking the middle of its footprint. */
  async pick(id: 'a' | 'b' | 'c', opts: { button?: 'left' | 'right' | 'middle'; shift?: boolean } = {}) {
    const at = { a: [1, 1], b: [7, 1], c: [1, 7] }[id]
    await this.click(await this.world(at[0], at[1]), opts)
  }

  selBar(): Locator { return this.page.locator('.sel-bar') }
  mod(key: string) { return this.page.keyboard.press('Control+' + key) }

  async hud(label: string): Promise<string> {
    return (await this.page.locator('.hud-cell').filter({ has: this.page.locator('em', { hasText: new RegExp('^' + label + '$') }) }).innerText()).replace(label, '').trim()
  }
}

/** Every test fails if the page logs an error or throws, whatever else it checks. */
export const test = base.extend<{ app: App; problems: string[]; firstVisit: boolean }>({
  // the one-time gesture guide is put away unless a test is about a first visit
  firstVisit: [false, { option: true }],
  page: async ({ page, firstVisit }, use) => {
    if (!firstVisit) await page.addInitScript((key) => { try { localStorage.setItem(key + 'pref:coached', 'true') } catch { /* storage blocked: the test is about that */ } }, KEY)
    await use(page)
  },
  problems: [async ({ page }, use) => {
    const problems: string[] = []
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
    page.on('console', (m) => { if (m.type() === 'error') problems.push('console.error: ' + m.text()) })
    await use(problems)
    expect(problems, 'the page reported errors').toEqual([])
  }, { auto: true }],
  app: async ({ page }, use) => { await use(new App(page)) },
})

export { expect }
