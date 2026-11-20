import { TRIO, expect, makeDoc, test } from './fixtures'

const row = (page: import('@playwright/test').Page, label: string) => page.locator('.panel.right .row').filter({ has: page.locator('.row-label', { hasText: new RegExp('^' + label + '$') }) })

test.describe('inspector', () => {
  test.beforeEach(async ({ app }) => { await app.open(TRIO()) })

  test('renames the blueprint from the top bar, updates the tab title and keeps it after a reload', async ({ page, app }) => {
    const name = page.getByLabel('Blueprint name')
    await name.fill('Checkout platform')
    await expect(page).toHaveTitle('Checkout platform · CloudMill Graph')
    await expect(page.locator('.panel.right .title-input')).toHaveValue('Checkout platform')
    await app.settled()
    await page.reload()
    await app.ready()
    await expect(page.getByLabel('Blueprint name')).toHaveValue('Checkout platform')
    // typing a name is one undo step, not one per letter
    await page.getByLabel('Blueprint name').fill('A')
    await page.getByLabel('Blueprint name').pressSequentially('bcdef')
    await page.getByLabel('Blueprint name').press('Enter')
    await app.mod('z')
    await expect(page.getByLabel('Blueprint name')).toHaveValue('Checkout platform')
  })

  test('editing a component changes its price everywhere at once', async ({ page, app }) => {
    await app.pick('a')
    const monthly = page.locator('.cost-total .mono')
    const before = await monthly.innerText()
    const count = row(page, 'Instances').locator('input')
    await count.fill('4')
    await expect(monthly).not.toHaveText(before)
    await expect(app.selBar()).toContainText('4 ×')
    const doc = await app.settled()
    expect(doc.nodes[0].props.count).toBe(4)

    // out-of-range and junk values never reach the blueprint
    await count.fill('99999')
    await count.blur()
    await expect(count).toHaveValue('500')
    await count.fill('abc')
    await count.blur()
    await expect(count).toHaveValue('500')
    await count.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    await expect(count).toHaveValue('489')
  })

  test('dropdowns work with the mouse and the keyboard, and do not swallow undo', async ({ page, app }) => {
    await app.pick('a')
    const family = page.getByRole('combobox', { name: 'Family' })
    await expect(family).toHaveText('m7g')
    await family.click()
    await expect(page.getByRole('listbox', { name: 'Family' })).toBeVisible()
    await page.getByRole('option', { name: 'c5', exact: true }).click()
    await expect(family).toHaveText('c5')
    await expect(family).toBeFocused()
    // keyboard: open, type ahead, confirm
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('r')
    await page.keyboard.press('Enter')
    await expect(family).toHaveText('r5')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(family).toHaveText('r5')
    // the list closes when clicking elsewhere
    await family.click()
    await page.locator('.panel.right .title-input').click()
    await expect(page.getByRole('listbox')).toHaveCount(0)
    // undo still works while the dropdown has focus
    await family.focus()
    await app.mod('z')
    // both picks were quick edits to one field, so one undo takes it back to the default
    expect((await app.settled()).nodes[0].props.family).toBeUndefined()
    await app.pick('a')
    await expect(family).toHaveText('m7g')
  })

  test('scale, colour, notes and link are saved with the component', async ({ page, app }) => {
    await app.pick('b')
    await page.getByRole('combobox', { name: 'Scale' }).click()
    await page.getByRole('option', { name: '150%' }).click()
    await page.locator('.panel.right .swatch[aria-label="#E5574F"]').click()
    await page.getByPlaceholder('Runbook notes').fill('Owner: payments\nPager: #db-oncall')
    await page.getByPlaceholder('https://link-to-docs-or-console').fill('javascript:alert(1)')
    await expect(page.getByRole('link', { name: 'Open link' })).toHaveCount(0)
    await page.getByPlaceholder('https://link-to-docs-or-console').fill('https://example.com/runbook')
    const link = page.getByRole('link', { name: 'Open link' })
    await expect(link).toHaveAttribute('href', 'https://example.com/runbook')
    await expect(link).toHaveAttribute('rel', /noopener/)
    const doc = await app.settled()
    // resized about its centre: (7,1) stays the middle
    expect(doc.nodes[1]).toMatchObject({ scale: 1.5, x: 5.5, y: -0.5, color: '#E5574F', notes: 'Owner: payments\nPager: #db-oncall', link: 'https://example.com/runbook' })
  })

  test('a toggle setting flips and is reflected in the advisor', async ({ page, app }) => {
    await app.pick('b')
    await expect(app.tab('Advisor')).toContainText('1')
    const multi = page.locator('.panel.right').getByRole('switch').first()
    await expect(multi).toHaveAttribute('aria-checked', 'false')
    await multi.click()
    await expect(multi).toHaveAttribute('aria-checked', 'true')
    await expect(app.tab('Advisor').locator('.badge')).toHaveCount(0)
  })

  test('edits a connection: label, style, arrows, reverse and delete', async ({ page, app }) => {
    await page.keyboard.press('c')
    await app.drag(await app.world(1, 1), await app.world(7, 1))
    await page.keyboard.press('Escape')
    await page.locator('.panel.right').getByLabel('Connection label').fill('SQL')
    await page.getByRole('radio', { name: 'Dashed' }).click()
    await page.getByRole('radio', { name: 'Both' }).click()
    await page.getByRole('radio', { name: 'Bold' }).click()
    await page.getByRole('button', { name: 'Reverse' }).click()
    await expect(page.locator('.insp-sub')).toHaveText('orders-db reads and writes web-1')
    let doc = await app.settled()
    expect(doc.edges).toMatchObject([{ from: 'b', to: 'a', label: 'SQL', style: 'dashed', arrow: 'both', width: 3.5 }])
    await expect(page.locator('.canvas-svg .edge text')).toHaveText('SQL')

    // the component lists its connection, and clicking it selects the connection
    await app.pick('a')
    await expect(page.locator('.conn')).toContainText('orders-db')
    await page.locator('.conn').click()
    await expect(page.locator('.title-static')).toHaveText('Connection')
    await page.locator('.panel.right').getByRole('button', { name: 'Delete' }).click()
    doc = await app.settled()
    expect(doc.edges).toEqual([])
  })

  test('summarises a mixed selection and deletes it as one undo step', async ({ page, app }) => {
    await page.keyboard.press('t')
    await app.click(await app.world(4, 4))
    await page.keyboard.press('Escape')
    await page.locator('.canvas-svg').focus().catch(() => {})
    await app.click(await app.world(4, -2))
    await app.mod('a')
    await expect(page.locator('.title-static')).toHaveText('4 items selected')
    await expect(page.locator('.insp-sub')).toHaveText('3 components · 1 label')
    await page.locator('.panel.right').getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByText('An empty plane.')).toBeVisible()
    await app.mod('z')
    await expect(app.nodes()).toHaveCount(3)
    await expect(page.locator('.canvas-svg [data-kind="label"]')).toHaveCount(1)
  })

  test('changes region and compares clouds; moving is a single undo step', async ({ page, app }) => {
    const total = page.locator('.stat-grid .mono')
    const us = await total.innerText()
    await page.getByRole('combobox', { name: 'Region' }).click()
    await page.getByRole('option', { name: 'South America (São Paulo)' }).click()
    await expect(total).not.toHaveText(us)
    expect((await app.settled()).region).toBe('sa-east-1')

    const rows = page.locator('.cloud-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('Current')
    await rows.filter({ hasText: 'GCP' }).getByRole('button', { name: 'Move' }).click()
    await expect(app.toast('Moved 3 components to GCP')).toBeVisible()
    let doc = await app.settled()
    expect(doc.nodes.every((n) => n.type.startsWith('gcp-'))).toBe(true)
    expect(doc.nodes.map((n) => n.name)).toEqual(['web-1', 'orders-db', 'assets'])
    await expect(page.getByRole('radio', { name: 'GCP' })).toHaveAttribute('aria-checked', 'true')
    await expect(rows.filter({ hasText: 'GCP' })).toContainText('Current')
    await app.mod('z')
    doc = await app.settled()
    expect(doc.nodes.map((n) => n.type)).toEqual(['ec2', 'rds', 's3'])
  })
})

