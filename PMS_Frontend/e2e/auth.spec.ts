import { expect, test } from '@playwright/test'
import { API_ORIGIN, collectConsoleErrors, signIn } from './helpers'

test('wrong password shows a form error and stays on the sign-in page', async ({ page }) => {
        const errors = collectConsoleErrors(page)
        await page.goto('/login')
        await page.getByLabel('Username').fill('demo.admin')
        await page.getByLabel('Password', { exact: true }).fill('not-the-right-password')
        await page.getByRole('button', { name: 'Sign in' }).click()
        await expect(page.getByText('The username or password is incorrect, or the account is inactive.')).toBeVisible()
        await expect(page).toHaveURL(/\/login$/)
        expect(errors).toEqual([])
})

test('sign in, keep the session across reloads, sign out, then be locked out', async ({ page, context }) => {
        const errors = collectConsoleErrors(page)
        await page.goto('/plants') // protected: redirects to sign-in first
        await expect(page).toHaveURL(/\/login$/)
        await signIn(page, 'demo.admin')
        await expect(page).toHaveURL(/\/plants$/) // returned to the requested page

        // The session is an HttpOnly, SameSite=Strict cookie; JavaScript holds nothing.
        // The cookie is scoped to Path=/api, so look it up for an API URL.
        const cookie = (await context.cookies(`${API_ORIGIN}/api/auth/me`)).find(
                (c) => c.name === 'pms_access_token',
        )
        expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api' })
        const clientSide = await page.evaluate(() => ({
                storage: localStorage.length + sessionStorage.length,
                documentCookie: document.cookie,
        }))
        expect(clientSide.storage).toBe(0)
        expect(clientSide.documentCookie).not.toContain('pms_access_token')

        await page.reload()
        await expect(page.getByRole('heading', { level: 1, name: 'Plants' })).toBeVisible()

        await page.getByRole('button', { name: 'Sign out' }).click()
        await expect(page.getByText('You have been signed out.')).toBeVisible()
        await page.goto('/employees')
        await expect(page).toHaveURL(/\/login$/)
        expect(errors).toEqual([])
})
