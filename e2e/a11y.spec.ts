/**
 * Accessibility on the desktop layout: axe's automated WCAG 2.1 A and AA rules on the dashboard, the editor, its
 * panels and its dialogs, in both themes, and by hand the things axe cannot judge (every control has a name, focus
 * can be seen, status messages are announced, reduced motion is respected).
 * A failure means someone using a keyboard or a screen reader has lost something, though the page may look right.
 */
import AxeBuilder from '@axe-core/playwright'
import { TRIO, expect, test } from './fixtures'

/** Automated WCAG 2.1 A/AA checks. Anything rated serious or critical fails the build. */
async function audit(page: import('@playwright/test').Page, include?: string) {
  // Whatever is still fading or sliding in has no settled colours to judge, so anything on its way in is let arrive first.
  // (Things that never stop, like traffic on a line, are left to run.)
  await page.evaluate((sel) => Promise.all(((sel ? document.querySelector(sel) : document.body)?.getAnimations({ subtree: true }) ?? [])
    .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null))), include)
  let axe = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
  if (include) axe = axe.include(include)
  const { violations } = await axe.analyze()
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)
}

test.describe('accessibility', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`dashboard passes automated checks in the ${theme} theme`, async ({ page, app }) => {
      await app.seed(TRIO())
      await page.evaluate((t) => localStorage.setItem('stratum:pref:theme', JSON.stringify(t)), theme)
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.locator('.card.doc')).toBeVisible()
      expect(await audit(page)).toEqual([])
    })

    test(`editor passes automated checks in the ${theme} theme`, async ({ page, app }) => {
      await app.seed(TRIO())
      await page.evaluate((t) => localStorage.setItem('stratum:pref:theme', JSON.stringify(t)), theme)
      await page.goto('/#/d/e2edoc')
      await page.reload()
      await app.ready()
      expect(await audit(page), 'document view').toEqual([])
      await app.pick('a')
      expect(await audit(page), 'component selected').toEqual([])
      await app.tab('Budget').click()
      expect(await audit(page, '.panel.right'), 'budget').toEqual([])
      await app.tab('Advisor').click()
      expect(await audit(page, '.panel.right'), 'advisor').toEqual([])
    })
  }

  test('dialogs pass automated checks', async ({ page, app }) => {
    await app.open(TRIO())
    for (const [open, name] of [['Control+e', 'Export'], ['?', 'Keyboard shortcuts'], ['Control+k', 'Command palette']] as const) {
      await page.keyboard.press(open)
      await expect(page.getByRole('dialog', { name })).toBeVisible()
      expect(await audit(page, '[role=dialog]'), name).toEqual([])
      await page.keyboard.press('Escape')
    }
    for (const name of ['Import', 'Version history', 'Share']) {
      await page.locator('.topbar').getByRole('button', { name, exact: true }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      expect(await audit(page, '[role=dialog]'), name).toEqual([])
      await page.keyboard.press('Escape')
    }
  })

  test('every control on the dashboard and in the editor has an accessible name', async ({ page, app }) => {
    const unnamed = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, [role=button], [role=switch], [role=combobox], [role=tab], [role=radio]')]
      .filter((el) => el.offsetParent !== null)
      .filter((el) => !(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText?.trim() || (el as HTMLInputElement).labels?.length))
      .map((el) => el.outerHTML.slice(0, 120)))
    await page.goto('/')
    expect(await unnamed()).toEqual([])
    await app.open(TRIO())
    expect(await unnamed()).toEqual([])
    await app.pick('b')
    expect(await unnamed()).toEqual([])
  })

  test('the dashboard can be used from the keyboard with a visible focus mark', async ({ page, app }) => {
    await page.goto('/')
    // the page is there to be tabbed through once it has been drawn
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const seen: string[] = []
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement
        const cs = getComputedStyle(el)
        return { name: el.getAttribute('aria-label') || el.innerText.trim().split('\n')[0], ring: cs.outlineStyle !== 'none' || cs.boxShadow !== 'none' }
      })
      expect(info.ring, 'focus is visible on ' + info.name).toBe(true)
      seen.push(info.name)
    }
    expect(seen).toEqual(expect.arrayContaining(['Templates', 'Toggle theme', 'Import Terraform', 'Start a blueprint', 'Open the sample blueprint']))
    // and activated from it
    await page.getByRole('button', { name: /^New blueprint/ }).focus()
    await page.keyboard.press('Enter')
    await app.ready()
  })

  test('dialogs announce themselves and status messages are live regions', async ({ page, app }) => {
    await app.open(TRIO())
    await expect(page.locator('.toasts')).toHaveAttribute('aria-live', 'polite')
    await expect(page.locator('.save-state')).toHaveAttribute('aria-live', 'polite')
    await page.keyboard.press('Control+e')
    await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: 'Close' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tablist')).toBeVisible()
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Inspect')
    await expect(page.getByRole('radiogroup', { name: 'Cloud provider' })).toBeVisible()
  })

  test('respects a reduced-motion preference', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    const az = page.locator('.hero-stage .readout.tr')
    await expect(az).toHaveText('AZ 045°')
    await page.waitForTimeout(900)
    await expect(az).toHaveText('AZ 045°') // the hero does not drift
    const moving = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && (a.effect?.getComputedTiming().duration as number) > 50).length)
    expect(moving).toBe(0)
  })
})