test.describe('budget and advisor', () => {
  test('budget follows the pricing model, the heatmap and the selection', async ({ page, app }) => {
    await app.open(TRIO())
    await page.locator('.hud-cell.cost').click()
    await expect(app.tab('Budget')).toHaveAttribute('aria-selected', 'true')
    const big = page.locator('.budget-center .big')
    const onDemand = await big.innerText()
    await expect(page.locator('.cost-row')).toHaveCount(3)
    // most expensive first
    const prices = (await page.locator('.cost-row .cost-row-top .mono').allInnerTexts()).map((t) => Number(t.replace(/[$,]/g, '')))
    expect([...prices].sort((x, y) => y - x)).toEqual(prices)

    await page.getByRole('radio', { name: '3-yr commit' }).click()
    await expect(big).not.toHaveText(onDemand)
    await expect(page.locator('.budget-sub .save')).toContainText('vs on-demand')

    await page.getByRole('switch', { name: 'Cost heatmap' }).click()
    await expect(page.locator('.canvas-svg .nd-label').first()).toContainText('/mo')
    await page.locator('.canvas-svg').hover({ position: { x: 300, y: 300 } })
    await page.keyboard.press('h')
    await expect(page.locator('.canvas-svg .nd-label').first()).not.toContainText('/mo')
    await expect(page.getByRole('switch', { name: 'Cost heatmap' })).toHaveAttribute('aria-checked', 'false')

    await page.locator('.cost-row').first().click()
    await expect(page.locator('.cost-row.on')).toHaveCount(1)
    await expect(app.selBar()).toBeVisible()
  })

  test('budget CSV downloads with a total row', async ({ page, app }) => {
    await app.open(TRIO())
    await app.tab('Budget').click()
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()])
    expect(dl.suggestedFilename()).toBe('e2e-blueprint-budget.csv')
    const text = (await (await dl.createReadStream()).toArray()).join('')
    const lines = text.trim().split('\n')
    // each line says what it rests on, and the total row says where the prices came from
    expect(lines[0]).toBe('Component,Service,Category,Line item,Monthly (USD),Yearly (USD),Basis,Note')
    expect(lines.at(-1)).toMatch(/^Total,,,us-east-1 · ondemand,\d+\.\d\d,\d+\.\d\d,,"AWS prices: AWS Price List Bulk API, read \d{4}-\d\d-\d\d\./)
    expect(lines.slice(1, -1).every((l) => /Published rate|Estimate|Published allowance/.test(l))).toBe(true)
  })

  test('an empty blueprint has calm empty states in every tab', async ({ page, app }) => {
    await app.newBlueprint()
    await app.tab('Budget').click()
    await expect(page.getByText('Add billable components to see a breakdown.')).toBeVisible()
    await expect(page.locator('.budget-center .big')).toHaveText('$0.00')
    await app.tab('Advisor').click()
    await expect(page.getByText('Nothing to review yet')).toBeVisible()
    await expect(page.locator('.score b')).toHaveText('100')
    expect(await page.locator('.panel.right').innerText()).not.toMatch(/NaN|undefined|Infinity/)
  })

  test('advisor shows, fixes one finding, then fixes the rest in a single undo step', async ({ page, app }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Start from the Three-tier web app template' }).click()
    await app.ready()
    await app.tab('Advisor').click()
    const findings = page.locator('.finding')
    const start = await findings.count()
    expect(start).toBeGreaterThan(3)
    const score = Number(await page.locator('.score b').innerText())

    const first = findings.filter({ hasText: 'single availability zone' })
    await first.getByRole('button', { name: 'Show' }).click()
    await expect(app.selBar()).toContainText('orders-db')
    await app.tab('Advisor').click()
    await first.getByRole('button', { name: 'Enable Multi-AZ' }).click()
    await expect(app.toast('Applied: Enable Multi-AZ')).toBeVisible()
    await expect(findings).toHaveCount(start - 1)
    expect(Number(await page.locator('.score b').innerText())).toBeGreaterThan(score)

    const left = await findings.count()
    await page.getByRole('button', { name: /Apply \d+ recommended fixes/ }).click()
    await expect(app.toast(/Applied \d+ fixes/)).toBeVisible()
    expect(await findings.count()).toBeLessThan(left)
    await app.mod('z')
    await expect(findings).toHaveCount(left)
  })

  test('components with missing settings never show "undefined"', async ({ page, app }) => {
    // a blueprint written by an older version or by hand may lack newer settings
    await app.open(makeDoc([{ id: 'a', type: 'rds', x: 0, y: 0 }, { id: 'b', type: 'ec2', x: 6, y: 0 }, { id: 'c', type: 'gcp-vm', x: 0, y: 6 }]))
    for (const id of ['a', 'b', 'c'] as const) {
      await app.pick(id)
      await expect(app.selBar()).toBeVisible()
      expect(await app.selBar().innerText()).not.toMatch(/undefined|NaN/)
      expect(await page.locator('.panel.right').innerText()).not.toMatch(/undefined|NaN/)
    }
    await app.tab('Budget').click()
    expect(await page.locator('.panel.right').innerText()).not.toMatch(/undefined|NaN/)
    expect(await page.locator('.canvas-svg').innerHTML()).not.toMatch(/undefined|NaN/)
  })
})

