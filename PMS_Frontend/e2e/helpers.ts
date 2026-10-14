import { expect, request, type Page } from '@playwright/test'

/** The isolated e2e API (see playwright.config.ts), never the development one. */
export const API_ORIGIN = process.env.PMS_E2E_API_ORIGIN ?? 'http://localhost:8001'

/** Per-run password of the synthetic accounts, set by playwright.config.ts. */
export function e2ePassword(): string {
        const value = process.env.PMS_E2E_PASSWORD
        if (!value)
                throw new Error(
                        'PMS_E2E_PASSWORD is not set; run the tests with `npm run test:e2e`.',
                )
        return value
}

export async function signIn(page: Page, username: string): Promise<void> {
        await page.goto('/login')
        await page.getByLabel('Username').fill(username)
        await page.getByLabel('Password', { exact: true }).fill(e2ePassword())
        await page.getByRole('button', { name: 'Sign in' }).click()
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
}

/** Look up ids through the API as an administrator (not via the browser). */
export async function adminLookup() {
        const api = await request.newContext({ baseURL: API_ORIGIN })
        const login = await api.post('/api/auth/login', {
                data: { username: 'demo.admin', password: e2ePassword() },
        })
        expect(login.ok()).toBe(true)
        const plants: { id: number; code: string }[] = await (await api.get('/api/plants')).json()
        const employees: { items: { id: number; employee_code: string }[] } = await (
                await api.get('/api/employees', { params: { limit: 200 } })
        ).json()
        await api.dispose()
        return {
                plantId: (code: string) => plants.find((p) => p.code === code)!.id,
                employeeId: (code: string) =>
                        employees.items.find((e) => e.employee_code === code)!.id,
        }
}

/**
 * Collect console errors raised by the application. The browser's own
 * "Failed to load resource" lines for expected 401/403/404 API responses
 * are network logs, not application errors, and are excluded.
 */
export function collectConsoleErrors(page: Page): string[] {
        const errors: string[] = []
        page.on('console', (message) => {
                if (message.type() !== 'error') return
                if (message.text().startsWith('Failed to load resource')) return
                errors.push(message.text())
        })
        page.on('pageerror', (error) => errors.push(error.message))
        return errors
}
