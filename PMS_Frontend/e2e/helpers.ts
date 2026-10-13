import { expect, request, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const API_ORIGIN = 'http://localhost:8000'

/**
 * Password of the seeded demo accounts: E2E_DEMO_PASSWORD, or
 * DEMO_USER_PASSWORD from PMS_Backend/.env. Read at runtime, never logged.
 */
export function demoPassword(): string {
  if (process.env.E2E_DEMO_PASSWORD) return process.env.E2E_DEMO_PASSWORD
  const envFile = fileURLToPath(new URL('../../PMS_Backend/.env', import.meta.url))
  const line = readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('DEMO_USER_PASSWORD='))
  const value = line?.slice('DEMO_USER_PASSWORD='.length).trim()
  if (!value) throw new Error('Set E2E_DEMO_PASSWORD or DEMO_USER_PASSWORD in PMS_Backend/.env')
  return value
}

export async function signIn(page: Page, username: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(demoPassword())
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
}

/** Look up ids through the API as an administrator (not via the browser). */
export async function adminLookup() {
  const api = await request.newContext({ baseURL: API_ORIGIN })
  const login = await api.post('/api/auth/login', {
    data: { username: 'demo.admin', password: demoPassword() },
  })
  expect(login.ok()).toBe(true)
  const plants: { id: number; code: string }[] = await (await api.get('/api/plants')).json()
  const employees: { items: { id: number; employee_code: string }[] } = await (
    await api.get('/api/employees', { params: { limit: 200 } })
  ).json()
  await api.dispose()
  return {
    plantId: (code: string) => plants.find((p) => p.code === code)!.id,
    employeeId: (code: string) => employees.items.find((e) => e.employee_code === code)!.id,
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
