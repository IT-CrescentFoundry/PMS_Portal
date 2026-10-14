/**
 * Full-access user against the demo seed (see PMS_Backend/app/seed/demo_data.py).
 * DEMO0001 is Head of Quality at Plant A (primary) and supports Quality at
 * Plant B; DEMO0009 transferred from Maintenance A to Maintenance B.
 */
import { expect, test } from '@playwright/test'
import { collectConsoleErrors, signIn } from './helpers'

let consoleErrors: string[] = []

test.beforeEach(async ({ page }) => {
        consoleErrors = collectConsoleErrors(page)
        await signIn(page, 'demo.admin')
})

test.afterEach(() => {
        expect(consoleErrors).toEqual([])
})

test('dashboard summarizes accessible data', async ({ page }) => {
        await expect(
                page.getByRole('heading', { level: 1, name: 'Welcome, demo.admin' }),
        ).toBeVisible()
        const summary = page.getByRole('region', { name: 'Summary' })
        await expect(summary.getByText('Plants', { exact: true })).toBeVisible()
        await expect(
                page.getByRole('table', { name: 'Headcount by plant and department' }),
        ).toBeVisible()
})

test('plant to department-at-plant navigation', async ({ page }) => {
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'Plants' })
                .click()
        await expect(page.getByRole('table', { name: 'Plants' }).getByRole('row')).toHaveCount(4) // header + 3
        await page.getByRole('link', { name: 'Demo Plant A' }).click()
        await expect(page.getByRole('heading', { level: 1, name: 'Demo Plant A' })).toBeVisible()
        await page
                .getByRole('table', { name: 'Departments at Demo Plant A' })
                .getByRole('link', { name: 'Quality' })
                .click()
        await expect(
                page.getByRole('heading', { level: 1, name: 'Quality — Demo Plant A' }),
        ).toBeVisible()
})

test('consolidated department counts a cross-plant employee once', async ({ page }) => {
        await page.goto('/departments')
        await page.getByRole('link', { name: 'Quality', exact: true }).click()
        await expect(
                page.getByRole('heading', { level: 1, name: 'Quality: all accessible plants' }),
        ).toBeVisible()
        const footer = page.getByRole('row', { name: /Total employees \(each counted once\)/ })
        await expect(footer).toContainText('4') // DEMO0001 counted once, not twice
})

test('employee directory shows one identity with primary and supporting assignments', async ({
        page,
}) => {
        await page.goto('/employees')
        await page.getByLabel('Search by employee code or name').fill('DEMO0001')
        await page.getByRole('button', { name: 'Search', exact: true }).click()
        const rows = page.getByRole('table', { name: 'Employees' }).getByRole('row')
        await expect(rows).toHaveCount(2) // header + one person
        await expect(rows.nth(1)).toContainText('Quality — Demo Plant A')
        await expect(rows.nth(1)).toContainText('Quality — Demo Plant B')
        await expect(rows.nth(1).getByText('Primary', { exact: true })).toBeVisible()
        await expect(rows.nth(1).getByText('Supporting', { exact: true })).toBeVisible()
})

test('assignment history shows a transfer', async ({ page }) => {
        await page.goto('/employees?q=DEMO0009')
        await page.getByRole('link', { name: 'Farhan Demo-Ali' }).click()
        const history = page.getByRole('table', { name: 'Assignment history, oldest first' })
        await expect(history.getByRole('row')).toHaveCount(3)
        await expect(history.getByText('Ended')).toBeVisible()
        await expect(history.getByText('Current')).toBeVisible()
})

test('headcount for one department at one plant', async ({ page }) => {
        await page.goto('/reports/headcount')
        const department = page.getByLabel('Department', { exact: true })
        await expect(department).toBeEnabled()
        await department.selectOption({ label: 'Quality' })
        await expect(page.getByRole('heading', { name: 'Quality — All Plants' })).toBeVisible()
        await page.getByLabel('Plant', { exact: true }).selectOption({ label: 'Demo Plant B' })
        await expect(page.getByRole('heading', { name: 'Quality — Demo Plant B' })).toBeVisible()
        const stats = page.locator('dl')
        await expect(stats.getByText('Headcount', { exact: true }).locator('..')).toContainText('1')
        await expect(
                stats.getByText('Supporting staff', { exact: true }).locator('..'),
        ).toContainText('1')
})
