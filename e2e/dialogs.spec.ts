import { TRIO, expect, test } from './fixtures'

const read = async (dl: import('@playwright/test').Download) => Buffer.concat(await (await dl.createReadStream()).toArray())

test.describe('export', () => {
  test.beforeEach(async ({ app }) => { await app.open(TRIO()) })

  test('downloads every format with real content', async ({ page, app }) => {
    const dialog = page.getByRole('dialog', { name: 'Export' })
    const get = async (format: string) => {
      await app.mod('e')
      await dialog.getByRole('button', { name: new RegExp('^' + format) }).click()
      const [dl] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download' }).click()])
      await expect(app.toast('Export downloaded').last()).toBeVisible()
      await expect(dialog).toHaveCount(0)
      return dl
    }
    const png = await get('PNG image')
    expect(png.suggestedFilename()).toBe('e2e-blueprint.png')
    const bytes = await read(png)
    expect(bytes.subarray(1, 4).toString()).toBe('PNG')
    expect(bytes.length).toBeGreaterThan(5000)

    const svg = await get('SVG vector')
    expect(svg.suggestedFilename()).toBe('e2e-blueprint.svg')
    const markup = (await read(svg)).toString()
    expect(markup.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(markup).toContain('web-1')
    expect(markup).not.toMatch(/data-kind|data-id|cursor:/)

    const tf = await get('Terraform')
    expect(tf.suggestedFilename()).toBe('main.tf')
    const hcl = (await read(tf)).toString()
    expect(hcl).toContain('resource "aws_instance" "web_1"')
    expect(hcl).toContain('resource "aws_db_instance" "orders_db"')
    expect(hcl).toContain('resource "aws_s3_bucket" "assets"')

    const json = await get('Blueprint JSON')
    expect(json.suggestedFilename()).toBe('e2e-blueprint.cloudmill.json')
    expect(JSON.parse((await read(json)).toString()).nodes).toHaveLength(3)

    const csv = await get('Budget CSV')
    expect(csv.suggestedFilename()).toBe('e2e-blueprint-budget.csv')
    expect((await read(csv)).toString()).toContain('web-1,EC2,compute')
  })

  test('image options change the preview, and code formats can be copied', async ({ page, app }) => {
    await app.tool('Select').click()
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export' })
    const preview = dialog.locator('.export-preview')
    await expect(preview.locator('svg.preview')).toBeVisible()
    await expect(preview.locator('.nd-label')).toHaveCount(3)
    await dialog.getByRole('switch', { name: 'Names' }).click()
    await expect(preview.locator('.nd-label')).toHaveCount(0)
    await dialog.getByRole('switch', { name: 'Background' }).click()
    await expect(preview).toHaveClass(/checker/)
    const iso = await preview.locator('svg.preview').getAttribute('viewBox')
    await dialog.getByRole('radio', { name: 'Plan' }).click()
    await expect(preview.locator('svg.preview')).not.toHaveAttribute('viewBox', iso!)
    await expect(dialog.getByRole('radio', { name: '2×' })).toHaveAttribute('aria-checked', 'true')

    await dialog.getByRole('button', { name: /^Terraform/ }).click()
    await expect(dialog.getByRole('radio', { name: 'Plan' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Copy' }).click()
    await expect(app.toast('Copied to clipboard')).toBeVisible()
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip).toBe(await dialog.locator('pre.code').innerText())
    expect(clip).toContain('provider "aws"')

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('exports the current camera angle when the view has been turned', async ({ page, app }) => {
    await page.keyboard.press('q')
    await expect.poll(() => app.hud('AZ')).toBe('090°')
    await app.mod('e')
    await expect(page.getByRole('dialog', { name: 'Export' }).getByRole('radio', { name: 'Current' })).toHaveAttribute('aria-checked', 'true')
  })
})

test.describe('import', () => {
  test('replaces the canvas from Terraform and can be undone', async ({ page, app }) => {
    await app.open(TRIO())
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Import' })
    await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    await expect(dialog.getByText('A live preview appears here.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Load sample' }).click()
    await expect(dialog.getByText('Replaces the current canvas. You can undo.')).toBeVisible()
    await expect(dialog.getByText(/connections inferred/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(app.toast('Imported 10 components')).toBeVisible()
    await expect(app.nodes()).toHaveCount(11)
    const doc = await app.settled()
    expect(doc.areas).toHaveLength(1)
    expect(doc.name).toBe('E2E blueprint') // only the canvas is replaced
    await app.mod('z')
    await expect(app.nodes()).toHaveCount(3)
  })

  test('explains Terraform it cannot use', async ({ page, app }) => {
    await app.newBlueprint()
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Import' })
    const box = dialog.locator('textarea')
    await box.fill('resource "null_resource" "x" {}\nresource "random_id" "y" {}')
    await expect(dialog.getByText('Found 2 resource block(s), but none map to a known component.')).toBeVisible()
    await box.fill('this is not terraform at all {{{')
    await expect(dialog.getByText('Found 0 resource block(s), but none map to a known component.')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('An empty plane.')).toBeVisible()
  })

  test('validates blueprint JSON and accepts a file', async ({ page, app }) => {
    await app.newBlueprint()
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Import' })
    await dialog.getByRole('radio', { name: 'Blueprint JSON' }).click()
    const box = dialog.locator('textarea')
    await box.fill('{ nope')
    await expect(dialog.getByText(/^Invalid JSON:/)).toBeVisible()
    await box.fill('{"hello": 1}')
    await expect(dialog.getByText('This JSON is not a blueprint file.')).toBeVisible()
    await box.fill('[]')
    await expect(dialog.getByText('This JSON is not a blueprint file.')).toBeVisible()
    // switching mode clears what was pasted
    await dialog.getByRole('radio', { name: 'Terraform (HCL)' }).click()
    await expect(box).toHaveValue('')

    await dialog.locator('input[type=file]').setInputFiles({ name: 'trio.cloudmill.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(TRIO())) })
    await expect(dialog.getByRole('radio', { name: 'Blueprint JSON' })).toHaveAttribute('aria-checked', 'true')
    await expect(dialog.locator('.export-preview .nd-label')).toHaveCount(3)
    await dialog.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(app.toast('Imported 3 components')).toBeVisible()
    await expect(app.nodes()).toHaveCount(3)
  })

  test('hostile JSON is neutralised rather than trusted', async ({ page, app }) => {
    await app.newBlueprint()
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Import' })
    await dialog.getByRole('radio', { name: 'Blueprint JSON' }).click()
    await dialog.locator('textarea').fill(JSON.stringify({
      name: '<img src=x onerror=alert(1)>',
      nodes: [{ id: 'a', type: 'no-such-type', x: 'NaN', y: null, name: '<script>window.__pwned=1</script>', scale: 9999 }, { id: 'b', type: 'ec2', x: '1e400', y: 4 }, null, 7],
      edges: [{ from: 'a', to: 'ghost' }, { from: 'a', to: 'b', style: 'wavy', arrow: 'sideways', width: 'thick' }],
      areas: [{ w: -5, d: 'x', kind: 'castle' }], labels: [{ text: 42, size: 'big' }],
    }))
    await dialog.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(app.nodes()).toHaveCount(2)
    const doc = await app.settled()
    expect(doc.nodes.map((n) => [n.x, n.y, n.scale])).toEqual([[0, 0, undefined], [0, 4, undefined]])
    expect(doc.edges).toMatchObject([{ from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2 }])
    expect(doc.areas).toMatchObject([{ w: 1, d: 4, kind: 'group' }])
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined()
    await expect(page.locator('.canvas-svg script, .canvas-svg img')).toHaveCount(0)
  })
})

test.describe('share, history, shortcuts and command palette', () => {
  test('a share link opens an independent copy; a damaged one says so', async ({ page, app, context }) => {
    await app.open(TRIO())
    await page.getByRole('button', { name: 'Share' }).click()
    const dialog = page.getByRole('dialog', { name: 'Share blueprint' })
    const field = dialog.locator('input')
    await expect(field).toHaveValue(/#\/s\/[\w-]+$/)
    await dialog.getByRole('button', { name: 'Copy link' }).click()
    await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible()
    const url = await page.evaluate(() => navigator.clipboard.readText())
    expect(url).toBe(await field.inputValue())

    const other = await context.newPage()
    await other.goto(url)
    await expect(other).toHaveURL(/#\/d\/(?!e2edoc)[\w-]+$/)
    await expect(other.locator('.canvas-svg [data-kind="node"]')).toHaveCount(3)
    await expect(other.locator('.toast')).toContainText('Opened a copy of the shared blueprint')
    await expect(other.getByLabel('Blueprint name')).toHaveValue('E2E blueprint')

    await other.goto(url.slice(0, -12) + 'AAAA')
    await expect(other.locator('.toast.warn')).toContainText('That share link is damaged or incomplete')
    await expect(other.getByRole('heading', { level: 1 })).toBeVisible()
    await other.close()
  })

  test('saves named versions and restores one', async ({ page, app }) => {
    await app.open(TRIO())
    await page.getByRole('button', { name: 'Version history' }).click()
    const dialog = page.getByRole('dialog', { name: 'Version history' })
    await expect(dialog.getByText('No versions yet.')).toBeVisible()
    await dialog.getByPlaceholder(/Name this version/).fill('Three components')
    await page.keyboard.press('Enter')
    await expect(dialog.locator('.snap')).toHaveCount(1)
    await expect(dialog.locator('.snap')).toContainText('Three components')
    await page.keyboard.press('Escape')

    await app.mod('a')
    await page.keyboard.press('Delete')
    await expect(app.nodes()).toHaveCount(0)
    await app.mod('s')
    await expect(app.toast('Version saved')).toBeVisible()

    await page.getByRole('button', { name: 'Version history' }).click()
    await expect(dialog.locator('.snap')).toHaveCount(2)
    const named = dialog.locator('.snap').filter({ hasText: 'Three components' })
    await named.focus()
    await page.keyboard.press('Enter')
    await expect(named).toHaveClass(/on/)
    await expect(dialog.locator('.export-preview .nd-label')).toHaveCount(3)
    await dialog.getByRole('button', { name: 'Restore this version' }).click()
    await expect(app.toast('Restored')).toBeVisible()
    await expect(app.nodes()).toHaveCount(3)

    // versions survive a reload and can be deleted
    await app.settled()
    await page.reload()
    await app.ready()
    await page.getByRole('button', { name: 'Version history' }).click()
    await dialog.locator('.snap').first().getByRole('button', { name: 'Delete version' }).click()
    await expect(dialog.locator('.snap')).toHaveCount(1)
  })

  test('shortcut sheet opens with ? and closes with Escape or a click outside', async ({ page, app }) => {
    await app.open(TRIO())
    await page.keyboard.press('?')
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('section')).toHaveCount(5)
    // shortcuts are spelled out for this platform, not as Mac symbols
    expect(await dialog.innerText()).not.toMatch(/[⌘⌥⇧⌫]/)
    // canvas shortcuts are ignored while a dialog is open
    await page.keyboard.press('a')
    await expect(app.tool('Area')).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.keyboard.press('?')
    await page.mouse.click(8, 450)
    await expect(dialog).toHaveCount(0)
  })

  test('command palette runs actions, jumps to components and closes cleanly', async ({ page, app }) => {
    await app.open(TRIO())
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await page.getByRole('button', { name: /Search or run a command/ }).click()
    await expect(palette.getByRole('textbox')).toBeFocused()
    await expect(palette.locator('.cmdk-item')).toHaveCount(14)

    await page.keyboard.type('hide grid')
    await expect(palette.locator('.cmdk-item')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(palette).toHaveCount(0)
    await expect(app.tool('Grid')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.canvas-svg rect[fill="url(#grid)"]')).toHaveCount(0)

    await app.mod('k')
    await page.keyboard.type('orders')
    await expect(palette.locator('.cmdk-group').first()).toHaveText('Jump to')
    await page.keyboard.press('Enter')
    await expect(app.selBar()).toContainText('orders-db')

    await app.mod('k')
    await page.keyboard.type('qqqqzzzz')
    await expect(palette.getByText('Nothing matches')).toBeVisible()
    await page.keyboard.press('Enter') // nothing to run: stays open, no error
    await expect(palette).toBeVisible()
    await app.mod('k') // the shortcut toggles
    await expect(palette).toHaveCount(0)

    await app.mod('k')
    await page.keyboard.type('light theme')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await app.mod('k')
    await page.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
    await expect(app.selBar()).toBeVisible() // Escape closed the palette only, the selection stays
  })
})

/** The browser's own Back and Forward, on a desktop: the same rule as on a phone. */
test.describe('browser Back on a desktop', () => {
  const visit = async (page: import('@playwright/test').Page, app: any) => {
    await app.seed(TRIO())
    await page.goto('about:blank')
    await page.goto('/')
    await page.getByRole('button', { name: 'Open E2E blueprint' }).click()
    await app.ready()
  }
  test('Back closes a dialog, a drop-down and a context menu before it leaves the blueprint', async ({ page, app }) => {
    await visit(page, app)
    await page.keyboard.press('ControlOrMeta+e')
    await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('dialog', { name: 'Export' })).toHaveCount(0)
    await expect(page.locator('.canvas-svg')).toBeVisible()

    await app.pick('b')
    await page.locator('.panel.right .select').first().click()
    await expect(page.locator('.select-list')).toBeVisible()
    await page.goBack()
    await expect(page.locator('.select-list')).toHaveCount(0)
    await expect(page.locator('.canvas-svg')).toBeVisible()

    const ground = await app.world(4, 4)
    await page.mouse.click(ground.x, ground.y, { button: 'right' })
    await expect(page.locator('.ctx-menu')).toBeVisible()
    await page.goBack()
    await expect(page.locator('.ctx-menu')).toHaveCount(0)
    await expect(page.locator('.canvas-svg')).toBeVisible()
    expect((await app.settled()).nodes).toHaveLength(3)
  })
  test('the side panels are part of the page, not layers: Back with them open leaves as usual, and Forward returns', async ({ page, app }) => {
    await visit(page, app)
    await expect(page.locator('.panel.palette')).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('button', { name: 'New blueprint' }).first()).toBeVisible()
    await page.goForward()
    await app.ready()
    await expect(page.locator('.panel.palette')).toBeVisible()
  })
  test('closing dialogs with Escape leaves history clean: one Back still leaves, and the arrow home does not strand the blueprint behind the dashboard', async ({ page, app }) => {
    await visit(page, app)
    for (let i = 0; i < 4; i++) { await page.keyboard.press('ControlOrMeta+e'); await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Export' })).toHaveCount(0) }
    await page.getByRole('button', { name: 'All blueprints' }).click()
    await expect(page.getByRole('button', { name: 'New blueprint' }).first()).toBeVisible()
    await page.goBack()
    expect(page.url()).toBe('about:blank')
  })
})
