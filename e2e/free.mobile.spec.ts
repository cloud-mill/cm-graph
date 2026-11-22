import type { Page } from '@playwright/test'
import { TRIO, expect, test as base } from './fixtures'
import { Fingers } from './touch'

/** On a phone too, a component goes exactly as far as the finger carries it and stays where the finger leaves it. */
const test = base.extend<{ fingers: Fingers }>({
  fingers: async ({ page, browserName }, use) => { await use(new Fingers(page, browserName === 'chromium')) },
})
const linked = () => { const d = TRIO(); d.edges.push({ id: 'e', from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2 } as any, { id: 'f', from: 'c', to: 'b', style: 'solid', arrow: 'end', width: 2 } as any); return d }
const corner = (page: Page, id: string) => page.locator(`[data-kind="node"][data-id="${id}"]`).evaluate((el) => { const m = (el as unknown as SVGGElement).getScreenCTM()!; return { x: m.e, y: m.f } })
const middle = async (page: Page, id: string) => { const b = (await page.locator(`[data-kind="node"][data-id="${id}"] .nd-body`).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
const line = (page: Page, id: string) => page.locator(`.edge-hit[data-id="${id}"]`).getAttribute('d')

test.describe('phone: components stay where the finger leaves them', () => {
  test.beforeEach(async ({ app }) => { await app.open(linked()) })

  test('press, hold and carry: it goes as far as the finger does, to the pixel, and does not move once it is let go', async ({ page, app, fingers }) => {
    const home = await corner(page, 'a'), others = [await corner(page, 'b'), await corner(page, 'c')], unrelated = await line(page, 'f')
    const from = await middle(page, 'a')
    await fingers.drag(from, { x: from.x + 31, y: from.y + 44 }, { hold: 520, steps: 12 })
    const left = await corner(page, 'a')
    expect(Math.abs(left.x - home.x - 31)).toBeLessThanOrEqual(1)
    expect(Math.abs(left.y - home.y - 44)).toBeLessThanOrEqual(1)
    // nothing runs afterwards that moves it, or anything else
    await page.waitForTimeout(600)
    expect(await corner(page, 'a')).toEqual(left)
    expect([await corner(page, 'b'), await corner(page, 'c')]).toEqual(others)
    expect(await line(page, 'f')).toBe(unrelated)
    // it is not on the grid, because it was not put on the grid
    const a = (await app.settled()).nodes[0]
    expect(Number.isInteger(a.x) && Number.isInteger(a.y)).toBe(false)
  })

  test('a small adjustment afterwards moves it just that much, and all of it is there after a reload', async ({ page, app, fingers }) => {
    const from = await middle(page, 'a')
    // up and away from the others, so that on the smallest screen it is not left standing behind one of them
    await fingers.drag(from, { x: from.x - 14, y: from.y - 46 }, { hold: 520, steps: 10 })
    const first = await corner(page, 'a'), again = await middle(page, 'a')
    await fingers.drag(again, { x: again.x + 12, y: again.y - 11 }, { hold: 520, steps: 8 })
    const second = await corner(page, 'a')
    expect(Math.abs(second.x - first.x - 12), JSON.stringify({ from, first, again, second })).toBeLessThanOrEqual(1)
    expect(Math.abs(second.y - first.y + 11)).toBeLessThanOrEqual(1)
    const saved = (await app.settled()).nodes[0], path = await line(page, 'e')
    await page.reload(); await app.ready()
    expect((await app.settled()).nodes[0]).toEqual(saved)
    expect(await line(page, 'e')).toBe(path)
  })
})
