/**
 * Shared Playwright fixtures for every spec: blueprints to seed, the `App` page driver, and a `test` that fails on
 * any error the page reports.
 *
 * Two coordinate systems meet here. Ground positions are in cells (the unit `x`, `y`, `w` and `d` are stored in).
 * Everything handed to the mouse or a finger is in screen pixels (CSS pixels from the top left of the viewport).
 * `world` and `cells` turn the first into the second by measuring the page, so no test hard-codes the camera.
 */
import { type Locator, type Page, expect, test as base } from '@playwright/test'

/** A component as a test writes it into storage. `x` and `y` are the ground position of its origin corner, in cells. */
export interface SeedNode { id: string; type: string; x: number; y: number; name?: string; props?: Record<string, unknown>; scale?: number }
/**
 * A blueprint as it sits in browser storage. Deliberately looser than the app's own `Doc`: it lists only what most
 * specs seed or read back, so a spec that stores or checks a hand-shaped line (`runs`, `fromSide`, `fromAt` and so
 * on) casts its edge.
 */
export interface SeedDoc {
  id: string; name: string; region: string
  nodes: (SeedNode & { props: Record<string, unknown> })[]
  edges: { id: string; from: string; to: string; style: string; arrow: string; width: number; label?: string }[]
  areas: { id: string; x: number; y: number; w: number; d: number; name: string; color: string; kind: string }[]
  labels: { id: string; x: number; y: number; text: string; size: number; dir: string }[]
  createdAt: number; updatedAt: number
}

/** Prefix of every storage key the app writes. Must match `K` in src/core/storage.ts, or what is seeded is never found. */
const KEY = 'stratum:'

/**
 * A blueprint holding the given components and nothing else, unless `extra` says otherwise. The id is always
 * `e2edoc` and the timestamps are fixed, so addresses and stored output are the same on every run. Pass `extra.id`
 * when a test seeds more than one.
 */
export function makeDoc(nodes: SeedNode[] = [], extra: Partial<SeedDoc> = {}): SeedDoc {
  return {
    id: 'e2edoc', name: 'E2E blueprint', region: 'us-east-1',
    nodes: nodes.map((n) => ({ props: {}, ...n })), edges: [], areas: [], labels: [],
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...extra,
  }
}

/**
 * Three components on a known grid: `a` at the origin, `b` six cells along x, `c` six cells along y. They are the
 * reference points `world`, `cells` and `pick` measure from. A function, so each test gets a copy it can alter.
 */
export const TRIO = () => makeDoc([
  { id: 'a', type: 'ec2', x: 0, y: 0, name: 'web-1' },
  { id: 'b', type: 'rds', x: 6, y: 0, name: 'orders-db' },
  { id: 'c', type: 's3', x: 0, y: 6, name: 'assets' },
])

/** Drives one page of the app: navigation, locators and screen measurements. It keeps no state beyond the page. */
export class App {
  constructor(readonly page: Page) {}

  /**
   * Store blueprints in the browser exactly as the app would. Loads the dashboard first, because storage belongs to
   * an origin and can only be written from a page on it. That page was drawn before the write, so reload or navigate
   * to see what was seeded. Adds to whatever is already stored.
   */
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

  /** Seed one blueprint and open it in the editor, waiting until it can be measured and clicked. */
  async open(doc: SeedDoc) {
    await this.seed(doc)
    await this.page.goto('/#/d/' + doc.id)
    await this.ready()
  }

  /**
   * Editor is on screen and the opening animation has finished. Component bodies rise into place for 1.5 s after a
   * blueprint opens (the `intro` class on the canvas), and a body measured during that is not where it will stand.
   */
  async ready() {
    await expect(this.page.locator('.canvas-svg')).toBeVisible()
    await expect(this.page.locator('.canvas-wrap.intro')).toHaveCount(0, { timeout: 5000 })
  }

  /** A new, empty blueprint made with the dashboard's own button. */
  async newBlueprint() {
    await this.page.goto('/')
    await this.page.getByRole('button', { name: 'New blueprint' }).click()
    await this.ready()
  }

