/**
 * The dashboard: what a first visit shows, making, opening, duplicating and deleting blueprints, templates, the
 * theme, and importing Terraform. A failure means someone cannot get into, or back to, their work.
 */
import { TRIO, expect, makeDoc, test } from './fixtures'

test.describe('dashboard', () => {
  test('loads with its title, hero and all six templates', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle('CloudMill Graph · cloud architecture studio')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Infrastructure')
    await expect(page.locator('#templates .card')).toHaveCount(6)
    await expect(page.locator('.feat')).toHaveCount(4)
    // every preview actually drew a diagram
    for (const art of await page.locator('#templates .card-art svg').all()) expect(await art.locator('g').count()).toBeGreaterThan(5)
    await expect(page.getByText('Nothing drafted yet')).toBeVisible()
  })

  test('has no en dash or em dash anywhere in its text', async ({ page }) => {
    await page.goto('/')
    const text = await page.locator('body').innerText()
    expect(text).not.toMatch(/[‒-―−]/)
  })

  test('creates a blueprint, returns to it from the list, and keeps it across a reload', async ({ page, app }) => {
    await app.newBlueprint()
    await expect(page.getByText('An empty plane.')).toBeVisible()
    await expect(page.getByLabel('Blueprint name')).toHaveValue('Untitled blueprint')
    const id = app.docId()
    await page.getByRole('button', { name: 'All blueprints' }).click()
    await expect(page.getByRole('button', { name: 'Open Untitled blueprint' })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Open Untitled blueprint' }).click()
    await expect(page).toHaveURL(new RegExp('#/d/' + id))
  })

  test('opens each template as an independent, editable copy', async ({ page, app }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Start from the Three-tier web app template' }).click()
    await app.ready()
    await expect(app.nodes()).toHaveCount(12)
    await expect(page.getByLabel('Blueprint name')).toHaveValue('Three-tier web application')
    const first = app.docId()
    await page.goto('/')
    await page.getByRole('button', { name: 'Start from the Three-tier web app template' }).click()
    await app.ready()
    expect(app.docId()).not.toBe(first)
  })

  test('opens a template from the keyboard', async ({ page, app }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Start from the Serverless API template' }).focus()
    await page.keyboard.press('Enter')
    await app.ready()
    await expect(app.nodes()).toHaveCount(17)
  })

  test('opens the sample from the hero', async ({ page, app }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Open the sample', exact: false }).first().click()
    await app.ready()
    await expect(page.getByLabel('Blueprint name')).toHaveValue('Kubernetes microservices')
  })

  test('duplicates a stored blueprint and deletes only after a second click', async ({ page, app }) => {
    await app.seed(TRIO())
    await page.reload()
    const card = page.locator('.card.doc')
    await expect(card).toHaveCount(1)
    await expect(card).toContainText('03 nodes')
    await card.hover()
    await card.getByRole('button', { name: 'Duplicate' }).click()
    await expect(page.locator('.card.doc')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Open E2E blueprint (copy)' })).toBeVisible()

    const copy = page.locator('.card.doc').filter({ hasText: '(copy)' })
    await copy.hover()
    await copy.getByRole('button', { name: 'Delete' }).click()
    await expect(page.locator('.card.doc')).toHaveCount(2) // first click only arms it
    await copy.getByRole('button', { name: 'Delete?' }).click()
    await expect(page.locator('.card.doc')).toHaveCount(1)
    await expect(page).toHaveURL(/\/#?\/?$/) // deleting never navigates into the blueprint
    await page.reload()
    await expect(page.locator('.card.doc')).toHaveCount(1)
  })

  test('confirming a delete from the keyboard does not open the blueprint', async ({ page, app }) => {
    await app.seed(TRIO())
    await page.reload()
    const card = page.locator('.card.doc')
    await card.hover()
    await card.getByRole('button', { name: 'Delete' }).click()
    await expect(card.getByRole('button', { name: 'Delete?' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('.card.doc')).toHaveCount(0)
    await expect(page.locator('.canvas-svg')).toHaveCount(0)
    await expect(page.getByText('Nothing drafted yet')).toBeVisible()
  })

  test('filters the list once there are more than three blueprints', async ({ page, app }) => {
    await app.seed(...['Alpha', 'Beta', 'Gamma', 'Delta'].map((name, i) => makeDoc([], { id: 'd' + i, name, updatedAt: 1_700_000_000_000 + i })))
    await page.reload()
    await expect(page.locator('.card.doc')).toHaveCount(4)
    // newest first
    await expect(page.locator('.card.doc h3').first()).toHaveText('Delta')
    const filter = page.getByLabel('Filter blueprints')
    await filter.fill('  gAm ')
    await expect(page.locator('.card.doc')).toHaveCount(1)
    await filter.fill('zzz')
    await expect(page.getByText('No blueprints match')).toBeVisible()
  })

  test('remembers the theme across reloads', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('button', { name: 'Toggle theme' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(250, 250, 250)')
  })

  test('imports Terraform straight into a new blueprint', async ({ page, app }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Import Terraform' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import' })
    await expect(dialog.getByRole('button', { name: 'Create blueprint' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Load sample' }).click()
    await expect(dialog.getByText('10 of 21 resources mapped')).toBeVisible()
    await dialog.getByRole('button', { name: 'Create blueprint' }).click()
    await app.ready()
    await expect(app.nodes()).toHaveCount(11) // ten resources and the users that reach them
  })

  test('section links scroll to their sections', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Blueprints' }).click()
    await expect(page.locator('#blueprints h2')).toBeInViewport()
  })
})
