import { TRIO, expect, test } from './fixtures'

const SIZES = [
  { name: 'small phone', width: 320, height: 640 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'wide', width: 1920, height: 1080 },
]

/** Elements whose box pokes out of the viewport sideways. */
const spill = (page: import('@playwright/test').Page, selector: string) => page.evaluate((sel) => {
  const w = document.documentElement.clientWidth
  return [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && (r.left < -1 || r.right > w + 1)
  }).map((el) => `${el.className || el.tagName}: ${Math.round(el.getBoundingClientRect().left)}..${Math.round(el.getBoundingClientRect().right)} of ${w}`)
}, selector)

for (const size of SIZES) {
  test.describe(`${size.name} (${size.width}×${size.height})`, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test('dashboard fits the screen with nothing cut off', async ({ page, app }) => {
      await app.seed(TRIO())
      await page.reload()
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(0)
      // on a phone the templates are a row to flick through, so only that row may run past the edge
      expect(await spill(page, `.dash-top > *, .hero-copy > *, .hero-stage, .statement h2, .feat, ${size.width <= 760 ? '.card.doc' : '.card'}, .sect-head, .dash-foot`)).toEqual([])
      await expect(page.getByRole('button', { name: 'Start a blueprint' })).toBeInViewport()
      await expect(page.getByRole('button', { name: /^New blueprint/ })).toBeInViewport()
      // button and card text is never clipped
      const clipped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.btn, .card h3, .text-btn')].filter((el) => el.offsetWidth > 0 && el.scrollWidth > el.clientWidth + 1).map((el) => el.innerText))
      expect(clipped).toEqual([])
      await page.locator('#blueprints').scrollIntoViewIfNeeded()
      await expect(page.locator('.card.doc')).toBeVisible()
    })

    test('editor keeps its controls on screen and the canvas usable', async ({ page, app }) => {
      await app.open(TRIO())
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
      expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(0)
      expect(await spill(page, '.topbar .island, .topbar .icon-btn, .topbar .btn, .toolbar, .toolbar .icon-btn, .zoom-ctl, .hud, .viewcube, .panel, .dock-row, .dock-btn, .fab')).toEqual([])
      // a narrow window gets the phone layout: a dock in place of the toolbar
      await expect(page.locator(size.width <= 760 ? '.dock' : '.toolbar')).toBeInViewport()
      await expect(page.getByRole('button', { name: 'Share' })).toBeInViewport()
      // all three components were framed inside the canvas that is actually visible
      const canvas = (await page.locator('.canvas-svg').boundingBox())!
      for (const id of ['a', 'b', 'c']) {
        const b = (await app.node(id).locator('.nd-body').boundingBox())!
        expect(b.x, id).toBeGreaterThanOrEqual(canvas.x)
        expect(b.x + b.width, id).toBeLessThanOrEqual(canvas.x + canvas.width)
        expect(b.y, id).toBeGreaterThanOrEqual(canvas.y)
        expect(b.y + b.height, id).toBeLessThanOrEqual(canvas.y + canvas.height)
      }
      // a component can still be selected by pointing at it
      const b = (await app.node('a').locator('.nd-body').boundingBox())!
      const lib = page.locator('.panel.palette'), insp = page.locator('.panel.right')
      if (size.width <= 760) { await expect(lib).toHaveCount(0); await expect(insp).toHaveCount(0) }
      await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.7)
      if (size.width > 940) await expect(page.locator('.panel.right .title-input')).toHaveValue('web-1')
      else await expect(page.locator('.sel-bar')).toContainText('web-1')
    })

    test('dialogs and menus stay inside the screen', async ({ page, app }) => {
      await app.open(TRIO())
      // checked once any opening animation has finished
      const inside = (selector: string) => expect.poll(async () => {
        const b = (await page.locator(selector).boundingBox())!
        return b.x >= 0 && b.x + b.width <= size.width + 1 && b.y >= 0 && b.y + b.height <= size.height + 1
      }, { message: selector + ' is inside the screen' }).toBe(true)
      await page.keyboard.press('Control+e')
      await inside('.modal')
      await expect(page.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: 'Download' })).toBeInViewport()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Control+k')
      await inside('.cmdk')
      await page.keyboard.press('Escape')
      await page.keyboard.press('?')
      await inside('.modal')
      await page.keyboard.press('Escape')
      // a context menu opened in the far corner is pulled back on screen
      const spot = await page.evaluate(() => {
        // the bare canvas point nearest the bottom-right corner
        for (let d = 6; d < 600; d += 6) {
          const x = innerWidth - d, y = innerHeight - d * 0.6 - 60
          if (document.elementFromPoint(x, y)?.classList.contains('canvas-svg')) return { x, y }
        }
        return null
      })
      expect(spot).not.toBeNull()
      await page.mouse.click(spot!.x, spot!.y, { button: 'right' })
      await inside('.ctx-menu')
    })
  })
}

test.describe('narrow window with a mouse', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('library and inspector are sheets, one at a time', async ({ page, app }) => {
    await app.open(TRIO())
    const lib = page.getByRole('dialog', { name: 'Library' }), insp = page.getByRole('dialog', { name: 'Inspector' })
    await page.locator('.dock').getByRole('button', { name: 'Add', exact: true }).click()
    await expect(lib).toBeVisible()
    await expect.poll(async () => { const b = (await lib.boundingBox())!; return b.width <= 390 && b.y > 200 && Math.round(b.y + b.height) <= 845 }).toBe(true)
    // a mouse still adds with a double-click
    await lib.locator('.pal-item[title="Virtual machine: EC2"]').dblclick()
    await expect(app.nodes()).toHaveCount(4)
    await lib.getByRole('button', { name: 'Close library' }).click()
    await page.locator('.dock').getByRole('button', { name: 'Edit' }).click()
    await expect(insp).toBeVisible()
    await expect(lib).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('everything without a button of its own is reachable through the menu', async ({ page, app }) => {
    await app.open(TRIO())
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toHaveCount(0)
    await page.locator('.dock').getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('dialog', { name: 'Command palette' }).getByRole('textbox').fill('export')
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Export' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: /^Terraform/ }).click()
    await expect(dialog.locator('pre.code')).toContainText('aws_instance')
    await expect(dialog.getByRole('button', { name: 'Download' })).toBeInViewport()
  })

  test('growing the window brings the desktop layout back without losing work', async ({ page, app }) => {
    await app.open(TRIO())
    await expect(page.locator('.dock')).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.locator('.dock')).toHaveCount(0)
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(app.nodes()).toHaveCount(3)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('.dock')).toBeVisible()
    await expect(page.locator('.toolbar')).toHaveCount(0)
  })
})

test.describe('resizing the window', () => {
  test('the canvas follows the window without losing the diagram', async ({ page, app }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await app.open(TRIO())
    for (const [w, h] of [[900, 700], [500, 800], [1700, 950]]) {
      await page.setViewportSize({ width: w, height: h })
      await page.keyboard.press('f')
      const canvas = (await page.locator('.canvas-svg').boundingBox())!
      expect(canvas.width).toBeGreaterThan(w * 0.25)
      await expect.poll(async () => {
        const b = (await app.node('a').locator('.nd-body').boundingBox())!
        return b.x >= canvas.x && b.x + b.width <= canvas.x + canvas.width && b.y >= canvas.y && b.y + b.height <= canvas.y + canvas.height
      }).toBe(true)
    }
  })
})
