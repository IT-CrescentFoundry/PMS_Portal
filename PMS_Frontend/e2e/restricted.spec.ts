/** Restricted users must not see out-of-scope data anywhere, even via URLs. */
import { expect, test } from '@playwright/test'
import { adminLookup, collectConsoleErrors, signIn } from './helpers'

test('plant-department head sees only Production at Plant A', async ({ page }) => {
        const ids = await adminLookup()
        const errors = collectConsoleErrors(page)
        await signIn(page, 'demo.production.head.a')

        await page.goto('/plants')
        const plants = page.getByRole('table', { name: 'Plants' })
        await expect(plants.getByRole('row')).toHaveCount(2) // header + Plant A
        await expect(plants).toContainText('Demo Plant A')
        await expect(plants).toContainText('Production')
        await expect(plants).not.toContainText('Quality')

        // Changing ids or query parameters in the URL reveals nothing.
        await page.goto(`/plants/${ids.plantId('PLT-B')}`)
        await expect(page.getByText('Not available')).toBeVisible()
        await page.goto(`/employees?plant_id=${ids.plantId('PLT-B')}`)
        await expect(page.getByText('Not available')).toBeVisible()
        await page.goto(`/employees/${ids.employeeId('DEMO0003')}`) // Quality at Plant B
        await expect(page.getByText('Not available')).toBeVisible()

        // Reports and lists contain only the accessible unit.
        await page.goto('/reports/headcount')
        await expect(
                page.getByRole('heading', { name: 'All Departments — All Plants' }),
        ).toBeVisible()
        const table = page.getByRole('table', { name: /Headcount by plant and department/ })
        await expect(table.getByRole('row')).toHaveCount(3) // header + 1 unit + total
        await expect(page.getByText(/Your access covers only part/)).toBeVisible()
        await page.goto('/employees')
        await expect(page.getByRole('table', { name: 'Employees' })).not.toContainText('Quality')
        await expect(page.getByRole('main')).not.toContainText('Demo Plant B')
        expect(errors).toEqual([])
})

test('employee-only user sees self-service and is denied organization pages', async ({ page }) => {
        const errors = collectConsoleErrors(page)
        await signIn(page, 'demo.employee')
        const nav = page.getByRole('navigation', { name: 'Main' })
        await expect(nav.getByRole('link', { name: 'Plants' })).toHaveCount(0)
        await page.goto('/plants')
        await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible()
        await nav.getByRole('link', { name: 'My employee record' }).click()
        await expect(page.getByText('You', { exact: true })).toBeVisible()
        expect(errors).toEqual([])
})