  /** The id of the blueprint in the address bar, or an empty string when the page is not on one. */
  docId() { return this.page.url().match(/#\/d\/([\w-]+)/)?.[1] ?? '' }

  /** The blueprint as last written to browser storage, or null if none is stored under that id. Does not wait for autosave. */
  async saved(id = this.docId()): Promise<SeedDoc | null> {
    return this.page.evaluate(([key, docId]) => JSON.parse(localStorage.getItem(key + 'doc:' + docId) || 'null'), [KEY, id] as const)
  }

  /**
   * Wait for autosave to catch up with the canvas, then return what was stored. Autosave runs 450 ms after the last
   * change, and this waits on the indicator the user sees, not on a sleep.
   */
  async settled(): Promise<SeedDoc> {
    // the desktop bar spells the state out; the phone bar shows it as a dot with the same label
    await expect(this.page.locator('.save-state:text-is("Saved"), .save-dot[aria-label="Saved"]')).toBeVisible()
    return (await this.saved())!
  }

  node(id: string): Locator { return this.page.locator(`[data-kind="node"][data-id="${id}"]`) }
  nodes(): Locator { return this.page.locator('.canvas-svg [data-kind="node"]') }
  edges(): Locator { return this.page.locator('.canvas-svg [data-kind="edge"]') }
  // the desktop toolbar only: the phone layout has a dock in its place
  tool(name: string): Locator { return this.page.locator('.toolbar').getByRole('button', { name, exact: true }) }
  // matched from the start of the name only: a tab can carry a badge count after it
  tab(name: string): Locator { return this.page.getByRole('tab', { name: new RegExp('^' + name) }) }
  toast(text: string | RegExp): Locator { return this.page.locator('.toast').filter({ hasText: text }) }

  /**
   * Where a component's origin corner (its `x`, `y` on the ground) is drawn, in screen pixels. Read from the
   * transform of its group, so it is not rounded to a pixel, and it is where the component is drawn right now:
   * while one is being carried, this is the copy in the hand.
   */
  async corner(id: string): Promise<{ x: number; y: number }> {
    return this.node(id).evaluate((el) => { const m = (el as unknown as SVGGElement).getScreenCTM()!; return { x: m.e, y: m.f } })
  }

  /**
   * Screen position (pixels) of the ground point (wx, wy), given in cells. Fractions are fine. Measured from where
   * the three seeded components are drawn (`a` at 0,0, `b` at 6,0 and `c` at 0,6), so it holds at any zoom, pan or
   * camera angle. Only valid while the blueprint has those three ids at those positions: once one of them has
   * moved, or is being carried, the answer is wrong and nothing says so. Specs that seed another layout measure
   * it themselves.
   */
  async world(wx: number, wy: number): Promise<{ x: number; y: number }> {
    const [a, b, c] = await Promise.all([this.corner('a'), this.corner('b'), this.corner('c')])
    const ux = { x: (b.x - a.x) / 6, y: (b.y - a.y) / 6 }, uy = { x: (c.x - a.x) / 6, y: (c.y - a.y) / 6 }
    return { x: a.x + ux.x * wx + uy.x * wy, y: a.y + ux.y * wx + uy.y * wy }
  }

  /** Screen offset (pixels) for a move of (dx, dy) cells on the ground: add it to a screen point. Same precondition as `world`. */
  async cells(dx: number, dy: number): Promise<{ x: number; y: number }> {
    const [o, t] = await Promise.all([this.world(0, 0), this.world(dx, dy)])
    return { x: t.x - o.x, y: t.y - o.y }
  }

  /**
   * Press at `from`, move to `to` and release, in screen pixels. It goes by way of the midpoint, `steps` moves to
   * each leg, so the app sees a drag in progress and not a jump: a press only becomes a drag after 4 px of travel.
   */
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

  /** Centre of a library tile on screen, in pixels, scrolled into view first. It only finds the tile: the test presses the mouse there itself. */
  async tile(title: string): Promise<{ x: number; y: number }> {
    const t = this.page.locator(`.pal-item[title="${title}"]`)
    await t.scrollIntoViewIfNeeded()
    const b = (await t.boundingBox())!
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }

  /**
   * Select a seeded component by clicking the middle of its footprint (two cells square at the default scale).
   * Same precondition as `world`, and the component must still be its seeded size.
   */
  async pick(id: 'a' | 'b' | 'c', opts: { button?: 'left' | 'right' | 'middle'; shift?: boolean } = {}) {
    const at = { a: [1, 1], b: [7, 1], c: [1, 7] }[id]
    await this.click(await this.world(at[0], at[1]), opts)
  }

  /**
   * Turn the mouse wheel `n` notches where the pointer is: negative away from the user, which zooms in. Chrome reports
   * every wheel event sent this way as exactly one notch, whatever distance is given, so several notches are several events.
   */
  async notches(n: number) {
    for (let i = 0; i < Math.abs(n); i++) await this.page.mouse.wheel(0, n < 0 ? -100 : 100)
  }

  selBar(): Locator { return this.page.locator('.sel-bar') }
  /** Ctrl with a key. The app takes Ctrl or Cmd for its shortcuts, so this works whatever the platform. */
  mod(key: string) { return this.page.keyboard.press('Control+' + key) }

  /** The value beside a label in the read-out at the foot of the canvas, as printed: `AZ` and `EL` are the camera angles, `N` the component count. */
  async hud(label: string): Promise<string> {
    return (await this.page.locator('.hud-cell').filter({ has: this.page.locator('em', { hasText: new RegExp('^' + label + '$') }) }).innerText()).replace(label, '').trim()
  }
}

/**
 * The `test` every spec imports in place of Playwright's own.
 * - Each test starts with empty browser storage: Playwright gives it a fresh browser context, and nothing here
 *   carries anything over.
 * - `problems` is always on: every test fails as it finishes if the page threw or logged an error, whatever else
 *   it checks. A test that expects an error empties the list before it ends.
 * - `firstVisit` (set with `test.use`) leaves the one-time gesture guide to appear as it does for a new user.
 */
export const test = base.extend<{ app: App; problems: string[]; firstVisit: boolean }>({
  // the one-time gesture guide is put away unless a test is about a first visit
  firstVisit: [false, { option: true }],
  page: async ({ page, firstVisit }, use) => {
    if (!firstVisit) await page.addInitScript((key) => { try { localStorage.setItem(key + 'pref:coached', 'true') } catch { /* storage blocked: the test is about that */ } }, KEY)
    await use(page)
  },
  // only this page is listened to: one a test opens with `context.newPage()` is not covered
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