/** Prices as displayed: the same number everywhere it appears, moving by published amounts when settings change. */
test.describe('pricing on screen', () => {
  const dollars = (t: string) => Number(t.replace(/[^0-9.]/g, ''))
  // one billable component; the other two cost nothing and are there so the grid helpers have their three reference points
  const pair = () => makeDoc([{ id: 'a', type: 'ec2', x: 0, y: 0, name: 'web', props: { family: 'm5', size: 'large', os: 'linux', count: 1, disk: 0 } }, { id: 'b', type: 'users', x: 6, y: 0 }, { id: 'c', type: 'igw', x: 0, y: 6 }])

  test('one instance costs its published hourly price for a month, in the footer, the inspector and the budget alike', async ({ page, app }) => {
    await app.open(pair())
    // m5.large in N. Virginia is $0.096 an hour: $70.08 over 730 hours
    await expect(page.locator('.hud-cell.cost')).toContainText('$70.08')
    await app.pick('a')
    await expect(page.locator('.cost-total')).toContainText('$70.08')
    await expect(page.locator('.cost-line').first()).toHaveClass(/fixed/)
    // a size up is the published price of that size ($0.192), and Windows its own published price ($0.376)
    await page.getByRole('combobox', { name: 'Size' }).click()
    await page.getByRole('option', { name: 'xlarge', exact: true }).click()
    await expect(page.locator('.cost-total')).toContainText('$140') // $140.16: amounts over $100 are shown in whole dollars
    await page.getByRole('combobox', { name: 'Platform' }).click()
    await page.getByRole('option', { name: 'Windows' }).click()
    await expect(page.locator('.cost-total')).toContainText('$274') // $274.48
    await expect(page.locator('.hud-cell.cost')).toContainText('$274')
    await page.getByRole('tab', { name: /Budget/ }).click()
    await expect(page.locator('.budget-center .big')).toHaveText('$274')
    // and to the cent in the breakdown
    await expect(page.locator('.basis-row.fixed .mono')).toHaveText('$274')
    expect((await app.settled()).nodes[0].props).toMatchObject({ size: 'xlarge', os: 'windows' })
  })

  test('a region reprices from that region\'s own list, and a commitment from published reserved rates', async ({ page, app }) => {
    await app.open(pair())
    await page.getByRole('tab', { name: /Budget/ }).click()
    await expect(page.locator('.budget-center .big')).toHaveText('$70.08')
    await page.waitForTimeout(400) // the panel has finished sliding in
    await page.getByRole('combobox', { name: 'Region' }).click()
    await page.getByRole('option', { name: 'eu-central-1' }).click()
    // Frankfurt publishes m5.large at $0.115: $83.95 a month
    await expect(page.locator('.budget-center .big')).toHaveText('$83.95')
    await page.getByRole('radio', { name: '1-yr commit' }).click()
    // and $0.072 reserved for a year with no upfront payment
    await expect(page.locator('.budget-center .big')).toHaveText('$52.56')
    await expect(page.getByText(/published reserved rate with no upfront payment/)).toBeVisible()
  })

  test('the budget shows what the total rests on, the free allowances, and where the prices came from', async ({ page, app }) => {
    await page.goto('/')
    await page.getByText('Three-tier web app', { exact: true }).first().click()
    await app.ready()
    await page.getByRole('tab', { name: /Budget/ }).click()
    const fixed = dollars(await page.locator('.basis-row.fixed .mono').innerText()), usage = dollars(await page.locator('.basis-row.usage .mono').innerText())
    const est = dollars(await page.locator('.basis-row.estimate .mono').innerText()), free = dollars(await page.locator('.basis-row.credit .mono').innerText())
    const total = dollars(await page.locator('.budget-center .big').innerText())
    expect(est).toBe(0) // an all-AWS template rests on no estimates
    expect(Math.abs(fixed + usage + est - free - total)).toBeLessThan(2) // whole-dollar rounding on screen
    expect(total).toBe(1088)
    await expect(page.locator('.basis-row.credit')).toContainText('CloudFront data transfer')
    await expect(page.getByRole('link', { name: 'AWS Price List Bulk API' })).toBeVisible()
    await expect(page.getByText(/Everything runs all month: 730 hours/)).toBeVisible()
    // the footer agrees with the panel
    await expect(page.locator('.hud-cell.cost')).toContainText('$1,088')
  })
})
