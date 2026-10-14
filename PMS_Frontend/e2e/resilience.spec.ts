import { expect, test } from '@playwright/test'
import { API_ORIGIN, collectConsoleErrors, signIn } from './helpers'

test('backend unavailable at start-up, then recovers with Retry', async ({ page }) => {
        await page.route(`${API_ORIGIN}/**`, (route) => route.abort('connectionrefused'))
        await page.goto('/')
        await expect(page.getByRole('heading', { name: 'PMS Portal is unavailable' })).toBeVisible()
        await page.unroute(`${API_ORIGIN}/**`)
        await page.getByRole('button', { name: 'Retry' }).click()
        await expect(page.getByRole('heading', { name: 'Sign in to PMS Portal' })).toBeVisible()
})

test('a failed page request offers a working Retry', async ({ page }) => {
        const errors = collectConsoleErrors(page)
        await signIn(page, 'demo.admin')
        await page.route(`${API_ORIGIN}/api/plants*`, (route) => route.abort('connectionrefused'))
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'Plants' })
                .click()
        await expect(page.getByText('Server unreachable')).toBeVisible()
        await page.unroute(`${API_ORIGIN}/api/plants*`)
        await page.getByRole('button', { name: 'Retry' }).click()
        await expect(page.getByRole('link', { name: 'Demo Plant A' })).toBeVisible()
        expect(errors.filter((e) => !e.includes('ERR_CONNECTION_REFUSED'))).toEqual([])
})

test('mobile layout uses a navigation drawer', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await signIn(page, 'demo.admin')
        const openButton = page.getByRole('button', { name: 'Open navigation' })
        await expect(openButton).toBeVisible()
        await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
        await openButton.click()
        await page
                .getByRole('navigation', { name: 'Main' })
                .getByRole('link', { name: 'Employees' })
                .click()
        await expect(page.getByRole('heading', { level: 1, name: 'Employees' })).toBeVisible()
        await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden() // drawer closed
        // No horizontal page scroll: wide tables scroll inside their own container.
        const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth - window.innerWidth,
        )
        expect(overflow).toBeLessThanOrEqual(0)
})
